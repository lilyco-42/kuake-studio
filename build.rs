//! 只在编译目标为 Windows 时，把 assets/kuake-studio.rc（图标 + 版本信息）
//! 编进 exe。其他平台这里是空操作，所以 Linux/macOS 构建完全不受影响。
//!
//! 用 CARGO_CFG_TARGET_OS 而不是 `#[cfg(windows)]`，这样在 Linux 上交叉编译
//! 到 Windows 时也会尝试（embed-resource 会用 windres）。

fn main() {
    println!("cargo:rerun-if-changed=assets/kuake-studio.rc");
    println!("cargo:rerun-if-changed=assets/kuake-studio.ico");

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os != "windows" {
        return;
    }

    // manifest_optional()：资源里的 manifest 是可选的（这里只有图标和版本号），
    // 找不到 RC.EXE 时退化成「不嵌图标」而不是让整个构建失败。
    embed_resource::compile("assets/kuake-studio.rc", embed_resource::NONE)
        .manifest_optional()
        .expect("嵌入 Windows 资源失败");
}
