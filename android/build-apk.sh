#!/usr/bin/env bash
# ---------------------------------------------------------------
# 音转文 · 安卓离线版打包
#
#   ./build-apk.sh
#
# 产物：../release/音转文-<版本>.apk（内含 540MB 离线模型，约 550MB）
#
# 依赖：JDK 17、Android SDK、Gradle、Node（同步资源用）
#
# 注意：这个 APK 不能再传 Google Play。
# Play 对单个 APK 的硬上限是 200MB，550MB 必须改用
# Play Asset Delivery（把模型拆成 asset pack）才能上架。
# 酷安、应用宝、以及企业内分发都接受直传，不受此限。
# ---------------------------------------------------------------

set -euo pipefail
cd "$(dirname "$0")"

JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME ANDROID_HOME
export PATH="$JAVA_HOME/bin:$PATH"

GRADLE_FILE="app/build.gradle"

# ---- 环境自检 ----
if [ ! -d "$ANDROID_HOME" ]; then
  echo "找不到 Android SDK：$ANDROID_HOME"
  echo "请设置 ANDROID_HOME 环境变量后重试。"
  exit 1
fi
if [ ! -f voicetype-release.keystore ]; then
  echo "找不到签名密钥 voicetype-release.keystore，无法打包。"
  exit 1
fi

# ---- 第 1 步：把网页资源 + 离线运行时 + 模型同步进 assets ----
echo "────────────────────────────────────────"
echo "  1/3  同步资源到 assets/web/"
echo "────────────────────────────────────────"
node scripts/sync-assets.mjs
echo

# ---- 第 2 步：构建 ----
echo "────────────────────────────────────────"
echo "  2/3  构建 APK"
echo "────────────────────────────────────────"
echo "（540MB 的 assets 首次打包会慢一些，之后资源走增量，快很多）"
echo
gradle assembleRelease --no-daemon --console=plain

# ---- 第 3 步：收集产物 ----
APK_DIR="app/build/outputs/apk/release"
APK=$(ls -t "$APK_DIR"/*.apk 2>/dev/null | head -1 || true)

if [ -z "$APK" ]; then
  echo
  echo "构建结束，但没有找到 APK，请检查上面的错误输出。"
  exit 1
fi

mkdir -p ../release
# 从 build.gradle 读 versionName，避免硬编码和真实版本对不上。
#
# 注意用 [[:space:]] 而不是 \s：macOS 自带的是 BSD grep，
# 它不支持 \s 这个 GNU 扩展。写 \s 的话 grep 匹配不到、返回退出码 1，
# 在 set -euo pipefail 下会直接把脚本干掉 —— 而且报错信息只有一行
# "grep: 退出码 1"，看起来像构建失败，其实 Gradle 早就 BUILD SUCCESSFUL 了。
APK_NAME=$(grep -E '^[[:space:]]*versionName[[:space:]]+"' "$GRADLE_FILE" | sed -E 's/.*"([^"]+)".*/\1/' | head -1)
if [ -z "$APK_NAME" ]; then
  echo "没能从 $GRADLE_FILE 里读出 versionName，检查一下那一行是不是被改过格式。"
  exit 1
fi
OUT="../release/音转文-${APK_NAME}.apk"
cp "$APK" "$OUT"

echo
echo "────────────────────────────────────────"
echo "  3/3  校验产物"
echo "────────────────────────────────────────"

# 3a. 基本信息（包名、版本、启动 Activity、权限、App 名称）
AAPT2=$(find "$ANDROID_HOME/build-tools" -name aapt2 -type f 2>/dev/null | sort -V | tail -1)
if [ -n "$AAPT2" ]; then
  echo "包信息："
  # 注意：权限这一项**不要用** `dump badging | grep uses-permission`。
  # 当 manifest 声明了 WRITE_EXTERNAL_STORAGE 时，badging 会合成一份
  # "READ_EXTERNAL_STORAGE" 一起打出来 —— 这是它的人类可读报告里加的「隐含伴随」，
  # 实际编译进 APK 的 manifest 只有 WRITE（用 `dump xmltree` 验过）。
  # Play Console 安装时也是按 binary manifest 走，多出来的那一条根本不会真的被要。
  # 真要列权限，用 `dump permissions` —— 它读的是二进制 manifest，没有这一层修饰。
  "$AAPT2" dump badging "$OUT" 2>/dev/null | grep -E "^(package|launchable-activity|application-label)" | sed 's/^/  /'
  echo "  权限（以二进制 manifest 为准）："
  "$AAPT2" dump permissions "$OUT" 2>/dev/null | grep -E "^uses-permission" | sed 's/^/    /'
  echo
fi

# 3b. 签名校验 —— 没签名的 APK 装不上，必须确认
APKSIGNER=$(find "$ANDROID_HOME/build-tools" -name apksigner -type f 2>/dev/null | sort -V | tail -1)
if [ -n "$APKSIGNER" ]; then
  if "$APKSIGNER" verify --print-certs "$OUT" > /tmp/apksigner-out.txt 2>&1; then
    echo "签名：✓ 有效"
    grep -E "SHA-256" /tmp/apksigner-out.txt | head -1 | sed 's/^/  /'
  else
    echo "签名：✗ 校验失败"
    cat /tmp/apksigner-out.txt | sed 's/^/  /'
    exit 1
  fi
  echo
fi

# 3c. 关键资源确实在包里 —— 这是"离线版"成不成立的根本
echo "内置资源抽查："
for f in \
  "assets/web/index.html" \
  "assets/web/js/whisper.js" \
  "assets/web/vendor/transformers.js" \
  "assets/web/vendor/ort/ort-wasm-simd-threaded.asyncify.wasm" \
  "assets/web/vendor/ort/ort-wasm-simd-threaded.asyncify.mjs" \
  "assets/web/models/whisper-large-v3-turbo/config.json" \
  "assets/web/models/whisper-large-v3-turbo/onnx/encoder_model_q4.onnx" \
  "assets/web/models/whisper-large-v3-turbo/onnx/decoder_model_merged_q4.onnx" ; do
  if unzip -l "$OUT" "$f" >/dev/null 2>&1; then
    sz=$(unzip -l "$OUT" "$f" 2>/dev/null | awk 'NR==4{printf "%.1f MB", $1/1048576}')
    echo "  ✓ $f  ($sz)"
  else
    echo "  ✗ 缺失：$f"
    exit 1
  fi
done

# 3d. 反向检查：被淘汰的 ORT 内核变体不能残留在包里。
# 只查"该有的在"是不够的 —— 老变体留着不会报错，只会让包白白胖 26MB，
# 而且一旦 whisper.js 的加载逻辑回退就会踩到 webgpuInit 那个坑。
for f in \
  "assets/web/vendor/ort/ort-wasm-simd-threaded.jsep.wasm" \
  "assets/web/vendor/ort/ort-wasm-simd-threaded.jsep.mjs" ; do
  if unzip -l "$OUT" "$f" >/dev/null 2>&1; then
    echo "  ✗ 陈旧内核残留在包里：$f（重新跑 scripts/sync-assets.mjs 并清掉 app/build 缓存）"
    exit 1
  fi
done
echo "  ✓ 无陈旧内核残留"
echo

SIZE=$(wc -c < "$OUT" | tr -d ' ')
echo "────────────────────────────────────────"
echo "  构建成功"
echo "  产物：$OUT"
printf "  体积：%s 字节 = %.2f MB\n" "$SIZE" "$(echo "$SIZE" | awk '{print $1/1048576}')"
echo "────────────────────────────────────────"
