# Lumen Notes

一个本地优先、局域网同步的 Markdown 笔记应用。桌面端（Windows / Linux）使用 Electron 壳，移动端目前只做 Android；两端共用同一份 `dist/` 渲染层。

## 核心设计

- **磁盘上的 `.md` 文件是唯一权威**。应用内的编辑先落在工作副本里，只有显式保存才写回磁盘；IndexedDB 只保存工作副本与草稿，不作为数据源。
- **每设备一个本地仓库 + 一个自己的云仓库**。同步基于内容 hash 收敛：相同则跳过、单边则拷贝、删除且 hash 等于基准则写墓碑，其余逐篇进入冲突选择。不做双向合并、闪电传输、自动快进或无在线设备时的收敛。
- **保存前比对磁盘 hash**，外部改动会弹出三选一提示；同步有独立的「同步当前笔记 / 全仓同步」与「拉取」入口，不自动同步。
- 每个笔记最多保留 15 条历史版本，覆盖前写入 `.lumen-history/`。

## 目录结构

```
src/            前端源码（React + CodeMirror）
electron/       桌面壳（主进程、preload、图标、NSIS 脚本）
server/         同步服务（REST + WebSocket）
scripts/        Android 构建脚本
public/         PWA 资源（Service Worker 缓存版本在此维护）
android/        Capacitor Android 工程（SAF 文件访问、扫码插件）
dist/           构建产物，不入库
```

## 开发环境

需要 Node.js 20+（推荐 22）与 npm。

```bash
npm ci
npm run dev        # Vite 开发服务器 + 同步服务
```

## 构建

所有平台构建前都必须先生成 `dist/`（`dist/` 不入库）：

```bash
npm run build      # tsc --noEmit && vite build
```

**Windows 安装包**

```bash
npm run dist:win   # 输出 electron-builder 配置的目录，默认 release-win-v5
```

**Linux 安装包（deb / rpm / AppImage）**

需在 Linux 主机上运行，Windows 无法交叉构建：

```bash
npm run build
./build-linux-all.sh                 # 输出 release-linux/，含自检与 SHA256SUMS
npm run dist:linux:rpm-setup         # 首次需准备 rpm 工具链时执行
```

也可手动用 `electron-builder.linux.yml` 或 `electron-builder.linux-all.yml` 直打（输出 `release-linux-v1/`），需自行解决 fpm / rpmbuild 依赖。

**Android APK**

需要 JDK 21 与 Android SDK（platform 35 / build-tools 35.0.0）。

```bash
node scripts/build-android.cjs
```

脚本会依次执行构建、`cap sync`（并逐字节校验入口 HTML，防止打包旧界面）与 Gradle `assembleDebug`，产物复制到 `release-android-v1/`。Android SDK 路径写在本机 `android/local.properties`（已忽略），仓库里提供的是模板 `android/local.properties.example`。

> 注意：任何前端资源改动都必须同步提升 `public/sw.js` 的缓存版本，并保证 `dist/sw.js` 与之一致。

## 数据存储

- 应用配置与日志写在系统用户数据目录，不写安装目录；可用 `LUMEN_CONFIG_FILE`、`LUMEN_DIST`、`DEFAULT_VAULT`、`INSTALL_DIR`、`LOG_DIR` 覆盖。
- 笔记正文以普通 `.md` 文件存在用户选择的仓库目录；附件放在笔记同级的 `img/<笔记名>/`。
- 手机端全部文件操作走系统文件选择器（SAF），不读取桌面 REST 服务；手机作为独立仓库参与同步。

## 同步服务

```bash
npm start          # 单端口同时提供 dist/ 静态资源与 /api、/raw、/health、/ws
```

局域网设备通过桌面端显示的二维码配对；非 loopback 访问需要会话。配对码排障副本写入用户数据目录的 `logs/pair-token.txt`。
