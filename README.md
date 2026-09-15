# 音转文 · 声音转文字（v2.0.0 · 完全离线）

一套代码，四端交付：**Android · macOS · Windows · iOS**。

**完全离线**：识别模型（726 MB）和推理运行时随安装包一起发出去，
装完之后**断网也能用**，全程不上传任何音频或文字。

模型用的是 **q4 量化**（int4 权重 + fp32 激活），这是刻意的选择：
更小的 q4f16 只有 WebGPU 能跑，而 macOS 的 WKWebView 和一部分安卓 WebView
都没有 WebGPU —— 那样「内置了模型却用不了」，程序会退回联网下载。
q4 代价是体积从 537 MB 涨到 726 MB，换来的是**任何设备都真离线**。

---

## 交付物

| 文件 | 平台 | 体积（实测） | 怎么来的 |
| --- | --- | --- | --- |
| `release/音转文-2.0.0.apk` | Android | **760.34 MB** | 本机 `android/build-apk.sh` |
| `release/音转文-2.0.0.dmg` | macOS | **518.17 MB** | 本机 `desktop/build-mac.sh` |
| `release/音转文_2.0.0_x64-setup.exe` | Windows | 约 461 MB | 云端构建（NSIS，双击即装） |
| `release/音转文-2.0.0.ipa` | iOS | 约 740 MB | ⬜ 待 Apple 证书，见 `.github/workflows/build-ios.yml` |

> 上面三个都是**带上「离线约束修复」重新构建**的版本（2026-09-15 18:54 前后出）。
> 修复前的旧包没删，挪在 `release/_修复前-2.0.0/`，确认新版没问题后可以自行删除。

Windows 只出 NSIS 这一个安装包（用户分发够用了）。**两种方式任选**：

1. **云端**（推荐，不用装任何工具链）：推 GitHub → Actions →「构建 Windows 版」
   → Run workflow，`bundles` 选 `nsis`，约 40~60 分钟后从 Artifacts 下载。
2. **本机**：在你的 Windows 机器上跑 `desktop/build-windows.ps1`。

> 需要 MSI（企业分发 / 域控推送）的话，把 `bundles` 选成 `msi` 或 `nsis,msi` 再跑一次即可，
> 工作流本来就支持，只是默认不产。

> DMG 比 APK 小一些，是因为 DMG 用 zlib 把 726 MB 的模型压过一道（约 480 MB），
> APK 里的模型是原样存储的。
> NSIS 的 `.exe` 又比它们都小，因为安装程序本身对内容做了一次 LZMA 压缩。

> **注意**：Tauri 产出的文件名带下划线和版本后缀
> （`音转文_2.0.0_x64-setup.exe`），与早期文档里写的
> `音转文-2.0.0-setup.exe` 不同。以实际产物为准。

> Windows 这条链最初是「只在 macOS 上验过」，推到 CI 上实跑才暴露出
> 三个只影响 Windows 的 bug（Python 中文日志崩溃、`shasum` 命令不存在、
> `title_bar_style` 是 macOS 专属 API）。都已修复，详见下面「运行验证」。

### 四个包里的模型，已逐个解包实测

「离线版」的命门就是模型必须真的在包里。四个已产出的包都拆开验过了，
两个 `.onnx` 的 SHA-256 与 `fetch-models.sh` 里登记的官方哈希**逐字节一致**：

| 包 | 模型在哪 | encoder | decoder |
| --- | --- | --- | --- |
| DMG | `音转文.app/Contents/Resources/models/…` | ✅ | ✅ |
| EXE | `models/whisper-large-v3-turbo/onnx/` | ✅ | ✅ |
| MSI | 内部 CAB 流 | ✅ | ✅ |
| APK | `assets/web/models/…`（STORED 不压缩） | ✅ | ✅ |

官方哈希：`7e64b20d…47d78`（encoder，424942775 字节）、
`8b933ac2…ceeb8`（decoder，334147222 字节）。

### 自己复现（附一个容易误判的坑）

早先想验证「模型有没有打进 EXE」，直接：

```bash
grep -c 'encoder_model_q4.onnx' 音转文_2.0.0_x64-setup.exe   # → 0
```

一度以为模型没进去。**那是误报**：NSIS 用 solid LZMA，连文件名都压进了数据流，
明文扫描本来就该搜不到。拿 APK 做阳性对照可以证明扫描方法没问题 ——
APK 里模型是 STORED 不压缩，同样的命令能搜到。

正确做法是直接把包解开：

```bash
brew install p7zip

# EXE（7z 会识别成 Type = Nsis）
7z l 音转文_2.0.0_x64-setup.exe                    # 列出 17 个文件
7z x 音转文_2.0.0_x64-setup.exe "models/*/onnx/*" -o/tmp/x
shasum -a 256 /tmp/x/models/whisper-large-v3-turbo/onnx/*.onnx

# APK（注意路径是 assets/web/…）
7z x 音转文-2.0.0.apk "assets/web/models/*/onnx/*" -o/tmp/y

# DMG（先挂载再进 app 包里找）
hdiutil attach -readonly -nobrowse 音转文-2.0.0.dmg
shasum -a 256 "/Volumes/音转文/音转文.app/Contents/Resources/models/whisper-large-v3-turbo/onnx/"*.onnx

# MSI（复合文档，7z 直接解成带随机名的流，按体积认）
7z x 音转文_2.0.0_x64_zh-CN.msi -o/tmp/z
```

EXE 里的完整清单长这样（17 个文件，772917269 字节原始 / 483282205 压缩）：

```
2026-09-15 17:12:30 .....     11140096   voicetype.exe
2026-09-15 17:06:30 ....A    334147222   models/…/onnx/decoder_model_merged_q4.onnx
2026-09-15 17:06:24 ....A    424942775   models/…/onnx/encoder_model_q4.onnx
2026-09-15 17:06:16 ....A      2480617   models/…/tokenizer.json
```

那两个体积正好是 CI 工作流 `build-windows.yml` 里硬卡的值 ——
对不上就构建失败，所以这也是一道自动校验，不是巧合。

**关键判据**：如果模型没进去，安装包只会有 ~22 MB。实际是 461 MB，
差 20 倍 —— 不可能有别的东西能凑出这个体积。
三个独立打包器的结果也互相印证：NSIS 461 MB / WiX 517 MB / DMG 518 MB。

> 仍未覆盖：**Windows 端没做运行时验证**（本机不是 Windows）。
> 装是能装、体积和格式都对，但「打开后能不能真的识别」只能你在 Windows 上试。
> 重点看两件事：① 首次启动后断网，模型能否载入；② 导出 txt/html 能否保存。

> 体积几乎全部来自内置的 whisper-large-v3-turbo（q4 量化，726 MB）。
> 这是「完全离线 + 最高识别质量」这个组合的必然代价 —— 想瘦身就得改成
> 首次启动时联网下载模型（那样安装包能回到 5 MB 左右，但就不再是离线版了）。

### 校验值（本机实测）

```
f32e24e46ea8dfe852e7bb7a48f5f13cc3928c5821ce2aa4765dcf359505786d  音转文-2.0.0.dmg
ac41f90debaac5cc0af063d1a09a74475cb64869dbcb91336e8051c24eb240fe  音转文-2.0.0.apk
021d15000dcc2a8f29854eade017e75be1dd903a23cb40c239f426b5513617dc  音转文_2.0.0_x64-setup.exe
```

