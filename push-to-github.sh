#!/usr/bin/env bash
# ---------------------------------------------------------------
# 推送到 GitHub
#
# 为什么需要这个脚本：
#   GitHub 从 2021 年起不再接受「账户密码」做 git 操作，
#   必须用 Personal Access Token（PAT）或 SSH key。
#   而 HTTPS 方式如果直接把 token 写进 remote URL，
#   它会明文留在 .git/config 里 —— 下次你随手把仓库发给别人、
#   或者备份 .git 目录，token 就漏了。
#   这个脚本在推送完成后把 remote URL 还原成干净的地址，
#   token 只存在于这一次进程里。
#
# 用法（二选一）：
#
#   1) 用 Personal Access Token（推荐，最快）
#      GITHUB_TOKEN=ghp_xxxxxxxx ./push-to-github.sh
#
#   2) 用 SSH（前提：已把公钥加到 GitHub）
#      USE_SSH=1 ./push-to-github.sh
#
# 怎么拿 PAT：
#   GitHub → Settings → Developer settings
#          → Personal access tokens → Tokens (classic)
#          → Generate new token (classic)
#   勾选 repo（完整仓库控制权）即可，其它不用勾。
#   生成后**只显示一次**，复制好再回来跑。
# ---------------------------------------------------------------

set -euo pipefail
cd "$(dirname "$0")"

REPO_OWNER="tmzgkktd-hash"
REPO_NAME="009"
BRANCH="${BRANCH:-main}"
REMOTE_NAME="origin"

say() { printf '%s\n' "$*"; }
die() { printf '\n[X] %s\n' "$*" >&2; exit 1; }

# 先确认仓库里有东西可推，别推个空仓库上去
if [ -z "$(git rev-parse --verify HEAD 2>/dev/null)" ]; then
  die "当前仓库还没有任何提交，先 git add / git commit 再推。"
fi

say "仓库：  https://github.com/$REPO_OWNER/$REPO_NAME"
say "分支：  $BRANCH"
say "提交：  $(git log --oneline | wc -l | tr -d ' ') 个"
say "文件：  $(git ls-files | wc -l | tr -d ' ') 个"
say "体积：  $(git count-objects -vH | awk '/size-pack/{print $2" "$3}')"
say ""

# ---------- 选择认证方式 ----------
if [ "${USE_SSH:-0}" = "1" ]; then
  say "方式：  SSH"
  PUSH_URL="git@github.com:$REPO_OWNER/$REPO_NAME.git"
  CLEAN_URL="$PUSH_URL"
else
  TOKEN="${GITHUB_TOKEN:-}"
  if [ -z "$TOKEN" ]; then
    say "方式：  HTTPS + Personal Access Token"
    say ""
    say "没有检测到 GITHUB_TOKEN。两种方式任选："
    say ""
    say "  A) 把 token 放进环境变量再跑（推荐，命令历史里不留 token）："
    say "       GITHUB_TOKEN=ghp_你的token ./push-to-github.sh"
    say ""
    say "  B) 改用 SSH（前提：公钥已加到 GitHub）："
    say "       USE_SSH=1 ./push-to-github.sh"
    say ""
    die "需要认证信息。生成 token：https://github.com/settings/tokens （勾 repo 即可）"
  fi
  say "方式：  HTTPS + Token（推完即从配置中移除）"
  PUSH_URL="https://$TOKEN@github.com/$REPO_OWNER/$REPO_NAME.git"
  CLEAN_URL="https://github.com/$REPO_OWNER/$REPO_NAME.git"
fi

# ---------- 配置 remote ----------
if git remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
  git remote set-url "$REMOTE_NAME" "$PUSH_URL"
else
  git remote add "$REMOTE_NAME" "$PUSH_URL"
fi

# 无论成功失败都要把 token 从 .git/config 里清掉
cleanup() {
  # shellcheck disable=SC2317
  git remote set-url "$REMOTE_NAME" "$CLEAN_URL" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ---------- 推送 ----------
say ""
say "────────────────────────────────────────"
say "  推送中…"
say "────────────────────────────────────────"
if ! git push -u "$REMOTE_NAME" "$BRANCH"; then
  say ""
  say "推送失败，常见原因："
  say "  • token 没勾 repo 权限，或已过期/被撤销"
  say "  • 远程仓库不是空的（里面有 README/LICENSE），"
  say "    需要先合并：git pull --rebase origin $BRANCH 再重跑"
  say "  • 仓库名或用户名写错了"
  die "推送未完成。"
fi

say ""
say "────────────────────────────────────────"
say "  ✓ 推送成功"
say "────────────────────────────────────────"
say ""
say "仓库地址： https://github.com/$REPO_OWNER/$REPO_NAME"
say ""
say "接下来出 Windows 安装包："
say "  1. 打开 https://github.com/$REPO_OWNER/$REPO_NAME/actions"
say "  2. 左侧点「构建 Windows 版」"
say "  3. 右上角 Run workflow → 选 nsis,msi → 绿色的 Run workflow"
say "  4. 等 40~60 分钟，在该次运行的 Artifacts 里下载 音转文-windows.zip"
say ""
say "出 iOS 包同理，点「构建 iOS 版」，但要先配 6 个 Apple 的 Secrets，"
say "步骤见 store/GO-LIVE.md §2.1.3。"
say ""