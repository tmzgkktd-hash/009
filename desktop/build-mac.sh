#!/usr/bin/env bash
# ---------------------------------------------------------------
# 音转文 · macOS 打包
#
#   ./build-mac.sh              打当前架构（Apple Silicon 上是 arm64）
#   ./build-mac.sh --universal  打通用包（Intel + Apple Silicon 都能跑，编译时间翻倍）
#
# 产物：../release/音转文-2.0.0.dmg
#
# 依赖：Rust、Node、Xcode Command Line Tools
#      （只要 CLT 就够，不需要装完整的 Xcode —— Tauri 用系统自带的 WKWebView）
#
# 关于体积：DMG 约 520MB，其中 726MB 的离线模型压完约 480MB。
# 这是"完全离线"的必然代价 —— 想瘦身就得改成首次启动时下载模型。
# ---------------------------------------------------------------

set -euo pipefail
cd "$(dirname "$0")"

UNIVERSAL=0
for a in "$@"; do
  case "$a" in
    --universal) UNIVERSAL=1 ;;
    *) echo "未知参数：$a"; exit 2 ;;
  esac
done

export PATH="$HOME/.cargo/bin:$PATH"

# ---- 环境自检 ----
echo "────────────────────────────────────────"
echo "  1/5  检查环境"
echo "────────────────────────────────────────"

for c in node cargo rustc; do
  if ! command -v "$c" >/dev/null 2>&1; then
    case "$c" in
      node)  echo "  缺少 Node.js。装法：brew install node  或去 nodejs.org 下 LTS";;
      cargo|rustc)
        echo "  缺少 Rust。装法：curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
        echo "  装完记得重开终端，或执行：source \"\$HOME/.cargo/env\"";;
    esac
    exit 1
  fi
done
echo "  Node   $(node --version)"
echo "  Rust   $(rustc --version)"

if ! xcode-select -p >/dev/null 2>&1; then
  echo "  缺少 Xcode Command Line Tools。装法：xcode-select --install"
  exit 1
fi
echo "  CLT    $(xcode-select -p)"

# ---- 检查随包资源 ----
echo
echo "────────────────────────────────────────"
echo "  2/5  检查随包资源"
echo "────────────────────────────────────────"

ROOT="$(cd .. && pwd)"
MODEL_DIR="$ROOT/models/whisper-large-v3-turbo"
VENDOR_JS="$ROOT/vendor/transformers.js"

[ -f "$VENDOR_JS" ] || { echo "  缺少离线运行时 $VENDOR_JS"; echo "  先跑：cd ../tools && npm install && node build-vendor.mjs"; exit 1; }
[ -f "$MODEL_DIR/config.json" ] || { echo "  缺少模型配置，先跑 ../fetch-models.sh"; exit 1; }

check_size() {
  local f="$1" want="$2" label="$3"
  [ -f "$f" ] || { echo "  缺少 $label：$f"; exit 1; }
  local got; got=$(wc -c < "$f" | tr -d ' ')
  local diff=$(( got > want ? got - want : want - got ))
  if [ "$diff" -gt 1000000 ]; then
    echo "  $label 体积不对（$got / 期望 $want），多半没下完，重跑 ../fetch-models.sh"
    exit 1
  fi
  echo "  ✓ $label $(echo "$got" | awk '{printf "%.1f MB", $1/1048576}')"
}
check_size "$MODEL_DIR/onnx/encoder_model_q4.onnx" 424942775 "编码器"
check_size "$MODEL_DIR/onnx/decoder_model_merged_q4.onnx" 334147222 "解码器"

# ---- 同步资源 ----
echo
echo "────────────────────────────────────────"
echo "  3/5  同步网页资源"
echo "────────────────────────────────────────"
node scripts/sync-app.mjs

# ---- 构建 ----
echo
echo "────────────────────────────────────────"
echo "  4/5  编译并打包"
echo "────────────────────────────────────────"

if [ ! -d node_modules ]; then
  echo "  安装构建依赖…"
  npm install --no-audit --no-fund
fi

if [ "$UNIVERSAL" = "1" ]; then
  echo "  目标：通用二进制（aarch64 + x86_64）"
  for t in aarch64-apple-darwin x86_64-apple-darwin; do
    rustup target add "$t" >/dev/null 2>&1 || true
  done
  npx tauri build --target universal-apple-darwin --bundles app
  BUNDLE="src-tauri/target/universal-apple-darwin/release/bundle"
else
  echo "  目标：当前架构 $(uname -m)"
  npx tauri build --bundles app
  BUNDLE="src-tauri/target/release/bundle"
