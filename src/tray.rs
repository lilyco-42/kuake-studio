//! 系统托盘：桌面三平台统一的交互入口（打开界面 / 开机自启 / 退出）。
//!
//! 只在 [[bin]]（desktop 特性）里编译；移动 / 鸿蒙只编 lib，不会碰到这里。
//! 用 tray-icon 0.25.1：Linux 走 ksni（纯 Rust D-Bus StatusNotifierItem，不需要
//! GTK3 / libappindicator，也不占主线程事件循环），Windows 走 Shell_NotifyIconW
//! （宿主自己泵 Win32 消息），macOS 走 NSStatusItem（必须主线程 + CFRunLoop）。
//! 因此 main.rs 把 axum 服务放到后台线程，主线程专门建托盘并跑事件循环。
//!
//! 托盘是「锦上添花」：无桌面 / 无 StatusNotifierWatcher / 非主线程等情况下
//! 构建失败只打一行日志并降级成纯后台服务，绝不让网盘客户端起不来。

use std::time::Duration;

use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

const ICON_W: u32 = 64;
const ICON_H: u32 = 64;
const MENU_OPEN: &str = "open";
const MENU_AUTOSTART: &str = "autostart";
const MENU_QUIT: &str = "quit";

#[cfg(target_os = "windows")]
const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
#[cfg(target_os = "windows")]
const RUN_VALUE: &str = "KuakeStudio";

/// 托盘线程内的全部状态。tray-icon 的 TrayIcon 与 muda 菜单项都不是 Send，
/// 必须原封不动留在创建它们的那个线程（这里就是主线程）。
struct Session {
    _tray: TrayIcon,
    autostart: CheckMenuItem,
}

pub struct Options {
    pub url: String,
    pub port: u16,
}

