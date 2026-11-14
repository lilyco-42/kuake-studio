//! kuake 的每条命令 = 一个 lilyco App。
//!
//! 一个结构体同时拿到：schema（前端表单、MCP tools、CLI help 全从它渲染）、
//! 参数解析与校验、安全分级、执行。这是 lilyco 框架「一次声明，四端可用」的落点。

use lilyco::prelude::*;

use crate::kuake;

fn start() -> std::time::Instant {
    std::time::Instant::now()
}

fn finish(
    ctx: &Context,
    started: std::time::Instant,
    v: serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    ctx.done(v.clone(), started.elapsed().as_millis() as u64);
    Ok(v)
}

fn human_size(bytes: u64) -> String {
    const U: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{bytes} B")
    } else {
        format!("{v:.1} {}", U[i])
    }
}

fn base(cmd: &str) -> Vec<String> {
    vec![cmd.to_string()]
}

// ── 只读（T0） ─────────────────────────────────────────────

/// 账号信息与容量
#[derive(Debug, App)]
#[app(
    name = "user",
    about = "账号信息与容量（昵称 / 会员类型 / 已用 / 总量）",
    run = "run_user"
)]
pub struct UserInfo {}

fn run_user(_app: &UserInfo, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    let v = kuake::run(ctx, &base("user"))?;
    finish(ctx, t, v)
}

/// kuake CLI 版本
#[derive(Debug, App)]
#[app(name = "version", about = "kuake CLI 版本", run = "run_version")]
pub struct Version {}

fn run_version(_app: &Version, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    let v = kuake::run(ctx, &base("version"))?;
    finish(ctx, t, v)
}

/// 列出目录
#[derive(Debug, App)]
#[app(name = "list", about = "列出目录内容", run = "run_list")]
pub struct ListDir {
    #[arg(about = "网盘目录路径，如 / 或 /03_项目与资料", default = "/")]
    pub path: String,
}

fn run_list(app: &ListDir, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    let path = if app.path.trim().is_empty() {
        "/".to_string()
    } else {
        app.path.trim().to_string()
    };
    let v = kuake::run(ctx, &["list".to_string(), path])?;
    finish(ctx, t, v)
}

/// 查看文件/目录详情
#[derive(Debug, App)]
#[app(name = "info", about = "查看文件或目录的详情", run = "run_info")]
pub struct Info {
    #[arg(about = "网盘路径")]
    pub path: String,
}

fn run_info(app: &Info, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    let v = kuake::run(ctx, &["info".to_string(), app.path.clone()])?;
    finish(ctx, t, v)
}

/// 全盘搜索文件（按文件名，返回完整路径）
#[derive(Debug, App)]
#[app(
    name = "search",
    about = "全盘搜索文件（按文件名，返回完整路径）",
    run = "run_search"
)]
pub struct Search {
    #[arg(about = "搜索关键词（必填，不能为空）")]
    pub q: String,
    #[arg(about = "页码，从 1 开始", default = 1, min = 1, max = 1000)]
    pub page: u32,
    #[arg(
        about = "每页条数（夸克后端上限 100）",
        default = 50,
        min = 1,
        max = 100
    )]
    pub size: u32,
}

fn run_search(app: &Search, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    let q = app.q.trim();
    if q.is_empty() {
        return Err(AppError::InvalidInput("搜索关键词不能为空".into()));
    }
    let v = kuake::run(
        ctx,
        &[
            "search".to_string(),
            q.to_string(),
            app.page.to_string(),
            app.size.to_string(),
        ],
    )?;
    finish(ctx, t, v)
}
/// 下载到本机
#[derive(Debug, App)]
#[app(name = "download", about = "下载文件到本机目录", run = "run_download")]
pub struct Download {
    #[arg(about = "网盘文件路径")]
    pub path: String,
    #[arg(about = "本机目标目录（不存在会自动创建，支持 ~）；留空则用 kuake 默认下载位置")]
    pub dest: Option<String>,
}

fn run_download(app: &Download, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    let mut argv = base("download");
    argv.push(app.path.clone());
    if let Some(d) = app
        .dest
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        // kuake 对「不存在的 dest」会当成文件名直接写出去（于是得到一个叫 dl 的文件而不是 dl/ 目录）。
        // 本命令把 dest 声明为「目录」，就自己先把它建出来，语义才不会漂。
        argv.push(prepare_dest_dir(d)?.to_string_lossy().to_string());
    }
    let v = kuake::run(ctx, &argv)?;
    finish(ctx, t, v)
}

