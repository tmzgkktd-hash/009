#!/usr/bin/env bash
# ---------------------------------------------------------------
# 下载「音转文」随包内置的离线模型
#
# 目标：whisper-large-v3-turbo 的 q4 量化版
#       （int4 权重 + fp32 激活：WebGPU 和纯 CPU 都能跑）
# 落点：models/whisper-large-v3-turbo/...
#
# 为什么不用更小的 q4f16（537MB）：fp16 系量化只有 WebGPU 能执行，
# 在 macOS 15 的 WKWebView（Safari 18）、老安卓 WebView 这类没有
# WebGPU 的环境里连 session 都建不起来。随包模型必须处处能跑，
# 所以选 q4（724MB）。取舍详见 js/whisper.js 的 BUNDLED_DTYPE 注释。
#
# 这个脚本踩过三个真实的坑，下面这些措施都是必需的，不要图省事删掉：
#
#  1) 文件锁。曾经有两个实例同时在写同一个文件（上一个进程没退干净），
#     两个 curl 各自从自己的偏移量写，文件体积忽大忽小、内容交错损坏。
#     现在用 mkdir 做原子锁，第二个实例直接退出。
#
#  2) 多连接分片下载。huggingface 对单连接限速在 180~380 KB/s，
#     563MB 单连接要 50 分钟；开到 6 条连接合计约 980 KB/s，10 分钟就够。
#     见 tools/parallel-download.py。
#
#  3) SHA-256 校验。体积对得上不代表内容对（交错写入就是体积正常但内容全错）。
#     期望值取自 HuggingFace 的 LFS oid，是权威值。
#     校验不过就整份作废，绝不留下"看着像、其实是坏的"文件。
#
# 中断后重跑即可，已下好的分片会跳过。
# ---------------------------------------------------------------
set -uo pipefail
cd "$(dirname "$0")"

REPO="onnx-community/whisper-large-v3-turbo"
DEST="models/whisper-large-v3-turbo"
LOCK=".fetch-models.lock"
PARALLEL="tools/parallel-download.py"

# ---- 找 python3 ----
PY=""
for c in python3 /opt/homebrew/bin/python3 /usr/bin/python3; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "找不到 python3 —— 多连接下载器需要它。"
  exit 1
fi

# ---- 文件锁：防止并发写同一个文件 ----
# 用「单文件 + noclobber」而不是「锁目录 + rm -rf」：
# 锁目录的清理要 rm -rf，容易触发批量删除保护而失败，
# 一旦失败就会卡在"锁没清掉、mkdir 又 EEXIST"的死循环里。
# 单文件的清理只要 rm -f，干净利落。
acquire_lock() {
  if ( set -o noclobber; printf '%s\n' "$$" > "$LOCK" ) 2>/dev/null; then
    return 0
  fi
  OLD=$(tr -d '[:space:]' < "$LOCK" 2>/dev/null || echo "")
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    echo "已有另一个下载进程在跑（PID $OLD），本实例退出，避免两个进程写坏同一个文件。"
    return 1
  fi
  echo "清理上次异常退出留下的锁。"
  rm -f "$LOCK"
  if ( set -o noclobber; printf '%s\n' "$$" > "$LOCK" ) 2>/dev/null; then
    return 0
  fi
  echo "无法建立锁文件 $LOCK"
  return 1
}

acquire_lock || exit 1
trap 'rm -f "$LOCK"' EXIT INT TERM

# 文件清单：路径|期望字节数|期望SHA-256（空表示不做哈希校验）
FILES=(
  "config.json|1332|"
  "generation_config.json|3897|"
  "preprocessor_config.json|340|"
  "tokenizer.json|2480617|"
  "tokenizer_config.json|282843|"
  "special_tokens_map.json|2186|"
  "added_tokens.json|34648|"
  "normalizer.json|52666|"
  "onnx/encoder_model_q4.onnx|424942775|7e64b20dd7b556cb7a2c1c65d9fbf31af985323c006f993d2a9dd10083547d78"
  "onnx/decoder_model_merged_q4.onnx|334147222|8b933ac24074a24a1635084d06a4ed37e387ef22d980f184a5fc27418e9ceeb8"
)

SOURCES=(
  "https://huggingface.co/$REPO/resolve/main"
  "https://hf-mirror.com/$REPO/resolve/main"
)

mkdir -p "$DEST/onnx"

# ---- 选一个通的源（留作备用，主源失败时按顺序再试） ----
BASES=()
for s in "${SOURCES[@]}"; do
  if curl -sIL --max-time 15 "$s/config.json" -o /dev/null 2>/dev/null; then
    BASES+=("$s")
  fi
