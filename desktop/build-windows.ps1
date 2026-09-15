<#
  音转文 · Windows 一键构建脚本
  ================================================================
  在你的 Windows 机器上跑这个脚本，就能得到安装包：

      ..\release\音转文-2.0.0-setup.exe     ← NSIS 安装包，双击即装
      ..\release\音转文-2.0.0.msi           ← MSI 安装包（企业分发用）

  用法（在 PowerShell 里）：
      cd 到本文件所在目录
      powershell -ExecutionPolicy Bypass -File .\build-windows.ps1

  首次运行会：
      1. 检查 Node / Rust / MSVC 三样东西齐不齐，缺哪样明确告诉你怎么装
      2. 把网页资源 + 离线运行时 + 726MB 模型同步进打包目录
      3. 编译并打出安装包（第一次要 20~40 分钟，之后增量会快很多）

  注意：本脚本只负责"构建"，不负责"签名"。
  上架微软商店需要 EV 代码签名证书，那是另一套流程，见 README。
#>

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Say  ($m) { Write-Host $m }
function Head ($m) { Write-Host ""; Write-Host ("─" * 52); Write-Host "  $m"; Write-Host ("─" * 52) }
function Ok   ($m) { Write-Host "  [OK] $m"   -ForegroundColor Green }
function Warn ($m) { Write-Host "  [!]  $m"   -ForegroundColor Yellow }
function Die  ($m) { Write-Host "  [X]  $m"   -ForegroundColor Red; exit 1 }

Head "音转文 · Windows 构建  (v2.0.0)"

# ================================================================
# 0. 前置检查
# ================================================================
Head "1/5  检查构建环境"

# ---- Node ----
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Die @"
没找到 Node.js。

装法（任选其一）：
  1. 官网下载 LTS 版：https://nodejs.org/zh-cn/download
  2. 用 winget：  winget install OpenJS.NodeJS.LTS
装完请重新打开 PowerShell 再跑本脚本。
"@
}
Ok "Node.js $(& node --version)"

# ---- Rust ----
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) {
  Die @"
没找到 Rust。

装法：
  1. 打开 https://rustup.rs/ ，下载 rustup-init.exe 并运行
  2. 安装时选默认选项（1），它会装 MSVC 工具链
  3. 装完关掉 PowerShell 重开，再跑本脚本
"@
}
Ok "Rust $(& rustc --version)"

# ---- MSVC 链接器 ----
# Rust 在 Windows 上默认用 MSVC 目标，没有 C++ 生成工具就会在链接阶段炸掉，
# 而且报错信息很长、很不直观。这里提前查出来，省得等半小时才发现。
$hasLink = $false
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
  $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
  if ($vsPath) { $hasLink = $true; Ok "Visual Studio C++ 生成工具：$vsPath" }
}
if (-not $hasLink) {
  $link = Get-Command link.exe -ErrorAction SilentlyContinue
  if ($link) { $hasLink = $true; Ok "找到链接器 $($link.Source)" }
}
if (-not $hasLink) {
  Warn @"
没检测到 Visual Studio 的 C++ 生成工具。

Rust 在 Windows 上编译需要它，缺了会在链接阶段失败。
装法：
  1. 下载 https://aka.ms/vs/17/release/vs_BuildTools.exe
  2. 运行时勾选「使用 C++ 的桌面开发」这一个工作负载即可
     （不用装完整的 Visual Studio，Build Tools 就够）
  3. 装完关掉 PowerShell 重开，再跑本脚本
"@
  Die "环境不齐，先补上再继续。"
}

# ---- 关键素材 ----
Head "2/5  检查随包资源"

# ⚠️ 只上**一**级，不是两级。
# $PSScriptRoot 是本脚本所在目录，也就是 voicetype\desktop；
# 再上一级才是 voicetype（仓库根，models\ 和 vendor\ 都在那儿）。
# 之前写的是 '..\..'，解析到了 voicetype 的**父目录**，
# 于是下面第一个检查就失败，还报「缺少离线推理运行时，先跑 build-vendor.mjs」
# —— 文件其实一直都在，只是找错了地方。
# （macOS 的 build-mac.sh 同样是 cd desktop 后 ROOT="$(cd .. && pwd)"，一级。）
$root = Resolve-Path (Join-Path $PSScriptRoot '..')             # voicetype\
$modelDir = Join-Path $root 'models\whisper-large-v3-turbo'
$vendorJs = Join-Path $root 'vendor\transformers.js'

