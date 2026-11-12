//! kuake-studio —— Quark 网盘客户端
//!
//! 骨架来自 lilyco 框架：每条 kuake 命令是一个 #[derive(App)] 结构体，
//! 装进同一个 Registry 后，四端（CLI / TUI / Web / MCP）共用一份 schema 与安全门。
//!
//! 用法：
//!   kuake-studio               # 起 Web 客户端（默认，自动开浏览器）
//!   kuake-studio --cli help    # 纯命令行（lilyco-cli 渲染同一份 schema）
//!   kuake-studio --mcp         # 作为 MCP server 暴露给 LLM
//!   LILYCO_PORT=8888 kuake-studio

mod apps;
mod crypt;
mod kuake;
mod login;
mod paths;
mod quark;
mod security;
mod server;

use std::sync::Arc;

use lilyco::prelude::*;

fn build_registry() -> Registry {
    let mut reg = Registry::new()
        // 本地交互面：T0 只读 + T1 需确认全部放行，T2/T3 仍拒绝。
        // 换成 DenyElevated 就是「只允许读」，可直接给无人值守场景用。
        .with_policy(Arc::new(lilyco::__core::safety::Interactive));
    for cmd in apps::commands() {
        if let Err(e) = reg.register(cmd) {
            panic!("注册命令失败: {e}");
        }
    }
    reg
}

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
        let rest: Vec<String> = args.iter().filter(|a| *a != "--cli").cloned().collect();
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
             kuake-studio [--port N]   起 Web 客户端（默认 8787）\n  \
             kuake-studio --cli ...    命令行模式（同一份 schema）\n  \
             kuake-studio --mcp        MCP server（stdio）\n  \
             kuake-studio --schema     打印全部命令 schema JSON\n\n\
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

    let url = format!("http://127.0.0.1:{port}");
    if std::env::var("KUAKE_STUDIO_NO_OPEN").is_err() {
        let u = url.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(600));
            let _ = open_browser(&u);
        });
    }

    let code = match rt.block_on(server::serve(state, port)) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("[kuake-studio] 监听 {url} 失败: {e}");
            1
        }
    };
    std::process::exit(code);
}

fn open_browser(url: &str) -> std::io::Result<()> {
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