```bash
# 拿到文件后自己核一遍
cd release
shasum -a 256 音转文-2.0.0.dmg 音转文-2.0.0.apk 音转文_2.0.0_x64-setup.exe
```

> 这三个值对应的是**重新构建后**的版本。修复前的旧值（`dmg 1791cc2d…`、
> `apk b7e864e1…`、`exe fc181951…`）已经作废，仅存档在
> `release/_修复前-2.0.0/` 里供对照。

> 一个小坑：`aapt2 dump badging` 在 manifest 里写了 `WRITE_EXTERNAL_STORAGE`
> 时会**额外**打一行 `READ_EXTERNAL_STORAGE maxSdkVersion=28` 出来，看着像多要了一个权限。
> 那是 badging 的人类可读报告里加的「隐含伴随」，实际编译进 APK 的二进制 manifest
> 只有 WRITE（用 `dump xmltree --file AndroidManifest.xml` 验过）。
> Play Console 安装时也是按 binary manifest 走，那条附加的根本不会真的被要。
> 所以构建脚本（`build-apk.sh`）现在权限一行用 `dump permissions` 读，
> 而不是 badging —— 后者会带这条误导信息。
> 遇到类似的多余权限提示，用 `aapt2 dump permissions x.apk | grep uses-permission`
> 才是真权限列表。

> DMG 重建过四次（补 CSP 转发 → 补 ATS 声明 → 修流式发送 → 带上 JS 修复），
> APK 重建过三次（关 `allowBackup` → 修 WebGPU 探测与降级 → 修缓存头与状态覆盖）。
> 上面都是最后一版。EXE / IPA 还没构建过，构建完请自己补一行。

---

## 运行验证（实测）

静态校验（`aapt2` / `apksigner` / 包内容抽查）只能证明「包装对了」，
证明不了「跑得起来」。安卓版因此在模拟器上完整跑过一轮。

**环境**：Android 模拟器 API 36 / arm64-v8a / 1080×2400，WebView 133.0.6943.137，
**8 GB 内存**（这一点很关键，见下）。

| 检查项 | 结果 |
| --- | --- |
| 安装 | ✅ `Success` |
| 启动 | ✅ `Status: ok`，`TotalTime: 588` |
| 崩溃 | ✅ 进程存活，logcat 无 `FATAL EXCEPTION` |
| 界面 | ✅ 渲染正确（内容在上、录音键在下） |
| 权限弹窗 | ✅ 标题显示中文名「音转文」 |
| **断网加载模型** | ✅ **飞行模式 + 关 WiFi/数据，模型仍载入到 2.60 GB** |
| 失败时的提示 | ✅ 无麦克风时显示「麦克风启动失败」（修复前会永远卡在「正在处理最后一段…」） |
| 麦克风 | ⚠️ 模拟器用 `-no-audio` 启动，无法验证（需真机） |

**断网那一项是重点**：这是「离线版」的核心承诺。做法是
`svc wifi disable` + `svc data disable` + `cmd connectivity airplane-mode enable`，
`ping 8.8.8.8` 确认 `Network is unreachable` 之后再启动应用。
结果 logcat 里**没有任何** hf-mirror / huggingface 的请求或 DNS 报错，
而 WebView 渲染进程 RSS 达到 **2.60 GB** —— 只能是包里那对 q4 文件
（本地不存在 q8 版本，断网也没有第二种可能）。

> **内存门槛**：先在 4 GB 模拟器上跑，模型载入失败；
> 换 8 GB 立刻正常。726 MB 的模型加上 onnxruntime 的 WASM 堆，
> 峰值要 2.5 GB 以上，4 GB 的机器（还要扣掉系统占用）不够。
> 这不是代码缺陷，但**上架说明里应当写明建议 4 GB 以上可用内存**。

> **已知无害现象**：载入过程中 logcat 会有一条
> `VoiceType: 本地资源不存在：.../encoder_model_quantized.onnx`。
> 这是 transformers.js 在探测 q8 变体（随包只有 q4），
> 探测失败后自动回退到 `_q4` 并成功载入，只是一次多余的往返，不影响结果。

**缓存策略的行为验证**（证明坑⑭真的堵上了）：跑完一轮之后查 WebView 的数据目录 ——

```bash
adb root && adb shell du -sk /data/data/com.voicetype.app/app_webview
adb shell ls /data/data/com.voicetype.app/app_webview/Default/ | grep -i cache
```

结果：**没有 `Cache` / `HTTP Cache` / `Code Cache` 任何一项**，
应用数据总量只有 **4.9 MB**（几乎全是 Chromium 自己的指标文件和 52 KB 的 localStorage）。
也就是说页面的脚本、运行时、wasm **一个字节都没落盘** ——
既杜绝了陈旧缓存，也不会在磁盘上平白多出 540 MB 的模型副本。

### 端到端转录（桌面，跑通整条链路）

安卓模拟器没有音频输入，麦克风那一环验不了；但「模型能不能真的把话转成字」
这件事可以在桌面端完整验证 —— 用的是**同一套 `js/`、同一份 q4 模型、同一个 vendor 运行时**。

做法：起一个补了 `COOP`/`COEP` 的本地 http 服务指向仓库根，用无头 Chrome 打开，
再通过 CDP 在页面里直接调 `ensure()` + `transcribe()`，音频用仓库自带的 `test-audio.wav`。

```json
{
  "coi": true, "sab": true,
  "info": { "webgpu": true, "isolated": true, "sab": true, "cores": 10, "threads": 4 },
  "bundledLarge": true, "localRuntime": true,
  "model": "large", "device": "wasm", "dtype": "q4", "bundled": true,
  "audioSeconds": 5.39, "loadMs": 4171, "inferMs": 17817, "rtf": 3.3,
  "text": "今天天气不错,我们下午三点开会讨论一下项目进度。",
  "suspect": false
}
```

三点值得记：

- **输出是对的**：中文简体、标点正确、`suspect=false`（没有触发幻觉截断）。
  这条同时证明了随包 q4 模型、随包运行时、以及整条调用链都是好的。
- **`device` 是 `wasm` 而不是 `webgpu`**，尽管 `info.webgpu` 为 `true`
  （API 存在）。这正是「WebGPU 探测」那个修复在起作用的证据 ——
  无头 Chrome 拿不到 adapter，修复前会硬选 webgpu 然后加载失败。
  说明那个修复不是安卓专属的，任何「API 在但拿不到设备」的环境都受益。
- `rtf` 3.3 偏高是因为样本只有 5.39 秒，固定开销占比大；
  按 19.9 秒样本实测，多线程是 RTF 1.08（见「已知限制」）。

### 导出 TXT / HTML（新增功能的验证）

「保存为 txt / html」是 2.0.0 新增的，光看代码不算数，所以也跑了一遍。
用对抗性文本喂进去（注入尝试、HTML 特殊字符、双语引号、换行、emoji、
结尾无标点），再从导出的 HTML 里把内容解析回来对照：

