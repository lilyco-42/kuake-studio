//! 自研夸克网盘 API 后端（不依赖本机 kuake CLI 子进程）。
//!
//! 这里只实现 kuake-studio 的网盘命令所覆盖的官方 HTTP 接口：
//! 账号 / 列表 / 详情 / 增删改 / 分享 / 上传 / 下载 / 转存 / 全盘搜索 / 回收站。
//! 返回值逐字复刻 kuake CLI 的 JSON 信封 {success,code,message,data}，
//! 因此 src/apps.rs、前端、SSE、MCP、--schema 全都不需要改动。
//!
//! 请求/响应形状来自公开接口实测（/tmp/quark-research/proto*.mjs），
//! 仅对照 AGPL 的 kuake_cli 源码做**语义**核对，未复制其任何代码。

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use lilyco::__core::{AppError, Context, LogLevel};
use md5::{Digest as _, Md5};
use reqwest::blocking::{Client, Response};
use reqwest::Url;
use serde_json::{json, Value};
use sha1::Sha1;

const PAN: &str = "https://pan.quark.cn";
const DRIVE: &str = "https://drive-pc.quark.cn";
const DRIVE_H: &str = "https://drive-h.quark.cn";
const UA_PC: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const UA_DL: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const UA_OSS: &str = "aliyun-sdk-js/1.0.0 Chrome 145.0.0.0 on Windows 10 64-bit";
const PART_SIZE: usize = 4 * 1024 * 1024;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn http_date() -> String {
    httpdate::fmt_http_date(SystemTime::now())
}

fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn env_trim(key: &str) -> Option<String> {
    let v = std::env::var(key).ok()?;
    let v = v.trim();
    let v = v
        .strip_prefix('\'')
        .and_then(|s| s.strip_suffix('\''))
        .or_else(|| v.strip_prefix('"').and_then(|s| s.strip_suffix('"')))
        .unwrap_or(v);
    (!v.is_empty()).then(|| v.to_string())
}

/// 登录凭据：优先 KUAKE_COOKIE；否则用 KUAKE_PUS + KUAKE_PUUS 拼最小可用串。
fn cookie() -> Result<String, AppError> {
    if let Some(c) = env_trim("KUAKE_COOKIE") {
        return Ok(c);
    }
    let pus = env_trim("KUAKE_PUS");
    let puus = env_trim("KUAKE_PUUS");
    if pus.is_some() || puus.is_some() {
        let mut parts = Vec::new();
        if let Some(v) = pus {
            parts.push(format!("__pus={v}"));
        }
        if let Some(v) = puus {
            parts.push(format!("__puus={v}"));
        }
        let joined = parts.join("; ");
        // 把裸值也补成 cookie 对（环境变量可能直接给值而不是 k=v）
        let joined = joined
            .replace("__pus=__pus=", "__pus=")
            .replace("__puus=__puus=", "__puus=");
        return Ok(joined);
    }
    Err(AppError::Runtime(
        "未找到夸克登录凭据。请运行 node tools/dump-cookies.mjs --write-env 刷新 cookie，\n或设置 KUAKE_COOKIE（或 KUAKE_PUS + KUAKE_PUUS）后重启客户端。".into(),
    ))
}

fn ok(message: &str, data: Value) -> Value {
    json!({ "success": true, "code": "OK", "message": message, "data": data })
}

fn err(msg: impl Into<String>) -> AppError {
    AppError::Runtime(msg.into())
}

fn as_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

fn as_i64(v: &Value) -> i64 {
    match v {
        Value::Number(n) => n
            .as_i64()
            .unwrap_or_else(|| n.as_f64().unwrap_or(0.0) as i64),
        Value::String(s) => s.parse().unwrap_or(0),
        _ => 0,
    }
}

fn as_bool(v: &Value) -> Option<bool> {
    match v {
        Value::Bool(b) => Some(*b),
        Value::Number(n) => Some(n.as_i64().unwrap_or(0) != 0),
        _ => None,
    }
}

/// 夸克返回的两种业务形状都检查：{success,code} 与 {status,code,message}。
fn ensure(v: &Value, what: &str) -> Result<(), AppError> {
    if v.get("success").and_then(Value::as_bool) == Some(false) {
        return Err(err(format!(
            "{what} 失败：{} [{}]",
            as_str(v.get("message").unwrap_or(&Value::Null)),
            as_str(v.get("code").unwrap_or(&Value::Null))
        )));
    }
    let code = v.get("code").unwrap_or(&Value::Null);
    let bad = match code {
        Value::Number(n) => n.as_i64().unwrap_or(0) != 0,
        Value::String(s) => !s.is_empty() && s != "OK",
        _ => false,
    };
    if bad {
        return Err(err(format!(
            "{what} 失败：{} [{}]",
            as_str(v.get("message").unwrap_or(&Value::Null)),
            as_str(code)
        )));
    }
    if let Some(st) = v.get("status").and_then(Value::as_i64) {
        if st != 200 && st != 0 {
            return Err(err(format!(
                "{what} 失败：HTTP 状态 {st}，{}",
                as_str(v.get("message").unwrap_or(&Value::Null))
            )));
        }
    }
    Ok(())
}

fn data_of(v: &Value) -> Result<Value, AppError> {
    Ok(v.get("data").cloned().unwrap_or(Value::Null))
}

/// 一个网盘条目（list 与 info 共用）
#[derive(Clone, Debug)]
struct Entry {
    fid: String,
    name: String,
    path: String,
    size: i64,
    dir: bool,
    created_at: i64,
    updated_at: i64,
}

impl Entry {
    fn root() -> Self {
        Entry {
            fid: "0".into(),
            name: String::new(),
            path: "/".into(),
            size: 0,
            dir: true,
            created_at: 0,
            updated_at: 0,
        }
    }
    fn to_list_item(&self) -> Value {
        let ctime = self.created_at / 1000;
        let mtime = self.updated_at / 1000;
        json!({
            "fid": self.fid,
            "file_name": self.name,
            "path": self.path,
            "size": self.size,
            "ctime": ctime,
            "mtime": mtime,
            "dir": self.dir,
            "download_url": "",
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        })
    }
    fn to_info_item(&self) -> Value {
        json!({
            "fid": self.fid,
            "file_name": self.name,
            "path": self.path,
            "size": self.size,
            "ctime": self.created_at / 1000,
            "mtime": self.updated_at / 1000,
            "dir": self.dir,
            "download_url": "",
        })
    }
}

