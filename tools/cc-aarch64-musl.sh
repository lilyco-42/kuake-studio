#!/usr/bin/env bash
# cc-rs 交叉编译时给 C 编译器追加 --target=<triple>；在没有对应 SDK 的 Runner 上
# （Android 不装 NDK、鸿蒙无 OHOS SDK）会有两类假象：
#   * host clang + x86-64 glibc 头把 uintptr_t 错定成 32 位（ring 的断言直接失败）；
#   * 不设 CC 时 cc-rs 用 host gcc 把 C 编成 x86-64，混进 arm64 归档（"假成功"）。
# zig cc 自带 aarch64 musl sysroot，字长正确，产出纯 AArch64 目标文件。
# 这里丢弃 cc-rs 追加的 --target=，改用 zig 的 -target aarch64-linux-musl。
# 静态库不做最终链接，musl 与 bionic / OHOS libc 的差异由宿主 App 链接时消解。
set -euo pipefail
args=()
for a in "$@"; do
  case "$a" in
    --target=*) ;;
    *) args+=("$a") ;;
  esac
done
exec zig cc -target aarch64-linux-musl "${args[@]}"
