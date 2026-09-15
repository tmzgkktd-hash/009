# 上架文案

四端共用，分语言版（中、英）列出。每个平台有字符限制的标在标题下。
带 `[填]` 标记的是**留给发布者替换**的占位。

---

## 应用名

- **中文（主名）**：音转文
- **英文（副名 / iOS 副标题位）**：VoiceType
- **包名 / Bundle ID**：
  - iOS / macOS：`com.voicetype.desktop`
  - Android：`com.voicetype.app`
  - Windows：Tauri 默认（`com.voicetype.desktop`），商店发布会要求新登记

## 开发者名 [填]

- Google Play / Microsoft / 酷安：填与商店账号一致的法律实体或个人姓名
- App Store Connect：填 Apple Developer Account 上的「Seller / Company Name」

## 类别

- **主类**：效率 / Productivity
- **副类**（如适用）：工具 / Utilities
- **内容分级**（Google Play）：所有人（PEGI 无 / IARC 无）

---

## Google Play

### 简短描述（≤80 字符）

> 离线语音转文字，726MB 模型内置，文字全程不出本机。

### 完整描述（≤4000 字符）

```
音转文是一款完全离线的中文语音转文字工具。
识别引擎（whisper-large-v3-turbo）与离线推理运行时都打包在安装包里，
无需联网、不会上传音频和文字。

【核心特性】
• 完全离线：首次打开后断网照常工作
• 中文优化：内置多语言识别模型，中文准确度业界领先
• 大模型内置：726 MB whisper-large-v3-turbo（q4 量化），手机也能跑
• 多种导出：转录结果一键保存为 txt / html / md / srt / vtt / json
• 隐私优先：所有数据只存在本机 localStorage，删除 App 即清除
• 无账号、无广告、无追踪

【为什么离线】
云端识别意味着把您说的话传给别人。对会议、采访、灵感记录这类私密场景，
这不是大家愿意承担的代价。音转文把这件事搬到本机——模型在你口袋里，
音频不出你手机。

【使用场景】
• 会议记录 / 课堂笔记 / 采访整理
• 视频配音脚本撰写
• 想到什么说什么，事后整理文字
• 不方便打字的场景

【技术细节】
• 识别引擎：whisper-large-v3-turbo（int4 量化）
• 运行时：onnxruntime + transformers.js（WebAssembly）
• 支持系统：Android 9.0 及以上（推荐 8GB 内存及以上机型）
• 安装包体积：约 760 MB（含模型）

【权限说明】
• 麦克风：仅在您按下录音按钮时使用，识别完成即释放
• 本地存储（Android 9 及以下）：仅在您主动保存导出文件时使用一次
• 我们没有任何可选权限，没有追踪、没有分析

【隐私承诺】
不收集任何数据，不上传任何内容，不接入任何第三方服务。
```

### 截图要求

- 至少 2 张，推荐 4–8 张
- 尺寸：手机 1080×1920 起（横竖比 9:16 / 2:1 / 16:9 都可）
- 横屏 1920×1080 也可
- 现有 `screenshots/preview-mobile.png` 等可直接用

### 资源

- 应用图标：`icons/icon-512.png`（Play 要求 512×512，32-bit PNG，无透明度）
- 特性图形：1024×500（用于 Play 商店顶部横幅，**需要单独做**，本仓库没有）

---

## App Store

### 副标题（≤30 字符）

> 离线语音转文字

### 宣传文本（Promotional Text，≤170 字符，可随时更新）

> 完全离线的中文语音转文字工具。726MB 模型内置在你的设备里，音频和文字都
> 不出本机。

### 关键词（≤100 字符，用逗号分隔，无空格）

> 语音转文字,转写,录音,会议记录,离线,中文,whisper

### 描述（≤4000 字符）

同 Google Play 的完整描述（中文版即可）。

### What's New（本次更新文案）

```
2.0.0 · 完全离线版
• 内置 whisper-large-v3-turbo（q4 量化，726 MB），无需联网即可识别
• 新增导出 txt / html / md / srt / vtt / json 六种格式
• 中文 App 名称「音转文」
• 重写桌面与安卓入口，体积、启动速度、准确率全面优化
```

### 截图要求

- iPhone 6.7"（iPhone 14 Pro Max 起）：1290×2796
- iPhone 6.5"（iPhone 11 Pro Max 起）：1242×2688（**现有截图分辨率可能不够**，需要用
  Xcode 模拟器重新截、或用 macOS 自带的 `screencapture` 截高分屏）
- iPad：可选，2048×2732

### App Privacy（营养标签问卷答案）

见 `data-safety.md`。

---

## Microsoft Store

### 简短描述（≤1000 字符）

> 离线语音转文字工具。内置 726 MB whisper 模型，断网照常工作，
> 音频和文字不出本机。中英文皆可识别，导出 txt / html。

### 完整描述

同 Google Play。

### 截图要求

- 尺寸：1366×768 起（16:9），推荐 1920×1080 或更高
- 现有 `screenshots/preview-desktop.png` 可直接用

### 资源

- Store Logo：300×300 PNG，`icons/icon-300.png`（**需要从 512 缩放生成**）
- 方形图标：`icons/icon-256.png`（同上）

---

## 酷安（Coolapk）

酷安商店字段简单：

### 应用名

> 音转文

### 简介（≤200 字）

> 完全离线的中文语音转文字工具。726MB 模型内置在你的手机里，无需联网。
> 录音只在本机处理，不上传。中英文皆可识别。
> 导出 txt / html / md / srt / vtt / json。

### 标签

> #语音转文字 #离线 #录音 #转写 #会议记录 #whisper #中文

### 截图

手机竖屏 1080×1920 起。现有 `screenshots/preview-mobile.png` 可用。

---

## 通用字段

### 支持网址（Support URL）[填]

需要一个公开可访问的 URL，常见做法：

- 留您个人主页 / GitHub 仓库地址
- 或建一个简单的静态页面（如 `support.html`，与 `privacy-policy.html` 同模板）

### 隐私政策 URL [必填]

`privacy-policy.html` 的实际托管地址，参考：

- GitHub Pages 启用后：`https://<user>.github.io/<repo>/privacy-policy.html`
- 或 Cloudflare Pages / Netlify / Vercel

### 版权声明（© 年份）

> © 2026 [您的名字 / 公司名]

### 营销 URL（可选）[填]

官网或 GitHub 仓库地址。