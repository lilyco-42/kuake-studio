# kuake-studio 一键安装（Windows PowerShell）
#
#   irm https://github.com/lilyco-42/kuake-studio/releases/latest/download/install.ps1 | iex
#   .\install.ps1 -Version v0.5.15     # 指定版本
#
# 做的事：下载对应 Release 资产 → SHA256 校验 → 解压到 %LOCALAPPDATA%\Programs\kuake-studio
#         → 创建开始菜单与桌面快捷方式
param([string]$Version = "")

$ErrorActionPreference = "Stop"
$repo = "lilyco-42/kuake-studio"

if (-not $Version) {
  $rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
  $Version = $rel.tag_name
}
$ver = $Version.TrimStart("v")
$base = "https://github.com/$repo/releases/download/$Version"
$pkg = "kuake-studio-$ver-windows-x64.zip"

$tmp = Join-Path $env:TEMP "kuake-install-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Write-Host "→ 版本 $Version，下载 $pkg"
Invoke-WebRequest "$base/$pkg" -OutFile (Join-Path $tmp $pkg)
Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $tmp "SHA256SUMS")

$want = Get-Content (Join-Path $tmp "SHA256SUMS") |
  Where-Object { $_ -match "\s\*?$([regex]::Escape($pkg))$" } |
  ForEach-Object { ($_ -split '\s+')[0] } |
  Select-Object -First 1
if (-not $want) { throw "SHA256SUMS 里没有 $pkg" }
$got = (Get-FileHash (Join-Path $tmp $pkg) -Algorithm SHA256).Hash.ToLower()
if ($got -ne $want.ToLower()) { throw "SHA256 校验失败（期望 $want，实际 $got）" }
Write-Host "✓ SHA256 校验通过"

# 便携 zip 是「散文件」结构（exe/dist/run.bat 在根）；未来若加外层目录，
# 这里按 exe 反查也能兼容，避免硬编码目录名。
$stage = Join-Path $tmp "stage"
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Expand-Archive (Join-Path $tmp $pkg) -DestinationPath $stage -Force
$exeHit = Get-ChildItem -Path $stage -Recurse -Filter "kuake-studio.exe" -File | Select-Object -First 1
if (-not $exeHit) { throw "解压后没有找到 kuake-studio.exe" }
$src = $exeHit.Directory.FullName
$dest = Join-Path $env:LOCALAPPDATA "Programs\kuake-studio"
# runner / 精简系统上 %LOCALAPPDATA%\Programs 可能不存在，Move-Item 会因父目录缺失失败
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Move-Item $src $dest

$exe = Join-Path $dest "kuake-studio.exe"
$ws = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath("Programs"), [Environment]::GetFolderPath("Desktop"))) {
  $lnk = $ws.CreateShortcut((Join-Path $dir "夸克网盘.lnk"))
  $lnk.TargetPath = $exe
  $lnk.WorkingDirectory = $dest
  $lnk.IconLocation = "$exe,0"
  $lnk.Save()
}
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "✓ 已安装到 $dest"
Write-Host "  开始菜单与桌面已创建「夸克网盘」快捷方式；卸载时删除该目录和两个快捷方式即可"
Write-Host "  首次打开在「账号」页扫码登录"