/// 把用户填的下载目录规整成一个**确实存在**的目录。
/// `~` 展开成 $HOME（用户在表单里手打很常见）；不存在就 mkdir -p；存在但不是目录则报错。
pub fn prepare_dest_dir(raw: &str) -> Result<std::path::PathBuf, AppError> {
    // 交给 paths::expand_home：它知道 Windows 上 HOME 可能是空的（要退 USERPROFILE）
    let path = crate::paths::expand_home(raw);
    let expanded = path.to_string_lossy().to_string();
    if path.is_file() {
        return Err(AppError::InvalidInput(format!(
            "目标 {expanded} 是一个已存在的文件，不是目录"
        )));
    }
    if !path.exists() {
        std::fs::create_dir_all(&path)
            .map_err(|e| AppError::InvalidInput(format!("无法创建下载目录 {expanded}: {e}")))?;
    }
    Ok(path)
}

/// 分享列表
#[derive(Debug, App)]
#[app(
    name = "share-list",
    about = "已创建的分享链接列表",
    run = "run_share_list"
)]
pub struct ShareList {
    #[arg(about = "页码，从 1 开始", default = 1, min = 1, max = 1000)]
    pub page: u32,
    #[arg(
        about = "每页条数（夸克后端上限 100）",
        default = 50,
        min = 1,
        max = 100
    )]
    pub size: u32,
}

fn run_share_list(app: &ShareList, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    let v = kuake::run(
        ctx,
        &[
            "share-list".to_string(),
            app.page.to_string(),
            app.size.to_string(),
        ],
    )?;
    finish(ctx, t, v)
}

/// 回收站列表（最近删除）
#[derive(Debug, App)]
#[app(
    name = "recycle-list",
    about = "回收站列表（最近删除，显示删除时间与剩余天数）",
    run = "run_recycle_list"
)]
pub struct RecycleList {
    #[arg(about = "页码，从 1 开始", default = 1, min = 1, max = 1000)]
    pub page: u32,
    #[arg(
        about = "每页条数（夸克后端上限 100）",
        default = 50,
        min = 1,
        max = 100
    )]
    pub size: u32,
}

fn run_recycle_list(app: &RecycleList, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    let v = kuake::run(
        ctx,
        &[
            "recycle-list".to_string(),
            app.page.to_string(),
            app.size.to_string(),
        ],
    )?;
    finish(ctx, t, v)
}

// ── 需确认（T1） ───────────────────────────────────────────

/// 新建文件夹
#[derive(Debug, App)]
#[app(
    name = "create",
    about = "在指定目录下新建文件夹",
    run = "run_create",
    safety = "t1"
)]
pub struct CreateFolder {
    #[arg(about = "新文件夹名称")]
    pub name: String,
    #[arg(about = "父目录路径", default = "/")]
    pub pdir: String,
}

fn run_create(app: &CreateFolder, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    let pdir = if app.pdir.trim().is_empty() {
        "/".to_string()
    } else {
        app.pdir.trim().to_string()
    };
    let v = kuake::run(ctx, &["create".to_string(), app.name.clone(), pdir])?;
    finish(ctx, t, v)
}

/// 上传本机文件
#[derive(Debug, App)]
#[app(
    name = "upload",
    about = "上传本机文件到网盘（目标必须是完整文件路径）",
    run = "run_upload",
    safety = "t1"
)]
pub struct Upload {
    #[arg(
        about = "本机文件绝对路径（也可以是 .kcrypt 加密文件）",
        must_exist = true
    )]
    pub file: std::path::PathBuf,
    #[arg(about = "网盘目标完整路径，如 /dir/name.ext（不能只是目录）")]
    pub dest: String,
    #[arg(about = "上传前加密口令（≥8 位，留空则明文上传）。填了就先在本机加密成 .kcrypt 再传")]
    pub passphrase: Option<String>,
}

