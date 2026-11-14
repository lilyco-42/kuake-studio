#!/usr/bin/env bash
# 不用 Gradle / AndroidX：aapt2 + javac + d8 + zipalign + apksigner 纯命令行打出可安装 APK。
# 本机与 GitHub Actions 共用；外部依赖只有 android.jar / build-tools / NDK / JDK。
# 自动收集 android/target/<triple>/release/libkuake_studio_jni.so 的所有 ABI 打进同一个 APK，
# arm64 真机与 x86_64 模拟器都能装。可用 KUAKE_STUDIO_SO 单独指定一个 .so（只打 arm64）。
set -eo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
APP="$REPO/android/app"
FRONTEND_DIST="$REPO/frontend/dist"

VER=$(sed -n 's/^version = "\(.*\)"/\1/p' "$REPO/Cargo.toml" | head -1)
[ -n "$VER" ] || { echo "读不到 Cargo.toml version" >&2; exit 1; }

SDK="$ANDROID_SDK_ROOT"
[ -n "$SDK" ] || SDK="$ANDROID_HOME"
[ -n "$SDK" ] || SDK="$HOME/Android/Sdk"
[ -d "$SDK" ] || { echo "找不到 Android SDK: $SDK" >&2; exit 1; }

# 编译 SDK：优先稳定的 android-36，否则取镜像里最新的一个
PLATFORM_JAR="$SDK/platforms/android-36/android.jar"
if [ ! -f "$PLATFORM_JAR" ]; then
  PLATFORM_JAR=$(ls -1 "$SDK"/platforms/android-*/android.jar | sort -V | tail -1)
fi
BT=$(ls -d "$SDK"/build-tools/*/ | sort -V | tail -1)
BT=$(cd "$BT" && pwd)
[ -f "$PLATFORM_JAR" ] || { echo "找不到 android.jar" >&2; exit 1; }
for t in aapt2 d8 zipalign apksigner; do
  [ -x "$BT/$t" ] || { echo "build-tools 缺 $t: $BT" >&2; exit 1; }
done
echo "[apk] SDK=$SDK"
echo "[apk] platform=$PLATFORM_JAR"
echo "[apk] build-tools=$BT"

[ -f "$FRONTEND_DIST/index.html" ] || { echo "找不到 frontend/dist（先跑前端 build）" >&2; exit 1; }

WORK="$REPO/android/build/apk-work"
rm -rf "$WORK"
mkdir -p "$WORK/classes" "$WORK/assets" "$WORK/lib"
LINK_DEBUG=""
if [ "${KUAKE_STUDIO_APK_DEBUGGABLE:-0}" = "1" ]; then
  LINK_DEBUG="--debug-mode"
fi

# KUAKE_STUDIO_APK_DEBUGGABLE=1 出一个 android:debuggable="true" 的诊断包，
# 文件名带 -debuggable 后缀，绝不会顶替要发布的 kuake-studio-<ver>-android.apk。
# 只用于 adb run-as 进 App 私有目录验证凭据落盘（生产包保持不可调试）。
if [ "${KUAKE_STUDIO_APK_DEBUGGABLE:-0}" = "1" ]; then
  OUT="$REPO/pkg/kuake-studio-$VER-android-debuggable.apk"
else
  OUT="$REPO/pkg/kuake-studio-$VER-android.apk"
fi
mkdir -p "$(dirname "$OUT")"

# 前端产物打成单个 zip，Java 层用 ZipInputStream 解到 filesDir/dist
(cd "$FRONTEND_DIST" && zip -q -r "$WORK/assets/dist.zip" .)

# 收集 JNI .so -> lib/<abi>/libkuake_studio_jni.so（未压缩存储，Android 直接 mmap）
SO_COUNT=0
if [ -n "$KUAKE_STUDIO_SO" ]; then
  [ -f "$KUAKE_STUDIO_SO" ] || { echo "找不到 KUAKE_STUDIO_SO=$KUAKE_STUDIO_SO" >&2; exit 1; }
  mkdir -p "$WORK/lib/arm64-v8a"
  cp "$KUAKE_STUDIO_SO" "$WORK/lib/arm64-v8a/libkuake_studio_jni.so"
  SO_COUNT=1
else
  for so in "$REPO"/android/target/*/release/libkuake_studio_jni.so; do
    [ -f "$so" ] || continue
    triple=$(basename "$(dirname "$(dirname "$so")")")
    case "$triple" in
      aarch64-linux-android)   abi=arm64-v8a ;;
      x86_64-linux-android)    abi=x86_64 ;;
      armv7-linux-androideabi) abi=armeabi-v7a ;;
      *) echo "[apk] 跳过未知 ABI 目录: $triple" >&2; continue ;;
    esac
    mkdir -p "$WORK/lib/$abi"
    cp "$so" "$WORK/lib/$abi/libkuake_studio_jni.so"
    SO_COUNT=$((SO_COUNT+1))
    echo "[apk] ABI $abi <- $triple"
  done