done
if [ ${#BASES[@]} -eq 0 ]; then
  echo "两个源都连不上，请检查网络后重试。"
  exit 1
fi
echo "可用源：${BASES[*]}"
echo

# ---- 找一把能算 SHA-256 的尺子 ----
#
# ⚠️ 不能写死 `shasum`：那是 macOS 上的 Perl 脚本，
#    Windows 的 Git Bash 里压根没这个命令。
#    实测 CI 上报 `shasum: command not found`，
#    于是下面的校验函数返回空串，每个文件都被判成「哈希不符」——
#    可实际上文件早就下对了（Python 下载器内部自己校验过，日志里
#    明明白白打了「SHA-256 通过」「✓ 完成 xxx.onnx」）。
#    就因为最后这次总校验拿不到哈希，整个脚本失败退出，
#    后面所有步骤全部 skipped。典型的「活干完了，卡在签字环节」。
#
# 按可用性依次降级：shasum（macOS）→ sha256sum（Linux / Git for Windows）
# → python（最后兜底）。三者算出来的都是 64 位小写十六进制，可直接字符串比较。
SHA256_CMD=""
for c in shasum sha256sum; do
  if command -v "$c" >/dev/null 2>&1; then SHA256_CMD="$c"; break; fi
done
if [ -z "$SHA256_CMD" ]; then
  for p in python3 python; do
    if command -v "$p" >/dev/null 2>&1; then SHA256_CMD="py:$p"; break; fi
  done
fi
if [ -z "$SHA256_CMD" ]; then
  echo "找不到任何能算 SHA-256 的工具（shasum / sha256sum / python 都没有）。"
  echo "没有校验就没法确认模型是完整的，这里停下来比较稳妥。"
  exit 1
fi

sha256_of() {
  [ -f "$1" ] || { echo ""; return; }
  case "$SHA256_CMD" in
    shasum)    shasum -a 256 "$1" | awk '{print $1}' ;;
    sha256sum) sha256sum "$1" | awk '{print $1}' ;;
    py:*)      "${SHA256_CMD#py:}" -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1" 2>/dev/null || echo "" ;;
    *)         echo "" ;;
  esac
}

fail=0

for entry in "${FILES[@]}"; do
  IFS='|' read -r f want expect_sha <<< "$entry"
  out="$DEST/$f"

  # ---- 已完成的正式文件：校验后跳过 ----
  if [ -f "$out" ]; then
    got=$(wc -c < "$out" | tr -d ' ')
    if [ "$got" = "$want" ]; then
      if [ -z "$expect_sha" ] || [ "$(sha256_of "$out")" = "$expect_sha" ]; then
        echo "跳过（已校验）：$f"
        continue
      fi
      echo "校验不通过，重新下载：$f"
    else
      echo "体积不符（$got / $want），重新下载：$f"
    fi
    rm -f "$out"
  fi

  ok=0
  for BASE in "${BASES[@]}"; do
    echo "下载：$f（$(echo "$want" | awk '{printf "%.1f", $1/1048576}') MB）"

    if [ "$want" -ge 4194304 ]; then
      # 大文件：多连接分片，自带 SHA 校验
      if "$PY" "$PARALLEL" "$BASE/$f" "$out" "$want" "${expect_sha:-}" 6; then
        ok=1
        break
      fi
    else
      # 小文件：单连接就够，写 .part 再原子改名
      part="$out.part"
      curl -fL -C - --http1.1 \
           --retry 8 --retry-delay 3 --retry-all-errors \
           --connect-timeout 30 --speed-time 60 --speed-limit 5120 \
           -sS "$BASE/$f" -o "$part" 2>/dev/null || true
      got=$(wc -c < "$part" 2>/dev/null | tr -d ' ' || echo 0)
      if [ "$got" = "$want" ]; then
        if [ -z "$expect_sha" ] || [ "$(sha256_of "$part")" = "$expect_sha" ]; then
          mv -f "$part" "$out"
          ok=1
          echo "  ✓ $f"
          break
        fi
      fi
      rm -f "$part"
    fi

    echo "  这个源没成功，换下一个…"
  done

  if [ "$ok" != "1" ]; then
    echo "  ✗ 失败：$f"
    fail=1
  fi
done

echo
if [ "$fail" != "0" ]; then
  echo "有文件没下完，重跑本脚本会从已下好的分片继续。"
  exit 1
fi

# ---- 总校验 ----
echo "总校验："
total=0
ok=1
for entry in "${FILES[@]}"; do
  IFS='|' read -r f want expect_sha <<< "$entry"
  out="$DEST/$f"
  if [ ! -f "$out" ]; then
    echo "  ✗ 缺失：$f"; ok=0; continue
  fi
  got=$(wc -c < "$out" | tr -d ' ')
  if [ "$got" != "$want" ]; then
    echo "  ✗ 体积不符：$f（$got / $want）"; ok=0; continue
  fi
  if [ -n "$expect_sha" ] && [ "$(sha256_of "$out")" != "$expect_sha" ]; then
    echo "  ✗ 哈希不符：$f"; ok=0; continue
  fi
  total=$((total + got))
done

echo
echo "合计 $total 字节 = $(echo "$total" | awk '{printf "%.1f MB", $1/1048576}')"

if [ "$ok" != "1" ]; then
  echo "校验未通过。"
  exit 1
fi
echo "模型就绪（体积与 SHA-256 全部对上）。"