fn run_upload(app: &Upload, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    let file = app.file.to_string_lossy().to_string();
    if file.trim().is_empty() {
        return Err(AppError::InvalidArg("缺少本机文件路径".into()));
    }
    if app.dest.trim().is_empty() || app.dest.trim().ends_with('/') {
        return Err(AppError::InvalidArg(
            "目标必须是完整文件路径（含文件名），不能是目录".into(),
        ));
    }
    let dest = app.dest.trim().to_string();
    let passphrase = app
        .passphrase
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // 加密分支：本机先加密成 .kcrypt，再上传那个文件。
    // 明文绝不落网盘，暂存目录在结束（成功或失败）后一律清掉。
    let (upload_src, upload_dest) = match passphrase.as_deref() {
        None => (file.clone(), dest.clone()),
        Some(pass) => {
            let dest_enc = crate::crypt::with_ext(&dest);
            let tmp_dir = std::env::temp_dir().join("kuake-studio-encrypt");
            std::fs::create_dir_all(&tmp_dir).map_err(|e| {
                AppError::InvalidInput(format!("无法创建加密暂存目录 {}: {e}", tmp_dir.display()))
            })?;
            let base = std::path::Path::new(&file)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "upload".into());
            let tmp_out = tmp_dir.join(format!(
                "{}-{}",
                std::process::id(),
                crate::crypt::with_ext(&base)
            ));
            ctx.log(LogLevel::Info, format!("加密中：{file} → {dest_enc}"));
            // 容器里记的原名 = 网盘上的名字（去掉 .kcrypt），解密后能还原
            let inner = upload_inner_name(&dest);
            let chunks = crate::crypt::encrypt_file_as(
                std::path::Path::new(&file),
                &tmp_out,
                &inner,
                pass,
                Some(ctx),
            );
            let chunks = match chunks {
                Ok(c) => c,
                Err(e) => {
                    let _ = std::fs::remove_file(&tmp_out);
                    return Err(e);
                }
            };
            let enc_size = std::fs::metadata(&tmp_out).map(|m| m.len()).unwrap_or(0);
            ctx.log(
                LogLevel::Info,
                format!(
                    "加密完成：{chunks} 块 / {} → 上传 {}",
                    human_size(enc_size),
                    dest_enc
                ),
            );
            (tmp_out.to_string_lossy().to_string(), dest_enc)
        }
    };

    ctx.log(LogLevel::Info, format!("上传 {upload_src} → {upload_dest}"));
    let res = kuake::run(
        ctx,
        &[
            "upload".to_string(),
            upload_src.clone(),
            upload_dest.clone(),
        ],
    );
    // 临时加密文件用完就删（无论成败）
    if upload_src != file {
        let _ = std::fs::remove_file(&upload_src);
    }
    let mut v = res?;
    // kuake upload 有个坑：dest 若是一个已存在的目录（或同名文件已存在），它返回
    // success:true + code:"SKIPPED"，实际什么都没传。这类「假成功」必须变成错误上抛。
    if v.get("code").and_then(|c| c.as_str()) == Some("SKIPPED") {
        let msg = v
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("kuake 跳过了上传");
        return Err(AppError::InvalidInput(format!(
            "{msg}。目标必须写成完整文件路径（含文件名），且不能已存在；如果是同名目录，请改个名字或先删除。"
        )));
    }
    if passphrase.is_some() {
        if let Some(obj) = v.as_object_mut() {
            obj.insert("encrypted".into(), serde_json::Value::Bool(true));
            obj.insert("cloud_path".into(), serde_json::Value::String(upload_dest));
        }
    }
    finish(ctx, t, v)
}

/// 网盘目标路径 → 容器内记录的原文件名（去掉 .kcrypt 后缀，取最后一段）
fn upload_inner_name(dest: &str) -> String {
    let name = dest.rsplit('/').find(|s| !s.is_empty()).unwrap_or("upload");
    let stripped = name
        .strip_suffix(".kcrypt")
        .or_else(|| name.strip_suffix(".KCRYPT"))
        .unwrap_or(name);
    if stripped.is_empty() {
        "upload".to_string()
    } else {
        stripped.to_string()
    }
}

/// 移动
#[derive(Debug, App)]
#[app(
    name = "move",
    about = "移动文件或目录到目标目录",
    run = "run_move",
    safety = "t1"
)]
pub struct Move {
    #[arg(about = "源路径")]
    pub src: String,
    #[arg(about = "目标目录（须已存在）")]
    pub dest: String,
}

