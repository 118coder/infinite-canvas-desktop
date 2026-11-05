# 一键构建桌面版：infinite-canvas-desktop.exe
# 需要：Bun 和 Go 1.25+（脚本会自动检查，找不到 Go 时会给出安装指引）
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$web = Join-Path $root "web"

Write-Host ""
Write-Host "========== 无限画布桌面版构建 ==========" -ForegroundColor Cyan

# ---- 环境自检 ----
$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun) {
    Write-Host "[错误] 未找到 bun。请先安装 Bun：https://bun.sh" -ForegroundColor Red
    Read-Host "按回车键退出"
    exit 1
}

$go = $null
$goCmd = Get-Command go -ErrorAction SilentlyContinue
if ($goCmd) { $go = $goCmd.Source }
if (-not $go) {
    foreach ($candidate in @("$env:ProgramFiles\Go\bin\go.exe", "C:\Go\bin\go.exe", "$env:LOCALAPPDATA\Programs\Go\bin\go.exe")) {
        if (Test-Path $candidate) { $go = $candidate; break }
    }
}
if (-not $go) {
    Write-Host "[错误] 未找到 Go。请安装 Go 1.25 或更高版本：" -ForegroundColor Red
    Write-Host "       方式一：winget install GoLang.Go"
    Write-Host "       方式二：https://go.dev/dl/ 下载 Windows msi 安装"
    Read-Host "按回车键退出"
    exit 1
}
$env:PATH = "$(Split-Path $go);$env:PATH"
$goVersion = & go version
if ($LASTEXITCODE -ne 0 -or -not $goVersion) {
    Write-Host "[错误] 检测到 Go 但无法运行（安装可能不完整）：$go" -ForegroundColor Red
    Write-Host "       请重新安装 Go：winget install GoLang.Go 或 https://go.dev/dl/"
    Read-Host "按回车键退出"
    exit 1
}
Write-Host "环境检查 OK：bun $(bun --version)，$goVersion" -ForegroundColor DarkGray

$apiDir = "src/app/api"
$apiMoved = $false

Write-Host "==> [1/4] 构建前端（静态导出），约 1-3 分钟..."
Push-Location $web
try {
    bun run build:bridge
    if ((Test-Path $apiDir) -and -not (Test-Path "src/app/_api")) {
        Move-Item $apiDir "src/app/_api"
        $apiMoved = $true
    }
    $env:BUILD_DESKTOP = "1"
    $versionFile = Join-Path $PSScriptRoot "VERSION"
    if (Test-Path $versionFile) {
        $env:NEXT_PUBLIC_APP_VERSION = (Get-Content $versionFile -Raw).Trim()
    }
    try {
        bunx next build
    }
    finally {
        Remove-Item Env:BUILD_DESKTOP -ErrorAction SilentlyContinue
        Remove-Item Env:NEXT_PUBLIC_APP_VERSION -ErrorAction SilentlyContinue
    }
}
finally {
    if ($apiMoved) { Move-Item "src/app/_api" $apiDir }
    Pop-Location
}

Write-Host "==> [2/4] 收集前端静态产物..."
$dist = Join-Path $root "desktop\dist"
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
Copy-Item (Join-Path $web "out") $dist -Recurse

Write-Host "==> [3/4] 编译桌面程序（首次约 1-2 分钟）..."
Push-Location $root
try {
    $env:CGO_ENABLED = "0"
    go build -trimpath -ldflags "-s -w" -o infinite-canvas-desktop.exe ./desktop
}
finally {
    Remove-Item Env:CGO_ENABLED -ErrorAction SilentlyContinue
    Pop-Location
}

Write-Host "==> [4/4] 构建完成！" -ForegroundColor Green
Write-Host "    程序位置：$root\infinite-canvas-desktop.exe"
Write-Host "    双击它即可启动，会自动打开浏览器；数据保存在同目录 data/ 文件夹。"
Read-Host "按回车键退出"
