//! 跨平台路径：HOME / 用户目录 / `~` 展开。
//!
//! 为什么单独一个模块：Windows 上 `HOME` 经常是空的（Git Bash 才有），
//! 真实位置在 `USERPROFILE`，或者退化成 `HOMEDRIVE`+`HOMEPATH`。
//! 之前四处直接读 `HOME`（apps/kuake/server），在 Windows 上 `~` 会展开成空串，
//! 下载目录就变成了相对路径 —— 于是文件被写到进程当前目录，用户找不到。

use std::path::PathBuf;

/// 当前用户主目录：HOME > USERPROFILE > HOMEDRIVE+HOMEPATH。
pub fn home_dir() -> Option<PathBuf> {
    for key in ["HOME", "USERPROFILE"] {
        if let Ok(v) = std::env::var(key) {
            let v = v.trim();
            if !v.is_empty() {
                return Some(PathBuf::from(v));
            }
        }
    }
    let drive = std::env::var("HOMEDRIVE").unwrap_or_default();
    let rest = std::env::var("HOMEPATH").unwrap_or_default();
    let drive = drive.trim();
    let rest = rest.trim();
    if !drive.is_empty() && !rest.is_empty() {
        return Some(PathBuf::from(format!("{drive}{rest}")));
    }
    None
}

/// 主目录的字符串形式；拿不到就返回空串（调用方自行兜底）。
pub fn home_str() -> String {
    home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// 把用户手打的 `~` / `~/x` / `~\\x` 展开成主目录下的真实路径。
/// 其他写法原样返回（相对路径、绝对路径、盘符路径都不动）。
pub fn expand_home(raw: &str) -> PathBuf {
    let raw = raw.trim();
    if raw == "~" {
        return home_dir().unwrap_or_else(|| PathBuf::from(raw));
    }
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tilde_expands_to_home() {
        let home = home_str();
        assert!(!home.is_empty(), "本机应能取到 HOME/USERPROFILE");
        assert_eq!(expand_home("~").to_string_lossy(), home);
        assert_eq!(
            expand_home("~/Downloads").to_string_lossy(),
            PathBuf::from(&home).join("Downloads").to_string_lossy()
        );
    }

    #[test]
    fn plain_paths_are_untouched() {
        assert_eq!(expand_home("/tmp/x").to_string_lossy(), "/tmp/x");
        assert_eq!(expand_home("C:\\tmp\\x").to_string_lossy(), "C:\\tmp\\x");
        assert_eq!(
            expand_home("relative/dir").to_string_lossy(),
            "relative/dir"
        );
    }
}
