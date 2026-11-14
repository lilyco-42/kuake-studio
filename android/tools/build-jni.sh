#!/usr/bin/env bash
# 本机 / CI 通用：交叉编译 Android JNI cdylib（desktop 特性 = 进程内跑同一套 axum 服务）。
# 用法：./android/tools/build-jni.sh [rust-target ...]
#   默认 aarch64-linux-android；传多个就编多个，例如再加 x86_64-linux-android 给模拟器。
# 产物：android/target/<triple>/release/libkuake_studio_jni.so
set -eo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)

# 定位 NDK：显式 > SDK/ndk 里版本号最大的 > 报错
NDK="$ANDROID_NDK_HOME"
if [ -z "$NDK" ]; then
  SDK="$ANDROID_SDK_ROOT"
  [ -n "$SDK" ] || SDK="$ANDROID_HOME"
  [ -n "$SDK" ] || SDK="$HOME/Android/Sdk"
  NDK=$(ls -d "$SDK"/ndk/*/ 2>/dev/null | sort -V | tail -1 || true)
fi
if [ -z "$NDK" ] || [ ! -d "$NDK/toolchains/llvm/prebuilt" ]; then
  echo "找不到 Android NDK：请设置 ANDROID_NDK_HOME 或 ANDROID_SDK_ROOT" >&2
  exit 1
fi

HOST_BIN=$(ls -d "$NDK"/toolchains/llvm/prebuilt/*/bin | head -1)
export PATH="$HOST_BIN:$PATH"

# 没传 target 就编默认的 arm64
[ "$#" -gt 0 ] || set -- aarch64-linux-android

# cc-rs 的 CC/AR 按 target 后缀取名；三个 target 一次性全设好，省掉动态变量名。
# linker 由 android/.cargo/config.toml 里的裸 clang 名从 PATH 解析。
export CC_aarch64_linux_android="$HOST_BIN/aarch64-linux-android24-clang"
export CC_x86_64_linux_android="$HOST_BIN/x86_64-linux-android24-clang"
export CC_armv7_linux_androideabi="$HOST_BIN/armv7a-linux-androideabi24-clang"
export AR_aarch64_linux_android="$HOST_BIN/llvm-ar"
export AR_x86_64_linux_android="$HOST_BIN/llvm-ar"
export AR_armv7_linux_androideabi="$HOST_BIN/llvm-ar"

# 显式指定产物目录：本机 ~/.cargo/config.toml 可能把 target-dir 指去共享缓存
export CARGO_TARGET_DIR="$REPO/android/target"

echo "[jni] NDK: $NDK"
cd "$REPO/android"
for t in "$@"; do
  case "$t" in
    aarch64-linux-android|x86_64-linux-android|armv7-linux-androideabi) ;;
    *) echo "未知 rust target: $t" >&2; exit 1 ;;
  esac
  echo "[jni] === cargo build --release --target $t ==="
  cargo build --release --locked --target "$t"
  so="$CARGO_TARGET_DIR/$t/release/libkuake_studio_jni.so"
  [ -f "$so" ] || { echo "缺产物: $so" >&2; exit 1; }
  echo "[jni] OK: $so"
done
