//! Android JNI 入口：在 App 进程内起 kuake-studio 的 axum 服务。
//!
//! 与桌面端完全同一套 build_registry() / server::serve() / 前端 dist，
//! 只是不打开外部浏览器 —— WebView 由 Java 层指向 http://127.0.0.1:8787。
//!
//! Java 层在 System.loadLibrary() 之前用 android.system.Os.setenv 设置：
//!   HOME              应用私有 filesDir（paths.rs / login 写 .env 用）
//!   TMPDIR            应用 cacheDir（std::env::temp_dir）
//!   KUAKE_STUDIO_DIST 从 assets 解出的 dist/ 绝对路径
//!   KUAKE_STUDIO_NO_OPEN=1 / KUAKE_STUDIO_PORT=8787
//!
//! 登录凭据：登录成功后 login.rs 把 cookie 写进 $HOME/.config/kuake/.env（$HOME 就是
//! filesDir），因此冷启动必须把该文件读回进程环境 —— 这一步在 server::serve() 里统一做，
//! 与桌面 main.rs 走同一入口，本文件不需要重复调用。
//! 因此 JNI 函数不需要解析 jstring，签名里前 2 个参数忽略即可。

use std::ffi::c_void;
use std::sync::OnceLock;

static STARTED: OnceLock<()> = OnceLock::new();

/// Java_dev_lilyco_kuakestudio_MainActivity_nativeStart()
/// static native void nativeStart(); —— 幂等，可重复调用。
#[no_mangle]
pub extern "C" fn Java_dev_lilyco_kuakestudio_MainActivity_nativeStart(
    _env: *mut c_void,
    _thiz: *mut c_void,
) {
    STARTED.get_or_init(|| {
        std::thread::Builder::new()
            .name("kuake-studio-server".into())
            .spawn(run_server)
            .expect("启动 kuake-studio 服务线程失败");
    });
}

fn run_server() {
    // 桌面 main.rs 的等价装配；端口固定 8787，前端 WebView 也写死这个地址。
    let port: u16 = std::env::var("KUAKE_STUDIO_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
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

    let dist = kuake_studio::server::default_dist();
    eprintln!("[kuake-studio/android] dist = {}", dist.display());
    let state = kuake_studio::server::build_state(kuake_studio::build_registry(), token, dist);

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .expect("无法创建 tokio runtime");

    if let Err(e) = rt.block_on(kuake_studio::server::serve(state, port)) {
        eprintln!("[kuake-studio/android] 监听 127.0.0.1:{port} 失败: {e}");
    }
}