| 检查 | 结果 |
| --- | --- |
| 7 段文本往返一致 | ✅ 全部 `roundTrip: true` |
| `<script>alert(1)</script>` 不被当标签 | ✅ 解析后 **0 个 script 节点**，按纯文本渲染 |
| `&` `<` `>` `"` `'` 转义 | ✅ `escapeHtml` 覆盖了这五个字符 |
| HTML 自包含 | ✅ 无 `script` / `src=` / `href=` / `link` / `@import` / 外链 |
| 结构完整 | ✅ `DOCTYPE`、`meta charset`、`</html>` 齐备 |
| 中文 / emoji 无损 | ✅ 原样保留 |
| 真的落盘成文件 | ✅ 浏览器下载出 `音转文-20260915-1234.txt`（75 字节 UTF-8）与 `.html` |
| 导出 HTML 能独立打开 | ✅ `file://` 打开有实际布局（709×404）、文字可见、时间徽标正常、深色模式规则在位 |

> 导出文件名是 `音转文-<时间戳>.<格式>`，落盘通道按环境三选一：
> 桌面/iOS 走 Tauri 原生「另存为」，安卓走 `@JavascriptInterface` 桥写进「下载/音转文」，
> 纯浏览器走 blob 下载。上面验的是最后那一条。

### 安卓落盘桥（单独在模拟器上验过）

桌面/iOS 走的是系统原生「另存为」对话框，安卓走的是自己写的
`SaveBridge.java`（`@JavascriptInterface` 桥）。自定义代码最容易藏 bug，
而这条一坏，「保存为 txt/html」在手机上就等于不存在，
所以也在 **API 36 模拟器**上真跑了一遍（debug 包 + CDP 驱动
`window.VoiceType.export()`，再用 `adb shell` 核对磁盘与 MediaStore）：

| 检查 | 结果 |
| --- | --- |
| 桥存在且可调 | ✅ `typeof window.__yzwSave.save === 'function'`，**同步**返回路径字符串 |
| TXT 落盘 | ✅ `Download/音转文/音转文-<时间戳>.txt`，内容与页面一致 |
| HTML 落盘 | ✅ 同上，`.html` 自包含、可独立打开 |
| 注入被转义 | ✅ 文件里是 `&lt;script&gt;`，没有可执行的 `<script>` 节点 |
| 大文本 | ✅ 2.7 MB 一次过桥精确落盘（字节数一致），无大小上限问题 |
| 同名重复导出 | ✅ 不覆盖，自动 `(2)` `(3)` |
| release 包含此修复 | ✅ dex 里能查到新增的 `uniqueName` / `existsInDownloads` / `actualName` |

**过程中改掉一个真问题**：同名文件时系统会兜底改名成
`音转文-20260915-1321.txt (1)` —— 序号加在了**扩展名之后**，
MediaStore 再按扩展名推 MIME 就推不出来，实测写进去的是
`application/octet-stream`（同一批里没撞车的那份是 `text/plain`，
对照过才敢这么归因）。后果不只是图标难看：在文件管理器里点它，
系统找不到能打开的应用，用户会以为「导出的文件坏了」。

修法是**自己先挑一个不撞车的名字**，序号放在扩展名前面（`xxx(2).txt`），
既保住 MIME，也和 Android 9 分支的命名规则统一；写入后再回查一次
MediaStore 拿到真实名字，保证 toast 里报的路径是真存在的那个。

> 这里还踩了个小坑：传给 `insert` 的 `RELATIVE_PATH` 写的是
> `Download/音转文`（无结尾斜杠），但 MediaStore 存进去、查出来是
> `Download/音转文/`（**有**斜杠）。第一版预检只按无斜杠比，一次都没匹配上，
> 预检形同虚设 —— 现象是 toast 已经能报出 `(1)` `(2)`（回查生效），
> 但 MIME 依旧退化。两种写法都放进 `OR` 条件里才稳。

> 仍未覆盖：Android 9 及以下那条分支（`saveViaLegacyDownloads`）在
> API 36 模拟器上跑不到，只做了静态审查。运行时权限申请是有的
> （`MainActivity.requestPermissionsThenSetup` 里对
> `WRITE_EXTERNAL_STORAGE` 做检查，manifest 上带 `maxSdkVersion="28"`），
> 但没有真机验过。

> **这次验证的边界，说清楚免得高估**：上面跑的是仓库根目录下的 `js/`，
> 与 DMG 里用的是**同一份源文件**，但 DMG 把前端**压缩后嵌进了可执行文件**
> （`frontendDist: "../app"`，二进制只有 10.9 MB，装不下解压后的 24 MB），
> 所以没法事后从 DMG 里把 JS 抠出来逐字节核对。
> 能确认的是：`build-mac.sh` 先 `sync-app.mjs` 再编译，本次同步时间戳与
> 构建时间吻合，且 `desktop/app/js/` 下三个文件都带修复标记。
> 这条链是成立的，但它属于「按构建流程推断」，不是「从产物里验出来」。

---

## 离线保证，以及修掉的一个真缺陷

「离线版」不是打包时把模型塞进去就完了 —— 还得保证**用户点不出联网**。

2.0.0 早期版本这里有个洞：打包版只随包了 `whisper-large-v3-turbo`(q4) 一个模型，
设置界面却把 4 个档位和「云端」引擎全摆着，两者都没按 `packaged` 做 gate。

| 用户操作 | 后果 |
| --- | --- |
| 选 Tiny / Base / Small | `ensureOnce` 里 `useBundled = !!base && modelKey === 'large'` 为假 → `remoteHost` 设成 `hf-mirror.com`，联网拉 43~237 MB |
| 选「云端」引擎 | 音频交给 Web Speech API 上传解码（macOS 的 WKWebView 带这个 API） |

麻烦的地方在于，`AndroidManifest.xml` 里确实声明了 `INTERNET`，
而 `store/data-safety.md` 白纸黑字写着「App 自身不发起任何网络请求」——
**在这些路径下这句话是假的**。商店的数据安全问卷一旦被抽查到，属于声明失实。

默认值本身一直是安全的（`large` + `offline`），要踩中得手动改设置。
但既然写了那个承诺，就得让它成立。修法是三道闸，任一生效即可：

1. **界面层**（`app.js` §18b）：打包版把 `#setModel` 的非 large 选项 remove、
   整个 select `disabled`，把 `#engineSeg` 里的「云端」按钮 remove。不给可选项。
2. **偏好层**（`loadPrefs`）：打包版一律 `whisperModel='large'`、`engine='offline'`。
   不再迁就旧偏好 —— 旧版存过 base/cloud 的用户升级后被纠正回来，这是有意的。
3. **加载层**（`loadOfflineModel`）：`ensureModel({ model: packaged ? 'large' : ... })`。
   防旧缓存、手改 localStorage、其它入口调用。

**怎么验的**：headless Chrome `--dump-dom`，给 `index.html` 注入伪 `window.__TAURI__`
让 `packaged` 为真，与未改动的 `index.html` 作对照：

| | 模型下拉选项 | 云端按钮 | select |
| --- | --- | --- | --- |
| 浏览器版（对照） | tiny / base / small / large | 存在 | 可选 |
| 打包版 | **large** | **已移除** | `disabled` |

对照通过很重要 —— 说明浏览器版没被误伤，那条路径本来就该能联网。

