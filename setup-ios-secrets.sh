#!/usr/bin/env bash
# ---------------------------------------------------------------
# 配置 iOS 构建所需的 6 个 GitHub Secrets
#
#   ./setup-ios-secrets.sh
#
# 为什么要加密：
#   GitHub 不接受明文上传 Secret。必须用仓库自己的公钥做一次
#   libsodium sealed box 加密，服务端才肯收。所以这个脚本依赖 PyNaCl。
#
# 用法（全部走环境变量，避免出现在 ps / 命令历史里）：
#
#   export GITHUB_TOKEN=github_pat_xxx          # 需要有 Secrets 写权限
#   export APPLE_CERTIFICATE="$(base64 -i Certificates.p12)"
#   export APPLE_CERTIFICATE_PASSWORD='导出 p12 时的密码'
#   export APPLE_SIGNING_IDENTITY='Apple Distribution: 张三 (TEAMID)'
#   export APPLE_ID='you@example.com'
#   export APPLE_PASSWORD='xxxx-xxxx-xxxx-xxxx'   # App 专用密码，不是登录密码
#   export APPLE_TEAM_ID='ABCDE12345'
#   ./setup-ios-secrets.sh
#
# 前置条件：
#   1. Apple Developer Program 会员（**$99/年**，没有这个签不了名，一切免谈）
#   2. 在 developer.apple.com 建好 Distribution 证书并导出成 .p12
#   3. 在 App Store Connect 建好 App（Bundle ID 必须是 com.voicetype.desktop）
#   4. App 专用密码在 appleid.apple.com 生成
#
# 配完之后：
#   GitHub → Actions →「构建 iOS 版」→ Run workflow
# ---------------------------------------------------------------

set -euo pipefail
cd "$(dirname "$0")"

REPO_OWNER="tmzgkktd-hash"
REPO_NAME="009"
API="https://api.github.com"

say() { printf '%s\n' "$*"; }
die() { printf '\n[X] %s\n' "$*" >&2; exit 1; }

# ---- 检查 token ----
: "${GITHUB_TOKEN:?先 export GITHUB_TOKEN=...（需要有 Secrets 写权限的 token）}"

# ---- 检查 6 个 Apple 值 ----
MISSING=()
for v in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY \
         APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
  [ -n "${!v:-}" ] || MISSING+=("$v")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  say "还缺这些没设置："
  for m in "${MISSING[@]}"; do say "  • $m"; done
  say ""
  say "参照脚本头部的用法把它们 export 出来再跑。"
  die "环境变量不全。"
fi

# ---- 找带 PyNaCl 的 python ----
PY=""
for c in /Users/penggege/.workbuddy-ai/binaries/python/envs/default/bin/python \
         python3 /usr/bin/python3; do
  if [ -x "$c" ] || command -v "$c" >/dev/null 2>&1; then
    if "$c" -c 'import nacl' >/dev/null 2>&1; then PY="$c"; break; fi
  fi
done
if [ -z "$PY" ]; then
  cat <<'TIP'
没找到装了 PyNaCl 的 Python —— 加密 Secret 必须要它。

装法（挑一个）：
  pip install pynacl
  # 或装到隔离环境，不污染系统：
  python3 -m venv ~/.venv-yzw && ~/.venv-yzw/bin/pip install pynacl
TIP
  die "缺少 PyNaCl。"
fi

say "仓库：  https://github.com/$REPO_OWNER/$REPO_NAME"
say "Python： $PY"
say ""

# ---- 取仓库公钥 ----
KEY_JSON=$(curl -s --max-time 25 -H "Authorization: Bearer $GITHUB_TOKEN" \
             -H "Accept: application/vnd.github+json" \
             "$API/repos/$REPO_OWNER/$REPO_NAME/actions/secrets/public-key")
if echo "$KEY_JSON" | grep -q '"message"'; then
  say "取公钥失败：$(echo "$KEY_JSON" | head -c 300)"
  die "多半是 token 没有 Secrets 权限。重新生成 token 时勾上 Secrets: Read and write。"
fi

# ---- 逐个加密并上传 ----
# 用 base64 把值传进 python，避免特殊字符（密码里的引号、换行）被 shell 吃掉。
upload() {
  local name="$1" value="$2"
  local b64val
  b64val=$(printf '%s' "$value" | base64)

  local payload
  payload=$(VALUE_B64="$b64val" KEY_JSON="$KEY_JSON" SECRET_NAME="$name" "$PY" - <<'PYEOF'
import base64, json, os
from nacl import encoding, public

kj = json.loads(os.environ["KEY_JSON"])
value = base64.b64decode(os.environ["VALUE_B64"])

pk = public.PublicKey(kj["key"].encode(), encoding.Base64())
enc = public.SealedBox(pk).encrypt(value)
print(json.dumps({
    "encrypted_value": base64.b64encode(enc).decode(),
    "key_id": kj["key_id"],
}))
PYEOF
)
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 -X PUT \
           -H "Authorization: Bearer $GITHUB_TOKEN" \
           -H "Accept: application/vnd.github+json" \
           -d "$payload" \
           "$API/repos/$REPO_OWNER/$REPO_NAME/actions/secrets/$name")

  case "$code" in
    204|201) say "  ✓ $name" ;;
    403) say "  ✗ $name  （403：token 没有 Secrets 写权限）"; return 1 ;;
    404) say "  ✗ $name  （404：仓库或 Secret 名不对）"; return 1 ;;
    *)    say "  ✗ $name  （HTTP $code）"; return 1 ;;
  esac
}

say "上传 6 个 Secrets："
fail=0
upload APPLE_CERTIFICATE          "$APPLE_CERTIFICATE"          || fail=1
upload APPLE_CERTIFICATE_PASSWORD "$APPLE_CERTIFICATE_PASSWORD" || fail=1
upload APPLE_SIGNING_IDENTITY     "$APPLE_SIGNING_IDENTITY"     || fail=1
upload APPLE_ID                   "$APPLE_ID"                   || fail=1
upload APPLE_PASSWORD             "$APPLE_PASSWORD"             || fail=1
upload APPLE_TEAM_ID              "$APPLE_TEAM_ID"              || fail=1

[ "$fail" -eq 0 ] || die "有 Secret 没传上去，看上面的状态码。"

say ""
say "────────────────────────────────────────"
say "  ✓ 6 个 Secrets 配置完成"
say "────────────────────────────────────────"
say ""
say "确认一下（应列出 6 个名字，注意：值不会再显示）："
curl -s --max-time 20 -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "$API/repos/$REPO_OWNER/$REPO_NAME/actions/secrets" \
  | "$PY" -c "import sys,json; [print('    '+s['name']) for s in json.load(sys.stdin).get('secrets',[])]"
say ""
say "接下来出 iOS 包："
say "  https://github.com/$REPO_OWNER/$REPO_NAME/actions"
say "  →「构建 iOS 版」→ Run workflow → 选 app-store-connect"
say ""
say "跑完在 Artifacts 里下载 .ipa，再用 Transporter 上传到 App Store Connect。"
say "（Transporter 是 macOS 上的官方工具，App Store 里免费下载。）"
say ""
