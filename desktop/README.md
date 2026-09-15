# 音转文 桌面端 / iOS（Tauri 2 外壳）

把同一份 Web 应用用 **Tauri 2** 包成原生安装包。
前端只有一份，桌面端、iOS、安卓、PWA 的界面和逻辑完全一致。

## 产物与体积

| 产物 | 体积 | 说明 |
| --- | --- | --- |
| `音转文-2.0.0.dmg` | 约 640 MB | macOS，内含 726MB 离线模型 |
| `音转文-2.0.0-setup.exe` | 约 740 MB | Windows NSIS 安装包 |
| `音转文-2.0.0.ipa` | 约 740 MB | iOS，需云端构建 |

体积几乎全是内置模型。Tauri 本身只贡献 6–10 MB —— 它复用系统自带的
WebView（macOS 用 WKWebView，Windows 用 WebView2），不像 Electron
那样把整个 Chromium 打进去。

## 前置条件

```bash
# Rust（必需）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Node 18+
node -v

# 平台依赖
#   macOS  ：xcode-select --install      （CLT 就够，不用装完整 Xcode）
#   Windows：Visual Studio C++ 生成工具 + WebView2 Runtime
```

## 构建

### macOS

```bash
./build-mac.sh               # 当前架构
./build-mac.sh --universal   # Intel + Apple Silicon 通用包
```

### Windows

在 Windows 机器上：

```powershell
powershell -ExecutionPolicy Bypass -File .\build-windows.ps1
```

脚本会先检查 Node / Rust / MSVC，缺哪样明确告诉你怎么装。

> ⚠️ `build-windows.ps1` 存的是 **UTF-8 with BOM + CRLF**。
> PowerShell 5.1 读没有 BOM 的 UTF-8 脚本时，会把中文按本地代码页解析，
> 输出全乱码，甚至因引号配对错位直接语法报错。改这个文件时请保持 BOM。

### iOS

走 GitHub Actions，见 `../.github/workflows/build-ios.yml`。
本地构建需要完整 Xcode，且签名需要付费 Apple Developer 账号。

## 目录结构

```
desktop/
├── build-mac.sh             # macOS 打包
├── build-windows.ps1        # Windows 打包（UTF-8 BOM）
├── package.json
├── scripts/
│   ├── sync-app.mjs         # 把 ../ 的 Web 资源同步到 app/
│   └── patch-ios.sh         # 修补 iOS Info.plist
├── app/                     # 同步产物（自动生成，不要手改）
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    └── src/main.rs          # 本地模型服务 + 原生保存
```

## 三个必须知道的设计决定

### 1. 726MB 的模型不能放进 `frontendDist`

Tauri 会把 `frontendDist` 整个嵌进可执行文件。726MB 进去，产物就变成一个
726MB 的 Mach-O / PE，构建慢且容易触到格式上限。

所以模型走 `bundle.resources` 放到应用资源目录：

```json
"bundle": { "resources": { "../../models": "models" } }
```

### 2. 模型用本地 HTTP 服务喂给页面，不用 Tauri 的自定义协议

Tauri 的自定义协议响应体是**一次性缓冲**的（`http::Response<Vec<u8>>`），
405MB 的编码器会被整个读进内存。

`src/lib.rs` 里起了一个只监听 `127.0.0.1` 的流式 HTTP 服务：

- 端口由系统随机分配（`bind(("127.0.0.1", 0))`）
- 支持 `Range` 请求，内存占用是常数
- 每个请求一个线程，长任务不阻塞后续请求
- 路径做 `Component::Normal` 校验，挡掉 `../` 穿越
- 前端通过 `model_base_url` 这个 IPC 命令拿地址

### 3. DMG 自己用 `hdiutil` 造，不用 `tauri build --bundles dmg`

Tauri 内置的 `bundle_dmg.sh` 是从 create-dmg 抄来的，里面有 GNU grep 的写法。
macOS 自带的是 BSD grep，跑到那里会报：

```
grep: bad regex '/dev/disk8s': brackets ([ ]) not balanced
```

然后丢一句 `error running bundle_dmg.sh` 就放弃，而此时临时映像已经挂上了，
还会留下一个没卸载的 `/Volumes/dmg.XXXXXX`。

`build-mac.sh` 改成 `tauri build --bundles app` + 自己调 `hdiutil`：
暂存目录里放 `.app` 和一个 `/Applications` 软链（拖拽安装），
打成压缩只读 DMG，最后**实际挂载一次**校验内容。
少一层依赖，出错也看得见。

### CSP 里的那个坑

`tauri.conf.json` 的 `connect-src` **必须包含 `http://127.0.0.1:*`**。

页面从 `tauri://localhost` 取模型时是跨源请求，CSP 不放行的话
浏览器会静默拦掉，表现为"模型加载失败"但控制台只有一条 CSP 违规。
另外 `script-src` 必须有 `'wasm-unsafe-eval'`，否则 WebAssembly 无法编译。

## 导出功能怎么落盘

`js/app.js` 的 `saveToLocal()` 按环境分三条路：

| 环境 | 通道 |
| --- | --- |
| Tauri（macOS / Windows / iOS） | `window.__TAURI__.dialog.save()` 弹原生「另存为」 |
| 安卓 WebView | `window.__yzwSave.save()` 这个 `@JavascriptInterface` 桥 |
| 纯浏览器 | `blob:` + `<a download>` |

安卓之所以不能走第三条：**WebView 对 `blob:` URL 的下载请求不会触发
`DownloadListener`**，点了完全没反应，而且不报任何错。