> **重新构建后的验证**（2026-09-15）：
> APK 可以直接验到底 —— 用 7z 把 `assets/web/js/app.js` 解出来，
> 其 SHA-256 与仓库源文件**完全相同**（`972c84a0…`），三处标记都在。
> DMG 做不到这一步：Tauri 把前端**压缩后嵌进二进制**（10.9 MB 的二进制
> 装不下 24 MB 前端），抠不出来逐字节比对。能确认的是
> `build-mac.sh` 先 `sync-app.mjs` 再编译，且新旧二进制哈希不同
> （旧 `13058112…` → 新 `fb9d8cce…`），说明改动确实被编译进去了。
> 顺带一个交叉印证：Tauri 嵌进 DMG 的那份 `app.js`（`972c84a0…`）
> 与从 APK 里解出的那份**是同一个文件**。
>
> Windows 的 `.exe` 与 DMG 同理（前端也在 Tauri 二进制里），所以改用
> 「拆出主程序对比」：从新旧两个安装包里各解出 `voicetype.exe`，
> 旧 `11140096` 字节 / 新 `11141120` 字节，哈希不同 —— 说明改动进去了。
> 三个包里的模型哈希都仍是官方值（`7e64b20d…` / `8b933ac2…`）。

---

## 这次新增 / 改动的东西

| | 说明 |
| --- | --- |
| **改名** | 中文名统一为 **音转文**。包名 / Bundle ID 保持 ASCII（`com.voicetype.app`），因为上架时商店不允许中文标识符 |
| **保存为 TXT / HTML** | 导出菜单新增 `.html`，与 `.txt` 并列。HTML 是自包含单文件（样式内联），双击就能在任意浏览器打开 |
| **三端原生落盘** | 桌面/iOS 走原生「另存为」对话框；Android 走 `@JavascriptInterface` 桥写进「下载/音转文」；纯浏览器走 blob 下载 |
| **真正离线** | 内置推理运行时（37.8 MB）+ 内置模型（726 MB），运行时不碰任何 CDN。模型用 q4 量化，**没有 WebGPU 的机器也能跑** |
| **安卓架构重写** | 去掉 TWA（它需要联网），改为内置 WebView + 本机虚拟 https 源 |

---

## 目录结构

```
voicetype/
├── index.html                 # 页面
├── css/  js/  icons/          # 样式 / 逻辑 / 图标
├── manifest.webmanifest       # PWA 清单
├── sw.js                      # Service Worker（仅纯浏览器场景注册）
│
├── models/                    # 内置模型（726 MB，git 忽略）
│   └── whisper-large-v3-turbo/
├── vendor/                    # 内置推理运行时（37.8 MB，git 忽略）
│   ├── transformers.js
│   └── ort/*.wasm
│
├── fetch-models.sh            # 下载模型（多连接 + SHA-256 校验）
├── tools/
│   ├── build-vendor.mjs       # 打包离线推理运行时
│   └── parallel-download.py   # 多连接分片下载器
│
├── android/                   # 安卓工程
│   ├── build-apk.sh           # 一键打包
│   └── scripts/sync-assets.mjs# 把网页资源同步进 assets/web/
│
├── desktop/                   # 桌面 + iOS 工程（Tauri 2）
│   ├── build-mac.sh           # macOS 打包
│   ├── build-windows.ps1      # Windows 打包（UTF-8 BOM，中文不乱码）
│   └── scripts/
│       ├── sync-app.mjs       # 同步前端资源
│       └── patch-ios.sh       # 修补 iOS Info.plist（麦克风权限等）
│
├── .github/workflows/
│   └── build-ios.yml          # iOS 云端构建
│
├── build-site.sh              # 打网页版发布目录
├── build-release.py           # 汇总产物到 release/
└── release/                   # 所有交付物
```

---

## 从零构建

### 0. 准备模型与运行时（三端共用，只需做一次）

```bash
# 726 MB 模型。多连接下载，约 12 分钟；中断了重跑会续传。
# 下完会逐个校验 SHA-256（期望值取自 HuggingFace 的 LFS oid）。
./fetch-models.sh

# 37.8 MB 离线推理运行时
cd tools && npm install && node build-vendor.mjs && cd ..
```

### 1. Android（本机）

```bash
cd android && ./build-apk.sh
```

脚本会依次：同步资源进 `assets/web/` → Gradle 打包 → 校验签名 → 抽查包内关键资源。
产物：`release/音转文-2.0.0.apk`

### 2. macOS（本机）

```bash
cd desktop && ./build-mac.sh              # 当前架构
cd desktop && ./build-mac.sh --universal  # Intel + Apple Silicon 通用包
```

产物：`release/音转文-2.0.0.dmg`

### 3. Windows（在你的 Windows 机器上）

把整个 `voicetype/` 目录拷过去（或者 clone 仓库），然后：

```powershell
cd desktop
powershell -ExecutionPolicy Bypass -File .\build-windows.ps1
```

脚本会先检查 Node / Rust / MSVC 三样东西齐不齐，缺哪样会明确告诉你怎么装。
产物（文件名由 Tauri 按版本+架构生成，注意是下划线不是连字符）：
`release\音转文_2.0.0_x64-setup.exe` 和 `release\音转文_2.0.0_x64_zh-CN.msi`

> 脚本存的是 **UTF-8 with BOM + CRLF**。这不是洁癖：
> Windows PowerShell 5.1 读没有 BOM 的 UTF-8 脚本时，会把中文当成本地代码页解析，
> 输出全变乱码，甚至因为引号配对错位而直接语法报错。改这个文件时请保持 BOM。

> **这条脚本从来没在 Windows 上真跑过**（作者手上没有 Windows 机器），
> 只做过静态审查。审查时抓出并修掉一个 bug：根目录写成了
> `Join-Path $PSScriptRoot '..\..'`（上两级 → 指到 `voicetype` 的父目录），
> 应为 `'..'`（上一级 → `voicetype`）。写错的表现是第一步就报
> 「缺少离线推理运行时」并让你去跑 `build-vendor.mjs` —— 文件其实一直都在。
> 其余部分（依赖检查、`nsis`/`msi` 打包目标、模型体积校验）核对过配置，
> 但仍请做好「第一次跑可能还要调」的心理准备。

### 4. iOS（云端）

推一个 GitHub 仓库，配好 Secrets，然后在 Actions 里手动触发。

```
Settings → Secrets and variables → Actions 需要这些：
  APPLE_CERTIFICATE            Apple Distribution 证书 .p12 的 base64
  APPLE_CERTIFICATE_PASSWORD   导出 .p12 时的密码
  APPLE_SIGNING_IDENTITY       "Apple Distribution: 你的名字 (TEAMID)"
  APPLE_ID                     你的 Apple ID
  APPLE_PASSWORD               App 专用密码（不是登录密码）
  APPLE_TEAM_ID                10 位团队 ID
```

生成 base64 证书：`base64 -i Certificates.p12 | pbcopy`

不配 Secrets 也能跑，只是产出未签名的包（装不到真机上，只能验证能编译通过）。

---

## 上架准备：四个渠道，四种要求

这一节很重要，**四个渠道的要求差别很大**，有两个会卡住当前这个包。

### 酷安 ✅ 可直接上传

接受直传 APK，没有体积上限问题。760 MB 的包可以直接发。

### Google Play ⚠️ 需要改打包方式

**当前这个 APK 传不上去。** 先说清楚两套上限，很容易搞混：