fi
[ "$SO_COUNT" -gt 0 ] || { echo "没有任何 JNI .so（先跑 build-jni.sh）" >&2; exit 1; }

# 1) 资源编译 + 链接（manifest / res / assets -> base.apk）
"$BT/aapt2" compile --dir "$APP/res" -o "$WORK/compiled.zip"
"$BT/aapt2" link -o "$WORK/base.apk" \
  ${LINK_DEBUG:+"$LINK_DEBUG"} \
  -I "$PLATFORM_JAR" \
  --manifest "$APP/AndroidManifest.xml" \
  -R "$WORK/compiled.zip" --auto-add-overlay \
  -A "$WORK/assets" \
  --min-sdk-version 24 --target-sdk-version 35 \
  --version-code 1 --version-name "$VER"

# 2) Java -> class -> classes.dex（纯 framework API，无 lambda / 无 R.java / 无 AndroidX）
javac -Xlint:-options -encoding UTF-8 -source 8 -target 8 \
  -bootclasspath "$PLATFORM_JAR" -classpath "$PLATFORM_JAR" \
  -d "$WORK/classes" "$APP/java/dev/lilyco/kuakestudio/MainActivity.java"
"$BT/d8" --lib "$PLATFORM_JAR" --min-api 24 --output "$WORK" \
  $(find "$WORK/classes" -name '*.class' | sort)

# 3) dex + 未压缩 .so 追加进 APK
cp "$WORK/base.apk" "$WORK/unsigned.apk"
(cd "$WORK" && zip -q -0 unsigned.apk classes.dex $(find lib -name libkuake_studio_jni.so | sort))

# 4) 16K 页对齐（Android 15+）；老 build-tools 没有 -P 时退回普通 4 字节对齐
if ! "$BT/zipalign" -f -P 16 4 "$WORK/unsigned.apk" "$WORK/aligned.apk" 2>/dev/null; then
  echo "[apk] 该 zipalign 不支持 -P 16，退回 4 字节对齐"
  "$BT/zipalign" -f 4 "$WORK/unsigned.apk" "$WORK/aligned.apk"
fi

# 5) debug 签名（keystore 每次现生成，不入库）
KS="$APP/debug.keystore"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" \
    -storepass android -keypass android -alias androiddebugkey \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
fi
"$BT/apksigner" sign \
  --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey \
  --min-sdk-version 24 --v1-signing-enabled true --v2-signing-enabled true \
  --out "$OUT" "$WORK/aligned.apk"

echo "[apk] apksigner verify:"
"$BT/apksigner" verify --verbose --min-sdk-version 24 "$OUT"
echo "[apk] ABIs: $(cd "$WORK" && find lib -name libkuake_studio_jni.so | tr '\n' ' ')"
echo "[apk] OK -> $OUT ($(stat -c %s "$OUT") 字节, version=$VER)"
echo "[apk] 安装: adb install -r $OUT"