fn run_move(app: &Move, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    let v = kuake::run(
        ctx,
        &["move".to_string(), app.src.clone(), app.dest.clone()],
    )?;
    finish(ctx, t, v)
}

/// 复制
#[derive(Debug, App)]
#[app(
    name = "copy",
    about = "复制文件或目录到目标目录",
    run = "run_copy",
    safety = "t1"
)]
pub struct Copy {
    #[arg(about = "源路径")]
    pub src: String,
    #[arg(about = "目标目录（须已存在）")]
    pub dest: String,
}

fn run_copy(app: &Copy, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    let v = kuake::run(
        ctx,
        &["copy".to_string(), app.src.clone(), app.dest.clone()],
    )?;
    finish(ctx, t, v)
}

/// 重命名
#[derive(Debug, App)]
#[app(
    name = "rename",
    about = "重命名文件或目录",
    run = "run_rename",
    safety = "t1"
)]
pub struct Rename {
    #[arg(about = "原路径")]
    pub path: String,
    #[arg(about = "新名称（只写名字，不写路径）")]
    pub new_name: String,
}

fn run_rename(app: &Rename, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    let v = kuake::run(
        ctx,
        &["rename".to_string(), app.path.clone(), app.new_name.clone()],
    )?;
    finish(ctx, t, v)
}

/// 删除（进回收站）
#[derive(Debug, App)]
#[app(
    name = "delete",
    about = "删除文件或目录",
    run = "run_delete",
    safety = "t1"
)]
pub struct Delete {
    #[arg(about = "要删除的网盘路径")]
    pub path: String,
}

fn run_delete(app: &Delete, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    let v = kuake::run(ctx, &["delete".to_string(), app.path.clone()])?;
    finish(ctx, t, v)
}

/// 创建分享链接
#[derive(Debug, App)]
#[app(
    name = "share",
    about = "为文件或目录创建分享链接",
    run = "run_share",
    safety = "t1"
)]
pub struct Share {
    #[arg(about = "要分享的网盘路径")]
    pub path: String,
    #[arg(about = "有效期（夸克只支持这四档）", default = ShareDays::D1)]
    pub days: ShareDays,
    #[arg(about = "是否生成提取码")]
    pub passcode: bool,
}

/// 分享有效期。夸克后端只认 0 / 1 / 7 / 30 这四个值，填 3、5、15 会静默失败，
/// 所以做成真枚举：schema 里就是 ArgKind::Enum，前端自动渲染成下拉框、
/// CLI 自动带上候选值校验，用户没机会填错。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareDays {
    D0,
    D1,
    D7,
    D30,
}

impl ShareDays {
    pub fn as_str(self) -> &'static str {
        match self {
            ShareDays::D0 => "0",
            ShareDays::D1 => "1",
            ShareDays::D7 => "7",
            ShareDays::D30 => "30",
        }
    }
}

impl serde::Serialize for ShareDays {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl lilyco::__core::schema::ValueEnum for ShareDays {
    fn variants() -> Vec<&'static str> {
        vec!["0", "1", "7", "30"]
    }
    fn from_str(s: &str) -> Option<Self> {
        match s.trim() {
            "0" => Some(ShareDays::D0),
            "1" => Some(ShareDays::D1),
            "7" => Some(ShareDays::D7),
            "30" => Some(ShareDays::D30),
            _ => None,
        }
    }
}