/// 在主线程跑托盘事件循环，直到用户点「退出」或后台服务结束。
pub fn run(opts: &Options, server_exit: &std::sync::mpsc::Receiver<i32>) -> i32 {
    let session = match build() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[kuake-studio] 系统托盘不可用（{e}），继续以纯后台服务模式运行");
            return server_exit.recv().unwrap_or(1);
        }
    };

    loop {
        while let Ok(ev) = MenuEvent::receiver().try_recv() {
            match ev.id.0.as_str() {
                MENU_OPEN => open_ui(&opts.url),
                MENU_AUTOSTART => toggle_autostart(&session.autostart, opts.port),
                MENU_QUIT => return 0,
                _ => {}
            }
        }

        while let Ok(ev) = TrayIconEvent::receiver().try_recv() {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = ev
            {
                open_ui(&opts.url);
            }
        }

        match server_exit.try_recv() {
            Ok(code) => return code,
            Err(std::sync::mpsc::TryRecvError::Empty) => {}
            Err(std::sync::mpsc::TryRecvError::Disconnected) => return 1,
        }

        pump();
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn open_ui(url: &str) {
    let _ = crate::open_browser(url);
}

fn build() -> Result<Session, String> {
    #[cfg(target_os = "macos")]
    {
        // 我们是一个普通 Rust bin（不是 NSApplication 宿主），先初始化 AppKit，
        // 否则 NSStatusBar / NSStatusItem 不会出现在菜单栏。
        let _ = objc2_app_kit::NSApplication::load();
    }

    let menu = Menu::new();
    let open = MenuItem::with_id(MENU_OPEN, "打开界面", true, None);
    let sep = PredefinedMenuItem::separator();
    let autostart =
        CheckMenuItem::with_id(MENU_AUTOSTART, "开机自启", true, autostart_enabled(), None);
    let quit = MenuItem::with_id(MENU_QUIT, "退出", true, None);
    menu.append_items(&[&open, &sep, &autostart, &quit])
        .map_err(|e| format!("装配托盘菜单失败: {e}"))?;

    let icon = Icon::from_rgba(
        include_bytes!("../assets/tray-icon-64.rgba").to_vec(),
        ICON_W,
        ICON_H,
    )
    .map_err(|e| format!("托盘图标数据异常: {e}"))?;

    // 三平台统一：左键直接打开界面，右键才出菜单。
    // Linux 的 ksni 后端不支持 menu_on_left_click，靠 emit_click 的 Click 事件同样生效。
    let tray = TrayIconBuilder::new()
        .with_icon(icon)
        .with_tooltip("kuake-studio — 夸克网盘")
        .with_menu(Box::new(menu))
        .with_menu_on_left_click(false)
        .build()
        .map_err(|e| format!("创建托盘图标失败: {e}"))?;

    Ok(Session {
        _tray: tray,
        autostart,
    })
}

fn toggle_autostart(item: &CheckMenuItem, port: u16) {
    let want = !item.is_checked();
    match set_autostart(want, port) {
        Ok(()) => item.set_checked(autostart_enabled()),
        Err(e) => eprintln!("[kuake-studio] 开机自启设置失败: {e}"),
    }
}

/// 平台事件循环泵：Windows 必须泵消息托盘才收得到点击；macOS 必须让主线程
/// CFRunLoop 转起来；Linux ksni 自带 D-Bus worker 线程，这里什么都不用做。
#[cfg(target_os = "windows")]
fn pump() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
    };
    unsafe {
        let mut msg = MSG::default();
        while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

#[cfg(target_os = "macos")]
fn pump() {
    let mode = unsafe { objc2_core_foundation::kCFRunLoopDefaultMode };
    let _ = objc2_core_foundation::CFRunLoop::run_in_mode(mode, 0.02, false);
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn pump() {}

// ── 开机自启（三平台各自的登录项，互不干扰）────────────────────────────

fn exe_and_args(port: u16) -> (String, Vec<String>) {
    let exe = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("kuake-studio"));
    (
        exe.to_string_lossy().into_owned(),
        vec!["--port".into(), port.to_string(), "--no-open".into()],
    )
}

/// 命令行路径带空格 / 引号时才加引号（Windows Run 键与 Linux Exec= 共用）。
#[cfg(not(target_os = "macos"))]
fn quote(s: &str) -> String {
    if s.contains(' ') || s.contains('\t') || s.contains('"') {
        format!("\"{}\"", s.replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

#[cfg(not(target_os = "macos"))]
fn command_line(parts: &[String]) -> String {
    parts.iter().map(|p| quote(p)).collect::<Vec<_>>().join(" ")
}

fn autostart_command(port: u16) -> Vec<String> {
    let (exe, args) = exe_and_args(port);
    let mut v = Vec::with_capacity(args.len() + 1);
    v.push(exe);
    v.extend(args);
    v
}

#[cfg(target_os = "windows")]
fn autostart_enabled() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(RUN_KEY)
        .and_then(|k| k.get_value::<String, _>(RUN_VALUE))
        .is_ok()
}

#[cfg(target_os = "windows")]
fn set_autostart(enable: bool, port: u16) -> std::io::Result<()> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(RUN_KEY)?;
    if enable {
        key.set_value(RUN_VALUE, &command_line(&autostart_command(port)))?;
    } else {
        match key.delete_value(RUN_VALUE) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

#[cfg(all(target_os = "linux", not(target_env = "ohos")))]
fn autostart_path() -> Option<std::path::PathBuf> {
    let base = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| kuake_studio::paths::home_dir().map(|h| h.join(".config")))?;
    Some(base.join("autostart").join("kuake-studio.desktop"))
}

#[cfg(all(target_os = "linux", not(target_env = "ohos")))]
fn autostart_enabled() -> bool {
    autostart_path().is_some_and(|p| p.is_file())
}

#[cfg(all(target_os = "linux", not(target_env = "ohos")))]
fn set_autostart(enable: bool, port: u16) -> std::io::Result<()> {
    let path = autostart_path()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "拿不到用户配置目录"))?;
    if !enable {
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        };
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(
        &path,
        desktop_entry(&command_line(&autostart_command(port))),
    )
}

#[cfg(all(target_os = "linux", not(target_env = "ohos")))]
fn desktop_entry(exec: &str) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nVersion=1.0\nName=夸克网盘\n\
         Comment=kuake-studio 夸克网盘客户端（系统托盘）\nExec={exec}\n\
         Icon=kuake-studio\nTerminal=false\nCategories=Network;FileTransfer;Utility;\n\
         X-GNOME-Autostart-enabled=true\nHidden=false\n"
    )
}