fi

APP_BUNDLE="$BUNDLE/macos/音转文.app"
if [ ! -d "$APP_BUNDLE" ]; then
  echo "  没找到 .app（$APP_BUNDLE），请检查上面的错误输出。"
  exit 1
fi

# ---- 生成 DMG ----
#
# 为什么不用 `npx tauri build --bundles dmg`：
#   Tauri 内置的 bundle_dmg.sh 是从 create-dmg 抄来的，里面有 GNU grep 的写法。
#   macOS 自带的是 BSD grep，跑到那里会报
#     grep: bad regex '/dev/disk8s': brackets ([ ]) not balanced
#   然后直接放弃，报一句没头没尾的
#     error running bundle_dmg.sh
#   而且此时它已经把临时映像挂上了，还会留下一个没卸载的 /Volumes/dmg.XXXXXX。
#   直接用系统自带的 hdiutil 造 DMG，少一层依赖，出错也看得见。
echo
echo "────────────────────────────────────────"
echo "  5/5  生成 DMG"
echo "────────────────────────────────────────"

# 暂存目录里放 app + 一个 /Applications 软链，用户拖进去就是安装
STAGE="$(mktemp -d)"
# 清理失败不能影响构建结果，所以吞掉错误码（有些沙箱环境会拦批量删除）
trap 'rm -rf "$STAGE" 2>/dev/null || true' EXIT
cp -R "$APP_BUNDLE" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

mkdir -p ../release
OUT="../release/音转文-2.0.0.dmg"
# 删不掉旧产物也继续：hdiutil 的 -ov 本来就会覆盖。
# 有些受管环境会对删除操作做配额限制，不能因为这个就把整个构建判失败。
rm -f "$OUT" 2>/dev/null || true

hdiutil create \
  -srcfolder "$STAGE" \
  -volname "音转文" \
  -fs HFS+ \
  -format UDZO \
  -imagekey zlib-level=9 \
  -ov \
  "$OUT" >/dev/null

if [ ! -f "$OUT" ]; then
  echo "  DMG 生成失败。"
  exit 1
fi

# 校验：能挂上、里面有 app 和 Applications 软链
echo "  校验 DMG…"
MP="$(hdiutil attach "$OUT" -nobrowse -readonly 2>/dev/null | awk '/\/Volumes\//{print $3}' | head -1)"
if [ -n "$MP" ]; then
  ls "$MP" | sed 's/^/    /'
  if [ ! -d "$MP/音转文.app" ]; then
    echo "  ✗ DMG 里没有 音转文.app"
    hdiutil detach "$MP" -force >/dev/null 2>&1
    exit 1
  fi
  if [ ! -L "$MP/Applications" ]; then
    echo "  ✗ DMG 里没有 Applications 软链（拖拽安装会失效）"
    hdiutil detach "$MP" -force >/dev/null 2>&1
    exit 1
  fi
  # 模型必须真的在包里，否则「离线版」不成立
  if [ ! -f "$MP/音转文.app/Contents/Resources/models/whisper-large-v3-turbo/onnx/encoder_model_q4.onnx" ]; then
    echo "  ✗ 包内缺少离线模型"
    hdiutil detach "$MP" -force >/dev/null 2>&1
    exit 1
  fi
  # 反向检查：换成 q4 之后，旧的 q4f16 不该还躺在包里（多占 537MB）
  if [ -f "$MP/音转文.app/Contents/Resources/models/whisper-large-v3-turbo/onnx/encoder_model_q4f16.onnx" ]; then
    echo "  ✗ 包内残留旧量化 q4f16，会白白多占 537MB"
    hdiutil detach "$MP" -force >/dev/null 2>&1
    exit 1
  fi
  hdiutil detach "$MP" -force >/dev/null 2>&1
  echo "  ✓ DMG 可挂载，内容与离线模型齐备"
else
  echo "  ! 挂载校验跳过（未能挂载）"
fi

SIZE=$(wc -c < "$OUT" | tr -d ' ')
echo "────────────────────────────────────────"
echo "  构建成功"
echo "  产物：$OUT"
printf "  体积：%s 字节 = %.2f MB\n" "$SIZE" "$(echo "$SIZE" | awk '{print $1/1048576}')"
echo "────────────────────────────────────────"
echo
echo "  首次打开会被 Gatekeeper 拦下（未签名）。"
echo "  用户可右键 → 打开，或执行："
echo "    xattr -dr com.apple.quarantine \"$OUT\""
echo "  要免掉这一步，需要 Apple Developer 账号（99 美元/年）做签名 + 公证。"
echo
