#!/usr/bin/env bash
# kuake-studio macOS 安装器：把 .app 放进 /Applications，Launchpad / Spotlight 即可搜索到
# 用法：解压 *-macos-universal.tar.gz 后，在该目录里运行 ./install-macos.sh
#      可选参数：./install-macos.sh <目标目录>（默认 /Applications，无权限时回退 ~/Applications）
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$SRC/kuake-studio.app"
[ -d "$APP" ] || {
  echo "✗ 找不到 kuake-studio.app；请在解压后的目录里运行本脚本" >&2
  exit 1
}
dest="${1:-/Applications}"
if [ ! -w "$dest" ]; then
  dest="$HOME/Applications"
fi
mkdir -p "$dest"
rm -rf "$dest/kuake-studio.app"
cp -R "$APP" "$dest/"
# 未签名包的首次打开提示：去掉隔离属性（失败不影响使用）
xattr -dr com.apple.quarantine "$dest/kuake-studio.app" 2>/dev/null || true
# 让 Launchpad / Spotlight 立即刷新图标与索引
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$dest/kuake-studio.app" 2>/dev/null || true
echo "✓ 已安装到 $dest/kuake-studio.app"