fn run_share(app: &Share, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    let created_before = now_ms();
    let attempt = kuake::run(
        ctx,
        &[
            "share".to_string(),
            app.path.clone(),
            app.days.as_str().to_string(),
            if app.passcode { "true" } else { "false" }.to_string(),
        ],
    );

    match attempt {
        Ok(v) => finish(ctx, t, v),
        Err(e) => {
            let msg = e.to_string();
            // kuake 在「异步任务」分支会把轮询请求发成不带 cookie 的形式，于是稳定返回
            // 401 require login [guest]。这时分享**可能已经建好了**，只是没拿到 share_id。
            // 与其把这条误导性错误抛给用户，不如回查分享列表把它捞回来。
            if msg.contains("require login [guest]") || msg.contains("wait for task complete") {
                ctx.log(
                    LogLevel::Info,
                    "kuake 没拿到分享结果，回查分享列表确认是否其实已创建…",
                );
                match recover_share(ctx, &app.path, created_before) {
                    Some(v) => {
                        ctx.log(
                            LogLevel::Warn,
                            "分享已创建（kuake 取回 share_id 时鉴权失败，已从分享列表恢复）",
                        );
                        return finish(ctx, t, v);
                    }
                    None => {
                        let hint = [
                            format!(
                                "分享没有建成。夸克对「{}」返回了 401，通常有两种原因：",
                                app.path
                            ),
                            "① 该文件违规，不支持分享 —— 换成分享它所在的上级目录试试；"
                                .to_string(),
                            "② 登录态刚过期 —— 刷新 cookie 后重启客户端。".to_string(),
                            format!("原始返回：{msg}"),
                        ]
                        .join("\n");
                        return Err(AppError::Runtime(hint));
                    }
                }
            }
            Err(e)
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 分享失败后回查：在最近的分享里找「刚刚创建、且文件对得上」的那一条，重建成
/// 和 kuake 正常返回一样的结构（share_url / pwd_id / share_id）。
fn recover_share(ctx: &Context, path: &str, created_before: i64) -> Option<serde_json::Value> {
    let v = kuake::run(
        ctx,
        &["share-list".to_string(), "1".to_string(), "50".to_string()],
    )
    .ok()?;
    let list = v.get("data")?.get("list")?.as_array()?;
    let name = path.rsplit('/').find(|s| !s.is_empty()).unwrap_or(path);
    let parent = match path.rfind('/') {
        Some(0) | None => "/",
        Some(i) => &path[..i],
    };
    // 只认「本次操作之前不久创建」的条目，避免把历史分享当成刚建好的
    let floor = created_before - 180_000;
    list.iter()
        .filter(|it| {
            let created = it.get("created_at").and_then(|c| c.as_i64()).unwrap_or(0);
            if created < floor || created > created_before + 180_000 {
                return false;
            }
            let file_name = it
                .get("first_file")
                .and_then(|f| f.get("file_name"))
                .and_then(|n| n.as_str())
                .unwrap_or("");
            let path_info = it.get("path_info").and_then(|p| p.as_str()).unwrap_or("");
            file_name == name && (path_info == parent || path_info.is_empty())
        })
        .max_by_key(|it| it.get("created_at").and_then(|c| c.as_i64()).unwrap_or(0))
        .map(|it| {
            let pwd_id = it.get("pwd_id").and_then(|p| p.as_str()).unwrap_or("");
            let share_url = it
                .get("share_url")
                .and_then(|u| u.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("https://pan.quark.cn/s/{pwd_id}"));
            serde_json::json!({
                "success": true,
                "code": "OK",
                "message": "分享已创建（share_id 从分享列表恢复）",
                "data": {
                    "share_url": share_url,
                    "pwd_id": pwd_id,
                    "share_id": it.get("share_id").and_then(|s| s.as_str()).unwrap_or(""),
                    "recovered": true,
                }
            })
        })
}

/// 取消分享
#[derive(Debug, App)]
#[app(
    name = "share-delete",
    about = "取消分享（按分享 ID 或路径）",
    run = "run_share_delete",
    safety = "t1"
)]
pub struct ShareDelete {
    #[arg(about = "分享 ID（pwd_id/share_id）或网盘路径，可多个")]
    pub targets: Vec<String>,
}

fn run_share_delete(app: &ShareDelete, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    if app.targets.is_empty() {
        return Err(AppError::InvalidArg("至少给一个分享 ID 或路径".into()));
    }
    let mut argv = base("share-delete");
    argv.extend(app.targets.iter().cloned());
    let v = kuake::run(ctx, &argv)?;
    finish(ctx, t, v)
}

/// 转存他人分享
#[derive(Debug, App)]
#[app(
    name = "share-save",
    about = "把别人的分享转存到我的网盘",
    run = "run_share_save",
    safety = "t1"
)]
pub struct ShareSave {
    #[arg(about = "分享链接，如 https://pan.quark.cn/s/xxxx")]
    pub link: String,
    #[arg(about = "提取码（无码留空）")]
    pub passcode: Option<String>,
    #[arg(about = "转存到我的哪个目录，留空为根目录")]
    pub dest_dir: Option<String>,
}

