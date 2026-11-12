//! kuake CLI 的子进程适配层。
//!
//! 三条职责，缺一不可：
//! 1. **启动参数装配**：一律以 argv 数组调用，绝不拼 shell 字符串（路径里有空格/中文）
//! 2. **可取消**：轮询子进程，ctx.is_cancelled() 为真就 kill —— 这是「取消」按钮唯一的
//!    真实出口（上传/下载可能跑很久）
//! 3. **脏输出解析**：kuake 的 stdout 会混入「上传进度: 100% | 速度: …」这类人类可读行，
//!    所以不能直接 from_str，必须扫描出第一个能解析的 JSON 对象

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use lilyco::__core::{AppError, Context};

/// kuake 可执行文件位置：KUAKE_BIN > ~/.local/bin/kuake > PATH
pub fn kuake_bin() -> String {
    if let Ok(p) = std::env::var("KUAKE_BIN") {
        if !p.trim().is_empty() {
            return p;
        }
    }
    // 优先 ~/.local/bin/kuake（Linux/macOS 手工安装的常见位置）。
    // Windows 上该目录不存在，而且可执行文件带 .exe 后缀，所以两个名字都试一遍，
    // 都不在就退回裸名 "kuake" 交给 PATH 解析。
    if let Some(home) = crate::paths::home_dir() {
        for name in ["kuake", "kuake.exe"] {
            let local = home.join(".local/bin").join(name);
            if local.is_file() {
                return local.to_string_lossy().to_string();
            }
        }
    }
    "kuake".to_string()
}

/// 载入凭据。
///
/// 单一口径是 `~/.config/kuake/.env`（由 tools/dump-cookies.mjs --write-env 刷新）：
/// 只要该文件里写了 KUAKE_*，就以它为准 —— 因为从父 shell 继承来的 KUAKE_COOKIE
/// 极容易是过期的（曾经 .zshrc 里硬编码过一份），一旦采信就表现为下载 403
/// `auth expired`，而报错信息完全指不出根因。设 KUAKE_STUDIO_ENV_PRIORITY=process
/// 可以恢复「进程环境变量优先」的老行为。
pub fn load_env_fallback() {
    // 幂等：Web 端 main 里调一次、每次 run 前也可能调一次，日志只该出现一行
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        load_env_fallback_inner();
    });
}

fn load_env_fallback_inner() {
    let from_file = read_env_files();
    if from_file == 0 {
        return;
    }
    let prefer_process =
        std::env::var("KUAKE_STUDIO_ENV_PRIORITY").ok().as_deref() == Some("process");
    if prefer_process {
        return;
    }
    // 文件优先：把文件里的值写回进程环境（read_env_files 已经写过，这里补一次提示）
    eprintln!("[kuake-studio] 凭据以 ~/.config/kuake/.env 为准");
}

/// 解析 .env 文本，只收 KUAKE_ 前缀；会剥掉值两侧的引号
/// （写 env 时值必须带引号：cookie 里有空格和分号，裸写会被 shell 的 source 拆开）
fn parse_env_text(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let key = k.trim();
        if !key.starts_with("KUAKE_") {
            continue;
        }
        let mut val = v.trim().to_string();
        let quoted = val.len() >= 2
            && ((val.starts_with('"') && val.ends_with('"'))
                || (val.starts_with('\'') && val.ends_with('\'')));
        if quoted {
            val = val[1..val.len() - 1].to_string();
        }
        out.push((key.to_string(), val));
    }
    out
}

/// 依次尝试 cwd/.env、~/.config/kuake/.env、~/.env，返回写入的键数
fn read_env_files() -> usize {
    let home = crate::paths::home_str();
    let candidates = [
        ".env".to_string(),
        format!("{home}/.config/kuake/.env"),
        format!("{home}/.env"),
    ];
    for path in candidates {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let pairs = parse_env_text(&text);
        let mut found = 0usize;
        for (key, val) in pairs {
            std::env::set_var(key, val);
            found += 1;
        }
        if found > 0 {
            eprintln!("[kuake-studio] 已从 {path} 载入 {found} 个 KUAKE_* 凭据");
            return found;
        }
    }
    0
}

/// 从脏输出里揪出第一个 JSON 对象
fn extract_json(s: &str) -> Option<serde_json::Value> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if v.is_object() {
            return Some(v);
        }
    }
    for (i, ch) in s.char_indices() {
        if ch != '{' {
            continue;
        }
        let mut it = serde_json::Deserializer::from_str(&s[i..]).into_iter::<serde_json::Value>();
        if let Some(Ok(v)) = it.next() {
            if v.is_object() {
                return Some(v);
            }
        }
    }
    None
}

/// 统一信封判定：success=false 一律变成 AppError，绝不静默返回空数据
fn envelope(v: serde_json::Value, stderr: &str) -> Result<serde_json::Value, AppError> {
    let failed = v.get("success").and_then(|s| s.as_bool()) == Some(false);
    if !failed {
        return Ok(v);
    }
    let code = v
        .get("code")
        .and_then(|c| c.as_str())
        .unwrap_or("ERROR")
        .to_string();
    let message = v
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("kuake 返回失败")
        .to_string();
    let mut detail = format!("{message} [{code}]");
    if code == "FILE_NOT_FOUND" || message.contains("auth expired") {
        detail.push_str("（若为登录失效，请更新 KUAKE_COOKIE 后重启客户端）");
    } else if stderr.trim().is_empty() {
        // 无更多线索，保持原样
    }
    Err(AppError::Runtime(detail))
}