#[cfg(target_os = "macos")]
fn launch_agent_path() -> Option<std::path::PathBuf> {
    kuake_studio::paths::home_dir()
        .map(|h| h.join("Library/LaunchAgents/dev.lilyco.kuake-studio.plist"))
}

#[cfg(target_os = "macos")]
fn autostart_enabled() -> bool {
    launch_agent_path().is_some_and(|p| p.is_file())
}

#[cfg(target_os = "macos")]
fn set_autostart(enable: bool, port: u16) -> std::io::Result<()> {
    let path = launch_agent_path()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "拿不到用户主目录"))?;
    if !enable {
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        };
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, launch_agent_plist(&autostart_command(port)))
}

#[cfg(target_os = "macos")]
fn launch_agent_plist(args: &[String]) -> String {
    let items: Vec<String> = args
        .iter()
        .map(|a| format!("    <string>{}</string>", xml_escape(a)))
        .collect();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n<dict>\n\
           <key>Label</key><string>dev.lilyco.kuake-studio</string>\n\
           <key>ProgramArguments</key>\n  <array>\n{}\n  </array>\n\
           <key>RunAtLoad</key><true/>\n\
           <key>KeepAlive</key><false/>\n\
         </dict>\n</plist>\n",
        items.join("\n")
    )
}

#[cfg(target_os = "macos")]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 兜底：桌面三平台以外的 cfg（例如 FreeBSD）也让 bin 能编，只是不写登录项。
#[cfg(not(any(
    target_os = "windows",
    target_os = "macos",
    all(target_os = "linux", not(target_env = "ohos"))
)))]
fn autostart_enabled() -> bool {
    false
}

#[cfg(not(any(
    target_os = "windows",
    target_os = "macos",
    all(target_os = "linux", not(target_env = "ohos"))
)))]
fn set_autostart(_enable: bool, _port: u16) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "此平台暂不支持开机自启",
    ))
}

#[cfg(test)]
mod tests {
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn quote_wraps_only_when_needed() {
        use super::quote;
        assert_eq!(
            quote("/opt/kuake-studio/kuake-studio"),
            "/opt/kuake-studio/kuake-studio"
        );
        assert_eq!(quote("/opt/my apps/ks"), "\"/opt/my apps/ks\"");
        assert_eq!(quote("--no-open"), "--no-open");
    }

    #[cfg(all(target_os = "linux", not(target_env = "ohos")))]
    #[test]
    fn autostart_desktop_entry_is_tray_only() {
        use super::desktop_entry;
        let s = desktop_entry("\"/opt/kuake-studio\" --port 8787 --no-open");
        assert!(s.contains("Type=Application"));
        assert!(s.contains("Exec=\"/opt/kuake-studio\" --port 8787 --no-open"));
        assert!(s.contains("--no-open"), "登录项不能自动弹浏览器");
        assert!(s.contains("X-GNOME-Autostart-enabled=true"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn launch_agent_has_no_open_flag() {
        use super::launch_agent_plist;
        let s = launch_agent_plist(&[
            "/Applications/kuake-studio".into(),
            "--port".into(),
            "8787".into(),
            "--no-open".into(),
        ]);
        assert!(s.contains("<key>RunAtLoad</key><true/>"));
        assert!(s.contains("<string>--no-open</string>"));
    }
}
