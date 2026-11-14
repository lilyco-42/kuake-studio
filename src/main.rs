//! kuake-studio —— Quark 网盘客户端（桌面 Web 宿主入口，瘦壳）
//!
//! 命令 / schema / 执行逻辑全在 kuake_studio 库（src/lib.rs）：桌面三平台与
//! 移动 / 鸿蒙的进程内原生库共用同一份 Registry。本 bin 只在 desktop 特性下编译
//! （见 Cargo.toml 的 required-features），职责：起本机 axum 服务、发随机令牌、
//! 起系统托盘、打开浏览器。Android / iOS / 鸿蒙不编这一段，改由 FFI C ABI 直接调库。
//!
//! 用法：
//!   kuake-studio               # 起 Web 客户端（默认 8787）+ 系统托盘 + 自动开浏览器
//!   kuake-studio --no-open     # 只起服务与托盘，不弹浏览器（开机自启用）
//!   kuake-studio --cli help    # 纯命令行（lilyco-cli 渲染同一份 schema）
//!   kuake-studio --mcp         # 作为 MCP server 暴露给 LLM
//!   kuake-studio --schema      # 打印全部命令 schema JSON
//!   KUAKE_STUDIO_PORT=8888 kuake-studio

use std::net::SocketAddr;
use std::time::Duration;

use kuake_studio::{build_registry, kuake, server};

mod tray;

fn main() {
    kuake::load_env_fallback();

    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.iter().any(|a| a == "--mcp") {
        lilyco::serve_mcp(build_registry());
        return;
    }

    // CLI 模式：lilyco-cli 直接读进程 argv（clap），所以必须先把 --cli 从 argv 里
    // 真的摘掉 —— 做法是没有 --cli 地 re-exec 自己。顺带支持「第一个参数就是命令名」
    // 这种自然写法（kuake-studio list /）。
    let first_is_command = match args.first() {
        Some(a) => !a.starts_with('-') && build_registry().contains(a),
        None => false,
    };
    if args.iter().any(|a| a == "--cli") || first_is_command {
        if first_is_command {
            lilyco::run_cli_registry("kuake-studio", build_registry());
            return;
        }
        let rest: Vec<String> = args
            .iter()
            .filter(|a| *a != "--cli" && *a != "--no-open")
            .cloned()
            .collect();
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            let exe = std::env::current_exe().expect("无法定位自身可执行文件");
            let err = std::process::Command::new(exe).args(&rest).exec();
            eprintln!("[kuake-studio] 无法切换到 CLI 模式: {err}");
            std::process::exit(1);
        }
        // Windows 没有 exec，起一个子进程把摘掉 --cli 的参数交给它，等它跑完。
        // 这样三个平台走的是同一套「argv 里没有 --cli」的前提。
        #[cfg(not(unix))]
        {
            let exe = std::env::current_exe().expect("无法定位自身可执行文件");
            match std::process::Command::new(exe).args(&rest).status() {
                Ok(st) => std::process::exit(st.code().unwrap_or(1)),
                Err(err) => {
                    eprintln!("[kuake-studio] 无法切换到 CLI 模式: {err}");
                    std::process::exit(1);
                }
            }
        }
    }

    if args.iter().any(|a| a == "--schema") {
        println!("{}", build_registry().to_json());
        return;
    }

    if args.iter().any(|a| a == "-h" || a == "--help") {
        println!(
            "kuake-studio {} —— Quark 网盘客户端\n\n\
             用法:\n  \
             kuake-studio [--port N] [--no-open]   起 Web 客户端 + 系统托盘（默认 8787）\n  \
             kuake-studio --cli ...    命令行模式（同一份 schema）\n  \
             kuake-studio --mcp        MCP server（stdio）\n  \
             kuake-studio --schema     打印全部命令 schema JSON\n\n\
             托盘:\n  \
             左键打开界面，右键菜单可设「开机自启」或「退出」；\n  \
             无桌面环境时自动降级为纯后台服务，功能不受影响。\n\n\
             环境变量:\n  \
             KUAKE_COOKIE / KUAKE_PUS+KUAKE_PUUS  网盘凭据\n  \
             KUAKE_BIN                             kuake 可执行文件路径\n  \
             KUAKE_STUDIO_PORT                     监听端口（默认 8787）\n  \
             KUAKE_STUDIO_DIST                     前端 dist 目录\n  \
             KUAKE_STUDIO_NO_OPEN=1                不自动开浏览器",
            env!("CARGO_PKG_VERSION")
        );
        return;
    }

    let port = args
        .iter()
        .position(|a| a == "--port")
        .and_then(|i| args.get(i + 1))
        .and_then(|p| p.parse::<u16>().ok())
        .or_else(|| {
            std::env::var("KUAKE_STUDIO_PORT")
                .ok()
                .and_then(|p| p.parse::<u16>().ok())
        })
        .unwrap_or(8787);

    let no_open =
        args.iter().any(|a| a == "--no-open") || std::env::var("KUAKE_STUDIO_NO_OPEN").is_ok();
    let url = format!("http://127.0.0.1:{port}");

    // 单实例：端口已被占用说明已经有一个实例在跑（bind 也必然失败），
    // 直接把它的界面叫出来即可，不再重复起服务 / 托盘。
    if already_running(port) {
        if !no_open {
            let _ = open_browser(&url);
        }
        return;
    }

    let token: String = {
        use rand::distributions::Alphanumeric;
        use rand::Rng;
        rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(40)
            .map(char::from)
            .collect()
    };

    let dist = server::default_dist();
    let state = server::build_state(build_registry(), token, dist);

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .expect("无法创建 tokio runtime");

    if !no_open {
        let u = url.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(600));
            let _ = open_browser(&u);
        });
    }

    // macOS 的 NSStatusItem 必须在主线程，Windows 托盘要在同一线程泵消息，
    // 所以 axum 服务整体挪到后台线程，主线程专跑托盘事件循环。
    let (exit_tx, exit_rx) = std::sync::mpsc::channel::<i32>();
    let server_url = url.clone();
    std::thread::spawn(move || {
        let code = match rt.block_on(server::serve(state, port)) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("[kuake-studio] 监听 {server_url} 失败: {e}");
                1
            }
        };
        let _ = exit_tx.send(code);
    });

    let code = tray::run(&tray::Options { url, port }, &exit_rx);
    std::process::exit(code);
}