fn run_share_save(app: &ShareSave, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    let mut argv = base("share-save");
    argv.push(app.link.clone());
    let passcode = app
        .passcode
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let dest = app
        .dest_dir
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if passcode.is_some() || dest.is_some() {
        argv.push(passcode.unwrap_or_default());
    }
    if let Some(d) = dest {
        argv.push(d);
    }
    let v = kuake::run(ctx, &argv)?;
    finish(ctx, t, v)
}

// ── 本机加解密（T1）：不上网盘也能用，和上传前加密同一套容器格式 ──────

/// 加密本机文件（AES-256-GCM 分块 + PBKDF2，生成 .kcrypt）
#[derive(Debug, App)]
#[app(
    name = "encrypt",
    about = "在本机把文件加密成 .kcrypt（AES-256-GCM 分块 + PBKDF2 派生密钥）",
    run = "run_encrypt_local",
    safety = "t1"
)]
pub struct EncryptLocal {
    #[arg(about = "本机要加密的文件路径", must_exist = true)]
    pub file: std::path::PathBuf,
    #[arg(about = "输出路径（留空 = 同目录下 原名.kcrypt）")]
    pub out: Option<String>,
    #[arg(about = "口令（≥8 位）。这是唯一能解开的凭据，丢了文件就废了")]
    pub passphrase: String,
}

fn run_encrypt_local(app: &EncryptLocal, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    let src = app.file.clone();
    let dest = match app.out.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(o) => std::path::PathBuf::from(o),
        None => {
            let name = src
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "output".into());
            src.with_file_name(crate::crypt::with_ext(&name))
        }
    };
    let chunks = crate::crypt::encrypt_file(&src, &dest, app.passphrase.trim(), Some(ctx))?;
    let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    finish(
        ctx,
        t,
        serde_json::json!({
            "success": true,
            "code": "OK",
            "message": "加密完成",
            "data": {
                "output": dest.to_string_lossy(),
                "size": size,
                "chunks": chunks,
            }
        }),
    )
}

/// 解密 .kcrypt 文件
#[derive(Debug, App)]
#[app(
    name = "decrypt",
    about = "解密 kuake-studio 的 .kcrypt 文件（还原成原文件名）",
    run = "run_decrypt_local",
    safety = "t1"
)]
pub struct DecryptLocal {
    #[arg(about = "本机 .kcrypt 文件路径", must_exist = true)]
    pub file: std::path::PathBuf,
    #[arg(about = "输出目录（留空 = 与加密文件同目录），支持 ~")]
    pub out_dir: Option<String>,
    #[arg(about = "口令")]
    pub passphrase: String,
}

fn run_decrypt_local(app: &DecryptLocal, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    // 先读头部：不是我们的容器就直接报「不是 kuake-studio 加密文件」，不用等 KDF
    let header = crate::crypt::read_header(&app.file)?;
    ctx.log(
        LogLevel::Info,
        format!(
            "容器：原名 {} · {} 字节 · {} 块 · KDF {} 轮",
            header.name,
            header.pt_len,
            if header.chunk == 0 {
                0
            } else {
                header.pt_len.div_ceil(header.chunk as u64)
            },
            header.kdf_iters
        ),
    );
    let out_dir = match app
        .out_dir
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        Some(d) => Some(prepare_dest_dir(d)?),
        None => None,
    };
    let out = crate::crypt::decrypt_file(
        &app.file,
        out_dir.as_deref(),
        app.passphrase.trim(),
        Some(ctx),
    )?;
    let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    finish(
        ctx,
        t,
        serde_json::json!({
            "success": true,
            "code": "OK",
            "message": "解密完成",
            "data": {
                "output": out.to_string_lossy(),
                "name": header.name,
                "size": size,
            }
        }),
    )
}

/// 夸克扫码登录（本机写 ~/.config/kuake/.env，不需要 kuake CLI）
#[derive(Debug, App)]
#[app(
    name = "login",
    about = "用夸克 App 扫码登录，自动刷新并写入本机 .env 凭据",
    run = "run_login",
    safety = "t1"
)]
pub struct Login {
    #[arg(about = "等待扫码的秒数（10~900）", default = 300, min = 10, max = 900)]
    pub timeout: u32,
}

