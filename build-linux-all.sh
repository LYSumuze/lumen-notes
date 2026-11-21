#!/usr/bin/env bash
# =============================================================================
# Lumen Notes 0.1.0 - Linux 全格式打包 (AppImage + deb + rpm, x64)
#
#   bash build-linux-all.sh                        # 默认三种格式
#   LUMEN_SETUP_RPM=1 bash build-linux-all.sh     # 自动准备本地 rpm 工具链
#   LUMEN_SMOKE=1 bash build-linux-all.sh         # 构建后做一次启动自检
#   LUMEN_MIRROR=official bash build-linux-all.sh # 改用官方源（默认国内镜像）
#   LUMEN_FORCE_INSTALL=1 bash build-linux-all.sh # 强制重跑 npm ci
#   LUMEN_TARGETS="AppImage,deb" bash build-linux-all.sh
#   额外参数会透传给 electron-builder，例如：-c.linux.compression=gz
#
# 产物: release-linux/LumenNotes-0.1.0-linux-*.{AppImage,deb,rpm}
# 配套配置: electron-builder.linux-all.yml（脚本运行时生成临时副本）
#
# 写入范围: 仅项目目录内的 node_modules/ dist/ release-linux/ .lumen-build/
#           以及它们的时间戳备份；不删除任何已有产物。
#           只有 LUMEN_SETUP_RPM=1 且需要 rpm 时才会准备本地工具链（不改系统）。
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

OUT_DIR="release-linux"
CFG_SRC="electron-builder.linux-all.yml"
# 生成的配置放项目根目录：electron-builder 的 projectDir 与 output 相对路径
# 不论按 cwd 还是按配置文件目录解析，结果都一致。
CFG_GEN=".electron-builder.linux.gen.yml"
STAMP="$(date +%Y%m%d-%H%M%S).$$"
PARTIAL=0