/// 端口上是否已有 kuake-studio 实例在监听。
///
/// 只做 TCP connect 会把「别的程序恰好占了 8787」误判成已有实例：那样 main 会
/// 静静返回，服务其实根本没起来。所以发一个最小 GET /api/boot，校验响应里的
/// name 字段；端口被无关程序占用时返回 false，让后面的 bind 明确报出监听失败。
fn already_running(port: u16) -> bool {
    use std::io::{Read, Write};
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(200))
    else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(400)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(400)));
    let req =
        format!("GET /api/boot HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 4096];
    let mut n = 0usize;
    while n < buf.len() {
        match stream.read(&mut buf[n..]) {
            Ok(0) | Err(_) => break,
            Ok(k) => n += k,
        }
    }
    let text = String::from_utf8_lossy(&buf[..n]).replace(' ', "");
    text.contains("\"name\":\"kuake-studio\"")
}

pub(crate) fn open_browser(url: &str) -> std::io::Result<()> {
    // Windows 用 cmd /C start：注意 start 的第一个参数会被当成窗口标题，
    // 所以必须显式给一个空标题 ""，否则 URL 会被当成标题、什么都不打开。
    #[cfg(windows)]
    let candidates: Vec<(&str, Vec<&str>)> = vec![("cmd", vec!["/C", "start", "", url])];
    #[cfg(not(windows))]
    let candidates: Vec<(&str, Vec<&str>)> = vec![
        ("xdg-open", vec![url]),
        ("gio", vec!["open", url]),
        ("open", vec![url]),
    ];

    for (bin, args) in candidates {
        if std::process::Command::new(bin)
            .args(&args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// 端口被无关程序占用时必须返回 false，否则主流程会静默退出、服务起不来。
    #[test]
    fn foreign_port_is_not_our_instance() {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut c, _) = l.accept().unwrap();
            let mut b = [0u8; 256];
            let _ = c.read(&mut b);
            let _ = c.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
        });
        assert!(!already_running(port));
    }

    /// 自家 /api/boot 信封应当被认出来（不需要 token）。
    #[test]
    fn own_boot_is_detected() {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut c, _) = l.accept().unwrap();
            let mut b = [0u8; 256];
            let _ = c.read(&mut b);
            let body = "{\"name\":\"kuake-studio\",\"version\":\"0.5.9\"}";
            let _ = c.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                )
                .as_bytes(),
            );
        });
        assert!(already_running(port));
    }
}
