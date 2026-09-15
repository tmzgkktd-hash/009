#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
音转文 发布包构建器（网页版部分）

    python3 build-release.py              # 只打在线版网页包（小，约 200 KB）
    python3 build-release.py --offline    # 额外打离线版网页包（含 540MB 模型，约 570 MB）

产出到 release/：
  音转文-单文件版.html     所有资源内联，双击即用（需要联网取模型）
  音转文-网页版/           完整目录 + 双击启动脚本
  音转文-网页版.zip        上面全部打包
  音转文-网页离线版.zip    仅在 --offline 时生成，含模型与运行时，完全离线
  使用说明.txt             面向使用者的说明

⚠️ 本脚本只负责「网页版」这几个文件。
   APK / DMG / EXE / IPA 由各自的构建脚本产出，放在同一个 release/ 里。
   所以这里绝不能整个清空 release/ —— 早期版本用 shutil.rmtree(RELEASE)，
   在安装包也放进 release/ 之后，那个写法会把辛苦构建的 600MB DMG 一起删掉。
"""

import base64
import os
import re
import shutil
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
RELEASE = os.path.join(ROOT, "release")
VERSION = "2.0.0"

WEB_DIR_NAME = "音转文-网页版"
SINGLE_NAME = "音转文-单文件版.html"
ZIP_NAME = f"音转文-网页版.zip"
ZIP_OFFLINE_NAME = f"音转文-网页离线版.zip"

# 这些是「安装包」，由别的脚本生成。本脚本碰都不碰它们。
INSTALLERS = [
    f"音转文-{VERSION}.apk",
    f"音转文-{VERSION}.dmg",
    f"音转文-{VERSION}-setup.exe",
    f"音转文-{VERSION}.msi",
    f"音转文-{VERSION}.ipa",
]

# 网页版运行时需要的文件（相对 ROOT）
RUNTIME = [
    "index.html",
    "manifest.webmanifest",
    "sw.js",
    "css/style.css",
    "js/app.js",
    "js/whisper.js",
    "js/capture.js",
    "js/offline.js",
    "js/zh-convert.js",
    "icons/icon.svg",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "icons/icon-180.png",
    "icons/icon-maskable-512.png",
]

# 内联进单文件版的脚本。顺序必须和 index.html 里一致 ——
# app.js 依赖前面几个挂到 window 上的模块。
SCRIPTS = [
    "js/zh-convert.js",
    "js/capture.js",
    "js/whisper.js",
    "js/offline.js",
    "js/app.js",
]


def read_text(rel: str) -> str:
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


def data_uri(rel: str) -> str:
    """把文件转成 data URI，直接嵌进 HTML。"""
    path = os.path.join(ROOT, rel)
    mime = {
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".webmanifest": "application/manifest+json",
    }[os.path.splitext(rel)[1]]
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return f"data:{mime};base64,{b64}"


# ------------------------------------------------------------------ 单文件版
def build_single_file() -> str:
    html = read_text("index.html")
    css = read_text("css/style.css")

    # 1. 外链样式 → 内联
    html = html.replace(
        '<link rel="stylesheet" href="css/style.css" />',
        "<style>\n" + css + "\n</style>",
    )

    # 2. 图标 → data URI
    html = html.replace('href="icons/icon.svg"', f'href="{data_uri("icons/icon.svg")}"')
    html = html.replace('href="icons/icon-180.png"', f'href="{data_uri("icons/icon-180.png")}"')

    # 3. manifest 在 file:// 下取不到，直接内联成 data URI
    html = html.replace(
        '<link rel="manifest" href="manifest.webmanifest" />',
        f'<link rel="manifest" href="{data_uri("manifest.webmanifest")}" />',
    )

    # 4. 外链脚本 → 内联
    # 必须按 SCRIPTS 的顺序逐个替换：app.js 依赖前面几个挂到 window 上的模块。
    # 早先这里只内联了 app.js，结果单文件版会去请求根本不存在的 js/whisper.js，
    # 离线引擎整个失效。所以下面还要再做一次「有没有漏网外链」的断言。
    for rel in SCRIPTS:
        tag = f'<script src="{rel}"></script>'
        if tag not in html:
            raise SystemExit(f"[build] index.html 里找不到 {tag}，内联顺序和页面不一致？")
        html = html.replace(tag, "<script>\n" + read_text(rel) + "\n</script>")

    leftover = re.findall(r'<script src="([^"]+)"', html)
    if leftover:
        raise SystemExit(f"[build] 还有未内联的脚本：{leftover}")

    # 5. 标注为单文件版
    html = html.replace(
        "<title>音转文 · 声音转文字</title>",
        f"<title>音转文 · 声音转文字（单文件版 v{VERSION}）</title>\n"
        f"<!-- 单文件版：CSS / JS / 图标已全部内联。\n"
        f"     注意：离线模型有 540MB，不可能内联进来，\n"
        f"     首次识别仍需联网下载模型；下过一次之后浏览器会缓存。\n"
        f"     要装完就能断网用，请用 APK / DMG / EXE / IPA。 -->",
    )

    return html


# ------------------------------------------------------------------ 启动脚本
MAC_LAUNCHER = r"""#!/bin/bash
# 音转文 启动器（macOS）
# 双击本文件：自动起一个本地服务器并打开浏览器。
# 之所以要起服务器而不是直接开 HTML，是因为 Safari 在 file:// 下会拦截麦克风。

