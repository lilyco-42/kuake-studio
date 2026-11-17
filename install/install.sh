#!/usr/bin/env bash
# kuake-studio 一键安装（Linux / macOS）
#
#   curl -fsSL https://github.com/lilyco-42/kuake-studio/releases/latest/download/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- v0.5.15     # 指定版本
#   ./install.sh --uninstall                          # 卸载入口（不动凭据与已下载文件）
#
# 做的事：识别系统 → 下载对应 Release 资产 → 用 SHA256SUMS 校验 → 交给包内安装器
set -euo pipefail

REPO="lilyco-42/kuake-studio"
TAG="${KUAKE_VERSION:-}"
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    v*) TAG="$arg" ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux)
    [ "$arch" = "x86_64" ] || die "Linux 目前只提供 x86_64 包（当前 $arch）"
    suffix="linux-x64"
    ;;
  Darwin)
    suffix="macos-universal"
    ;;
  *)
    die "不支持的系统：$os（Windows 请用 install.ps1）"
    ;;
esac

if [ "$UNINSTALL" = 1 ]; then
  if [ -x "$HOME/.local/opt/kuake-studio/install.sh" ]; then
    "$HOME/.local/opt/kuake-studio/install.sh" --uninstall || true
  fi
  rm -rf "/Applications/kuake-studio.app" "$HOME/Applications/kuake-studio.app"
  say "✓ 已卸载（凭据与已下载文件未动）"
  exit 0
fi

if [ -z "$TAG" ]; then
  TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$TAG" ] || die "无法获取最新版本（可显式传 vX.Y.Z）"
fi
ver="${TAG#v}"
base="https://github.com/$REPO/releases/download/$TAG"
pkg="kuake-studio-$ver-$suffix.tar.gz"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
say "→ 版本 $TAG（$os/$arch）"
say "→ 下载 $pkg"
curl -fsSL --retry 3 -o "$tmp/$pkg" "$base/$pkg" || die "下载失败：$base/$pkg"
curl -fsSL --retry 3 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || die "下载 SHA256SUMS 失败"
want="$(awk -v f="$pkg" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS" | head -1)"
[ -n "$want" ] || die "SHA256SUMS 里没有 $pkg"
if command -v sha256sum >/dev/null 2>&1; then
  got="$(sha256sum "$tmp/$pkg" | awk '{print $1}')"
else
  got="$(shasum -a 256 "$tmp/$pkg" | awk '{print $1}')"
fi
[ "$got" = "$want" ] || die "SHA256 校验失败（期望 $want，实际 $got）"
say "✓ SHA256 校验通过"

tar -xzf "$tmp/$pkg" -C "$tmp"
dir="$tmp/kuake-studio-$ver-$suffix"

if [ "$os" = "Linux" ]; then
  (cd "$dir" && ./install.sh) || die "安装器执行失败"
  say "✓ 已安装：应用菜单 / 桌面「夸克网盘」（服务 127.0.0.1:8787）"
else
  (cd "$dir" && ./install-macos.sh) || die "安装器执行失败"
  say "✓ 已安装到 /Applications（或 ~/Applications），Launchpad 可搜索「夸克网盘」"
fi