if (-not (Test-Path $vendorJs)) {
  Die "缺少离线推理运行时：$vendorJs`n先跑 tools\build-vendor.mjs 生成它。"
}

$enc = Join-Path $modelDir 'onnx\encoder_model_q4.onnx'
$dec = Join-Path $modelDir 'onnx\decoder_model_merged_q4.onnx'
if (-not (Test-Path $enc)) { Die "缺少模型编码器：$enc`n先跑 fetch-models.sh（macOS/Linux）或在能上网的机器上下好再拷过来。" }
if (-not (Test-Path $dec)) { Die "缺少模型解码器：$dec" }

# 体积校验：半截的模型打进去，装出来就是个一打开就报错的包
$encSize = (Get-Item $enc).Length
$decSize = (Get-Item $dec).Length
if ([Math]::Abs($encSize - 424942775) -gt 1000000) { Die "编码器体积不对（$encSize 字节），多半没下完，重新下载后再试。" }
if ([Math]::Abs($decSize - 334147222) -gt 1000000) { Die "解码器体积不对（$decSize 字节），多半没下完，重新下载后再试。" }
Ok ("编码器 {0:N1} MB" -f ($encSize / 1MB))
Ok ("解码器 {0:N1} MB" -f ($decSize / 1MB))

# 反向校验：换量化格式（q4f16 → q4）时旧文件不会自己消失，
# 而 bundle.resources 是把整个 models 目录搬进安装包的 ——
# 留着旧的会让安装包白白多出约 537MB，用户还多下一倍流量。
# 宁可在这里直接失败，也别打出一个虚胖的包。
$stale = Get-ChildItem $modelDir -Recurse -Filter '*q4f16*' -ErrorAction SilentlyContinue
if ($stale) {
  Warn "models 目录里还留着旧的 q4f16 模型，会让安装包白胖约 537MB："
  $stale | ForEach-Object { Warn ("  " + $_.FullName) }
  Die "先删掉上面这些旧文件，再重新构建。"
}
Ok "无陈旧量化残留"

# ================================================================
# 3. 同步资源
# ================================================================
Head "3/5  同步网页资源到打包目录"
& node (Join-Path $PSScriptRoot 'scripts\sync-app.mjs')
if ($LASTEXITCODE -ne 0) { Die "资源同步失败。" }

# ================================================================
# 4. 装依赖并构建
# ================================================================
Head "4/5  安装构建依赖"
if (-not (Test-Path 'node_modules')) {
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Die "npm install 失败。" }
} else {
  Ok "node_modules 已存在，跳过"
}

Head "5/5  编译并打包（726MB 模型，第一次会比较久，请耐心等）"
Say "  正在构建 NSIS + MSI 安装包…"

& npx tauri build --bundles nsis,msi
if ($LASTEXITCODE -ne 0) { Die "构建失败，请看上面的错误输出。" }

# ================================================================
# 收集产物
# ================================================================
$relDir = Join-Path $root 'release'
if (-not (Test-Path $relDir)) { New-Item -ItemType Directory -Path $relDir | Out-Null }

$nsisDir = 'src-tauri\target\release\bundle\nsis'
$msiDir  = 'src-tauri\target\release\bundle\msi'

$found = @()
if (Test-Path $nsisDir) {
  Get-ChildItem $nsisDir -Filter *.exe | ForEach-Object {
    $dest = Join-Path $relDir "音转文-2.0.0-setup.exe"
    Copy-Item $_.FullName $dest -Force
    $found += $dest
  }
}
if (Test-Path $msiDir) {
  Get-ChildItem $msiDir -Filter *.msi | ForEach-Object {
    $dest = Join-Path $relDir "音转文-2.0.0.msi"
    Copy-Item $_.FullName $dest -Force
    $found += $dest
  }
}

Head "构建完成"
if ($found.Count -eq 0) {
  Warn "没有在 bundle 目录里找到安装包，请检查上面的输出。"
  exit 1
}
foreach ($f in $found) {
  $mb = (Get-Item $f).Length / 1MB
  Say ("  {0}" -f $f)
  Say ("    {0:N1} MB" -f $mb)
}
Say ""
Say "  这两个文件就是可以分发的 Windows 安装包。"
Say "  上架微软商店需要 EV 代码签名证书，见 README 的「上架准备」一节。"
Say ""