cd "$(dirname "$0")" || exit 1

PORT=8777
while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT + 1))
  if [ "$PORT" -gt 8900 ]; then
    echo "找不到可用端口，请先关闭占用 8777-8900 的程序。"
    read -r -p "按回车键退出..."
    exit 1
  fi
done

if ! command -v python3 >/dev/null 2>&1; then
  echo "没有找到 python3。"
  echo "macOS 一般自带 python3；如果没有，可以改用 Chrome 直接打开「音转文-单文件版.html」。"
  read -r -p "按回车键退出..."
  exit 1
fi

python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" >/dev/null 2>&1
  exit 0
}
trap cleanup INT TERM EXIT

sleep 1
open "http://127.0.0.1:$PORT/"

cat <<EOF

  音转文 已启动
  ────────────────────────────────────
  地址：http://127.0.0.1:$PORT/

  浏览器打开后，点圆形按钮开始说话。
  首次使用需要允许麦克风权限。

  停止服务：直接关掉这个窗口，或按 Ctrl+C。
EOF

wait "$SERVER_PID"
"""

WIN_LAUNCHER = r"""@echo off
chcp 65001 >nul
title 音转文 启动器
cd /d "%~dp0"

echo.
echo   音转文 正在启动...
echo.

where python >nul 2>&1
if errorlevel 1 (
  echo   没有找到 Python。
  echo.
  echo   两个办法，任选其一：
  echo     1^) 用 Chrome 或 Edge 直接打开「音转文-单文件版.html」
  echo     2^) 到 https://www.python.org/downloads/ 装一个 Python，再双击本文件
  echo.
  pause
  exit /b 1
)

set PORT=8777
start "" /b python -m http.server %PORT% --bind 127.0.0.1
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:%PORT%/

echo   音转文 已启动
echo   ------------------------------------
echo   地址：http://127.0.0.1:%PORT%/
echo.
echo   浏览器打开后，点圆形按钮开始说话。
echo   首次使用需要允许麦克风权限。
echo.
echo   停止服务：直接关掉这个窗口。
echo.
pause >nul
taskkill /f /im python.exe >nul 2>&1
"""

README_TXT = """音转文 · 声音转文字  v{version}
================================================

macOS / Windows / iOS / Android 四端可用。
装成 App 之后完全离线运行，不上传任何数据。


