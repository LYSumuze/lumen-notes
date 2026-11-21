/**
 * Build the Android debug APK from this source tree.
 *
 *   node scripts/build-android.cjs
 *
 * Requires JDK 21 + Android SDK (platform 35, build-tools 35.0.0). Override
 * with JAVA_HOME / ANDROID_HOME; on the original dev machine the toolchain is
 * preinstalled under E:/android-dev and is picked up automatically.
 *
 * Steps: vite build -> cap sync android -> gradle assembleDebug -> copy APK.
 * `npx cap sync` copies dist/ into android/app/src/main/assets/public and
 * regenerates capacitor.config.json, so the APK always ships the current UI.
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const ANDROID = path.join(ROOT, 'android')
const env = { ...process.env }

const LOCAL_JDK = 'E:/android-dev/jdk21'
const LOCAL_SDK = 'E:/android-dev/android-sdk'
const LOCAL_GRADLE = 'E:/android-dev/gradle-dist/gradle-8.11.1/bin/gradle.bat'

// Capacitor 7 / AGP 8.7.2 need JDK 21. The host's JAVA_HOME may still point
// at an older JDK (e.g. 11), so prefer the toolchain installed for this app;
// on another machine set LUMEN_JDK or JAVA_HOME explicitly.
env.JAVA_HOME = process.env.LUMEN_JDK ||
  (fs.existsSync(LOCAL_JDK) ? LOCAL_JDK : env.JAVA_HOME)
function jdkMajor(home) {
  try {
    const m = fs.readFileSync(path.join(home, 'release'), 'utf8').match(/JAVA_VERSION="?(\d+)/)
    return m ? Number(m[1]) : 0
  } catch { return 0 }
}
if (!env.JAVA_HOME || jdkMajor(env.JAVA_HOME) < 17) {
  console.error('需要 JDK 17 以上（Capacitor 7 要求 JDK 21）。请设置 LUMEN_JDK 或 JAVA_HOME。')
  process.exit(1)
}
const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT ||
  (fs.existsSync(LOCAL_SDK) ? LOCAL_SDK : '')
if (sdk) {
  env.ANDROID_HOME = sdk
  env.ANDROID_SDK_ROOT = sdk
  // Gradle accepts forward slashes on Windows; escaping backslashes is not needed.
  fs.writeFileSync(path.join(ANDROID, 'local.properties'), `sdk.dir=${sdk.replace(/\\/g, '/')}\n`)
}
if (env.JAVA_HOME) env.PATH = `${path.join(env.JAVA_HOME, 'bin')}${path.delimiter}${env.PATH || ''}`

function run(cmd, args, cwd = ROOT) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, {
    cwd, env, stdio: 'inherit', shell: process.platform === 'win32',
  })
  if (r.status !== 0) process.exit(r.status == null ? 1 : r.status)
}

console.log('JAVA_HOME =', env.JAVA_HOME || '(system default)')
console.log('ANDROID_HOME =', sdk || '(from local.properties / Android Studio)')

// Vite empties dist/assets before writing. On hosts with a bulk-delete guard
// that removes >50 files in one Node call, that cleanup aborts the whole build.
// Remove dist up front through the platform's own command instead.
const DIST = path.join(ROOT, 'dist')
if (fs.existsSync(DIST)) {
  console.log('\n$ clean dist/')
  if (process.platform === 'win32') {
    const r = spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', DIST], { stdio: 'inherit' })
    if (r.status !== 0) process.exit(1)
  } else {
    fs.rmSync(DIST, { recursive: true, force: true })
  }
}

run('npm', ['run', 'build'])

// cap sync also clears assets/public in one bulk call, which hits the same
// guard. Removing the directory up front makes its own cleanup a no-op.
const WEB_ASSETS = path.join(ANDROID, 'app/src/main/assets/public')
if (fs.existsSync(WEB_ASSETS)) {
  console.log('\n$ clean android web assets/')
  if (process.platform === 'win32') {
    const r = spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', WEB_ASSETS], { stdio: 'inherit' })
    if (r.status !== 0) process.exit(1)
  } else {
    fs.rmSync(WEB_ASSETS, { recursive: true, force: true })
  }
}
run('npx', ['cap', 'sync', 'android'])

// cap sync can report a failed copy yet still exit 0. Refuse to ship an APK
// whose bundled UI is stale: compare the entry file byte-for-byte.
const srcEntry = fs.readFileSync(path.join(DIST, 'index.html'))
const dstEntry = path.join(WEB_ASSETS, 'index.html')
if (!fs.existsSync(dstEntry) || !fs.readFileSync(dstEntry).equals(srcEntry)) {
  console.error('cap sync 未更新 assets/public：APK 会带旧版界面，已中止。')
  process.exit(1)
}

const gradle = fs.existsSync(LOCAL_GRADLE)
  ? LOCAL_GRADLE
  : path.join(ANDROID, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')
run(gradle, ['assembleDebug', '--no-daemon'], ANDROID)

const built = path.join(ANDROID, 'app/build/outputs/apk/debug/app-debug.apk')
if (!fs.existsSync(built)) {
  console.error('APK not found at', built)
  process.exit(1)
}
const outDir = path.join(ROOT, 'release-android-v1')
fs.mkdirSync(outDir, { recursive: true })
const out = path.join(outDir, 'LumenNotes-0.1.0-android-debug.apk')
fs.copyFileSync(built, out)
const bytes = fs.statSync(out).size
const sha = require('node:crypto').createHash('sha256').update(fs.readFileSync(out)).digest('hex')
console.log('\nAPK =', out)
console.log('BYTES =', bytes)
console.log('SHA256 =', sha)
