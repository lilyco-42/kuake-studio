//! 只在编译目标为 Windows 时，把 assets/kuake-studio.rc（图标 + 版本信息）
//! 编进 exe。其他平台这里是空操作，所以 Linux/macOS 构建完全不受影响。
//!
//! 用 CARGO_CFG_TARGET_OS 而不是 #[cfg(windows)]，这样在 Linux 上交叉编译
//! 到 Windows 时也会尝试（embed-resource 会用 llvm-rc）。
//!
//! 版本信息从 CARGO_PKG_VERSION 生成，避免资源脚本里硬编码旧版本号。

use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=assets/kuake-studio.rc");
    println!("cargo:rerun-if-changed=assets/kuake-studio.ico");

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os != "windows" {
        return;
    }

    let version = std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".into());
    let nums: Vec<u32> = version
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<u32>().unwrap_or(0))
        .collect();
    let csv = format!(
        "{},{},{},0",
        nums.first().copied().unwrap_or(0),
        nums.get(1).copied().unwrap_or(0),
        nums.get(2).copied().unwrap_or(0)
    );

    // llvm-rc 不认相对 assets/ 的路径（OUT_DIR 与源码树不同），图标写绝对路径。
    let icon = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into()))
        .join("assets/kuake-studio.ico");
    let icon = icon.to_string_lossy().replace('\\', "/");

    let template = std::fs::read_to_string("assets/kuake-studio.rc")
        .expect("读取 assets/kuake-studio.rc 失败");
    let rc = template
        .replace("KS_ICON_PATH", &icon)
        .replace("KS_VERSION_CSV", &csv)
        .replace("KS_VERSION_STR", &version);

    let out: PathBuf = std::env::var("OUT_DIR").expect("OUT_DIR 未设置").into();
    let generated = out.join("kuake-studio.generated.rc");
    std::fs::write(&generated, rc).expect("写入生成的 .rc 失败");

    // manifest_optional()：资源里的 manifest 是可选的（这里只有图标和版本号），
    // 找不到资源编译器时退化成「不嵌图标」而不是让整个构建失败。
    embed_resource::compile(generated, embed_resource::NONE)
        .manifest_optional()
        .expect("嵌入 Windows 资源失败");
}