【四个安装包】

  Android  音转文-{version}.apk
           传到手机上点开安装。安卓会提示"来自未知来源"，
           在设置里允许一次即可。需要 Android 6.0 及以上。

  macOS    音转文-{version}.dmg
           双击打开，把「音转文」拖进「应用程序」。
           首次打开会被系统拦下（因为没买签名证书），
           右键点图标 → 打开 → 打开，放行一次即可。

  Windows  音转文-{version}-setup.exe
           双击安装。首次运行可能弹 SmartScreen 警告，
           点「更多信息」→「仍要运行」。

  iOS      音转文-{version}.ipa
           需要通过 TestFlight 或 Xcode 安装，不能直接双击。


【离线是怎么回事】

  四个安装包里都内置了完整的识别模型（540 MB）和推理运行时。
  装完之后，断网也能用，飞行模式也能用。
  录音和文字全程留在这台设备上，不经过任何服务器。

  这也是安装包为什么这么大 —— 540 MB 里 537 MB 是模型。
  换来的是：不依赖网络、不依赖任何厂商的云服务、
  在国内网络环境下也能正常工作。


【怎么用】

  1. 打开 App，第一次会问麦克风权限，选「允许」
  2. 点屏幕下方那个圆形按钮开始说话
  3. 说完再点一下停止，文字就出现在上方了
  4. 点右上角的导出按钮，可以存成 txt 或 html

  · txt  纯文本，记事本直接打开
  · html 带排版的网页，双击就能在浏览器里看
  · 手机上保存的位置是「下载 / 音转文」文件夹
  · 电脑上会弹出「另存为」对话框，自己挑位置


【找不到导出的文件？】

  Android ：文件管理器 → 内部存储 → Download → 音转文
  macOS   ：默认在你上次保存的位置，或「下载」文件夹
  Windows ：默认「下载」文件夹
  iOS     ：导出后会问你要存到「文件」App 的哪里


【录音按钮在哪】

  页面下方那个大圆按钮。文字区在上方，说话时字会自己往上滚。


【识别效果不好怎么办】

  · 离麦克风近一点，环境安静一些，效果会明显变好
  · 一次别说太长，一句一句说准确率更高
  · 中文识别用的是 large-v3-turbo 模型，是当前开源里最好的之一


【常见问题】

  Q：安装包为什么这么大？
  A：因为内置了 540 MB 的识别模型。好处是装完就不用联网了。
     想省空间只能改用在线版（网页版），代价是每次识别都要联网。

  Q：手机上识别有点慢？
  A：手机上是否能用 GPU 加速取决于系统 WebView 内核的版本。
     支持的话很快；不支持时会退回 CPU 计算，大模型会明显变慢。
     这种情况建议一次录短一点（十几秒）。

  Q：会收集我的录音吗？
  A：不会。没有网络请求，没有账号，没有统计。
     音频只在内存里处理，不写盘也不上传。

  Q：macOS 提示"无法打开，因为无法验证开发者"？
  A：这是没买苹果签名证书的正常表现。
     右键点 App 图标 → 打开 → 再点「打开」，放行一次就行。
     或者执行：xattr -dr com.apple.quarantine /Applications/音转文.app

  Q：Windows 提示"Windows 已保护你的电脑"？
  A：同理，点「更多信息」→「仍要运行」。
     这是因为没有买代码签名证书。


【上架信息（给分发的人看）】

  酷安          ：直接上传 APK，无体积限制
  Google Play   ：单个 APK 上限 200 MB，本包 550 MB 需要用
                  Play Asset Delivery 拆分，或改成首次启动下载模型
  App Store     ：需要付费开发者账号（99 美元/年）
  Microsoft Store：需要 EV 代码签名证书（约 300-500 美元/年）