/// 官方接口的文件名会做 HTML 转义 + URL 编码，还原成用户看到的名字。
fn decode_name(s: &str) -> String {
    let mut t = s
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ");
    let bytes = t.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h = |b: u8| -> Option<u8> {
                match b {
                    b'0'..=b'9' => Some(b - b'0'),
                    b'a'..=b'f' => Some(b - b'a' + 10),
                    b'A'..=b'F' => Some(b - b'A' + 10),
                    _ => None,
                }
            };
            if let (Some(a), Some(b)) = (h(bytes[i + 1]), h(bytes[i + 2])) {
                out.push(a * 16 + b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    if let Ok(s) = String::from_utf8(out) {
        t = s;
    }
    t
}

fn normalize_path(p: &str) -> String {
    let mut s = p.trim().replace('\\', "/");
    while s.contains("//") {
        s = s.replace("//", "/");
    }
    if s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    if s.is_empty() {
        s = "/".into();
    }
    s
}

fn is_root(p: &str) -> bool {
    matches!(p, "/" | "" | "." | "0")
}

fn path_join(base: &str, name: &str) -> String {
    if base == "/" || base.is_empty() {
        format!("/{name}")
    } else {
        format!("{base}/{name}")
    }
}

struct Api {
    http: Client,
    long: Client,
    cookie: String,
}

impl Api {
    fn new() -> Result<Self, AppError> {
        let cookie = cookie()?;
        let http = Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent(UA_PC)
            .build()
            .map_err(|e| err(format!("构建 HTTP 客户端失败：{e}")))?;
        let long = Client::builder()
            .timeout(Duration::from_secs(7200))
            .user_agent(UA_DL)
            .build()
            .map_err(|e| err(format!("构建 HTTP 客户端失败：{e}")))?;
        Ok(Api { http, long, cookie })
    }

    fn url(base: &str, ep: &str, extra: &[(&str, String)]) -> Result<Url, AppError> {
        let mut u =
            Url::parse(&format!("{base}{ep}")).map_err(|e| err(format!("URL 无效：{e}")))?;
        {
            let mut q = u.query_pairs_mut();
            q.append_pair("pr", "ucpro");
            q.append_pair("fr", "pc");
            q.append_pair("uc_param_str", "");
            for (k, v) in extra {
                q.append_pair(k, v);
            }
        }
        Ok(u)
    }

    fn send(
        &self,
        method: &str,
        url: Url,
        body: Option<&Value>,
        long: bool,
    ) -> Result<Response, AppError> {
        let client = if long { &self.long } else { &self.http };
        let mut req = client
            .request(
                method
                    .parse::<reqwest::Method>()
                    .map_err(|_| err("HTTP 方法无效"))?,
                url,
            )
            .header("Cookie", &self.cookie)
            .header("Accept", "application/json, text/plain, */*")
            .header("Accept-Language", "zh-CN,zh;q=0.9")
            .header("Cache-Control", "no-cache")
            .header("Pragma", "no-cache")
            .header("Priority", "u=1, i")
            .header("Referer", "https://pan.quark.cn/list")
            .header("Origin", "https://pan.quark.cn");
        if let Some(b) = body {
            req = req
                .header("Content-Type", "application/json")
                .body(serde_json::to_vec(b)?);
        }
        req.send().map_err(|e| err(format!("网络请求失败：{e}")))
    }

    /// 普通 API：返回整个响应 JSON（已检查业务码）。
    fn api(
        &self,
        method: &str,
        base: &str,
        ep: &str,
        extra: &[(&str, String)],
        body: Option<&Value>,
    ) -> Result<Value, AppError> {
        let url = Self::url(base, ep, extra)?;
        let text = self
            .send(method, url, body, false)?
            .text()
            .map_err(|e| err(format!("读取响应失败：{e}")))?;
        let v: Value = serde_json::from_str(&text).map_err(|_| {
            err(format!(
                "响应不是 JSON（前 400 字）：{}",
                &text[..text.len().min(400)]
            ))
        })?;
        ensure(&v, ep)?;
        Ok(v)
    }

    fn get(&self, ep: &str, extra: &[(&str, String)]) -> Result<Value, AppError> {
        self.api("GET", DRIVE, ep, extra, None)
    }

    fn post(&self, ep: &str, extra: &[(&str, String)], body: Value) -> Result<Value, AppError> {
        self.api("POST", DRIVE, ep, extra, Some(&body))
    }

    fn post_h(&self, ep: &str, extra: &[(&str, String)], body: Value) -> Result<Value, AppError> {
        self.api("POST", DRIVE_H, ep, extra, Some(&body))
    }
}
impl Api {
    /// 按父 fid 列目录：每页 50 条，短页结束翻页（绝不依赖 data.total，
    /// 夸克返回的 total 与实际条数可能不一致，照它翻页会漏文件）。
    fn list_by_fid(&self, fid: &str, base: &str) -> Result<Vec<Entry>, AppError> {
        let mut all = Vec::new();
        for page in 1..=200u32 {
            let extra: Vec<(&str, String)> = vec![
                ("pdir_fid", fid.to_string()),
                ("_page", page.to_string()),
                ("_size", "50".to_string()),
                ("_fetch_total", "1".to_string()),
                ("_fetch_sub_dirs", "0".to_string()),
                ("_sort", "file_type:asc,updated_at:desc".to_string()),
                ("fetch_all_file", "1".to_string()),
                ("fetch_risk_file_name", "1".to_string()),
            ];
            let v = self.get("/1/clouddrive/file/sort", &extra)?;
            let data = data_of(&v)?;
            let list: Vec<Value> = data
                .get("list")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let n = list.len();
            for item in &list {
                let name = decode_name(&as_str(item.get("file_name").unwrap_or(&Value::Null)));
                let created = as_i64(item.get("created_at").unwrap_or(&Value::Null));
                let updated = as_i64(item.get("updated_at").unwrap_or(&Value::Null));
                all.push(Entry {
                    fid: as_str(item.get("fid").unwrap_or(&Value::Null)),
                    path: path_join(base, &name),
                    name,
                    size: as_i64(item.get("size").unwrap_or(&Value::Null)),
                    dir: as_bool(item.get("dir").unwrap_or(&Value::Null)).unwrap_or_else(|| {
                        !item.get("file").and_then(Value::as_bool).unwrap_or(false)
                    }),
                    created_at: if created > 0 {
                        created
                    } else {
                        as_i64(item.get("l_created_at").unwrap_or(&Value::Null))
                    },
                    updated_at: if updated > 0 {
                        updated
                    } else {
                        as_i64(item.get("l_updated_at").unwrap_or(&Value::Null))
                    },
                });
            }
            if n < 50 {
                break;
            }
        }
        Ok(all)
    }

    /// 远程路径 → 条目。根返回 fid "0"；否则逐级列目录按名字匹配（比递归
    /// GetFileInfo 省请求）。路径段与列表里的文件名都先 decode_name 再比。
    fn resolve(&self, raw: &str) -> Result<Entry, AppError> {
        let p = normalize_path(raw);
        if is_root(&p) {
            return Ok(Entry::root());
        }
        let parts: Vec<&str> = p
            .trim_start_matches('/')
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();
        let mut fid = "0".to_string();
        let mut base = String::new();
        let mut last: Option<Entry> = None;
        for part in parts {
            let want = decode_name(part);
            let here = if base.is_empty() {
                "/".to_string()
            } else {
                base.clone()
            };
            let entries = self.list_by_fid(&fid, &here)?;
            let hit = entries
                .into_iter()
                .find(|e| e.name == want)
                .ok_or_else(|| err(format!("找不到路径：{raw}")))?;
            base = path_join(&here, &hit.name);
            fid = hit.fid.clone();
            last = Some(hit);
        }
        last.ok_or_else(|| err(format!("找不到路径：{raw}")))
    }

    /// 目标目录参数 → fid。空/根 → "0"；否则必须真是个目录。
    fn dest_dir_fid(&self, raw: &str) -> Result<String, AppError> {
        let p = normalize_path(raw);
        if is_root(&p) {
            return Ok("0".to_string());
        }
        let e = self.resolve(&p)?;
        if !e.dir {
            return Err(err(format!("目标 {raw} 不是目录")));
        }
        Ok(e.fid)
    }

    /// /account/info 是 pan.quark.cn 域名、success/code 形状、query 也不同，
    /// 所以单独走一次请求，不套 Api::url 的 pr/fr/uc_param_str 模板。
    fn account(&self) -> Result<Value, AppError> {
        let mut u = Url::parse(&format!("{PAN}/account/info"))
            .map_err(|e| err(format!("URL 无效：{e}")))?;
        u.query_pairs_mut()
            .append_pair("fr", "pc")
            .append_pair("platform", "pc");
        let text = self
            .send("GET", u, None, false)?
            .text()
            .map_err(|e| err(format!("读取响应失败：{e}")))?;
        let v: Value = serde_json::from_str(&text).map_err(|_| {
            err(format!(
                "账号响应不是 JSON：{}",
                &text[..text.len().min(300)]
            ))
        })?;
        ensure(&v, "/account/info")?;
        data_of(&v)
    }

    fn member(&self) -> Result<Value, AppError> {
        let extra: Vec<(&str, String)> = vec![
            ("fetch_subscribe", "true".into()),
            ("fetch_identity", "true".into()),
            ("_ch", "home".into()),
        ];
        let v = self.get("/1/clouddrive/member", &extra)?;
        data_of(&v)
    }

    /// 分享/转存接口要带 __dt(100-999) 与 __t(毫秒) 防重放参数。
    fn dt_t() -> Vec<(&'static str, String)> {
        let dt = 100 + (rand::random::<u16>() % 900);
        vec![("__dt", dt.to_string()), ("__t", now_ms().to_string())]
    }
}

/// 毫秒时间戳 → 本地（Asia/Shanghai, UTC+8）"YYYY-MM-DD HH:MM:SS"。
/// 不引入 chrono：用 civil_from_days 手算即可，expires_at_formatted 只要这个值。
fn format_ts(ms: i64) -> String {
    let secs = ms / 1000 + 8 * 3600;
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

/// 天数（1970-01-01 起）→ 公历年月日（Howard Hinnant civil_from_days）。
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

/// 解析分享链接：取 /s/{pwd_id}，顺便抓「提取码 xxxx」。
fn parse_share_link(link: &str) -> Result<(String, String), AppError> {
    let pwd = link
        .split("/s/")
        .nth(1)
        .map(|s| {
            s.chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect::<String>()
        })
        .unwrap_or_default();
    let passcode = link
        .split_once("提取码")
        .map(|(_, tail)| {
            tail.trim_start_matches(|c: char| c == ':' || c == '：' || c.is_whitespace())
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_string()
        })
        .unwrap_or_default();
    if pwd.is_empty() {
        return Err(err(format!("无法从分享链接里解析出 pwd_id：{link}")));
    }
    Ok((pwd, passcode))
}

/// 手写 SHA1 中间态（只喂完整 64 字节块，不负责最终 padding）。
/// OSS 多分片上传要 X-Oss-Hash-Ctx：夸克要一份 Go sha1.MarshalBinary 风格的
/// 状态快照（h0..h4 + 已处理字节数），sha1 crate 不导出内部状态，只能自己维护。
struct Sha1State {
    h: [u32; 5],
    buf: [u8; 64],
    used: usize,
    total: u64,
}

impl Sha1State {
    fn new() -> Self {
        Sha1State {
            h: [
                0x6745_2301,
                0xEFCD_AB89,
                0x98BA_DCFE,
                0x1032_5476,
                0xC3D2_E1F0,
            ],
            buf: [0; 64],
            used: 0,
            total: 0,
        }
    }

    fn update(&mut self, mut data: &[u8]) {
        self.total += data.len() as u64;
        if self.used > 0 {
            let take = (64 - self.used).min(data.len());
            self.buf[self.used..self.used + take].copy_from_slice(&data[..take]);
            self.used += take;
            data = &data[take..];
            if self.used == 64 {
                let block = self.buf;
                self.compress(&block);
                self.used = 0;
            }
        }
        while data.len() >= 64 {
            let mut block = [0u8; 64];
            block.copy_from_slice(&data[..64]);
            self.compress(&block);
            data = &data[64..];
        }
        if !data.is_empty() {
            self.buf[..data.len()].copy_from_slice(data);
            self.used = data.len();
        }
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = self.h;
        for (i, &wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A82_7999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let t = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        self.h[0] = self.h[0].wrapping_add(a);
        self.h[1] = self.h[1].wrapping_add(b);
        self.h[2] = self.h[2].wrapping_add(c);
        self.h[3] = self.h[3].wrapping_add(d);
        self.h[4] = self.h[4].wrapping_add(e);
    }

    /// 转成夸克要求的 HashCtx JSON（键顺序与值形状都必须一致）。
    fn hash_ctx(&self) -> Value {
        let bits = self.total * 8;
        json!({
            "hash_type": "sha1",
            "h0": self.h[0].to_string(),
            "h1": self.h[1].to_string(),
            "h2": self.h[2].to_string(),
            "h3": self.h[3].to_string(),
            "h4": self.h[4].to_string(),
            "Nl": (bits as u32).to_string(),
            "Nh": ((bits >> 32) as u32).to_string(),
            "data": "",
            "num": "0",
        })
    }
}

fn need<'a>(argv: &'a [String], i: usize, name: &str) -> Result<&'a str, AppError> {
    argv.get(i)
        .map(|s| s.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::InvalidArg(format!("缺少必填参数: {name}")))
}

fn opt(argv: &[String], i: usize) -> &str {
    argv.get(i).map(|s| s.as_str()).unwrap_or("")
}

/// 在任意层级的响应 JSON 里找第一个同名键（分享/下载任务的返回层级不固定）。
fn deep_get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    if let Some(x) = v.get(key) {
        return Some(x);
    }
    match v {
        Value::Object(m) => {
            for (_, x) in m {
                if let Some(r) = deep_get(x, key) {
                    return Some(r);
                }
            }
            None
        }
        Value::Array(a) => {
            for x in a {
                if let Some(r) = deep_get(x, key) {
                    return Some(r);
                }
            }
            None
        }
        _ => None,
    }
}

fn mime_of(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let m = match ext.as_str() {
        "txt" | "log" | "md" | "csv" | "srt" | "json" | "yaml" | "yml" | "toml" | "xml" => {
            "text/plain; charset=utf-8"
        }
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" | "cjs" => "application/javascript",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "mp4" | "m4v" => "video/mp4",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "apk" => "application/vnd.android.package-archive",
        "kcrypt" | "bin" | "dat" => "application/octet-stream",
        _ => "application/octet-stream",
    };
    m.to_string()
}

/// 目标文件已存在时自动加 " (1)" / " (2)" 后缀，避免覆盖用户文件。
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    for i in 1..1000 {
        let c = dir.join(format!("{stem} ({i}){ext}"));
        if !c.exists() {
            return c;
        }
    }
    dir.join(format!("{stem}-{}", now_ms()))
}