fn run_login(app: &Login, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    let mut session = crate::login::LoginSession::start()?;
    let svg_path =
        std::env::temp_dir().join(format!("kuake-studio-login-qr-{}.svg", std::process::id()));
    std::fs::write(&svg_path, session.qr_svg.as_bytes()).map_err(|e| {
        AppError::Runtime(format!("无法保存二维码 SVG 到 {}：{e}", svg_path.display()))
    })?;
    ctx.log(
        LogLevel::Info,
        format!("二维码已保存：{}", svg_path.display()),
    );
    ctx.log(
        LogLevel::Info,
        "请用夸克 App 扫描这个 SVG；在手机上确认登录后凭据会自动写入本机。",
    );
    let meta = session.wait(
        &|| ctx.is_cancelled(),
        &|msg| ctx.log(LogLevel::Info, msg),
        u64::from(app.timeout),
    )?;
    let mut data = meta
        .as_object()
        .cloned()
        .unwrap_or_else(serde_json::Map::new);
    data.insert(
        "qr_url".into(),
        serde_json::Value::String(session.qr_url.clone()),
    );
    data.insert(
        "qr_svg_path".into(),
        serde_json::Value::String(svg_path.to_string_lossy().to_string()),
    );
    finish(
        ctx,
        t,
        serde_json::json!({
            "success": true,
            "code": "OK",
            "message": "扫码登录成功",
            "data": serde_json::Value::Object(data),
        }),
    )
}

/// 从回收站恢复（可多个）
#[derive(Debug, App)]
#[app(
    name = "recycle-restore",
    about = "从回收站恢复到原目录（按 record_id，可多个）",
    run = "run_recycle_restore",
    safety = "t1"
)]
pub struct RecycleRestore {
    #[arg(about = "回收站条目的 record_id（列表里复制），可多个")]
    pub records: Vec<String>,
}

fn run_recycle_restore(app: &RecycleRestore, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    let records = clean_ids(&app.records);
    if records.is_empty() {
        return Err(AppError::InvalidArg("至少给一个 record_id".into()));
    }
    let v = kuake::run(
        ctx,
        &["recycle-restore".to_string()]
            .into_iter()
            .chain(records)
            .collect::<Vec<_>>(),
    )?;
    finish(ctx, t, v)
}

/// 永久删除回收站条目（不可恢复）
#[derive(Debug, App)]
#[app(
    name = "recycle-purge",
    about = "永久删除回收站里的条目（不可恢复，按 record_id，可多个）",
    run = "run_recycle_purge",
    safety = "t1"
)]
pub struct RecyclePurge {
    #[arg(about = "回收站条目的 record_id（列表里复制），可多个")]
    pub records: Vec<String>,
}

fn run_recycle_purge(app: &RecyclePurge, ctx: &Context) -> Result<serde_json::Value, AppError> {
    let t = start();
    let records = clean_ids(&app.records);
    if records.is_empty() {
        return Err(AppError::InvalidArg("至少给一个 record_id".into()));
    }
    let v = kuake::run(
        ctx,
        &["recycle-purge".to_string()]
            .into_iter()
            .chain(records)
            .collect::<Vec<_>>(),
    )?;
    finish(ctx, t, v)
}