"""


# ------------------------------------------------------------------ 构建

def clean_web_artifacts() -> None:
    """只删网页版自己的产物，绝不碰安装包。"""
    for name in [WEB_DIR_NAME, SINGLE_NAME, ZIP_NAME, ZIP_OFFLINE_NAME, "使用说明.txt"]:
        p = os.path.join(RELEASE, name)
        if os.path.isdir(p):
            shutil.rmtree(p)
        elif os.path.isfile(p):
            os.remove(p)
    # 老版本留下的目录名
    legacy = os.path.join(RELEASE, "VoiceType")
    if os.path.isdir(legacy):
        shutil.rmtree(legacy)


def main() -> None:
    offline = "--offline" in sys.argv

    os.makedirs(RELEASE, exist_ok=True)
    clean_web_artifacts()

    app_dir = os.path.join(RELEASE, WEB_DIR_NAME)

    # --- 完整版目录 ---
    for rel in RUNTIME:
        dst = os.path.join(app_dir, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(os.path.join(ROOT, rel), dst)

    # --- 启动脚本 ---
    mac_path = os.path.join(app_dir, "启动 音转文.command")
    with open(mac_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(MAC_LAUNCHER)
    os.chmod(mac_path, 0o755)

    with open(os.path.join(app_dir, "启动 音转文.bat"), "w", encoding="utf-8", newline="\r\n") as f:
        f.write(WIN_LAUNCHER)

    # --- 单文件版 ---
    single = os.path.join(RELEASE, SINGLE_NAME)
    with open(single, "w", encoding="utf-8") as f:
        f.write(build_single_file())
    shutil.copy2(single, os.path.join(app_dir, SINGLE_NAME))

    # --- 说明 ---
    with open(os.path.join(RELEASE, "使用说明.txt"), "w", encoding="utf-8") as f:
        f.write(README_TXT.format(version=VERSION))

    # --- 打包 zip（在线版）---
    # 安装包本身已经是压缩包，再塞进来毫无收益，所以 zip 只装网页版。
    zip_path = os.path.join(RELEASE, ZIP_NAME)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for base, _, files in os.walk(app_dir):
            for name in files:
                full = os.path.join(base, name)
                z.write(full, os.path.relpath(full, RELEASE))

    # --- 离线版 zip（可选）---
    if offline:
        vendor = os.path.join(ROOT, "vendor")
        models = os.path.join(ROOT, "models")
        missing = [p for p in (vendor, models) if not os.path.isdir(p)]
        if missing:
            print("\n  跳过离线版：缺少以下目录（先跑 fetch-models.sh 和 tools/build-vendor.mjs）")
            for p in missing:
                print(f"    {os.path.relpath(p, ROOT)}")
        else:
            print("\n  正在打离线版 zip（含 540MB 模型，这一步比较慢）…")
            off_path = os.path.join(RELEASE, ZIP_OFFLINE_NAME)
            with zipfile.ZipFile(off_path, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as z:
                for base, _, files in os.walk(app_dir):
                    for name in files:
                        full = os.path.join(base, name)
                        z.write(full, os.path.relpath(full, RELEASE))
                for top in ("vendor", "models"):
                    src = os.path.join(ROOT, top)
                    for base, _, files in os.walk(src):
                        for name in files:
                            full = os.path.join(base, name)
                            z.write(full, os.path.join(WEB_DIR_NAME, os.path.relpath(full, ROOT)))

    # --- 报告 ---
    print("\nrelease/ 目录：\n")
    for base, dirs, files in os.walk(RELEASE):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(base, name)
            size = os.path.getsize(full)
            mark = "  [安装包]" if name in INSTALLERS else ""
            print(f"  {os.path.relpath(full, RELEASE):<40} {size:>12,d} B{mark}")

    have = [n for n in INSTALLERS if os.path.isfile(os.path.join(RELEASE, n))]
    missing_inst = [n for n in INSTALLERS if n not in have]
    print(f"\n  已就绪的安装包：{len(have)}/{len(INSTALLERS)}")
    for n in have:
        print(f"    ✓ {n}")
    for n in missing_inst:
        print(f"    · {n}（还没构建）")


if __name__ == "__main__":
    main()