fn oss_client() -> Result<Client, AppError> {
    Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| err(format!("构建 OSS 客户端失败：{e}")))
}

/// 删除/移动/复制是异步任务：接口只给 task_id 时就轮询到 status==2，
/// 否则刚点完「删除」列表里文件还在，UI 会以为命令失败了。
fn wait_task(api: &Api, v: &Value, label: &str) -> Result<Value, AppError> {
    let mut d = data_of(v)?;
    if !as_bool(d.get("finish").unwrap_or(&Value::Null)).unwrap_or(false) {
        if let Some(t) = d.get("task_id") {
            let tid = as_str(t);
            if !tid.is_empty() {
                d = poll_task(
                    api,
                    &tid,
                    &["finish", "status"],
                    &format!("{label}任务超时"),
                )?;
            }
        }
    }
    Ok(d)
}

/// OSS 请求不能带夸克那套 Cookie/Referer 头（会破坏签名语义），单开一个干净请求。
fn oss_send(
    client: &Client,
    method: &str,
    url: &str,
    headers: &[(&str, String)],
    body: Option<Vec<u8>>,
) -> Result<Response, AppError> {
    let u = Url::parse(url).map_err(|e| err(format!("OSS URL 无效：{e}")))?;
    let m: reqwest::Method = method.parse().map_err(|_| err("OSS 方法无效"))?;
    let mut req = client.request(m, u);
    for (k, v) in headers {
        req = req.header(*k, v.as_str());
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    req.send().map_err(|e| err(format!("OSS 请求失败：{e}")))
}

/// 轮询异步任务（分享 / 下载）。返回的 data 里出现指定键且 status==2 即完成。
fn poll_task(
    api: &Api,
    task_id: &str,
    keys: &[&str],
    timeout_hint: &str,
) -> Result<Value, AppError> {
    for _ in 0..24 {
        let extra: Vec<(&str, String)> = vec![
            ("task_id", task_id.to_string()),
            ("retry_index", "0".to_string()),
        ];
        let v = api.get("/1/clouddrive/task", &extra)?;
        let d = data_of(&v)?;
        let status = as_i64(d.get("status").unwrap_or(&Value::Null));
        if status == 2
            && (keys.iter().any(|k| deep_get(&d, k).is_some()) || keys.contains(&"status"))
        {
            return Ok(d);
        }
        if status == 3 {
            return Err(err(format!("夸克异步任务失败：{d}")));
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err(err(timeout_hint.to_string()))
}

/// 上传时逐级确保父目录存在（夸克 CLI 的 UploadFile 也是这个行为）。
fn ensure_dir(api: &Api, raw: &str) -> Result<(String, String), AppError> {
    let p = normalize_path(raw);
    if is_root(&p) {
        return Ok(("0".to_string(), "/".to_string()));
    }
    let parts: Vec<&str> = p
        .trim_start_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    let mut fid = "0".to_string();
    let mut base = String::new();
    for part in parts {
        let want = decode_name(part);
        let here = if base.is_empty() {
            "/".to_string()
        } else {
            base.clone()
        };
        let entries = api.list_by_fid(&fid, &here)?;
        if let Some(hit) = entries.into_iter().find(|e| e.name == want && e.dir) {
            base = path_join(&here, &hit.name);
            fid = hit.fid;
        } else {
            let v = api.post(
                "/1/clouddrive/file",
                &[],
                json!({ "pdir_fid": fid, "file_name": want, "dir_path": "", "dir_init_lock": false }),
            )?;
            let d = data_of(&v)?;
            let new_fid = as_str(d.get("fid").unwrap_or(&Value::Null));
            if new_fid.is_empty() {
                return Err(err(format!("创建目录 {want} 失败：接口没返回 fid")));
            }
            base = path_join(&here, &want);
            fid = new_fid;
        }
    }
    Ok((fid, base))
}

impl Sha1State {
    /// 仅供单测：补上 SHA1 padding，得到完整摘要的十六进制串。
    #[cfg(test)]
    fn finalize_hex(mut self) -> String {
        let bits = self.total * 8;
        let mut tail = vec![0x80u8];
        while (self.used + tail.len()) % 64 != 56 {
            tail.push(0);
        }
        tail.extend_from_slice(&bits.to_be_bytes());
        self.update(&tail);
        self.h.iter().map(|x| format!("{x:08x}")).collect()
    }
}

/// 总入口：被 src/kuake.rs::run 拦截调用，签名与 kuake::run 完全一致。
pub fn dispatch(ctx: &Context, argv: &[String]) -> Result<Value, AppError> {
    if argv.is_empty() {
        return Err(AppError::InvalidArg("空命令".into()));
    }
    let cmd = argv[0].as_str();
    let api = Api::new()?;
    match cmd {
        "user" => cmd_user(&api),
        "version" => Ok(ok(
            "kuake-studio 原生夸克 API",
            json!({ "version": format!("native {}", env!("CARGO_PKG_VERSION")) }),
        )),
        "list" => cmd_list(&api, argv),
        "search" => cmd_search(&api, argv),
        "info" => cmd_info(&api, argv),
        "download" => cmd_download(ctx, &api, argv),
        "share-list" => cmd_share_list(&api, argv),
        "create" => cmd_create(&api, argv),
        "upload" => cmd_upload(ctx, &api, argv),
        "move" => cmd_move_copy(&api, argv, "move"),
        "copy" => cmd_move_copy(&api, argv, "copy"),
        "rename" => cmd_rename(&api, argv),
        "delete" => cmd_delete(&api, argv),
        "recycle-list" => cmd_recycle_list(&api, argv),
        "recycle-restore" => cmd_recycle_action(&api, argv, false),
        "recycle-purge" => cmd_recycle_action(&api, argv, true),
        "share" => cmd_share(&api, argv),
        "share-delete" => cmd_share_delete(&api, argv),
        "share-save" => cmd_share_save(&api, argv),
        other => Err(AppError::InvalidArg(format!("未知命令: {other}"))),
    }
}

fn cmd_user(api: &Api) -> Result<Value, AppError> {
    let mut data = api.account()?;
    let member = api.member()?;
    if let (Some(dst), Some(src)) = (data.as_object_mut(), member.as_object()) {
        for k in [
            "use_capacity",
            "total_capacity",
            "member_type",
            "super_vip_exp_at",
        ] {
            if let Some(v) = src.get(k) {
                dst.insert(k.to_string(), v.clone());
            }
        }
    }
    Ok(ok("get user info success", data))
}

fn cmd_list(api: &Api, argv: &[String]) -> Result<Value, AppError> {
    let raw = if opt(argv, 1).is_empty() {
        "/"
    } else {
        opt(argv, 1)
    };
    let p = normalize_path(raw);
    let e = if is_root(&p) {
        Entry::root()
    } else {
        api.resolve(&p)?
    };
    let items: Vec<Value> = if e.dir {
        let base = if is_root(&p) {
            "/".to_string()
        } else {
            p.clone()
        };
        api.list_by_fid(&e.fid, &base)?
            .iter()
            .map(|x| x.to_list_item())
            .collect()
    } else {
        vec![e.to_list_item()]
    };
    Ok(ok("列出目录成功", json!({ "list": items })))
}

/// 按 pdir_fid 逐级反查到根，拼出可直接喂给 download/rename/move/copy/info 的完整路径。
/// `lookup(fid) -> (文件名, 上一级 fid)` 由调用方提供（带缓存 + 网络），这里只做纯逻辑，
/// 因此能用假的祖先链离线单测。返回 (path, complete)：complete=false 表示链断了或成环，
/// 调用方必须把 path 视为不可用，绝不能拿半截路径去跑写操作。
fn build_search_path<F>(pdir: &str, name: &str, max_depth: usize, mut lookup: F) -> (String, bool)
where
    F: FnMut(&str) -> Option<(String, String)>,
{
    let mut names = vec![name.to_string()];
    let mut seen: HashSet<String> = HashSet::new();
    let mut cur = pdir.to_string();
    let mut complete = true;
    while !is_root(&cur) {
        if names.len() > max_depth || !seen.insert(cur.clone()) {
            complete = false;
            break;
        }
        match lookup(&cur) {
            Some((parent_name, parent_fid)) if !parent_name.is_empty() => {
                names.push(parent_name);
                cur = parent_fid;
            }
            _ => {
                complete = false;
                break;
            }
        }
    }
    names.reverse();
    let path = names
        .iter()
        .fold(String::new(), |acc, n| path_join(&acc, n));
    (path, complete)
}

/// 数值参数：留空用默认，非法报 InvalidArg，越界收敛到 [lo, hi]。
fn arg_num(raw: &str, default: u32, lo: u32, hi: u32, name: &str) -> Result<u32, AppError> {
    if raw.trim().is_empty() {
        return Ok(default);
    }
    let n: u32 = raw
        .trim()
        .parse()
        .map_err(|_| AppError::InvalidArg(format!("{name} 必须是数字")))?;
    Ok(n.clamp(lo, hi))
}

/// 全盘搜索（kuake CLI 没有这条命令，是本项目自研扩展）。
///
/// 官方 /file/search 只回 fid/pdir_fid，不回 path，也不回 total；这里沿 pdir_fid
/// 用 /file/info 逐级反查祖先拼出完整路径，让所有基于路径的命令原样复用。
/// 同一次搜索里祖先高度重合，所以按 fid 缓存；失败只把单条标成 path_partial，
/// 不拖垮整次搜索。
fn cmd_search(api: &Api, argv: &[String]) -> Result<Value, AppError> {
    let q = need(argv, 1, "q")?.trim();
    if q.is_empty() {
        return Err(AppError::InvalidArg("搜索关键词不能为空".into()));
    }
    let page = arg_num(opt(argv, 2), 1, 1, 1000, "page")?;
    let size = arg_num(opt(argv, 3), 50, 1, 100, "size")?;

    let mut extra = Api::dt_t();
    extra.push(("q", q.to_string()));
    extra.push(("_page", page.to_string()));
    extra.push(("_size", size.to_string()));
    extra.push(("_fetch_total", "1".to_string()));
    extra.push(("_sort", "file_type:desc,updated_at:desc".to_string()));
    extra.push(("_is_hl", "1".to_string()));
    let v = api.get("/1/clouddrive/file/search", &extra)?;
    let data = data_of(&v)?;
    let raw_list: Vec<Value> = data
        .get("list")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let n = raw_list.len();

    // fid → Some((名字, 父 fid)) / None（查不到也缓存，避免重复打同一个失败请求）。
    let mut cache: HashMap<String, Option<(String, String)>> = HashMap::new();
    let mut budget: usize = 150; // 一次搜索最多打 150 次 /file/info，防异常目录树拖死
    let mut lookup = |fid: &str| -> Option<(String, String)> {
        if let Some(hit) = cache.get(fid) {
            return hit.clone();
        }
        if budget == 0 {
            return None;
        }
        budget -= 1;
        let mut ex = Api::dt_t();
        ex.push(("fid", fid.to_string()));
        let got = api
            .get("/1/clouddrive/file/info", &ex)
            .ok()
            .and_then(|resp| data_of(&resp).ok())
            .and_then(|d| {
                let name = decode_name(&as_str(d.get("file_name").unwrap_or(&Value::Null)));
                let parent = as_str(d.get("pdir_fid").unwrap_or(&Value::Null));
                if name.is_empty() {
                    None
                } else {
                    Some((name, parent))
                }
            });
        cache.insert(fid.to_string(), got.clone());
        got
    };

    let mut items = Vec::with_capacity(n);
    for item in &raw_list {
        let name = decode_name(&as_str(item.get("file_name").unwrap_or(&Value::Null)));
        let pdir = as_str(item.get("pdir_fid").unwrap_or(&Value::Null));
        let (path, complete) = build_search_path(&pdir, &name, 12, &mut lookup);
        let created = as_i64(item.get("created_at").unwrap_or(&Value::Null));
        let updated = as_i64(item.get("updated_at").unwrap_or(&Value::Null));
        let entry = Entry {
            fid: as_str(item.get("fid").unwrap_or(&Value::Null)),
            name,
            path: if complete { path } else { String::new() },
            size: as_i64(item.get("size").unwrap_or(&Value::Null)),
            dir: as_bool(item.get("dir").unwrap_or(&Value::Null))
                .unwrap_or_else(|| !item.get("file").and_then(Value::as_bool).unwrap_or(false)),
            created_at: if created > 0 {
                created
            } else {
                as_i64(item.get("l_created_at").unwrap_or(&Value::Null))
            },
            updated_at: if updated > 0 {
                updated
            } else {
                as_i64(item.get("l_updated_at").unwrap_or(&Value::Null))
            },
        };
        let mut obj = entry.to_list_item();
        if let Some(m) = obj.as_object_mut() {
            let hl = as_str(item.get("hl_file_name").unwrap_or(&Value::Null));
            if !hl.is_empty() {
                m.insert("hl_file_name".into(), json!(hl));
            }
            if !complete {
                m.insert("path_partial".into(), json!(true));
            }
        }
        items.push(obj);
    }

    Ok(ok(
        "搜索文件成功",
        json!({
            "list": items,
            "q": q,
            "page": page,
            "size": size,
            // 接口不回 total：满页就认为可能还有下一页（短页即止）。
            "has_more": n as u32 >= size,
        }),
    ))
}

fn cmd_info(api: &Api, argv: &[String]) -> Result<Value, AppError> {
    let raw = if opt(argv, 1).is_empty() {
        "/"
    } else {
        opt(argv, 1)
    };
    let p = normalize_path(raw);
    if is_root(&p) {
        let mut d = Entry::root().to_info_item();
        if let Some(m) = d.as_object_mut() {
            m.insert("is_directory".into(), json!(true));
        }
        return Ok(ok("根目录", d));
    }
    Ok(ok("获取文件信息成功", api.resolve(&p)?.to_info_item()))
}

fn cmd_share_list(api: &Api, argv: &[String]) -> Result<Value, AppError> {
    let page = if opt(argv, 1).is_empty() {
        "1"
    } else {
        opt(argv, 1)
    };
    let size = if opt(argv, 2).is_empty() {
        "50"
    } else {
        opt(argv, 2)
    };
    let extra: Vec<(&str, String)> = vec![
        ("page", page.into()),
        ("size", size.into()),
        ("_page", page.into()),
        ("_size", size.into()),
        ("exclude_fids", "".into()),
        ("_fetch_total", "1".into()),
        ("_fetch_notify_follow", "1".into()),
        ("_order_field", "created_at".into()),
        ("_order_type", "desc".into()),
        ("_sort", "create_time:desc".into()),
    ];
    let v = api.get("/1/clouddrive/share/mypage/detail", &extra)?;
    Ok(ok("Get share list successfully", data_of(&v)?))
}

fn cmd_create(api: &Api, argv: &[String]) -> Result<Value, AppError> {
    let name = need(argv, 1, "name")?;
    let pdir = if opt(argv, 2).is_empty() {
        "/"
    } else {
        opt(argv, 2)
    };
    let fid = api.dest_dir_fid(pdir)?;
    let v = api.post(
        "/1/clouddrive/file",
        &[],
        json!({ "pdir_fid": fid, "file_name": name, "dir_path": "", "dir_init_lock": false }),
    )?;
    Ok(ok("创建文件夹成功", data_of(&v)?))
}

fn cmd_move_copy(api: &Api, argv: &[String], which: &str) -> Result<Value, AppError> {
    let src = need(argv, 1, "src")?;
    let dest = if opt(argv, 2).is_empty() {
        "/"
    } else {
        opt(argv, 2)
    };
    let src_fid = api.resolve(src)?.fid;
    let to = api.dest_dir_fid(dest)?;
    let ep = if which == "move" {
        "/1/clouddrive/file/move"
    } else {
        "/1/clouddrive/file/copy"
    };
    let v = api.post(
        ep,
        &[],
        json!({ "action_type": 1, "exclude_fids": [], "filelist": [src_fid], "to_pdir_fid": to }),
    )?;
    let mut d = wait_task(api, &v, if which == "move" { "移动" } else { "复制" })?
        .as_object()
        .cloned()
        .unwrap_or_default();
    d.entry("fid".to_string())
        .or_insert_with(|| Value::String(String::new()));
    let msg = if which == "move" {
        "移动成功"
    } else {
        "复制成功"
    };
    Ok(ok(msg, Value::Object(d)))
}

fn cmd_rename(api: &Api, argv: &[String]) -> Result<Value, AppError> {
    let path = need(argv, 1, "path")?;
    let new_name = need(argv, 2, "new-name")?;
    if new_name.contains('/') || new_name.contains('\\') {
        return Err(AppError::InvalidInput("名称不能包含路径分隔符".into()));
    }
    let fid = api.resolve(path)?.fid;
    let v = api.post(
        "/1/clouddrive/file/rename",
        &[],
        json!({ "fid": fid, "file_name": new_name }),
    )?;
    let mut d = data_of(&v)?.as_object().cloned().unwrap_or_default();
    d.entry("fid".to_string())
        .or_insert_with(|| Value::String(String::new()));
    Ok(ok("重命名成功", Value::Object(d)))
}

fn cmd_delete(api: &Api, argv: &[String]) -> Result<Value, AppError> {
    let path = need(argv, 1, "path")?;
    let fid = api.resolve(path)?.fid;
    let v = api.post(
        "/1/clouddrive/file/delete",
        &[],
        json!({ "action_type": 1, "exclude_fids": [], "filelist": [fid] }),
    )?;
    let mut d = wait_task(api, &v, "删除")?
        .as_object()
        .cloned()
        .unwrap_or_default();
    d.entry("fid".to_string())
        .or_insert_with(|| Value::String(fid));
    Ok(ok("删除成功", Value::Object(d)))
}

/// 回收站条目 → 前端直接可渲染的形状。
///
/// 回收站条目和普通列表项不是同一套字段：记录身份是 record_id（不是 fid），
/// 删除时间在 move_recycle_at，30 天后会进「深度回收」。这里归一一次，
/// 让 UI 不必认识夸克的原始键名。
fn recycle_item(it: &Value) -> Value {
    let mut remain_ms = as_i64(it.get("invisible_remain").unwrap_or(&Value::Null));
    if remain_ms <= 0 {
        remain_ms = as_i64(it.get("move_deep_recycle_at").unwrap_or(&Value::Null)) - now_ms();
    }
    let remain_ms = remain_ms.max(0);
    // 夸克用 file_type==0 表示目录（普通列表里则是 dir 布尔）
    let dir = as_i64(it.get("file_type").unwrap_or(&Value::Null)) == 0;
    json!({
        "record_id": as_str(it.get("record_id").unwrap_or(&Value::Null)),
        "fid": as_str(it.get("fid").unwrap_or(&Value::Null)),
        "file_name": decode_name(&as_str(it.get("file_name").unwrap_or(&Value::Null))),
        "size": as_i64(it.get("size").unwrap_or(&Value::Null)),
        "dir": dir,
        "deleted_at": as_i64(it.get("move_recycle_at").unwrap_or(&Value::Null)),
        "created_at": as_i64(it.get("created_at").unwrap_or(&Value::Null)),
        "updated_at": as_i64(it.get("updated_at").unwrap_or(&Value::Null)),
        "move_deep_recycle_at": as_i64(it.get("move_deep_recycle_at").unwrap_or(&Value::Null)),
        "remain_ms": remain_ms,
        // 还剩几天进深度回收；不足一天按一天算，0 表示已到期或后端没给
        "remain_days": (remain_ms + 86_399_999) / 86_400_000,
        "format_type": as_str(it.get("format_type").unwrap_or(&Value::Null)),
        "file_source": as_str(it.get("file_source").unwrap_or(&Value::Null)),
        "pdir_fid": as_str(it.get("pdir_fid").unwrap_or(&Value::Null)),
    })
}

/// 回收站列表。这个接口**回 total**（/file/search 不回），所以前端能真翻页。
fn cmd_recycle_list(api: &Api, argv: &[String]) -> Result<Value, AppError> {
    let page = arg_num(opt(argv, 1), 1, 1, 1000, "page")?;
    let size = arg_num(opt(argv, 2), 50, 1, 100, "size")?;
    let extra: Vec<(&str, String)> = vec![
        ("_page", page.to_string()),
        ("_size", size.to_string()),
        ("_fetch_total", "1".to_string()),
    ];
    let v = api.get("/1/clouddrive/file/recycle/list", &extra)?;
    let data = data_of(&v)?;
    let raw: Vec<Value> = data
        .get("list")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let items: Vec<Value> = raw.iter().map(recycle_item).collect();
    let total = as_i64(data.get("total").unwrap_or(&Value::Null));
    let deep = as_i64(deep_get(&data, "deep_recycle_count").unwrap_or(&Value::Null));
    // 有 total 就按 total 算；total 缺失时退化成「满页即可能还有下一页」。
    let has_more = if total > 0 {
        i64::from(page) * i64::from(size) < total
    } else {
        raw.len() as u32 >= size
    };
    Ok(ok(
        "回收站列表",
        json!({
            "list": items,
            "total": total,
            "page": page,
            "size": size,
            "has_more": has_more,
            "deep_recycle_count": deep,
        }),
    ))
}

/// 回收站的两个写操作：恢复（异步任务）与永久删除（同步返回 finish）。
///
/// body 只有一种合法形状：select_mode 2 + record_list 字符串数组。
/// record_list 必须是**字符串数组**（传对象数组、或把字段名写成 filelist /
/// record_list_str，一律 14001 Bad Parameter）；select_mode 必须是 2，
/// 传 1 是「全部」语义（record_list 为空时会把整个回收站都恢复），绝不能当探针。
fn cmd_recycle_action(api: &Api, argv: &[String], purge: bool) -> Result<Value, AppError> {
    let records: Vec<String> = argv
        .iter()
        .skip(1)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if records.is_empty() {
        return Err(AppError::InvalidArg("至少给一个 record_id".into()));
    }
    let n = records.len();
    let (ep, label) = if purge {
        ("/1/clouddrive/file/recycle/remove", "永久删除")
    } else {
        ("/1/clouddrive/file/recycle/recover", "恢复")
    };
    let v = api.post(ep, &[], json!({ "select_mode": 2, "record_list": records }))?;
    let d = if purge {
        data_of(&v)?
    } else {
        // 恢复是异步任务。注意 record_id 不存在时夸克照样回 code=0 + task_id，
        // 只是任务永远到不了 status=2 —— 靠 wait_task 超时报错，而不是假装成功。
        wait_task(api, &v, label)?
    };
    Ok(ok(
        if purge {
            "已永久删除"
        } else {
            "已恢复"
        },
        json!({ "count": n, "record_list": records, "result": d }),
    ))
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn cmd_download(ctx: &Context, api: &Api, argv: &[String]) -> Result<Value, AppError> {
    let path = need(argv, 1, "path")?;
    let dest = opt(argv, 2);
    let e = api.resolve(path)?;
    if e.dir {
        return Err(AppError::InvalidInput(
            "不能下载目录，请选择单个文件".into(),
        ));
    }
    let v = api.post(
        "/1/clouddrive/file/download",
        &[],
        json!({ "fids": [e.fid] }),
    )?;
    let d = data_of(&v)?;
    let mut url = deep_get(&d, "download_url").map(as_str).unwrap_or_default();
    if url.is_empty() {
        if let Some(t) = deep_get(&d, "task_id") {
            let tid = as_str(t);
            if !tid.is_empty() {
                let done = poll_task(api, &tid, &["download_url"], "download task timeout")?;
                url = deep_get(&done, "download_url")
                    .map(as_str)
                    .unwrap_or_default();
            }
        }
    }
    if url.is_empty() {
        return Err(err("夸克没有返回下载地址（可能文件违规或登录态过期）"));
    }
    if dest.is_empty() {
        return Ok(ok(
            "Download URL retrieved successfully",
            json!({ "fid": e.fid, "path": e.path, "download_url": url }),
        ));
    }
    let dir = Path::new(dest);
    if !dir.is_dir() {
        std::fs::create_dir_all(dir)?;
    }
    let local = unique_path(dir, &e.name);
    let u = Url::parse(&url).map_err(|e| err(format!("下载地址无效：{e}")))?;
    let mut resp = api
        .long
        .get(u)
        .header("Cookie", &api.cookie)
        .header("Accept", "*/*")
        .header("Accept-Language", "zh-CN,zh;q=0.9")
        .header("Cache-Control", "no-cache")
        .header("Pragma", "no-cache")
        .header("Priority", "u=0, i")
        .header("Referer", "https://pan.quark.cn/")
        .header("Sec-Fetch-Dest", "iframe")
        .header("Sec-Fetch-Mode", "navigate")
        .header("Sec-Fetch-Site", "same-site")
        .header("Upgrade-Insecure-Requests", "1")
        .send()
        .map_err(|e| err(format!("下载请求失败：{e}")))?;
    if !resp.status().is_success() {
        let st = resp.status();
        let mut body = String::new();
        let _ = resp.read_to_string(&mut body);
        return Err(err(format!(
            "download failed: status {st}, body: {}",
            &body[..body.len().min(400)]
        )));
    }
    let mut f = std::fs::File::create(&local)?;
    let mut buf = [0u8; 64 * 1024];
    let mut total = 0u64;
    let mut next_tick = 1024u64 * 1024;
    loop {
        if ctx.is_cancelled() {
            return Err(AppError::Cancelled);
        }
        let n = resp.read(&mut buf)?;
        if n == 0 {
            break;
        }
        f.write_all(&buf[..n])?;
        total += n as u64;
        if total >= next_tick {
            ctx.tick(
                total,
                Some(e.size.max(0) as u64),
                format!("下载中 · {} ", human_bytes(total)),
            );
            next_tick += 1024 * 1024;
        }
    }
    f.flush()?;
    ctx.log(
        LogLevel::Info,
        format!("下载完成：{}（{} 字节）", local.display(), total),
    );
    Ok(ok(
        "File downloaded successfully",
        json!({ "local_path": local.to_string_lossy(), "path": e.path }),
    ))
}

fn human_bytes(n: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", units[i])
    }
}

/// 上传：先流式算整个文件的 md5/sha1 问秒传，未命中再按 4 MiB 分片 PUT + commit。
fn cmd_upload(ctx: &Context, api: &Api, argv: &[String]) -> Result<Value, AppError> {
    let src = need(argv, 1, "file")?;
    let dest = need(argv, 2, "dest")?;
    let file = Path::new(src);
    if !file.is_file() {
        return Err(AppError::InvalidInput(format!(
            "本机文件不存在或不是文件：{src}"
        )));
    }
    let size = std::fs::metadata(file)?.len();
    let dpath = normalize_path(dest);
    if dpath.ends_with('/') || is_root(&dpath) {
        return Err(AppError::InvalidArg(
            "目标必须是完整文件路径（含文件名），不能是目录".into(),
        ));
    }
    let (parent_raw, file_name) = match dpath.rfind('/') {
        Some(0) => ("/".to_string(), dpath[1..].to_string()),
        Some(i) => (dpath[..i].to_string(), dpath[i + 1..].to_string()),
        None => ("/".to_string(), dpath.clone()),
    };
    let (pdir_fid, parent_display) = ensure_dir(api, &parent_raw)?;
    // policy=skip：同名已存在时不静默覆盖，回 SKIPPED 让 apps.rs 转成明确错误。
    if api
        .list_by_fid(&pdir_fid, &parent_display)?
        .iter()
        .any(|e| e.name == file_name)
    {
        return Ok(json!({
            "success": true,
            "code": "SKIPPED",
            "message": format!("文件已存在，跳过上传: {dpath}"),
            "data": {},
        }));
    }

    // 第一遍：流式算摘要（不把整个文件读进内存）。
    let mut f = std::fs::File::open(file)?;
    let mut md5 = Md5::new();
    let mut sha = Sha1::new();
    let mut buf = vec![0u8; 1024 * 1024];
    let mut read_total = 0u64;
    loop {
        if ctx.is_cancelled() {
            return Err(AppError::Cancelled);
        }
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        md5.update(&buf[..n]);
        sha.update(&buf[..n]);
        read_total += n as u64;
    }
    let md5_hex = hex(&md5.finalize());
    let sha1_hex = hex(&sha.finalize());
    let stamp = now_ms();
    let mime = mime_of(&file_name);

    let pre_v = api.post(
        "/1/clouddrive/file/upload/pre",
        &[],
        json!({
            "ccp_hash_update": true,
            "parallel_upload": true,
            "dir_name": "",
            "file_name": file_name,
            "format_type": mime,
            "mimeType": mime,
            "l_created_at": stamp,
            "l_updated_at": stamp,
            "pdir_fid": pdir_fid,
            "size": size,
        }),
    )?;
    let pre = data_of(&pre_v)?;
    let meta = pre_v.get("metadata").cloned().unwrap_or(json!({}));
    let part_size = meta
        .get("part_size")
        .map(as_i64)
        .filter(|n| *n >= 64 && *n % 64 == 0)
        .unwrap_or(PART_SIZE as i64) as usize;
    let task_id = as_str(pre.get("task_id").unwrap_or(&Value::Null));
    let bucket = as_str(pre.get("bucket").unwrap_or(&Value::Null));
    let obj_key = as_str(pre.get("obj_key").unwrap_or(&Value::Null));
    let upload_id = as_str(pre.get("upload_id").unwrap_or(&Value::Null));
    let upload_url = as_str(pre.get("upload_url").unwrap_or(&Value::Null));
    let auth_info = pre.get("auth_info").cloned().unwrap_or(json!({}));
    let callback = pre.get("callback").cloned().unwrap_or(json!({}));
    if task_id.is_empty() || bucket.is_empty() || obj_key.is_empty() || upload_id.is_empty() {
        return Err(err("upload/pre 返回的参数不完整"));
    }
    let host = upload_url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/');
    let oss_root = format!("https://{bucket}.{host}/{obj_key}");

    let hash_v = api.post(
        "/1/clouddrive/file/update/hash",
        &[],
        json!({ "md5": md5_hex, "sha1": sha1_hex, "task_id": task_id }),
    )?;
    let instant = as_bool(data_of(&hash_v)?.get("finish").unwrap_or(&Value::Null)).unwrap_or(false);

    let oss = oss_client()?;
    let mut etags: Vec<(usize, String)> = Vec::new();
    let mut state = Sha1State::new();
    if !instant {
        let mut f2 = std::fs::File::open(file)?;
        let mut part = 1usize;
        let mut chunk = vec![0u8; part_size];
        loop {
            if ctx.is_cancelled() {
                return Err(AppError::Cancelled);
            }
            let n = f2.read(&mut chunk)?;
            if n == 0 {
                break;
            }
            let data = chunk[..n].to_vec();
            // 第 N 片的 HashCtx 是「前 N-1 片都喂完」的 SHA1 中间态。
            let ctx_b64 = if part >= 2 {
                let hc = serde_json::to_vec(&state.hash_ctx())?;
                Some(b64(&hc))
            } else {
                None
            };
            state.update(&data);
            let date = http_date();
            let mut auth_meta = format!("PUT\n\n{mime}\n{date}\n");
            if let Some(c) = &ctx_b64 {
                auth_meta.push_str(&format!("X-Oss-Hash-Ctx:{c}\n"));
            }
            auth_meta.push_str(&format!(
                "x-oss-date:{date}\nx-oss-user-agent:{UA_OSS}\n/{bucket}/{obj_key}?partNumber={part}&uploadId={upload_id}"
            ));
            let auth_v = api.post(
                "/1/clouddrive/file/upload/auth",
                &[],
                json!({ "auth_info": auth_info, "auth_meta": auth_meta, "task_id": task_id }),
            )?;
            let auth_key = as_str(data_of(&auth_v)?.get("auth_key").unwrap_or(&Value::Null));
            if auth_key.is_empty() {
                return Err(err(format!("第 {part} 片没拿到 auth_key")));
            }
            let put_url = format!("{oss_root}?partNumber={part}&uploadId={upload_id}");
            let mut hdrs: Vec<(&str, String)> = vec![
                ("Authorization", auth_key),
                ("Content-Type", mime.clone()),
                ("Date", date.clone()),
                ("x-oss-date", date.clone()),
                ("x-oss-user-agent", UA_OSS.to_string()),
            ];
            if let Some(c) = &ctx_b64 {
                hdrs.push(("X-Oss-Hash-Ctx", c.clone()));
            }
            let mut resp = oss_send(&oss, "PUT", &put_url, &hdrs, Some(data))?;
            let st = resp.status();
            let mut etag = resp
                .headers()
                .get("etag")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .trim_matches('"')
                .to_string();
            if !st.is_success() {
                let mut body = String::new();
                let _ = resp.read_to_string(&mut body);
                if st.as_u16() == 409 && body.contains("PartAlreadyExist") {
                    etag = body
                        .split("<PartEtag>")
                        .nth(1)
                        .and_then(|s| s.split("</PartEtag>").next())
                        .unwrap_or("")
                        .trim_matches('"')
                        .to_string();
                } else {
                    return Err(err(format!(
                        "第 {part} 片上传失败（HTTP {st}）：{}",
                        &body[..body.len().min(300)]
                    )));
                }
            }
            if etag.is_empty() {
                return Err(err(format!("第 {part} 片没有 ETag")));
            }
            etags.push((part, etag));
            let sent = part as u64 * part_size as u64;
            ctx.tick(
                sent.min(size),
                Some(size),
                format!(
                    "上传中 · {} / {}",
                    human_bytes(sent.min(size)),
                    human_bytes(size)
                ),
            );
            part += 1;
            if n < part_size {
                break;
            }
        }
        if etags.is_empty() {
            return Err(err("文件为空且无法秒传，已中止"));
        }
        // CompleteMultipartUpload：auth_meta 第二行必须是 Content-MD5(base64)。
        let xml = format!(
            "<CompleteMultipartUpload>{}</CompleteMultipartUpload>",
            etags
                .iter()
                .map(|(i, e)| format!("<Part><PartNumber>{i}</PartNumber><ETag>{e}</ETag></Part>"))
                .collect::<String>()
        );
        let content_md5 = b64(&Md5::digest(xml.as_bytes()));
        let callback_b64 = match &callback {
            Value::String(s) => b64(s.as_bytes()),
            other => b64(&serde_json::to_vec(other)?),
        };
        let date2 = http_date();
        let auth_meta2 = format!(
            "POST\n{content_md5}\napplication/xml\n{date2}\nx-oss-callback:{callback_b64}\nx-oss-date:{date2}\nx-oss-user-agent:{UA_OSS}\n/{bucket}/{obj_key}?uploadId={upload_id}"
        );
        let auth_v2 = api.post(
            "/1/clouddrive/file/upload/auth",
            &[],
            json!({ "auth_info": auth_info, "auth_meta": auth_meta2, "task_id": task_id }),
        )?;
        let auth_key2 = as_str(data_of(&auth_v2)?.get("auth_key").unwrap_or(&Value::Null));
        let commit_url = format!("{oss_root}?uploadId={upload_id}");
        let hdrs2: Vec<(&str, String)> = vec![
            ("Authorization", auth_key2),
            ("Content-Type", "application/xml".into()),
            ("Content-MD5", content_md5),
            ("Referer", "https://pan.quark.cn/".into()),
            ("x-oss-callback", callback_b64),
            ("x-oss-date", date2),
            ("x-oss-user-agent", UA_OSS.to_string()),
        ];
        let mut resp2 = oss_send(&oss, "POST", &commit_url, &hdrs2, Some(xml.into_bytes()))?;
        let st2 = resp2.status();
        if !st2.is_success() {
            let mut body = String::new();
            let _ = resp2.read_to_string(&mut body);
            return Err(err(format!(
                "合并分片失败（HTTP {st2}）：{}",
                &body[..body.len().min(400)]
            )));
        }
    }

    let finish_v = api.post(
        "/1/clouddrive/file/upload/finish",
        &[],
        json!({ "obj_key": obj_key, "task_id": task_id }),
    )?;
    let mut data = data_of(&finish_v)?.as_object().cloned().unwrap_or_default();
    data.entry("size".to_string())
        .or_insert_with(|| json!(read_total));
    data.entry("md5".to_string())
        .or_insert_with(|| json!(md5_hex));
    data.entry("sha1".to_string())
        .or_insert_with(|| json!(sha1_hex));
    data.entry("format_type".to_string())
        .or_insert_with(|| json!(mime));
    data.entry("task_id".to_string())
        .or_insert_with(|| json!(task_id));
    data.entry("finish".to_string())
        .or_insert_with(|| json!(true));
    let msg = if instant {
        "上传完成（秒传）"
    } else {
        "上传完成"
    };
    ctx.log(
        LogLevel::Info,
        format!("{msg}：{dpath}（{}）", human_bytes(size)),
    );
    Ok(ok(msg, Value::Object(data)))
}

fn cmd_share(api: &Api, argv: &[String]) -> Result<Value, AppError> {
    let path = need(argv, 1, "path")?;
    let days = if opt(argv, 2).is_empty() {
        "1"
    } else {
        opt(argv, 2)
    };
    let with_code = matches!(opt(argv, 3), "true" | "1" | "yes");
    let expired_type = match days {
        "0" => 1,
        "1" => 2,
        "7" => 3,
        "30" => 4,
        _ => {
            return Err(AppError::InvalidArg(format!(
                "有效期只能是 0 / 1 / 7 / 30 天，收到 {days} 天"
            )))
        }
    };
    let e = api.resolve(path)?;
    let title = if e.name.is_empty() {
        path.to_string()
    } else {
        e.name.clone()
    };
    let url_type = if with_code { 2 } else { 1 };
    let mut body = json!({
        "fid_list": [e.fid],
        "title": title,
        "url_type": url_type,
        "expired_type": expired_type,
    });
    let passcode: String;
    if with_code {
        // 4 位提取码，和夸克网页一致。
        passcode = (0..4)
            .map(|_| {
                let d = rand::random::<u8>() % 10;
                char::from(b'0' + d)
            })
            .collect();
        body["passcode"] = json!(passcode);
    } else {
        passcode = String::new();
    }
    let v = api.post("/1/clouddrive/share", &[], body)?;
    let d = data_of(&v)?;
    let mut share_id = deep_get(&d, "share_id").map(as_str).unwrap_or_default();
    if share_id.is_empty() {
        if let Some(t) = deep_get(&d, "task_id") {
            let tid = as_str(t);
            if !tid.is_empty() {
                // 超时文案保留 "wait for task complete"，apps.rs::run_share 才会
                // 回查分享列表（夸克对违规文件的异步任务会假报 401）。
                let done = poll_task(api, &tid, &["share_id"], "wait for task complete timeout")?;
                share_id = deep_get(&done, "share_id").map(as_str).unwrap_or_default();
            }
        }
    }
    if share_id.is_empty() {
        return Err(err("wait for task complete: 分享任务没返回 share_id"));
    }
    let link_v = api.post(
        "/1/clouddrive/share/password",
        &[],
        json!({ "share_id": share_id }),
    )?;
    let l = data_of(&link_v)?;
    let share_url = as_str(l.get("share_url").unwrap_or(&Value::Null));
    let pwd_id = as_str(l.get("pwd_id").unwrap_or(&Value::Null));
    let code = as_str(l.get("passcode").unwrap_or(&Value::Null));
    let expires_at = as_i64(l.get("expired_at").unwrap_or(&Value::Null));
    let formatted = if expires_at > 0 {
        format_ts(expires_at)
    } else {
        String::new()
    };
    Ok(ok(
        "Share link created successfully",
        json!({
            "share_url": if share_url.is_empty() { format!("https://pan.quark.cn/s/{pwd_id}") } else { share_url },
            "pwd_id": pwd_id,
            "passcode": if code.is_empty() { passcode } else { code },
            "expires_at": expires_at,
            "expires_at_formatted": formatted,
        }),
    ))
}

fn cmd_share_delete(api: &Api, argv: &[String]) -> Result<Value, AppError> {
    let mut ids: Vec<String> = Vec::new();
    let mut processed_paths: Vec<String> = Vec::new();
    for a in argv.iter().skip(1) {
        if a.is_empty() {
            continue;
        }
        if a.starts_with('/') {
            // 路径参数：反查该文件的分享 ID（与 kuake CLI 一致）。
            let fid = api.resolve(a)?.fid;
            let list = api.get(
                "/1/clouddrive/share/mypage/detail",
                &[
                    ("_page", "1".into()),
                    ("_size", "50".into()),
                    ("_order_field", "created_at".into()),
                    ("_order_type", "desc".into()),
                ],
            )?;
            let d = data_of(&list)?;
            if let Some(arr) = d.get("list").and_then(Value::as_array) {
                for s in arr {
                    let first = as_str(
                        s.get("first_file")
                            .and_then(|f| f.get("fid"))
                            .unwrap_or(&Value::Null),
                    );
                    if first == fid {
                        ids.push(as_str(s.get("share_id").unwrap_or(&Value::Null)));
                        processed_paths.push(a.clone());
                        break;
                    }
                }
            }
        } else {
            ids.push(a.clone());
        }
    }
    ids.retain(|s| !s.is_empty());
    if ids.is_empty() {
        return Err(AppError::InvalidArg("缺少必填参数: share_id".into()));
    }
    let v = api.post(
        "/1/clouddrive/share/delete",
        &[],
        json!({ "share_ids": ids }),
    )?;
    let _ = data_of(&v)?;
    let mut data = json!({ "deleted_share_ids": ids });
    if !processed_paths.is_empty() {
        data["processed_paths"] = json!(processed_paths);
    }
    Ok(ok("Share deleted successfully", data))
}

fn cmd_share_save(api: &Api, argv: &[String]) -> Result<Value, AppError> {
    let link = need(argv, 1, "link")?;
    let (pwd_id, mut passcode) = parse_share_link(link)?;
    let mut dest_dir = "/".to_string();
    // apps.rs::run_share_save 的 argv：arg2 以 / 开头是 dest_dir，否则是提取码；arg3 是 dest_dir。
    for a in argv.iter().skip(2) {
        if a.is_empty() {
            continue;
        }
        if a.starts_with('/') {
            dest_dir = a.clone();
        } else {
            passcode = a.clone();
        }
    }
    let mut extra = Api::dt_t();
    let body = json!({
        "pwd_id": pwd_id.clone(),
        "passcode": passcode.clone(),
        "support_visit_limit_private_share": true,
    });
    let stoken_v = api.post_h("/1/clouddrive/share/sharepage/token", &extra, body.clone())?;
    let stoken = as_str(data_of(&stoken_v)?.get("stoken").unwrap_or(&Value::Null));
    if stoken.is_empty() {
        return Err(err("分享页没有返回 stoken（提取码可能不对或分享已失效）"));
    }
    let to_pdir_fid = api.dest_dir_fid(&dest_dir)?;
    extra.push(("__dt", (100 + rand::random::<u16>() % 900).to_string()));
    extra.push(("__t", now_ms().to_string()));
    // 全量转存：pdir_save_all=true，fid_list / share_token_list 留空。
    let save_v = api.post(
        "/1/clouddrive/share/sharepage/save",
        &extra,
        json!({
            "fid_list": [],
            "share_token_list": [],
            "to_pdir_fid": to_pdir_fid,
            "pwd_id": pwd_id,
            "stoken": stoken,
            "pdir_fid": "0",
            "pdir_save_all": true,
            "exclude_fids": [],
            "scene": "link",
        }),
    );
    let save_v = match save_v {
        Ok(v) => v,
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("41017") || msg.contains("用户禁止转存自己的分享") {
                return Err(err("不能转存自己的分享：夸克禁止把本人创建的分享保存到本人网盘（41017）。请用另一个账号的分享链接，或让对方转存。"));
            }
            return Err(e);
        }
    };
    let save_data = data_of(&save_v)?;
    Ok(ok(
        "Share files saved successfully",
        json!({
            "pwd_id": pwd_id,
            "dest_dir": dest_dir,
            "dest_fid": to_pdir_fid,
            "save_all": true,
            "save_data": save_data,
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_accepts_both_envelope_shapes() {
        assert!(ensure(&json!({"success": true, "code": "OK", "data": {}}), "x").is_ok());
        assert!(ensure(
            &json!({"status": 200, "code": 0, "message": "ok", "data": {}}),
            "x"
        )
        .is_ok());
    }

    #[test]
    fn ensure_rejects_failed_envelopes() {
        let a = ensure(
            &json!({"success": false, "code": "AUTH", "message": "expired"}),
            "x",
        );
        assert!(a.is_err());
        assert!(a.unwrap_err().to_string().contains("expired"));
        let b = ensure(
            &json!({"status": 403, "code": 41017, "message": "nope"}),
            "x",
        );
        assert!(b.is_err());
    }

    #[test]
    fn decode_name_unescapes_html_and_percent() {
        assert_eq!(decode_name("a&amp;b%20c"), "a&b c");
        assert_eq!(decode_name("&#39;x&#39;"), "'x'");
    }

    #[test]
    fn normalize_path_and_join_are_stable() {
        assert_eq!(normalize_path(" //a\\\\b// "), "/a/b");
        assert_eq!(normalize_path("/"), "/");
        assert_eq!(normalize_path(""), "/");
        assert_eq!(path_join("/", "x"), "/x");
        assert_eq!(path_join("/a", "b"), "/a/b");
        assert!(is_root("0"));
    }

    #[test]
    fn format_ts_is_beijing_time() {
        // 2026-11-13 23:59:59 +08:00
        let ms = 1794585599000i64;
        assert_eq!(format_ts(ms), "2026-11-13 23:59:59");
        assert_eq!(format_ts(0), "1970-01-01 08:00:00");
    }

    #[test]
    fn parse_share_link_extracts_pwd_and_passcode() {
        let (p, c) = parse_share_link("https://pan.quark.cn/s/abc123def456 提取码 ab12").unwrap();
        assert_eq!(p, "abc123def456");
        assert_eq!(c, "ab12");
        assert!(parse_share_link("https://pan.quark.cn/").is_err());
    }

    #[test]
    fn sha1_state_matches_standard_digest() {
        let mut s = Sha1State::new();
        s.update(b"abc");
        assert_eq!(s.finalize_hex(), "a9993e364706816aba3e25717850c26c9cd0d89d");
        let mut s2 = Sha1State::new();
        s2.update(&vec![b'a'; 1000]);
        let expect = hex(&Sha1::digest(vec![b'a'; 1000]));
        let ctx = s2.hash_ctx();
        assert_eq!(ctx["hash_type"], "sha1");
        assert_eq!(ctx["Nl"], "8000");
        assert_eq!(ctx["Nh"], "0");
        assert_eq!(s2.finalize_hex(), expect);
    }

    #[test]
    fn search_path_stops_at_root() {
        let (p, done) = build_search_path("0", "README.md", 12, |_| unreachable!());
        assert!(done);
        assert_eq!(p, "/README.md");
    }

    #[test]
    fn search_path_walks_ancestors() {
        let chain: HashMap<&str, (&str, &str)> = HashMap::from([
            ("86fe", ("手机备份", "6f29")),
            ("6f29", ("01_迁移备份", "0")),
        ]);
        let (p, done) = build_search_path("86fe", "RESTORE-README.md", 12, |fid| {
            chain
                .get(fid)
                .map(|(n, d)| ((*n).to_string(), (*d).to_string()))
        });
        assert!(done);
        assert_eq!(p, "/01_迁移备份/手机备份/RESTORE-README.md");
    }

    #[test]
    fn search_path_detects_cycle_and_caps_depth() {
        let (_, done) = build_search_path("a", "x.txt", 12, |fid| {
            Some((
                "loop".to_string(),
                if fid == "a" { "b" } else { "a" }.to_string(),
            ))
        });
        assert!(!done);
        let (_, done2) = build_search_path("n0", "x.txt", 2, |fid| {
            let n: usize = fid[1..].parse().unwrap_or(0);
            Some((format!("d{n}"), format!("n{}", n + 1)))
        });
        assert!(!done2);
    }

    #[test]
    fn search_arg_num_defaults_clamps_and_rejects_junk() {
        assert_eq!(arg_num("", 50, 1, 100, "size").unwrap(), 50);
        assert_eq!(arg_num("999", 50, 1, 100, "size").unwrap(), 100);
        assert_eq!(arg_num("0", 1, 1, 1000, "page").unwrap(), 1);
        assert!(arg_num("abc", 1, 1, 1000, "page").is_err());
    }
}