| 发布方式 | 上限 |
| --- | --- |
| **仍用 APK** 发布（旧式） | 单个 APK **100 MB** |
| 改用 AAB：**base module** | **200 MB** |
| 改用 AAB：**单个 asset pack** | **1.5 GB** |
| 改用 AAB：模块 + install-time 资产包累计 | 4 GB |

（以上均为 Play Console 计算的**压缩后下载体积**，不是文件原始大小。）

我们是 760 MB，走哪条都超 —— 但换成 AAB + 资产包就宽裕了：**模型 726 MiB
远低于单个 asset pack 的 1.5 GB**，只要把它从 base module 里挪出去即可。

要上 Play 有两条路：

1. **Play Asset Delivery（推荐）** —— 模型拆成 `install-time` 资产包。

   - `settings.gradle` 里加一个 `:models` 资产包模块，
     `build.gradle` 用 `com.android.asset-pack` 插件，
     `assetPack { packType = "install-time" }`
   - 把 `models/` 整个挪进该模块的 `src/main/assets/`
   - base module 加 `assetPacks = [":models"]`
   - **运行时要改**：模型现在是通过 WebView 的
     `https://appassets.androidplatform.net/assets/web/models/…` 加载的，
     挪走后这个 URL 会 404。要么让 WebView 的资源加载器额外映射资产包目录，
     要么加一个桥把资产包的真实路径告诉 JS
     （`AssetPackManager.getPackLocation()`）。
   - 用 `bundletool build-apks` + `install-apks` 可以在模拟器/真机上真跑一遍验证，
     不需要先传 Play Console。

   工作量约半天，主要成本在上面第 4 步。
2. **首次启动时下载模型** —— 安装包回到 5 MB，模型改成进 App 后下载。
   代价：不再是"装完就能断网用"。

> 另外：Play 要求 targetSdk 跟到最新（本项目已用 36），
> 以及必须有隐私政策链接。本 App 不收集任何数据，隐私政策写起来很简单。

### Apple App Store ⚠️ 需要付费账号

- 必须有 **Apple Developer Program**（99 美元/年）。个人开发者账号即可。
- `.ipa` 只能在 macOS 上打（或用本项目提供的 GitHub Actions 流程）。
- 需要在 App Store Connect 里建 App，填隐私标签（本 App 选「不收集数据」）。
- **审核注意**：App 必须能在无网络下完成核心功能（我们做到了），
  麦克风用途说明必须写清楚（`patch-ios.sh` 已自动写入中文说明）。
- 审核可能要求提供演示账号 —— 本 App 没有账号体系，在备注里说明即可。
- **体积要提前说明**：`.ipa` 约 740 MB，远超 App Store 的
  **200 MB 蜂窝下载阈值**（用户可在「设置 → App Store → 蜂窝数据」里放开，
  但默认是拦的）。这不影响上架，但建议在 App 描述里写一句
  「首次安装需在 Wi-Fi 下进行」，否则容易收到一星差评。

### Microsoft Store ⚠️ 需要 EV 代码签名证书

- 提交 `.msi` 或 `.exe`。注册 Microsoft Partner Center 开发者账号
  （个人 19 美元一次性，公司 99 美元一次性）。
- **需要 EV 代码签名证书**（约 300–500 美元/年）才能提交桌面应用。
  这是四端里成本最高的一项。
- 如果不打算上商店，直接把 `.exe` 给用户也行，只是首次运行会有
  SmartScreen 警告（点「更多信息」→「仍要运行」即可）。

---

## 已知限制

1. **APK 已在模拟器上验证，但没有在真机上验证过。**
   上一版的「一打开就闪退」是反编译定位并修掉的；这一版重写了整个安卓入口，
   并已在模拟器上完整跑通（安装 / 启动 / 渲染 / 断网载入模型，见「运行验证」一节）。
   仍未验证的是**麦克风采集**——模拟器没有音频输入，这一环必须拿真机试。
   另外 **Android 9 及以下**的落盘分支（`saveViaLegacyDownloads`，用公共
   「下载」目录 + `WRITE_EXTERNAL_STORAGE`）在 API 36 模拟器上跑不到，
   只做过静态审查 + 权限申请链路核对，没有真机验过。
2. **内存需求：建议 4 GB 以上。** 726 MB 的模型加上 onnxruntime 的 WASM 堆，
   峰值需要 2.5 GB 以上。实测在 4 GB 的模拟器上模型载入失败，
   换 8 GB 立刻正常。低内存机型（或后台驻留程序很多时）可能出现
   「模型加载失败」，这是资源不足而非程序缺陷。
3. **识别速度取决于后端，差距很大（实测）。**
   同一台 10 核机器、同一段 19.9 秒音频、同一个内置 q4 模型：

   | 后端 | 耗时 | RTF¹ | 说明 |
   | --- | --- | --- | --- |
   | WebGPU | 2.72 s | **0.14** | 比实时快约 7 倍 |
   | WASM（CPU，多线程） | 21.5 s | **1.08** | 比实时略慢 |
   | WASM（CPU，单线程） | 77.7 s | **3.90** | 比实时慢约 4 倍 |

   ¹ RTF = 推理耗时 ÷ 音频时长，小于 1 表示比实时快。

   **CPU 路径快不快，取决于页面有没有拿到「跨源隔离」。**
   `SharedArrayBuffer` 只在跨源隔离下开放，没有它 ORT 只能单线程跑，
   10 核用 1 核 —— 一小时的录音要等四小时，用户会以为程序死了。
   所以四个平台都补上了 `COOP: same-origin` + `COEP: require-corp`：

   | 平台 | 做法 |
   | --- | --- |
   | macOS / Windows / iOS | **页面本身由 `http://127.0.0.1:<随机端口>` 提供**，由这个本地服务发头（见坑⑥） |
   | Android | `MainActivity` 的 `shouldInterceptRequest` 里给响应加头（**实测无效，见下**） |
   | 网页版 / PWA | 部署时由服务器加（托管环境要自己配，代码里配不了） |

   ⚠️ **Android 上这条路走不通，目前是单线程。**
   `shouldInterceptRequest` 里加的 `COOP`/`COEP` 确实发出去了
   （页面里 `fetch(location.href)` 能把它们读回来），
   但 CDP 抓到的 **Document 响应里完全没有这两个头**，`crossOriginIsolated` 恒为 `false`。

   为了排除「是我们的拦截机制有问题」，用**真实公共站点**做了对照实验：
   在同一个 WebView 里打开 `https://vscode.dev/`（证书有效、且它自己就带完整的 COOP+COEP），
   结果同样是 `crossOriginIsolated: false`、`SharedArrayBuffer` 不存在。
   所以这是 **WebView 自身的限制**，不是配置问题。
   WebView 提供方也已核实是完整版 `com.google.android.webview 133.0.6943.137`（非 stub）。

   > 想走 `adb root` + 装系统 CA 去排除证书干扰也不行：
   > `adb remount` 报 `Device must be bootloader unlocked`，`/system` 只读。

   代价就是安卓端只能单线程 WASM（RTF 约 3.9，比多线程慢 3.6 倍）。
   这一点目前**没有绕过办法**，属于已知限制。

   ⚠️ 光在 `tauri.conf.json` 里写 `app.security.headers` **不管用**。
   实测那两个头确实发出去了（在应用里 `fetch(location.href)` 能把它们读回来），
   但 **WKWebView 对自定义协议不认这两个头**，`crossOriginIsolated` 依然是 `false`。
   真正解决问题的是把页面换到环回地址上（见坑⑥）。

   （这两个头不会挡掉联网下载模型：`fetch` 走的是 CORS 模式，
   而 CORS 模式的请求按规范不受 COEP 约束，只需要服务器给 CORS 头。）

   实测确认 **macOS 15 的 WKWebView 没有 WebGPU**（Safari 要到 26 才默认开启），
   所以在这台 Mac 上 DMG 版走的是 CPU 路径 —— 但有了多线程，
   从「1 分钟录音要等 4 分钟」变成「1 分钟录音等 1 分钟出头」，可以接受了。

   线程数上限定在 4：实测 4 线程 21.5 秒、8 线程 21.4 秒，**再加线程没有收益** ——
   q4 权重 726 MB，推理时要把权重整个流式过一遍内存，瓶颈在内存带宽而不是算力。
   既然 4 就够，就留出核心给录音和界面（否则录进来的音频会丢帧）。
   想手动限制可以在控制台执行 `localStorage.setItem('yzw-threads','2')`。

   另外低端安卓机上 726 MB 模型加载阶段吃内存（已开 `largeHeap`）。
