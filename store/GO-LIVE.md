# 上架四端 · 全流程清单

把仓库的 4 个产物对应到 4 个商店的完整流程。
每一步都能独立验证。带 `[填]` 的字段按需替换。

## 总览

| 商店 | 产物 | 在哪儿打 | 上传方式 | 预计审核时长 |
| --- | --- | --- | --- | --- |
| **Google Play** | `release/音转文-2.0.0.apk` | 已出 | Play Console 直接上传 | 1–3 天 |
| **App Store** | （需 .ipa） | GitHub Actions | App Store Connect | 1–2 天 |
| **Microsoft Store** | （需 .msi/.exe） | 你的 Windows 机器 | Partner Center | 1–3 天 |
| **酷安** | `release/音转文-2.0.0.apk` | 已出 | 酷安开发者后台 | 1–2 天 |

---

## 阶段 0：准备上传物料（所有商店都需要）

### 0.1 隐私政策 HTML

`store/privacy-policy.html`（中文）+ `store/privacy-policy-en.html`（英文）。

**必须**托管在一个公开可访问的 HTTPS 地址，常见选择：

- **GitHub Pages**：仓库根或 `docs/` 目录放 HTML 即可，URL 形如
  `https://<user>.github.io/<repo>/privacy-policy.html`
  - 注意：仓库默认分支名是 `main` 还是别的，要对应上
  - Pages 启用可能要等几分钟生效
- **Cloudflare Pages / Netlify / Vercel**：直接把 `store/privacy-policy.html` 拖上去就行
- **对象存储 + CDN**：阿里云 OSS / 腾讯云 COS 都可以，绑定自定义域名后挂证书

填进去之前**自己核一遍**：

- [ ] 两个文件都用浏览器打开过，没有控制台报错
- [ ] 切换深色模式外观正常
- [ ] 移动端宽度（375px）排版没破
- [ ] 没有外部 JS / CSS / 字体引用（部分商店政策要求）

### 0.2 应用描述、关键词、截图

`store/description.md` 里已经按四端列好了：每个商店的字段、字符限制、要替换的占位。

截图要求（**截图需要重做**，现有 `screenshots/` 是 1.1.0 旧版的）：

| 商店 | 手机端 | 桌面端 | 备注 |
| --- | --- | --- | --- |
| Play | 1080×1920 起 | — | 现有 `preview-mobile.png` 可作起点 |
| App Store | 1290×2796 起（6.7"） | — | **必须用 Xcode 模拟器重截** |
| MS Store | — | 1920×1080 起 | 现有 `preview-desktop.png` 可作起点 |
| 酷安 | 1080×1920 起 | — | 现有 `preview-mobile.png` 可用 |

### 0.3 数据安全问卷答案

`store/data-safety.md` 已经按四端分别整理好标准答案，**所有问题都是「No / 不收集」**。

---

## 阶段 1：Google Play 上架

### 1.1 注册 Google Play Console