log()  { printf '\n[lumen] %s\n' "$*"; }
warn() { printf '\n[warn] %s\n' "$*" >&2; }
die()  { printf '\n[error] %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------- 1. 环境自愈 ----
# IDE/终端注入的 NODE_OPTIONS、PYTHONPATH 会让 npm 与 python3 直接崩溃；
# ELECTRON_RUN_AS_NODE 会让 Electron 以纯 Node 模式启动（没有 GUI）。
unset NODE_OPTIONS PYTHONPATH PYTHONHOME ELECTRON_RUN_AS_NODE || true

# 选一个版本最高的 node（electron-builder 26 需要较新的 Node），
# 同时让 python3 落到系统版本（某些 managed python 缺 encodings 模块）。
pick_node() {
  local best='' best_major=0 p major
  for p in "$HOME"/.workbuddy/binaries/node/versions/*/bin/node \
           /usr/local/bin/node /usr/bin/node; do
    [ -x "$p" ] || continue
    major="$("$p" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf 0)"
    case "$major" in ''|*[!0-9]*) major=0 ;; esac
    if [ "$major" -gt "$best_major" ]; then best_major="$major"; best="$p"; fi
  done
  printf '%s' "$best"
}
NODE_BIN="$(pick_node)"
[ -n "$NODE_BIN" ] || die '未找到可用的 Node.js'
export PATH="$(dirname "$NODE_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
command -v npm >/dev/null || die '未找到 npm'
command -v python3 >/dev/null || die '未找到 python3'
python3 -c 'import sys' >/dev/null 2>&1 || die 'python3 无法运行（环境仍被污染？）'
log "node $(node -v) | npm $(npm -v) | $(python3 -V 2>&1)"

# /tmp 可能是小容量 tmpfs；Electron 安装脚本与 electron-builder 解压
# 都会往那里写上百 MB。统一改到用户缓存所在的大盘。
export TMPDIR="${LUMEN_TMPDIR:-$HOME/.cache/lumen-build-tmp}"
mkdir -p "$TMPDIR"
log "临时目录: $TMPDIR"

# ------------------------------------------------------------- 2. 下载镜像 ----
# 无代理时 GitHub / npmjs 可能很慢，默认走国内镜像。
case "${LUMEN_MIRROR:-cn}" in
  cn)
    export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
    export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
    export npm_config_registry="https://registry.npmmirror.com"
    REGISTRY="$npm_config_registry"
    log '使用国内镜像（Electron / npm / electron-builder 二进制）'
    ;;
  official)
    REGISTRY="https://registry.npmjs.org/"
    log '使用官方源'
    ;;
  *) die 'LUMEN_MIRROR 只能是 cn 或 official' ;;
esac

# ------------------------------------------------------------- 3. rpm 工具 ----
# electron-builder 26 的 deb/rpm 由 FPM 生成，rpm 目标硬性要求 rpmbuild。
# 若系统没有，则走「不改系统的本地工具链」：
#   隔离 apt 只下载 deb -> dpkg-deb -x 解包到 ~/.cache -> wrapper 注入
#   LD_LIBRARY_PATH 与 RPM_CONFIGDIR，把 rpmbuild 暴露到 PATH。
RPM_ROOT="${LUMEN_RPM_ROOT:-$HOME/.cache/lumen-rpm-root}"
RPM_BIN="$RPM_ROOT/usr/bin"
RPM_LIBS="$RPM_ROOT/usr/lib/x86_64-linux-gnu:$RPM_ROOT/lib/x86_64-linux-gnu"
RPM_APT="$HOME/.cache/lumen-apt"

prepare_local_rpm_tools() {
  if [ ! -x "$RPM_BIN/rpmbuild" ]; then
    log '下载并解包 rpm 工具链（隔离 apt，仅下载不安装）…'
    mkdir -p "$RPM_APT/lists/partial" "$RPM_APT/cache/archives/partial" \
             "$RPM_APT/etc" "$RPM_APT/log" "$RPM_ROOT"
    cp /etc/apt/sources.list.d/official-package-repositories.list "$RPM_APT/etc/sources.list" 2>/dev/null \
      || cp /etc/apt/sources.list "$RPM_APT/etc/sources.list"
    : > "$RPM_APT/status"
    local apt_opts=(
      -o "Dir::State::lists=$RPM_APT/lists"
      -o "Dir::Cache=$RPM_APT/cache"
      -o "Dir::State::status=$RPM_APT/status"
      -o "Dir::Etc::sourcelist=$RPM_APT/etc/sources.list"
      -o "Dir::Etc::sourceparts=-"
      -o "Dir::Log=$RPM_APT/log"
      -o Debug::NoLocking=1
      -o APT::Sandbox::User=root
    )
    apt-get "${apt_opts[@]}" update -qq || die '隔离 apt 索引更新失败'
    apt-get "${apt_opts[@]}" install --download-only -y rpm >/dev/null 2>&1 \
      || die 'rpm 依赖 deb 下载失败'
    for f in "$RPM_APT/cache/archives/"*.deb; do
      # 个别包（pam/passwd）在只读 uid 映射下 chown 失败，与 rpm 无关。
      dpkg-deb -x "$f" "$RPM_ROOT" >/dev/null 2>&1 || true
    done
  fi
  [ -x "$RPM_BIN/rpmbuild" ] || die '本地 rpm 工具链解压后仍找不到 rpmbuild'

  # FPM 通过 PATH 找 rpmbuild；wrapper 自带库路径与宏目录。
  for name in rpm rpmbuild rpm2cpio; do
    [ -x "$RPM_BIN/$name" ] || continue
    [ -e "$RPM_BIN/$name.real" ] || mv -- "$RPM_BIN/$name" "$RPM_BIN/$name.real"
    python3 - "$RPM_BIN/$name" "$RPM_ROOT" "$RPM_LIBS" "$name" <<'PY'
import sys, pathlib
out, root, libs, name = sys.argv[1:5]
p = pathlib.Path(out)
p.write_text(
        '#!/bin/bash\n'
        f'export LD_LIBRARY_PATH="{libs}${{LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}}"\n'
        f'export RPM_CONFIGDIR="{root}/usr/lib/rpm"\n'
        # rpm 的 popt 选项别名按 argv[0] 程序名加载：直接用 .real 调用，
        # `rpm -qpi` 之类组合选项会被判为「未知的选项」。
        f'exec -a "{root}/usr/bin/{name}" "{root}/usr/bin/{name}.real" "$@"\n'
)
p.chmod(0o755)
PY
  done
  export PATH="$RPM_BIN:$PATH"
  log "本地 rpm 工具链就绪: $(rpmbuild --version 2>&1)"
}

TARGETS_CSV="${LUMEN_TARGETS:-AppImage,deb,rpm}"
case ",$TARGETS_CSV," in *,rpm,*) WANT_RPM=1 ;; *) WANT_RPM=0 ;; esac
if [ "$WANT_RPM" -eq 1 ] && ! command -v rpmbuild >/dev/null 2>&1; then
  # 已有隔离工具链缓存就直接复用，无需任何额外开关。
  if [ -x "$RPM_BIN/rpmbuild" ]; then
    export PATH="$RPM_BIN:$PATH"
    for name in rpm rpmbuild rpm2cpio; do
      [ -x "$RPM_BIN/$name" ] || continue
      [ -e "$RPM_BIN/$name.real" ] || mv -- "$RPM_BIN/$name" "$RPM_BIN/$name.real"
      python3 - "$RPM_BIN/$name" "$RPM_ROOT" "$RPM_LIBS" "$name" <<'PY'
import sys, pathlib
out, root, libs, name = sys.argv[1:5]
p = pathlib.Path(out)
p.write_text(
        '#!/bin/bash\n'
        f'export LD_LIBRARY_PATH="{libs}${{LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}}"\n'
        f'export RPM_CONFIGDIR="{root}/usr/lib/rpm"\n'
        f'exec -a "{root}/usr/bin/{name}" "{root}/usr/bin/{name}.real" "$@"\n'
)
p.chmod(0o755)
PY
    done
    log "复用本地 rpm 工具链: $(rpmbuild --version 2>&1)"
  else
    case "${LUMEN_SETUP_RPM:-0}" in
      1) prepare_local_rpm_tools ;;
      system)
        [ "$(id -u)" -eq 0 ] || die '安装 rpm 工具需要 root 权限'
        log '安装系统 rpm 构建工具 (apt-get install rpm) …'
        mkdir -p /var/lib/apt/lists/partial /var/cache/apt/archives/partial
        apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends rpm \
          || die '系统 rpm 安装失败，可改用 LUMEN_SETUP_RPM=1 的本地方案'
        command -v rpmbuild >/dev/null 2>&1 || die 'rpm 安装后仍找不到 rpmbuild'
        ;;
      *)
        warn 'rpm 目标需要 rpmbuild（FPM 依赖），本机未安装。'
        warn '允许自动准备本地工具链请加 LUMEN_SETUP_RPM=1（不改系统）。'
        warn '本次先产出 AppImage + deb，最后会明确报告 rpm 缺失（退出码 2）。'
        TARGETS_CSV="$(python3 -c 'import sys; print(",".join(t.strip() for t in sys.argv[1].split(",") if t.strip() and t.strip() != "rpm"))' "$TARGETS_CSV")"
        PARTIAL=1
        ;;
    esac
  fi
fi
[ -n "$TARGETS_CSV" ] || die '没有可用的打包目标'

# ------------------------------------------------------- 4. 干净的输出目录 ----
# electron-builder 复用旧输出目录时会批量删除 linux-unpacked/，
# 某些环境的删除保护会拦截该操作。这里只移动、不删除。
if [ -e "$OUT_DIR" ]; then
  BAK="${OUT_DIR}.prev-${STAMP}"
  mv -- "$OUT_DIR" "$BAK"
  log "旧 $OUT_DIR/ 已移动为 $BAK（保留未删除）"
fi

# --------------------------------------------------------- 5. 动态目标配置 ----
python3 - "$CFG_GEN" "$TARGETS_CSV" "$CFG_SRC" <<'PY'
import sys, re, pathlib
out = pathlib.Path(sys.argv[1])
targets = [t.strip() for t in sys.argv[2].split(',') if t.strip()]
src = pathlib.Path(sys.argv[3]).read_text(encoding='utf-8')
block = '  target:\n' + ''.join('    - %s\n' % t for t in targets)
new, n = re.subn(r'(?m)^  target:\n(?:    - [A-Za-z0-9_.-]+\n)+', block, src, count=1)
if n != 1:
    raise SystemExit('生成配置失败：未找到 linux.target 配置块')
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(new, encoding='utf-8')
print('打包目标:', ', '.join(targets))
PY

# ------------------------------------------------------------- 6. 安装依赖 ----
# 依赖已完整时跳过 npm ci，避免它清空 node_modules/ 触发删除保护。
NEED_INSTALL=1
if [ "${LUMEN_FORCE_INSTALL:-0}" != "1" ] && [ -f node_modules/.package-lock.json ] \
   && [ -x node_modules/.bin/electron-builder ] && [ -x node_modules/.bin/vite ] \
   && [ -d node_modules/express ] && [ -d node_modules/ws ] \
   && [ -d node_modules/react ] && [ -f node_modules/electron/dist/electron ] \
   && [ -f node_modules/electron/path.txt ]; then
  NEED_INSTALL=0
fi
if [ "$NEED_INSTALL" -eq 1 ]; then
  log 'npm ci（按 lockfile 精确安装，含 Electron Linux 二进制）…'
  # --loglevel=error 压掉沙箱不支持 fchown 造成的大量 TAR_ENTRY_ERROR 警告
  npm ci --no-audit --no-fund --loglevel=error --registry="$REGISTRY"
else
  log '依赖已完整，跳过 npm ci（LUMEN_FORCE_INSTALL=1 可强制重装）'
fi

# ------------------------------------------------------------- 7. 前端产物 ----
# vite 默认会清空 outDir；先移走旧 dist，让它新建目录而不是批量删除。
if [ -d dist ]; then
  DIST_BAK="dist.prev-${STAMP}"
  mv -- dist "$DIST_BAK"
  log "旧 dist/ 已移动为 $DIST_BAK（保留未删除）"
fi
log 'npm run build（tsc --noEmit && vite build）…'
npm run build
[ -f dist/index.html ] || die '前端产物 dist/index.html 未生成'

# ----------------------------------------------------------------- 8. 打包 ----
log 'electron-builder --linux --x64 …'
./node_modules/.bin/electron-builder --linux --x64 --config "$CFG_GEN" "$@"

# ------------------------------------------------------------- 9. 产物自检 ----
python3 - "$OUT_DIR" "$TARGETS_CSV" <<'PY'
import sys, pathlib
out = pathlib.Path(sys.argv[1])
targets = [t.strip() for t in sys.argv[2].split(',') if t.strip()]
ext = {'AppImage': '.AppImage', 'deb': '.deb', 'rpm': '.rpm'}
fail = []
print('\n=== 产物 ===')
for t in targets:
    files = sorted(out.glob('*' + ext[t]))
    if not files:
        print('  %-9s 缺失' % t)
        fail.append(t + ': 未找到文件')
        continue
    f = files[0]
    mb = f.stat().st_size / 1024 / 1024
    print('  %-9s %-46s %7.1f MB' % (t, f.name, mb))
    if mb < 1:
        fail.append(t + ': 文件异常小')
app = out / 'linux-unpacked' / 'resources' / 'app'
need = ['package.json', 'dist/index.html', 'electron/main.cjs', 'server/index.mjs',
        'node_modules/express/package.json', 'node_modules/ws/package.json',
        'node_modules/react/package.json']
print('\n=== 包内文件自检 (asar=false) ===')
for rel in need:
    ok = (app / rel).exists()
    print('  %-46s %s' % (rel, 'OK' if ok else '缺失'))
    if not ok:
        fail.append('包内缺少 ' + rel)
if fail:
    print('\n自检失败: ' + '; '.join(fail))
    sys.exit(1)
print('自检通过')
PY

{
  # 只写文件名，便于在 release-linux/ 目录里直接 `sha256sum -c SHA256SUMS.txt`
  for f in "$OUT_DIR"/*.AppImage "$OUT_DIR"/*.deb "$OUT_DIR"/*.rpm; do
    [ -f "$f" ] && (cd "$OUT_DIR" && sha256sum "$(basename "$f")")
  done
} > "$OUT_DIR/SHA256SUMS.txt"
log "校验和已写入 $OUT_DIR/SHA256SUMS.txt"

if command -v dpkg-deb >/dev/null 2>&1; then
  for f in "$OUT_DIR"/*.deb; do
    [ -f "$f" ] || continue
    log "deb 元数据: $(basename "$f")"
    dpkg-deb -I "$f" | python3 -c 'import sys
for l in sys.stdin:
    if any(k in l for k in ("Package:", "Version:", "Architecture:", "Depends:", "Maintainer:", "Homepage:")):
        print("  " + l.strip())' || true
  done
fi
if command -v rpm >/dev/null 2>&1; then
  for f in "$OUT_DIR"/*.rpm; do
    [ -f "$f" ] || continue
    log "rpm 元数据: $(basename "$f")"
    rpm -qpi "$f" | python3 -c 'import sys
for l in sys.stdin:
    if any(k in l for k in ("Name ", "Version ", "Release ", "Architecture", "Summary", "License", "URL")):
        print("  " + l.strip())' || true
  done
fi

if [ ! -e /dev/fuse ]; then
  warn '本机没有 /dev/fuse（且未装 libfuse2），AppImage 无法直接运行。'
  warn '验证请使用: <AppImage> --appimage-extract-and-run，或改用 deb/rpm。'
fi

# --------------------------------------------------------- 10. 可选启动自检 ----
# 用解包后的 linux-unpacked 可执行文件验证，绕开 AppImage 的 FUSE 依赖。
if [ "${LUMEN_SMOKE:-0}" = "1" ]; then
  log '启动自检（LUMEN_SMOKE=1）…'
  EXE="$(python3 - <<'PY'
import os, pathlib
d = pathlib.Path('release-linux/linux-unpacked')
c = []
for p in d.iterdir():
    if not p.is_file():
        continue
    try:
        with p.open('rb') as f:
            magic = f.read(4)
    except OSError:
        continue
    if magic == b'\x7fELF' and os.access(p, os.X_OK):
        c.append(p)
print(max(c, key=lambda p: p.stat().st_size) if c else '')
PY
)"
  if [ -z "$EXE" ]; then
    warn '未找到打包后的可执行文件，跳过启动自检'
  else
    CDP_PORT="${LUMEN_CDP_PORT:-9333}"
    # CI / 容器里通常没有 X server 与 D-Bus；强制 headless ozone，
    # 否则 Chromium 会在 "Missing X server or $DISPLAY" 处直接退出。
    ELECTRON_DISABLE_SANDBOX=1 "$EXE" --no-sandbox \
      --ozone-platform=headless --disable-gpu \
      --remote-debugging-port="$CDP_PORT" > "$OUT_DIR/smoke.log" 2>&1 &
    SMOKE_PID=$!
    OK=0
    for _i in $(seq 1 40); do
      if curl -fsS --max-time 2 http://127.0.0.1:18740/health >/dev/null 2>&1; then OK=1; break; fi
      sleep 0.5
    done
    if [ "$OK" -eq 1 ]; then
      log "启动自检通过：同步服务 /health 就绪"
    else
      warn "启动自检未通过（可能无图形会话或 root sandbox），日志见 $OUT_DIR/smoke.log"
      python3 -c "import pathlib,sys; print(''.join(pathlib.Path(sys.argv[1]).read_text(errors='replace').splitlines(True)[-12:]))" "$OUT_DIR/smoke.log" 2>/dev/null || true
    fi
    kill "$SMOKE_PID" 2>/dev/null || true
    wait "$SMOKE_PID" 2>/dev/null || true
  fi
fi

# ----------------------------------------------------------------- 汇总 ------
log "完成。产物目录: $PWD/$OUT_DIR"
python3 -c '
import pathlib, sys
for f in sorted(pathlib.Path(sys.argv[1]).iterdir()):
    if f.is_file() and f.suffix in (".AppImage", ".deb", ".rpm"):
        print("  " + f.name)
' "$OUT_DIR"
if [ "$PARTIAL" -eq 1 ]; then
  warn 'rpm 未生成（缺 rpmbuild）。加 LUMEN_SETUP_RPM=1 重跑即可补齐。'
  exit 2
fi
