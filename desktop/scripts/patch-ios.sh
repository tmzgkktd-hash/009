#!/usr/bin/env bash
# ---------------------------------------------------------------
# 修补 Tauri 生成的 iOS 工程（在 CI 上、tauri ios init 之后运行）
#
#   ./scripts/patch-ios.sh
#
# 干四件事，每一件漏了都会出问题：
#
#  1) 写 NSMicrophoneUsageDescription。
#     没有这一项，App 一调用 getUserMedia 就会被系统直接杀掉进程，
#     不是"权限被拒"而是"闪退"——审核也会因此被拒。
#
#  2) 写 CFBundleDisplayName = 音转文。
#     Xcode 工程目录名用的是 ASCII，桌面图标下的名字走这个键。
#
#  3) 写 ITSAppUsesNonExemptEncryption = false。
#     本 App 不用任何加密（只做本地音频识别），声明为非豁免加密后，
#     每次上传 TestFlight 就不会再被问一遍出口合规问题。
#
#  4) 写 NSAppTransportSecurity.NSAllowsLocalNetworking = true。
#     页面是从 http://127.0.0.1:<随机端口> 加载的，不是 tauri://localhost
#     （原因见 src-tauri/src/lib.rs 顶部：自定义协议在 WKWebView 里不是
#     安全上下文，录音和跨源隔离都会坏掉，iOS 同理）。
#     而 ATS 从 iOS 17 起不再默认放行 IP 地址 —— 漏了这一项，iOS 17+ 上
#     页面直接加载不出来。
#
# 用 PlistBuddy 而不是直接改 XML：它会正确处理键不存在时的新增、
# 已存在时的覆盖，也不会破坏 plist 的格式。
# ---------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

APPLE_DIR="src-tauri/gen/apple"

if [ ! -d "$APPLE_DIR" ]; then
  echo "找不到 $APPLE_DIR —— 先跑 tauri ios init。"
  exit 1
fi

# 找出生成的 Info.plist（目录名由 productName 决定，可能是中文）
PLIST=$(find "$APPLE_DIR" -maxdepth 2 -name Info.plist -not -path "*/build/*" | head -1)
if [ -z "$PLIST" ]; then
  echo "在 $APPLE_DIR 下没找到 Info.plist。"
  echo "生成出来的目录结构："
  find "$APPLE_DIR" -maxdepth 2 -type d | sed 's/^/  /'
  exit 1
fi
echo "目标 Info.plist：$PLIST"

PB=/usr/libexec/PlistBuddy

set_key() {
  local key="$1" type="$2" value="$3"
  if $PB -c "Print :$key" "$PLIST" >/dev/null 2>&1; then
    $PB -c "Set :$key $value" "$PLIST"
  else
    $PB -c "Add :$key $type $value" "$PLIST"
  fi
  echo "  ✓ $key"
}

echo "写入："
set_key CFBundleDisplayName string "音转文"
set_key NSMicrophoneUsageDescription string "音转文需要访问麦克风，才能把您说的话转成文字。录音只在本机处理，不会上传到任何服务器。"
set_key ITSAppUsesNonExemptEncryption bool false

# ---- App Transport Security：放行本机回环地址 ----
#
# 页面来自 http://127.0.0.1:<随机端口>，而 ATS 从 iOS 17 起不再默认放行
# IP 地址。Apple 文档原文：
#   "In iOS 17, iPadOS 17, and macOS 14, ATS no longer allows connections to
#    IP addresses by default."
# 同一页也说明 NSAllowsLocalNetworking 的作用正是
#   "enable access to unqualified domains, .local domains, and IP addresses"。
#
# 为什么不用 NSAllowsArbitraryLoads：那是完全绕过 ATS，范围太大，
# 审核时也更容易被追问。NSAllowsLocalNetworking 只放开本机 / 局域网，
# 正好对应我们的用法（App 自己起的本地服务）。
if ! $PB -c "Print :NSAppTransportSecurity" "$PLIST" >/dev/null 2>&1; then
  $PB -c "Add :NSAppTransportSecurity dict" "$PLIST"
fi
if ! $PB -c "Print :NSAppTransportSecurity:NSAllowsLocalNetworking" "$PLIST" >/dev/null 2>&1; then
  $PB -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" "$PLIST"
else
  $PB -c "Set :NSAppTransportSecurity:NSAllowsLocalNetworking true" "$PLIST"
fi
echo "  ✓ NSAppTransportSecurity.NSAllowsLocalNetworking = true"

# 语音识别场景下，用户切到后台时不应该被立刻掐断录音；
# 声明 audio 后台模式可以让系统在锁屏/切后台时继续跑（审核时会要求说明用途，
# 我们的用途就是"持续录音转写"，属于合理使用）。
if ! $PB -c "Print :UIBackgroundModes" "$PLIST" >/dev/null 2>&1; then
  $PB -c "Add :UIBackgroundModes array" "$PLIST"
fi
if ! $PB -c "Print :UIBackgroundModes:0" "$PLIST" >/dev/null 2>&1; then
  $PB -c "Add :UIBackgroundModes:0 string audio" "$PLIST"
  echo "  ✓ UIBackgroundModes[0] = audio"
fi

echo
echo "修补后的关键项："
for k in CFBundleDisplayName NSMicrophoneUsageDescription ITSAppUsesNonExemptEncryption NSAppTransportSecurity:NSAllowsLocalNetworking; do
  printf "  %s = %s\n" "$k" "$($PB -c "Print :$k" "$PLIST" 2>/dev/null || echo '(未设置)')"
done
echo
echo "iOS 工程修补完成。"