[Google Play Console](https://play.google.com/console) 注册开发者账号（一次性 $25）。

### 1.2 创建应用

- 应用名称：音转文
- 默认语言：中文（简体）
- 应用或游戏：应用
- 免费 / 付费：免费（暂时）

### 1.3 商店设置

按 `description.md` 的「Google Play」段填：简短描述、完整描述、截图。

**隐私政策 URL**：填阶段 0.1 托管好的英文版本
（`privacy-policy-en.html`，英文版给海外用户看）。

**应用分类**：工具 / 效率。

**标签**：语音转文字、离线、转写、录音、whisper。

**应用图标**：上传 `icons/icon-512.png`。

**特性图形（1024×500）**：本仓库没有，需要做一张。可以用 `icons/icon.svg`
扩出来 + 加一行「完全离线 · 726 MB 内置」标语。

### 1.4 数据安全问卷

按 `data-safety.md` 的「Google Play · Data safety form」段填。所有类型全部「No」。

### 1.5 内容分级

IARC 问卷：

- **类别**：工具
- **是否有用户生成内容**：否
- **是否分享位置**：否
- 所有问题都选「No」，结果会落到「所有人」分级。

### 1.6 目标受众与内容

- 目标年龄组：18 岁以上（不特别针对儿童）
- 是否含广告：**否**
- 是否应用内购：**否**

### 1.7 上传 APK / AAB

- 第一次发版本：先上传 APK 试流程
- **正式上架用 AAB**：Google Play 现在对 APK 实际上要求 AAB（App Bundle）
  - 跑：`cd android && gradle bundleRelease`
  - 产物：`android/app/build/outputs/bundle/release/app-release.aab`
- 上传后 Play Console 自动算出按架构 / DPI 拆分的多个 APK

> **AAB 拆分 vs 体积上限**：Play Asset Delivery 要求单个 AAB 不超 150 MB。
> 我们的 726 MB 模型占了大头，所以必须改成「把模型拆出来当 Asset Pack」才能传。
> **这就是 build-apk.sh 注释里那句「不能再传 Google Play」的原因。**
>
> 工程上要做的改动（这一版**没做**，是下一版的事）：
> 1. 模型从 `assets/web/models/` 挪到独立的 Asset Pack
> 2. 运行时通过 Asset Pack API 按需加载
> 3. 改 `MainActivity` 的拦截器：本地找不到时去 Asset Pack 找
>
> 临时方案：现在直接传这个 760 MB 的 AAB 看是否真被拒（理论上 150 MB 限制
> 在某些渠道类别会被自动豁免，但官方文档不保证）。或者：
>
> - 先上**酷安 / 应用宝 / 华为 / 小米**（国内商店无此限制）
> - 上 Google Play 之前先把模型改用 Asset Pack 拆分（推荐）

### 1.8 发布轨道

第一次发：内部测试 → 封闭式测试 → 开放式测试 → 正式版。
**第一次**可以直接到「开放式测试」（发布前必走一遍流程）。

---

## 阶段 2：App Store 上架

iOS 的产物（.ipa）必须在 GitHub Actions 上构建，因为本机没有 macOS + Xcode + Apple 证书。

### 2.1 准备工作

#### 2.1.1 初始化 git 仓库

`voicetype/` 目录目前**不是** git 仓库，先初始化：

```bash
cd voicetype
git init
git add .
# 先建一个 .gitignore 把不该提交的排除掉
# （构建产物 / 模型 / node_modules 等，下面有现成的）
git commit -m "init: 音转文 2.0.0 离线版"
```

把仓库推到 GitHub（私人 repo 即可，模型进 git-lfs 或别传）：
```bash
# 在 GitHub 上创建一个空仓库，然后：
git remote add origin git@github.com:<user>/<repo>.git
git push -u origin main
```

#### 2.1.2 配置 .gitignore

仓库里有没有 `.gitignore`？先把以下放进去（避免误提交大型二进制）：

```gitignore
# 构建产物
release/
desktop/app/
android/app/build/
android/app/release/

# 模型与运行时
models/
vendor/

# 依赖
**/node_modules/

# 系统
.DS_Store
*.keystore   # 密钥本身另存，本仓库**绝不放**签证书的密钥
```

> 注意：模型 (~720 MB) 不能直接 push，否则 GitHub 单文件 100 MB 限制 + 仓库体积会爆。
> 改为：在 `.github/workflows/build-ios.yml` 里用 `fetch-models.sh` 在 CI 上临时下载
> （**当前 workflow 就是这么做的**，别改）。

#### 2.1.3 在 GitHub 仓库里配置 6 个 Secrets

**推荐：用脚本一次传完**（不用在网页上点 6 次）：

```bash
export GITHUB_TOKEN=github_pat_xxx                       # 需 Secrets 写权限
export APPLE_CERTIFICATE="$(base64 -i Certificates.p12)"
export APPLE_CERTIFICATE_PASSWORD='导出 p12 时的密码'
export APPLE_SIGNING_IDENTITY='Apple Distribution: 张三 (TEAMID)'
export APPLE_ID='you@example.com'
export APPLE_PASSWORD='xxxx-xxxx-xxxx-xxxx'              # App 专用密码
export APPLE_TEAM_ID='ABCDE12345'
./setup-ios-secrets.sh
```

脚本会用仓库自己的 libsodium 公钥做 sealed box 加密后再上传（GitHub 不收明文），
需要 `pip install pynacl`。6 个名字与 `.github/workflows/build-ios.yml` 消费的完全一致。

**或者在网页上手动加**：Settings → Secrets and variables → Actions → New repository secret：

| Secret | 内容 |
| --- | --- |
| `APPLE_CERTIFICATE` | `base64 -i Certificates.p12` 的输出（一行无换行） |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 .p12 时设的密码 |
| `APPLE_SIGNING_IDENTITY` | `Apple Distribution: <你的名字> (<TEAMID>)` |
| `APPLE_ID` | Apple ID 邮箱 |
| `APPLE_PASSWORD` | App 专用密码（不是登录密码） |
| `APPLE_TEAM_ID` | 10 位团队 ID |

`APPLE_PASSWORD` 在 [appleid.apple.com](https://appleid.apple.com) → App 专用密码生成。

### 2.2 触发构建

GitHub → Actions → 「构建 iOS 版」→ Run workflow → 选导出方式。

第一次跑大概 20–40 分钟（Xcode + Rust + 下载模型 + 签名打包）。

产物在 Actions → 该次运行 → Artifacts：`音转文-ios.zip`（里面是 .ipa）。

### 2.3 上传 App Store Connect

- 注册 Apple Developer Program（**一次性 $99/年**，不可免）
- App Store Connect → 我的 App → 新建 App
  - 平台：iOS
  - 名称：音转文
  - 主要语言：简体中文
  - Bundle ID：`com.voicetype.desktop`（**必须与证书里的一致**）
  - SKU：随便起一个不重复字符串
- 在 App Store Connect 里**先创建** App 后，Transporter 或 Xcode 才能上传构建
- 用 Transporter 上传 .ipa（最稳）

### 2.4 配置上架资料

按 `description.md` 的「App Store」段填：副标题、宣传文本、关键词、描述、What's New。

### 2.5 App Privacy 问卷

按 `data-safety.md` 的「App Store · App Privacy」段填。所有问题都是「No」。

### 2.6 截图

**必须**用 Xcode 模拟器截 6.7" 的图（1290×2796）。

```bash
# 安装 Xcode 后跑：
xcrun simctl create "iPhone 16 Pro Max" "iPhone 16 Pro Max"
xcrun simctl boot "iPhone 16 Pro Max"
open -a Simulator
# 装上 .ipa（开发模式）：
xcrun simctl install booted 音转文-2.0.0.ipa
# 启动
xcrun simctl launch booted com.voicetype.desktop
# 截图
xcrun simctl io booted screenshot shot.png
# 导出 1290×2796
```

或者直接用 macOS 自带的 `screencapture -l` 截高分屏。

### 2.7 提交审核

App Store Connect → 版本 → 添加构建 → 填写审核资料 → 提交。

预计审核：1–2 天。审核被拒时回到「审核资料」页看具体原因。

---

## 阶段 3：Microsoft Store 上架

### 3.1 在 Windows 机器上构建

仓库根的 `desktop/build-windows.ps1` 已修复（路径层级 bug），在你 Windows 机器上：

```powershell
cd voicetype\desktop
powershell -ExecutionPolicy Bypass -File .\build-windows.ps1
```

产物：

- `release\音转文-2.0.0-setup.exe`（NSIS 安装包，用户友好）
- `release\音转文-2.0.0.msi`（MSI 安装包，企业分发）

详细步骤、依赖检查、错误处理都在脚本里。

### 3.2 注册 Microsoft Partner Center

[Partner Center](https://partner.microsoft.com) 注册开发者账号（一次性 $19）。

### 3.3 创建应用

- 保留的应用名称：音转文
- 发行类别：工具 / Utilities
- 价格：免费

### 3.4 上传包

- Partner Center → 应用 → 包 → 上传 .msi / .exe
- 系统会自动校验签名（**没签的也能传，但用户首次启动会弹 SmartScreen 警告**）
- 真要零警告需要 EV 代码签名证书（**贵**，先不上也行）

### 3.5 商店资料

按 `description.md` 的「Microsoft Store」段填。

### 3.6 隐私声明

在「属性 → 隐私 URL」填阶段 0.1 托管好的 `privacy-policy.html` 地址。

### 3.7 提交

预计审核 1–3 天。

---

## 阶段 4：酷安上架

酷安审核宽松，是最快能上的一家。

### 4.1 注册酷安开发者

[酷安开发者中心](https://developer.coolapk.com) 注册。

### 4.2 创建应用

- 应用名：音转文
- 应用包名：`com.voicetype.app`
- 应用简介（≤200 字）：按 `description.md` 的「酷安」段填

### 4.3 上传 APK

直接传 `release/音转文-2.0.0.apk`（760 MB，国内商店无 150 MB 限制）。

### 4.4 隐私政策

填阶段 0.1 托管好的 `privacy-policy.html` 地址。

### 4.5 截图

`screenshots/preview-mobile.png` 直接用（1080×1920 起即可）。

预计审核 1–2 天。

---

## 阶段 5：其他可上架的国内商店

- **应用宝**（腾讯）：[open.qq.com/console](https://open.qq.com/console)
- **华为应用市场**：需华为开发者账号
- **小米应用商店**：`dev.mi.com`
- **OPPO 软件商店**：`open.oppomobile.com`
- **vivo 应用商店**：`dev.vivo.com.cn`

流程都差不多：注册 → 资质审核（个人开发者需要身份证 / 营业执照）→ 上传 APK → 填描述 →
等审核。

---

## 总收尾

四端都通过后：

- [ ] 在 README 里更新各商店的下载链接 / 二维码
- [ ] 制作统一落地页（可选）：`https://<user>.github.io/<repo>/`
- [ ] 计划下一版本：把模型从 APK/AAB 拆出去做成 Play Asset Delivery
  才能正式上 Google Play（750 MB > 150 MB 限制）

---

## 常见踩坑

| 现象 | 原因 | 解法 |
| --- | --- | --- |
| Play Console 拒收 760 MB APK | AAB 单文件 150 MB 上限 | 把模型拆成 Asset Pack |
| App Store 上传后 24 小时还没构建出现在列表 | 通常是证书不匹配 | 用 `appstoreconnect-cli` 查具体错 |
| 酷安第一次审核要 3 天 | 个人开发者需人工核身 | 上传身份证正反面 |
| 隐私政策 URL 填了但审核被驳 | URL 不是 HTTPS | 换成 Pages / OSS / Netlify |
| iOS 第一次构建跑 40 分钟还在转 | 第一次要装满所有依赖 | 耐心等，第二次跑会快很多 |
| Windows 上跑脚本报 `gradle not found` | 没装 Gradle | 装 Gradle 8.x 或用 `winget install gradle` |