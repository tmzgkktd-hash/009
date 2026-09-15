#!/usr/bin/env bash
# 把运行时需要的文件同步到 site/，用于发布到线上。
# 发布目录必须干净：不能带 desktop/package.json 和 Cargo.toml，
# 否则平台的工程探测会把它误判成 Node / Rust 项目。
#
# 用法：
#   ./build-site.sh                      默认不打包 assetlinks.json
#   ./build-site.sh --with-assetlinks    连 assetlinks.json 一起打包
#
# assetlinks.json 默认不打包，是因为它会触发 TWA 的域名校验 ——
# 校验一旦通过，安卓打开 App 就不再显示地址栏。这一步要等域名和
# 签名证书都定下来再做，所以做成显式开关，避免顺手带上去。

set -euo pipefail
cd "$(dirname "$0")"

WITH_ASSETLINKS=0
for arg in "$@"; do
  case "$arg" in
    --with-assetlinks) WITH_ASSETLINKS=1 ;;
    *) echo "未知参数：$arg（只支持 --with-assetlinks）" >&2; exit 1 ;;
  esac
done

OUT=site
rm -rf "$OUT"
mkdir -p "$OUT/css" "$OUT/js" "$OUT/icons"

cp index.html manifest.webmanifest sw.js "$OUT/"
cp css/style.css            "$OUT/css/"
cp js/*.js                  "$OUT/js/"
cp icons/icon.svg icons/icon-192.png icons/icon-512.png \
   icons/icon-180.png icons/icon-maskable-512.png "$OUT/icons/"

# TWA 的数字资产声明：Android 靠它确认「App 与域名同属一家」，
# 校验通过后打开 App 就不显示浏览器地址栏。
if [ "$WITH_ASSETLINKS" = "1" ]; then
  mkdir -p "$OUT/.well-known"
  cp android/assetlinks.json "$OUT/.well-known/assetlinks.json"
  echo "（已包含 .well-known/assetlinks.json）"
else
  echo "（未包含 .well-known/assetlinks.json，需要时加 --with-assetlinks）"
fi

echo "已同步到 $OUT/："
find "$OUT" -type f | sort | while read -r f; do
  printf "  %-34s %7d B\n" "${f#$OUT/}" "$(wc -c < "$f" | tr -d ' ')"
done
printf "\n合计 %s 字节\n" "$(find "$OUT" -type f -exec wc -c {} + | tail -1 | awk '{print $1}')"