/// 运行一条 kuake 命令并返回其 JSON 信封
pub fn run(ctx: &Context, argv: &[String]) -> Result<serde_json::Value, AppError> {
    // 默认走自研原生夸克 API（src/quark.rs），不再依赖本机 kuake CLI 子进程。
    // 设 KUAKE_STUDIO_BACKEND=cli 可回退到下面的子进程实现。
    if std::env::var("KUAKE_STUDIO_BACKEND").as_deref() != Ok("cli") {
        return crate::quark::dispatch(ctx, argv);
    }
    if argv.is_empty() {
        return Err(AppError::InvalidArg("空命令".into()));
    }
    let started = Instant::now();
    let bin = kuake_bin();
    let mut child = Command::new(&bin)
        .args(argv)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Runtime(format!("无法启动 kuake（{bin}）：{e}")))?;

    let mut out_pipe = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Runtime("无法读取 kuake 标准输出".into()))?;
    let mut err_pipe = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Runtime("无法读取 kuake 标准错误".into()))?;

    let stdout: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let so = Arc::clone(&stdout);
    let se = Arc::clone(&stderr);
    let h1 = std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match out_pipe.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Ok(mut g) = so.lock() {
                        g.extend_from_slice(&buf[..n]);
                    }
                }
                Err(_) => break,
            }
        }
    });
    let h2 = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match err_pipe.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Ok(mut g) = se.lock() {
                        g.extend_from_slice(&buf[..n]);
                    }
                }
                Err(_) => break,
            }
        }
    });

    let sub = argv.first().cloned().unwrap_or_default();
    let mut last_tick = 0u64;
    let mut cancelled = false;
    loop {
        if ctx.is_cancelled() {
            let _ = child.kill();
            cancelled = true;
            break;
        }
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                return Err(AppError::Runtime(format!("等待 kuake 结束失败：{e}")));
            }
        }
        let elapsed = started.elapsed();
        if elapsed > Duration::from_secs(900) {
            let _ = child.kill();
            return Err(AppError::Runtime("kuake 执行超过 15 分钟，已中止".into()));
        }
        let secs = elapsed.as_secs();
        if elapsed.as_millis() >= 1200 && secs > last_tick {
            last_tick = secs;
            ctx.tick(secs, None, format!("kuake {sub} 执行中… {secs}s"));
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    let _ = h1.join();
    let _ = h2.join();
    if cancelled {
        return Err(AppError::Cancelled);
    }

    let out =
        String::from_utf8_lossy(&stdout.lock().unwrap_or_else(|e| e.into_inner())).to_string();
    let err =
        String::from_utf8_lossy(&stderr.lock().unwrap_or_else(|e| e.into_inner())).to_string();

    match extract_json(&out) {
        Some(v) => envelope(v, &err),
        None => {
            let detail = if !err.trim().is_empty() {
                err.trim().to_string()
            } else if out.trim().is_empty() {
                format!("kuake {sub} 没有任何输出")
            } else {
                out.trim().chars().take(2000).collect::<String>()
            };
            Err(AppError::Runtime(detail))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_json_from_noisy_stdout() {
        let raw = "上传进度: 42% | 速度: 1 MB/s\n\n{\n  \"success\": true,\n  \"data\": {\"fid\": \"x\"}\n}\n";
        let v = extract_json(raw).expect("应当能揪出 JSON");
        assert_eq!(v["success"].as_bool(), Some(true));
    }

    #[test]
    fn failed_envelope_becomes_error() {
        let raw =
            "{\"success\":false,\"code\":\"FILE_NOT_FOUND\",\"message\":\"file not found: /a\"}";
        let v = extract_json(raw).unwrap();
        let err = envelope(v, "").unwrap_err().to_string();
        assert!(err.contains("FILE_NOT_FOUND"), "{err}");
    }
}

#[cfg(test)]
mod env_tests {
    use super::parse_env_text;

    #[test]
    fn parses_quoted_cookie_with_spaces_and_semicolons() {
        let text = "KUAKE_COOKIE='__puus=aa; bb=cc; dd=ee'\n";
        let pairs = parse_env_text(text);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].0, "KUAKE_COOKIE");
        // 引号被剥掉，且里头的空格、分号原样保留
        assert_eq!(pairs[0].1, "__puus=aa; bb=cc; dd=ee");
    }

    #[test]
    fn parses_double_quoted_and_ignores_other_keys() {
        let text = "# 注释\nFOO=bar\nKUAKE_PUS=\"x=y\"\n\n";
        let pairs = parse_env_text(text);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0], ("KUAKE_PUS".to_string(), "x=y".to_string()));
    }

    #[test]
    fn unquoted_value_is_kept_as_is() {
        let pairs = parse_env_text("KUAKE_BIN=/home/lilyco/.local/bin/kuake\n");
        assert_eq!(pairs[0].1, "/home/lilyco/.local/bin/kuake");
    }
}