3. **iOS 的麦克风授权行为未在真机验证。** WKWebView 的 `getUserMedia`
   在 iOS 上依赖系统权限弹窗，`Info.plist` 里的用途说明已由脚本写入，
   但实际弹窗行为需要在真机上确认。
4. **识别质量数据来自 5 段 TTS 合成的短音频**，不是真人多场景语料。
5. **未签名 / 未公证**：macOS 首次打开会被 Gatekeeper 拦（右键 → 打开可绕过），
   Windows 会有 SmartScreen 警告。消除这两步需要花钱买证书。
6. **macOS 首次录音会弹一次系统麦克风授权，需要点「允许」。**
   这一步在自动化环境里点不了（辅助功能权限不在手上），所以「点完之后能拿到音轨」
   这一格没有在真机点过。**其余环节都已实测通过**：`navigator.mediaDevices` 存在、
   包内 `Info.plist` 带 `NSMicrophoneUsageDescription`、请求时进程不崩、
   页面回报 `perm=prompt` 且能枚举到 1 个输入设备（label 为空，正是未授权的特征）。
   WebKit 那一层的采集授权不用管：wry 的 UI delegate 直接返回 `WKPermissionDecision::Grant`。
   换句话说，链路是通的，只差用户点一下。
7. **不存在的路径会返回 `index.html` 而不是 404。**
   这是 Tauri 资产解析器的兜底行为（先试 `{path}.html`，再试 `{path}/index.html`，
   最后回 `index.html`），对单页应用是合理的。副作用是：如果模型文件缺失，
   `fetch` 会拿到 200 + HTML，onnxruntime 会把 HTML 当模型解析并报一个指不到原因的错。
   排查「离线模型好像没生效」时，记得先确认文件真的在包里
   （`build-mac.sh` 的挂载校验会替你把这一关）。
   顺带说明：已实测多种 `../` 穿越写法（含 `%2e%2e`、`..%2f`）都拿不到系统文件，
   返回的始终是应用自己的 `index.html`。

---

## 为什么选这个技术路线

| 方案 | 安装包 | 四端 | 结论 |
| --- | --- | --- | --- |
| Electron + React Native | 150 MB+ / 两套代码 | 要维护两份 | ❌ |
| Tauri + Flutter | 约 15 MB | 两套代码 | ⚠️ 可维护性差 |
| **Web 前端 + 各平台原生壳** | 一份前端代码 | 一套逻辑 | ✅ **本项目** |

前端是纯 HTML/CSS/JS，四个平台各自套一层最薄的壳：

- **Android**：WebView + 本机虚拟 https 源（`appassets.androidplatform.net`）
- **macOS / Windows / iOS**：Tauri 2（复用系统自带 WebView，不塞 Chromium）
- **纯浏览器**：直接当 PWA 用，双击单文件 HTML 也能跑

这样界面和逻辑只有一份，改一处四端同时生效。

### 几个值得记下来的技术坑

**① 安卓不能直接用 `file:///android_asset/`。**
浏览器的 `getUserMedia`（录音）只在「安全上下文」里可用，`file://` 不算。
所以要用 `WebViewAssetLoader` 或自建拦截器造一个 `https://` 虚拟源。
但 `WebViewAssetLoader` 自带的 `AssetsPathHandler` 用 `MimeTypeMap` 猜类型，
**安卓的映射表里没有 `.mjs`** —— 返回 null 就不写 `Content-Type`，
WebView 随即拒绝执行 ES module（报 "MIME type of ''"）。
离线引擎正是靠 `import()` 加载 `vendor/ort/*.mjs` 的，踩上这个坑就是白屏且无报错。
本项目自己实现了资源拦截器，把 `.mjs` / `.wasm` / `.onnx` 的 MIME 钉死。

**② 桌面端 726 MB 的模型不能放进 `frontendDist`。**
Tauri 会把 `frontendDist` 整个嵌进可执行文件，726 MB 进去就得到一个
726 MB 的 Mach-O / PE。而且 Tauri 的自定义协议响应体是一次性缓冲的
（`http::Response<Vec<u8>>`），405 MB 的编码器会被整个读进内存。
本项目改为：模型走 `bundle.resources` 放到应用资源目录，
由 `lib.rs` 里一个只监听 `127.0.0.1` 的流式 HTTP 服务按需喂给页面（支持 Range）。

**③ 不要用 `npx tauri build --bundles dmg`，直接调 `hdiutil`。**
Tauri 内置的 `bundle_dmg.sh` 是从 create-dmg 抄来的，里面有 GNU grep 的写法；
macOS 自带的是 BSD grep，跑到那里会报
`grep: bad regex '/dev/disk8s': brackets ([ ]) not balanced`，
然后丢一句没头没尾的 `error running bundle_dmg.sh` 就放弃 ——
而此时它已经把临时映像挂上了，还会留下一个没卸载的 `/Volumes/dmg.XXXXXX`。
`build-mac.sh` 现在改用系统自带的 `hdiutil` 造 DMG，并在结尾实际挂载校验一次。

**④ 替换量化格式时，一定要有「反向校验」。**
把内置模型从 q4f16 换成 q4 时，旧的 537 MB 文件不会自己消失：
同步脚本只做增量覆盖，从不管多余的文件。结果就是包里同时躺着两套模型。
现在同步脚本和打包脚本都会断言「不该有的确实不在」。

**⑤ 默认档位必须跟着「随包模型」走，不能跟着「设备能力」走。**
内置的 large 从 q4f16 换成 q4 之后，CPU 也能跑了，但默认值的逻辑没跟着改：
`whisperModel: ('gpu' in navigator) ? 'large' : 'base'` ——
没有 WebGPU 的设备会默认选 **base，而 base 并没有随包**。
用户装完第一次录音就去联网下 78MB；国内网络下这一步大概率直接失败，
表现出来的就是「离线版一装就是坏的」。
同理 macOS 的 WKWebView 带 Web Speech API，默认引擎会落到 `cloud`，一样要联网。
现在打包版一律默认 `large` + `offline`（用 `packaged` 判定），
并用 `PREFS_VERSION` 把老版本存下来的错误默认值迁一次。
教训：**默认值是有语义的** —— 改了模型、量化格式或打包方式，
就要回头把所有依赖它的默认值检查一遍。这类 bug 不会报错，只会让产品悄悄失效。

