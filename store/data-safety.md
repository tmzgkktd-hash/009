# 数据安全 / 隐私问卷答案

四端商店在发布时都会问一遍「你们收集哪些数据」。App 实际上**什么都不收集**，
所以答案也都是「不收集」/「否」。下面按商店分别给出可直接复制的标准答案。

带 `[填]` 的字段请按需替换。

---

## Google Play · Data safety form

打开 Google Play Console → 上传新版本 →「Data safety」（数据安全）。

### 一、数据收集与安全

> Does your app collect or share any of the required user data types?
> **No**

> Is all of the user data collected by your app encrypted in transit?
> **No data is collected.**（不必选）

> Do you provide a way for users to request that their data is deleted?
> **No data is collected.**（不必选）

### 二、数据类型

逐条把下面六项**全部勾「No, this type of data is not collected and not shared」**：

| 类型 | 是否收集 | 备注 |
| --- | --- | --- |
| Location | ❌ | |
| Personal info（姓名、邮箱、电话、地址、用户ID） | ❌ | |
| Financial info | ❌ | |
| Health and fitness | ❌ | |
| Messages | ❌ | |
| Photos and videos | ❌ | |
| Audio files（这里要勾 No） | ❌ | **重要**：本地处理，识别完成即释放 |
| Files and docs | ❌ | **重要**：本地存储，导出由用户主动触发 |
| Calendar | ❌ | |
| Contacts | ❌ | |
| App activity（应用内活动） | ❌ | |
| Web browsing | ❌ | |
| App info and performance | ❌ | |
| Device or other IDs | ❌ | |

### 三、Data disclosure（数据披露）

> **数据未披露给第三方。**（因为没有第三方服务）

### 四、Account creation

> **应用无账号系统。**

---

## App Store · App Privacy（营养标签）

打开 App Store Connect → App 信息 →「App Privacy」→ 回答问题。

### 第一步：是不是收集数据？

> **「No, we do not collect data from this app.」**

因为 App 完全离线、不连网、不接入 SDK，**所有问题都是「No」**。
直接确认到最后一页就行。

> 如果审核员仍然追问，可以补一句英文：「VoiceType runs entirely offline.
> The 726 MB whisper model is bundled in the app; no data leaves the device.
> Privacy policy: https://<your-url>/privacy-policy-en.html」

---

## Microsoft Store · Declaration

MS Store 上架时也要回答隐私问题。

- 「Does your app collect, store, or transmit any personal data?」→ **No**
- 「Does your app use any third-party analytics or crash reporting?」→ **No**
- 「Provide a privacy policy URL」→ 填托管好的 `privacy-policy.html` 地址

---

## 酷安

酷安审核表单里：

- 「用户数据收集范围」→ 选「无数据收集」
- 「隐私政策」→ 填托管好的 `privacy-policy.html` 地址

---

## 标准话术（审核质疑时备用）

> VoiceType 是一款离线语音转文字 App。所有语音识别都在用户设备本地完成：
>
> 1. 音频流在 WebAssembly 中实时处理，识别完成后立即释放，从不写入磁盘、
>    从不上传网络；
> 2. 转录结果只存储在浏览器 `localStorage` 中，删除 App 即清除；
> 3. 没有账号、登录、广告或第三方分析 SDK；
> 4. 网络权限（`INTERNET`）仅为 WebView 加载本地资源时的同源检查而保留。
>    打包版在代码层面就没有发起外部请求的入口 —— 模型档位与识别引擎
>    都被固定为随包的离线组合（见下），设置界面里也不存在可联网的选项。
>
> 详细隐私政策：https://<your-url>/privacy-policy-en.html

> **为什么第 4 条值得单独说**（2.0.0 修过的一个真实缺陷）：
> 早期版本在打包版里仍然把 4 个模型档位和「云端」引擎摆在设置里。
> 选 Tiny/Base/Small 会走到从 hf-mirror.com 下载 43~237 MB 的分支，
> 选「云端」则把音频交给 Web Speech API 上传解码 —— 两条路都会让
> 「不联网、不上传」变成假话。现在有三道闸：
> 界面上摘掉选项（`app.js` §18b）、偏好强制纠正（`loadPrefs`）、
> 加载时钉死随包档位（`loadOfflineModel`）。
> 改动前后默认行为一致（本来默认就是离线），被堵的是手动改设置的那条路。

---

## 自检清单

发版前自己核一遍：

- [ ] Play Console 的 Data Safety 问卷全部勾「No」
- [ ] App Store Connect 的 App Privacy 全部勾「No」
- [ ] MS Store 隐私问卷全部勾「No」
- [ ] 酷安隐私问卷全部勾「无数据收集」
- [ ] **装好后在飞行模式下走一遍**：设置里应当只有「离线」引擎、
      模型下拉框不可选且只剩 Large；录一段能正常出字
- [ ] 四端的隐私政策 URL 都是有效的 HTTPS（HTTP 会被部分商店拒）
- [ ] 隐私政策页面能正常在手机浏览器打开（不少商店会用手机预览）
- [ ] 隐私政策页面**没有**任何外部 JS / CSS / 字体引用（很多商店对外部资源过敏）