/// 前端「每行一个」的 Textarea 会带进空行与首尾空格，统一清一遍再做非空校验。
fn clean_ids(raw: &[String]) -> Vec<String> {
    raw.iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// 全部命令（顺序即 UI 里的呈现顺序）
pub fn commands() -> Vec<lilyco::__core::registry::RegisteredCommand> {
    vec![
        RegisteredCommand::from_app::<ListDir>(),
        RegisteredCommand::from_app::<Info>(),
        RegisteredCommand::from_app::<Search>(),
        RegisteredCommand::from_app::<UserInfo>(),
        RegisteredCommand::from_app::<Version>(),
        RegisteredCommand::from_app::<Download>(),
        RegisteredCommand::from_app::<ShareList>(),
        RegisteredCommand::from_app::<RecycleList>(),
        RegisteredCommand::from_app::<CreateFolder>(),
        RegisteredCommand::from_app::<Upload>(),
        RegisteredCommand::from_app::<Move>(),
        RegisteredCommand::from_app::<Copy>(),
        RegisteredCommand::from_app::<Rename>(),
        RegisteredCommand::from_app::<Delete>(),
        RegisteredCommand::from_app::<Share>(),
        RegisteredCommand::from_app::<ShareDelete>(),
        RegisteredCommand::from_app::<ShareSave>(),
        RegisteredCommand::from_app::<RecycleRestore>(),
        RegisteredCommand::from_app::<RecyclePurge>(),
        RegisteredCommand::from_app::<EncryptLocal>(),
        RegisteredCommand::from_app::<DecryptLocal>(),
        RegisteredCommand::from_app::<Login>(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_schema_is_kebab_and_has_default() {
        let s = <ListDir as App>::schema();
        assert_eq!(s.name, "list");
        assert_eq!(s.args.len(), 1);
        assert_eq!(s.args[0].name, "path");
        assert_eq!(s.args[0].default.as_ref().unwrap(), "/");
        assert!(!s.args[0].required);
    }

    #[test]
    fn rename_arg_is_kebab_case() {
        let s = <Rename as App>::schema();
        let names: Vec<&str> = s.args.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, vec!["path", "new-name"]);
    }

    #[test]
    fn search_schema_requires_q_and_defaults_pagination() {
        let s = <Search as App>::schema();
        assert_eq!(s.name, "search");
        assert_eq!(s.args.len(), 3);
        assert_eq!(s.args[0].name, "q");
        assert!(s.args[0].required);
        assert_eq!(s.args[1].name, "page");
        assert_eq!(s.args[1].default.as_ref().unwrap(), &serde_json::json!(1));
        assert_eq!(s.args[2].name, "size");
        assert_eq!(s.args[2].default.as_ref().unwrap(), &serde_json::json!(50));
    }

    #[test]
    fn recycle_schema_defaults_and_safety() {
        // 只读的列表页：分页有默认值（HTTP/MCP/FFI 宿主靠 schema default 兜底），且不是 T1。
        let list = <RecycleList as App>::schema();
        assert_eq!(list.name, "recycle-list");
        assert_eq!(list.args.len(), 2);
        assert_eq!(list.args[0].name, "page");
        assert_eq!(
            list.args[0].default.as_ref().unwrap(),
            &serde_json::json!(1)
        );
        assert_eq!(list.args[1].name, "size");
        assert_eq!(
            list.args[1].default.as_ref().unwrap(),
            &serde_json::json!(50)
        );
        assert!(matches!(
            list.safety,
            lilyco::__core::safety::SafetyTier::ReadOnly
        ));

        // 两个写操作：record_id 是列表（前端渲染成每行一个），且必须走确认。
        let restore = <RecycleRestore as App>::schema();
        assert_eq!(restore.args.len(), 1);
        assert_eq!(restore.args[0].name, "records");
        assert!(matches!(
            restore.args[0].kind,
            lilyco::__core::schema::ArgKind::List { .. }
        ));
        assert!(!matches!(
            restore.safety,
            lilyco::__core::safety::SafetyTier::ReadOnly
        ));
        assert!(!matches!(
            <RecyclePurge as App>::schema().safety,
            lilyco::__core::safety::SafetyTier::ReadOnly
        ));
    }

    #[test]
    fn clean_ids_drops_blanks_and_trims() {
        let got = clean_ids(&[
            "  a  ".to_string(),
            String::new(),
            "   ".to_string(),
            "b".to_string(),
        ]);
        assert_eq!(got, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn registry_registers_every_command() {
        let mut reg =
            Registry::new().with_policy(std::sync::Arc::new(lilyco::__core::safety::Interactive));
        for c in commands() {
            reg.register(c).expect("重复命令名");
        }
        assert!(reg.contains("list"));
        assert!(reg.contains("share-delete"));
        assert!(reg.contains("search"));
        assert_eq!(reg.visible().count(), commands().len());
    }
}

#[cfg(test)]
mod dest_tests {
    use super::prepare_dest_dir;

    #[test]
    fn creates_missing_directory() {
        let base = std::env::temp_dir().join(format!("kstest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let nested = base.join("a/b");
        let out = prepare_dest_dir(nested.to_str().unwrap()).unwrap();
        assert!(out.is_dir());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_existing_file() {
        let f = std::env::temp_dir().join(format!("kstest-file-{}", std::process::id()));
        std::fs::write(&f, b"x").unwrap();
        let err = prepare_dest_dir(f.to_str().unwrap()).unwrap_err();
        assert!(format!("{err:?}").contains("不是目录"), "got {err:?}");
        let _ = std::fs::remove_file(&f);
    }
}