**⑥ `tauri://localhost` 在 macOS 上不是「安全上下文」—— 一个原因坏三件事。**
Tauri 在 macOS 上默认用 `tauri://localhost` 提供页面。但 WKWebView 不把自定义协议
当成 potentially trustworthy，哪怕主机名写的是 localhost。在构建出的 app 里回传实测：

```
origin = tauri://localhost
navigator.mediaDevices   →  undefined
self.crossOriginIsolated →  false
```

于是三件事同时坏掉，而且**都不报错**：

- 录不了音 —— `navigator.mediaDevices` 根本不存在（这是个录音软件）
- COOP/COEP 不生效 → 拿不到 `SharedArrayBuffer` → ORT 只能单线程，慢 3.6 倍
- 其余依赖安全上下文的 API 一律不可用

改法：**页面也由本地服务提供**，窗口指向 `http://127.0.0.1:<随机端口>/index.html`。
环回地址按 Secure Contexts 规范属于 potentially trustworthy，是安全上下文，
而且 http 是标准协议，WebKit 会正常处理 COOP/COEP。一处改动，三个问题一起消失。
改完实测 `isolated=true / sab=true / hasMedia=true`。

这条同时解释了上一节那句「在 conf 里写 `app.security.headers` 没用」：
头确实发出去了，是 WebKit 不认。

**⑦ 页面变成「远程来源」之后，连应用自己的命令也要过 ACL。**
这是上一条的代价，也是最容易漏的一步。Tauri 那道闸是
`if (plugin_command.is_some() || has_app_acl_manifest || !is_local) && acl.is_none() { 拒 }`，
注意中间的 `!is_local`。而 `is_local_url()` 只认 `tauri://` 协议和自己注册的自定义协议，
`http://127.0.0.1` 不在其中 —— 来源被判为 Remote，**应用命令一并纳入 ACL 检查**。
以前从 `tauri://localhost` 调自定义命令不用配权限，换了来源就得配。

而且**要配两处，缺一不可**：

| 文件 | 回答的问题 |
| --- | --- |
| `capabilities/default.json` 的 `remote.urls` | 哪个来源可以拿到这套权限 |
| `permissions/voice-type.toml` | 这些命令本身可不可以被授予 |

实测只写前者仍然报 `Command model_base_url not allowed by ACL` ——
因为那时应用清单是空的，`allowed_commands` 里压根没有这两个命令名。
应用命令的标识符**不带插件名前缀**（写 `allow-model-base-url`，不是 `app:allow-...`）。
写错不会静默失败：`tauri-build` 会在构建期报 permission not found。

**⑧ 自己提供页面，就得自己转发 CSP。**
Tauri 会在构建期把 `app.security.csp` 处理成「这一份文档专用」的 CSP
（页面里内联脚本/样式的 sha256 是那时候算好注入的），结果放在 `Asset.csp_header` 里。
以前是 Tauri 的协议处理器负责把它挂到响应上；页面改由本地服务提供之后，这活就归我们了。
漏掉的后果是 **CSP 静默失效**：页面照常跑、不报任何错，只是再没有脚本来源限制。
自检方式：让页面动态插一个内联 `<script>`，本该被 CSP 挡掉。
修好之后同一探针回报 `inlineRan=false`，并且响应头里能看到 Tauri 注入的三个 sha256。

**⑨ 在 macOS 上，`Info.plist` 少了麦克风用途说明会被系统直接杀掉进程。**
这不是「弹窗拒绝」，是崩溃 —— 日志里只有一句
`attempted to access privacy-sensitive data without a usage description`。
Tauri 会自动合并与 `tauri.conf.json` 同目录的 `Info.plist`
（见 `src-tauri/Info.plist`），加一个 `NSMicrophoneUsageDescription` 即可。
实测构建出的包里原本**一个 Usage 键都没有**。

顺带一个好消息：**WebKit 这一层的采集授权不用自己实现**。
wry 的 `wry_web_view_ui_delegate.rs` 里
`webView:requestMediaCapturePermissionForOrigin:...` 直接返回
`WKPermissionDecision::Grant`。所以剩下唯一的门槛就是 macOS 的 TCC 系统弹窗，
第一次录音时点一次「允许」即可。

**⑩ 换成环回地址之后，Apple 平台还要放行 ATS。**
页面从 `http://127.0.0.1:<随机端口>` 加载，而 App Transport Security
从 **iOS 17 / iPadOS 17 / macOS 14 起不再默认放行 IP 地址**。Apple 文档原文：

> In iOS 17, iPadOS 17, and macOS 14, ATS no longer allows connections to
> IP addresses by default.

同一页也说明 `NSAllowsLocalNetworking` 的作用正是
「enable access to unqualified domains, `.local` domains, and IP addresses」。
所以两个平台都要声明：

```xml
<key>NSAppTransportSecurity</key>
<dict><key>NSAllowsLocalNetworking</key><true/></dict>
```

macOS 写在 `src-tauri/Info.plist`（Tauri 自动合并进 .app），
iOS 由 `desktop/scripts/patch-ios.sh` 写入。
用 `NSAllowsLocalNetworking` 而**不是** `NSAllowsArbitraryLoads` ——
后者是完全绕过 ATS，范围过大、审核时更容易被追问；前者只放开本机 / 局域网，
正好对应「App 自己起的本地服务」这个用法。
Apple 还专门建议：即使不打算兼容老系统，也把 `NSAllowsLocalNetworking` 设成 `YES`
当作一种「声明意图」。

> 这条对 iOS 尤其要紧：iOS 用的是同一套 WKWebView，也就同样存在
> `tauri://localhost` 不是安全上下文的问题（坑⑥），所以 iOS 也必须走环回地址，
> 于是也必须放行 ATS。漏掉这一项的表现是 **iOS 17+ 上页面直接加载不出来**。

**⑪ 自己写静态服务，几百 MB 的文件必须流式发，HEAD 还要回真实长度。**

这条是自查时抓出来的。原来的实现是：

```rust
// 老代码：先整个读进内存，再写出去
match fs::read(path) { Ok(buf) => respond(stream, "200 OK", &ct, &buf), ... }
```

两个毛病：

1. **无 Range 的 GET 会先把整个文件读进内存。** encoder 是 424 MB，
   于是先占 424 MB 堆，再和 onnxruntime 自己的 WASM 堆叠加。
   macOS 上勉强能忍，iOS 上这种瞬时翻倍很容易被 jetsam 直接杀掉。
2. **HEAD 报 `Content-Length: 0`。** 因为 `respond()` 是从 `body.len()` 推长度的，
   而 HEAD 传的是空体。语义上 HEAD 的头部必须和 GET 完全一致，
   回 0 会让做预检的客户端把 424 MB 的模型当成空文件。

改法是把响应头单独拆出来（`write_head` 显式接 `content_length`），三条分支都流式：
Range 走 `File::take(len)`，HEAD 只回头，GET 走 `io::copy`。
实测改前 HEAD 返回 `0 字节`、改后返回 `424942775 字节`；
三种请求（Range / 全量 GET / HEAD）的字节数都与磁盘实际大小逐字节吻合。

> 顺带一提，Range 也可能是 `bytes=0-` 这种「整份文件」——
> 所以 Range 分支同样不能 `vec![0u8; len]`，不然等于换了个地方重演同一个问题。

**⑫ `desktop/app/` 是构建产物，改前端要改仓库根。**

`desktop/scripts/sync-app.mjs` 的方向是
**`voicetype/`（仓库根）→ `voicetype/desktop/app/`**。
所以 `desktop/app/js/app.js` 是拷出来的，直接改它会在下次构建时被静默覆盖
（覆盖完内容和原来一样，什么错都不报，只是你的改动没了）。

前端源码在 **`voicetype/js/`**、**`voicetype/css/`**、**`voicetype/index.html`**。

> 一个容易误判的地方：`android/app/src/main/assets/web/` 里的文件与
> `voicetype/js/` 下的**是同一个 inode**（硬链接），所以改源文件后
> Android 那边看起来「自动更新了」；而 `desktop/app/` 是**真拷贝**，不会。
> 两个平台同步机制不同，别按 Android 的行为去推断桌面端。

**⑬ `android:allowBackup` 默认是 `true`，对「数据不出本机」的应用是个洞。**

模板生成的清单里这一项是 `true`，很容易一直没人动。开着它的后果是
Android 的自动备份会把应用数据同步到用户的云端网盘 ——
而 **WebView 的 localStorage（转录历史、偏好设置就存在那里）属于应用数据**。

对一个卖点就是「完全离线、数据不出本机」的应用来说这是自相矛盾的：
用户以为文本只在自己手机里，实际已经被传出去了。
上 Google Play 时，「数据安全」表单也填不成「不收集」。

已改成 `android:allowBackup="false"`（`app/src/main/AndroidManifest.xml`）。
顺带也避免一类怪问题：换机恢复时把旧版本的 WebView 数据灌进新版本，
历史记录和设置可能对不上。

**⑭ 安卓虚拟源的 HTTP 缓存会跨版本命中，让用户跑着旧代码。**

这一条是真机验证时踩到的，也是最容易被误诊的一条。

原先给页面/脚本/wasm 发的是 `Cache-Control: public, max-age=86400`（想「重启后秒开」），
只有 `.onnx` 走 `no-store`。问题在于 **WebView 的 HTTP 缓存是按 URL 存的，
而虚拟源 `appassets.androidplatform.net` 在版本之间是不变的** ——
于是覆盖安装新版本之后，WebView 会继续用缓存里的**旧 JS**，最长 24 小时。

实测就栽在这里：旧的 `whisper.js` 去要 `encoder_model_quantized.onnx`，
而新包里只有 `encoder_model_q4.onnx`，请求 404，表现是**离线模型完全加载不出来**。
`pm clear` 之后立刻正常 —— 所以一度被误判成「模拟器内存不够」。

现在所有响应一律 `no-store`。这些字节本来就在 APK 里，读它是本地操作、
不走网络，缓存省下的只是解压那几十毫秒；一旦发版，代价却是用户跑着旧代码。
（桌面端不受影响：Tauri 侧是 `TcpListener::bind(("127.0.0.1", 0))` 随机端口，
每次启动源地址都变，缓存天然不跨版本命中。）

**⑮ `stopRecording(silent)` 会把调用方刚设好的错误文案覆盖掉。**

`app.js` 里 `startOfflineRecording()` 失败时是这么收尾的：

```js
setStatus('麦克风启动失败', 'err');   // ① 先报错
stopRecording(true);                  // ② 紧接着静默停止
```

而 `stopRecording()` 无条件执行 `setStatus('正在处理最后一段…')`，
`finishStop(silent)` 又只在**非** silent 时才设状态 ——
两步叠加的结果是最终界面**永远停在「正在处理最后一段…」**，
计时器停在 `00:00`，用户完全看不出刚才失败了。

改法：silent 时不动状态文案（`if (!silent) setStatus(...)`），
把控制权留给调用方。这类「静默路径覆盖显式状态」的 bug 不会报错、
不会崩，只是把错误提示吃掉，很难从日志里看出来 ——
只有真的截图看界面才会发现。

**⑯ 让 MediaStore 自己处理重名，会把文件的 MIME 弄坏。**

`SaveBridge` 往「下载/音转文」写文件时，如果同名文件已存在，
系统不会覆盖、也不会报错，而是**自动改名**成
`音转文-20260915-1321.txt (1)` —— 序号加在了**扩展名之后**。
于是 MediaStore 按扩展名推 MIME 时推不出来，落库的是
`application/octet-stream`（同一批里没撞车的那份是 `text/plain`，
正是这个对照让我们确认了归因）。

后果比「图标难看」严重：在文件管理器里点它，系统找不到能打开的应用，
用户会以为导出的文件坏了。而触发条件并不罕见 ——
导出文件名只精确到分钟，同一分钟内导出两次就会撞上。

修法是自己先挑名字（序号放扩展名**前面**：`xxx(2).txt`），
写入后再回查一次真实名字，让提示里的路径和磁盘对得上。

> 顺带一个坑中坑：预检查询里比 `RELATIVE_PATH` 时，
> 传进去的是 `Download/音转文`（无结尾斜杠），
> 而 MediaStore 存的是 `Download/音转文/`（**有**斜杠）。
> 只按无斜杠比的话一次都匹配不上，预检静默失效 ——
> 现象很有迷惑性：提示已经能正确报出 `(1)` `(2)`，
> 看起来「修好了」，但 MIME 依旧是坏的。
> 判断预检到底有没有生效，要看 **MediaStore 里的 `mime_type` 列**，
> 不能只看文件名。

---

## 隐私

不收集任何数据。

- 音频只在内存里处理，不写盘、不上传
- 识别全部在本机完成（WebGPU / WASM）
- 历史记录存在浏览器 `localStorage` 里，清缓存即清空
- 导出的 TXT / HTML 只写到你自己选的位置
- 没有账号、没有统计、没有第三方 SDK

---

## 上架四端

`store/` 目录里按四端分别整理好了上架需要的全部资料，
README 的「构建入口」只管怎么打出产物，**这些是商店侧的事**：

- **`store/privacy-policy.html`** / **`store/privacy-policy-en.html`**
  隐私政策（中/英双版，单文件 HTML，可直接静态托管）。
  四家商店都要隐私政策 URL，这是绕不过去的。
- **`store/description.md`** 四端的应用名、描述、关键词、截图要求、字段长度。
  中文为主；App Store / 微软商店的英文部分有特别说明。
- **`store/data-safety.md`** Google Play Data Safety、App Store 营养标签、
  Microsoft / 酷安问卷的标准答案。所有问题都是「不收集」。
- **`store/GO-LIVE.md`** 端到端清单：从托管隐私政策 → 注册开发者账号 →
  上传产物 → 填资料 → 等审核。包含 iOS 仓库初始化与 6 个 Secrets 配置、
  Windows 跑 `build-windows.ps1` 的具体步骤、以及**Google Play 150 MB 限制
  与本应用 760 MB 体积之间的冲突**和应对方案（下一步要做的事）。

按 `GO-LIVE.md` 走完一遍即可上 4 家。

---

## 许可

仅供个人使用。
