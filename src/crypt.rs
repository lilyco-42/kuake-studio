//! 上传前加密插件（可选模块）。
//!
//! 设计目标：流式（不把整文件读进内存）+ 可校验（分块 AEAD，任何一块被改都解不开）
//! + 自带文件名（解密后不用问用户原名叫什么）。
//!
//! 容器格式 KCS1（全部小端）：
//!   magic     4B   "KCS1"
//!   kdf_iters 4B   u32  PBKDF2-HMAC-SHA256 迭代数
//!   chunk     4B   u32  明文块大小（1 MiB）
//!   pt_len    8B   u64  明文总长度
//!   salt      16B  PBKDF2 盐
//!   npfx      4B   每块 nonce 的前 4 字节（随机，其余 8 字节是块序号）
//!   name_len  2B   u16  原名 UTF-8 字节数（上限 512）
//!   name      nB   原文件名
//!   之后是块序列，每块： ct_len 4B u32 | ciphertext（明文长度 + 16B tag）
//!
//! 加密参数：AES-256-GCM，密钥 = PBKDF2-HMAC-SHA256(passphrase, salt, kdf_iters)。
//! 每块 AAD = 块序号(8B BE) + 末块标记(1B)，防止重排 / 截断。

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use lilyco::prelude::*;
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use sha2::Sha256;

pub const MAGIC: &[u8; 4] = b"KCS1";
pub const CHUNK: usize = 1 << 20;
pub const KDF_ITERS: u32 = 200_000;
pub const TAG: usize = 16;
pub const MAX_NAME: usize = 512;
pub const EXT: &str = "kcrypt";

/// 口令强度下限：太短的口令在离线爆破面前等于没有
pub const MIN_PASSPHRASE: usize = 8;

pub fn check_passphrase(p: &str) -> Result<(), AppError> {
    if p.chars().count() < MIN_PASSPHRASE {
        return Err(AppError::InvalidInput(format!(
            "口令至少 {MIN_PASSPHRASE} 位（这是唯一能解开的凭据，丢了文件就废了）"
        )));
    }
    Ok(())
}

fn nonce_bytes(prefix: &[u8; 4], counter: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[..4].copy_from_slice(prefix);
    n[4..].copy_from_slice(&counter.to_be_bytes());
    n
}

fn aad_bytes(counter: u64, is_last: bool) -> [u8; 9] {
    let mut a = [0u8; 9];
    a[..8].copy_from_slice(&counter.to_be_bytes());
    a[8] = if is_last { 1 } else { 0 };
    a
}

/// 加密 src -> dest，容器里记录 src 的文件名。ctx 只用 tick 报进度，可为 None。
pub fn encrypt_file(
    src: &Path,
    dest: &Path,
    passphrase: &str,
    ctx: Option<&Context>,
) -> Result<u64, AppError> {
    let name = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "unnamed".to_string());
    encrypt_file_as(src, dest, &name, passphrase, ctx)
}

/// 同 encrypt_file，但容器里记录的原文件名可以指定。
/// 上传前加密必须走这条：本机暂存名是 `{uuid}-原名`，要用网盘上的名字才对。
pub fn encrypt_file_as(
    src: &Path,
    dest: &Path,
    inner_name: &str,
    passphrase: &str,
    ctx: Option<&Context>,
) -> Result<u64, AppError> {
    check_passphrase(passphrase)?;
    let meta = std::fs::metadata(src)
        .map_err(|e| AppError::InvalidInput(format!("读不到源文件 {}: {e}", src.display())))?;
    if !meta.is_file() {
        return Err(AppError::InvalidInput(format!(
            "{} 不是一个普通文件",
            src.display()
        )));
    }
    let pt_len = meta.len();

    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let mut npfx = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut npfx);

    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), &salt, KDF_ITERS, &mut key);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| AppError::Runtime("初始化加密器失败".into()))?;

    let mut nb = inner_name.as_bytes().to_vec();
    if nb.len() > MAX_NAME {
        nb.truncate(MAX_NAME);
    }

    let mut input = BufReader::with_capacity(CHUNK, File::open(src)?);
    let mut out = BufWriter::with_capacity(CHUNK, File::create(dest)?);

    out.write_all(MAGIC)?;
    out.write_all(&KDF_ITERS.to_le_bytes())?;
    out.write_all(&(CHUNK as u32).to_le_bytes())?;
    out.write_all(&pt_len.to_le_bytes())?;
    out.write_all(&salt)?;
    out.write_all(&npfx)?;
    out.write_all(&(nb.len() as u16).to_le_bytes())?;
    out.write_all(&nb)?;

    let total_chunks = if pt_len == 0 {
        1
    } else {
        pt_len.div_ceil(CHUNK as u64)
    };
    let mut buf = vec![0u8; CHUNK];
    let mut written: u64 = 0;
    let mut counter: u64 = 0;
    loop {
        let mut filled = 0usize;
        while filled < CHUNK {
            let n = input.read(&mut buf[filled..])?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        let is_last = written + filled as u64 >= pt_len;
        let nonce = nonce_bytes(&npfx, counter);
        let aad = aad_bytes(counter, is_last);
        let ct = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &buf[..filled],
                    aad: &aad,
                },
            )
            .map_err(|_| AppError::Runtime("加密失败（AES-GCM）".into()))?;
        out.write_all(&(ct.len() as u32).to_le_bytes())?;
        out.write_all(&ct)?;
        written += filled as u64;
        counter += 1;
        if let Some(c) = ctx {
            c.tick(
                counter,
                Some(total_chunks),
                format!("加密中 {} / {}", written, pt_len),
            );
        }
        if is_last {
            break;
        }
    }
    out.flush()?;
    Ok(counter)
}

/// 容器头部信息（解密前可读，用于展示）
#[derive(Debug, Clone)]
pub struct Header {
    pub kdf_iters: u32,
    pub chunk: u32,
    pub pt_len: u64,
    pub name: String,
}

/// 只读头部，不解密 —— 用于「这是什么文件」这种展示
pub fn read_header(path: &Path) -> Result<Header, AppError> {
    let mut f = BufReader::new(File::open(path)?);
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic)
        .map_err(|_| bad("不是 kuake-studio 加密文件（太短）"))?;
    if &magic != MAGIC {
        return Err(bad("不是 kuake-studio 加密文件（magic 不匹配）"));
    }
    let mut b4 = [0u8; 4];
    let mut b8 = [0u8; 8];
    f.read_exact(&mut b4)?;
    let kdf_iters = u32::from_le_bytes(b4);
    f.read_exact(&mut b4)?;
    let chunk = u32::from_le_bytes(b4);
    f.read_exact(&mut b8)?;
    let pt_len = u64::from_le_bytes(b8);
    let mut salt = [0u8; 16];
    f.read_exact(&mut salt)?;
    let mut npfx = [0u8; 4];
    f.read_exact(&mut npfx)?;
    let mut b2 = [0u8; 2];
    f.read_exact(&mut b2)?;
    let n = u16::from_le_bytes(b2) as usize;
    let mut nb = vec![0u8; n];
    f.read_exact(&mut nb)?;
    Ok(Header {
        kdf_iters,
        chunk,
        pt_len,
        name: String::from_utf8_lossy(&nb).to_string(),
    })
}

fn bad(msg: &str) -> AppError {
    AppError::InvalidInput(msg.to_string())
}

/// 解密 src 到 out_dir（None = 与源文件同目录）。返回落地的真实路径。
pub fn decrypt_file(
    src: &Path,
    out_dir: Option<&Path>,
    passphrase: &str,
    ctx: Option<&Context>,
) -> Result<PathBuf, AppError> {
    let mut f = BufReader::with_capacity(CHUNK, File::open(src)?);
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic)
        .map_err(|_| bad("不是 kuake-studio 加密文件（太短）"))?;
    if &magic != MAGIC {
        return Err(bad("不是 kuake-studio 加密文件（magic 不匹配）"));
    }
    let mut b4 = [0u8; 4];
    let mut b8 = [0u8; 8];
    f.read_exact(&mut b4)?;
    let kdf_iters = u32::from_le_bytes(b4);
    f.read_exact(&mut b4)?;
    let chunk = u32::from_le_bytes(b4) as usize;
    if chunk == 0 || chunk > (64 << 20) {
        return Err(bad("头部损坏（块大小异常）"));
    }
    f.read_exact(&mut b8)?;
    let pt_len = u64::from_le_bytes(b8);
    let mut salt = [0u8; 16];
    f.read_exact(&mut salt)?;
    let mut npfx = [0u8; 4];
    f.read_exact(&mut npfx)?;
    let mut b2 = [0u8; 2];
    f.read_exact(&mut b2)?;
    let nlen = u16::from_le_bytes(b2) as usize;
    if nlen > MAX_NAME {
        return Err(bad("头部损坏（文件名过长）"));
    }
    let mut nb = vec![0u8; nlen];
    f.read_exact(&mut nb)?;
    let name = String::from_utf8_lossy(&nb).to_string();
    let name = sanitize_name(&name)?;

    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), &salt, kdf_iters, &mut key);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| AppError::Runtime("初始化解密器失败".into()))?;

    let dir = match out_dir {
        Some(d) => d.to_path_buf(),
        None => src.parent().unwrap_or_else(|| Path::new(".")).to_path_buf(),
    };
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| AppError::InvalidInput(format!("无法创建目录 {}: {e}", dir.display())))?;
    }
    let target = unique_path(&dir.join(&name));

    let mut out = BufWriter::with_capacity(chunk, File::create(&target)?);
    let total_chunks = if pt_len == 0 {
        1
    } else {
        pt_len.div_ceil(chunk as u64)
    };
    let mut written: u64 = 0;
    let mut counter: u64 = 0;
    loop {
        let mut lb = [0u8; 4];
        if f.read_exact(&mut lb).is_err() {
            let _ = std::fs::remove_file(&target);
            return Err(bad("文件不完整（数据块缺失）"));
        }
        let ct_len = u32::from_le_bytes(lb) as usize;
        if ct_len < TAG || ct_len > chunk + TAG {
            let _ = std::fs::remove_file(&target);
            return Err(bad("文件损坏（块长度异常）"));
        }
        let mut ct = vec![0u8; ct_len];
        if f.read_exact(&mut ct).is_err() {
            let _ = std::fs::remove_file(&target);
            return Err(bad("文件不完整（数据块缺失）"));
        }
        let is_last = written + (ct_len - TAG) as u64 >= pt_len;
        let nonce = nonce_bytes(&npfx, counter);
        let aad = aad_bytes(counter, is_last);
        let pt = cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ct,
                    aad: &aad,
                },
            )
            .map_err(|_| {
                let _ = std::fs::remove_file(&target);
                AppError::InvalidInput(
                    "解密失败：口令不对，或文件被改动 / 截断（分块校验没过）".into(),
                )
            })?;
        out.write_all(&pt)?;
        written += pt.len() as u64;
        counter += 1;
        if let Some(c) = ctx {
            c.tick(
                counter,
                Some(total_chunks),
                format!("解密中 {} / {}", written, pt_len),
            );
        }
        if is_last {
            break;
        }
    }
    out.flush()?;
    if written != pt_len {
        let _ = std::fs::remove_file(&target);
        return Err(AppError::InvalidInput(format!(
            "解密长度不符：期望 {pt_len} 字节，实际 {written} 字节"
        )));
    }
    Ok(target)
}

/// 原文件名可能来自外面，必须掐掉路径分隔符与 ..
fn sanitize_name(name: &str) -> Result<String, AppError> {
    let base = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if base.is_empty() || base == "." || base == ".." {
        return Err(bad("容器里的文件名不可用"));
    }
    Ok(base)
}

/// 同名文件不覆盖，改成 name (1).ext
fn unique_path(p: &Path) -> PathBuf {
    if !p.exists() {
        return p.to_path_buf();
    }
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let ext = p.extension().map(|s| s.to_string_lossy().to_string());
    for i in 1..1000 {
        let cand = match &ext {
            Some(e) => p.with_file_name(format!("{stem} ({i}).{e}")),
            None => p.with_file_name(format!("{stem} ({i})")),
        };
        if !cand.exists() {
            return cand;
        }
    }
    p.to_path_buf()
}

/// 给已加密的文件名补 .kcrypt（已有就不重复加）
pub fn with_ext(s: &str) -> String {
    let t = s.trim();
    if t.to_ascii_lowercase().ends_with(&format!(".{EXT}")) {
        t.to_string()
    } else {
        format!("{t}.{EXT}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kcs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn roundtrip_small_and_multi_chunk() {
        let d = tmpdir("rt");
        let size = CHUNK * 2 + 17;
        let plain: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        let src = d.join("报告 v1.bin");
        std::fs::write(&src, &plain).unwrap();

        let enc = d.join("报告 v1.bin.kcrypt");
        let blocks = encrypt_file(&src, &enc, "correct horse battery", None).unwrap();
        assert_eq!(blocks, 3);

        let h = read_header(&enc).unwrap();
        assert_eq!(h.pt_len, size as u64);
        assert_eq!(h.name, "报告 v1.bin");

        let out_dir = d.join("out");
        let got = decrypt_file(&enc, Some(&out_dir), "correct horse battery", None).unwrap();
        assert_eq!(got, out_dir.join("报告 v1.bin"));
        assert_eq!(std::fs::read(&got).unwrap(), plain);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn wrong_passphrase_is_rejected() {
        let d = tmpdir("pw");
        let src = d.join("a.txt");
        std::fs::write(&src, b"hello world").unwrap();
        let enc = d.join("a.txt.kcrypt");
        encrypt_file(&src, &enc, "right-passphrase", None).unwrap();
        let out = d.join("o");
        let err = decrypt_file(&enc, Some(&out), "wrong-passphrase", None).unwrap_err();
        assert!(format!("{err}").contains("口令不对"), "got {err}");
        assert!(!out.join("a.txt").exists(), "失败不能留下半截文件");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn truncation_is_detected() {
        let d = tmpdir("tr");
        let src = d.join("big.bin");
        std::fs::write(&src, vec![7u8; CHUNK + 100]).unwrap();
        let enc = d.join("big.bin.kcrypt");
        encrypt_file(&src, &enc, "0123456789", None).unwrap();
        let full = std::fs::read(&enc).unwrap();
        std::fs::write(&enc, &full[..full.len() - 64]).unwrap();
        let err = decrypt_file(&enc, Some(&d.join("o")), "0123456789", None).unwrap_err();
        let m = format!("{err}");
        assert!(m.contains("不完整") || m.contains("解密失败"), "got {m}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn short_passphrase_rejected() {
        let d = tmpdir("sp");
        let src = d.join("x");
        std::fs::write(&src, b"x").unwrap();
        let err = encrypt_file(&src, &d.join("x.kcrypt"), "short", None).unwrap_err();
        assert!(format!("{err}").contains("至少"), "got {err}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ext_helper_is_idempotent() {
        assert_eq!(with_ext("a.txt"), "a.txt.kcrypt");
        assert_eq!(with_ext("a.txt.kcrypt"), "a.txt.kcrypt");
        assert_eq!(with_ext("a.txt.KCRYPT"), "a.txt.KCRYPT");
    }

    #[test]
    fn empty_file_roundtrips() {
        let d = tmpdir("empty");
        let src = d.join("empty.bin");
        std::fs::write(&src, b"").unwrap();
        let enc = d.join("empty.bin.kcrypt");
        encrypt_file(&src, &enc, "0123456789", None).unwrap();
        let got = decrypt_file(&enc, Some(&d.join("o")), "0123456789", None).unwrap();
        assert_eq!(std::fs::read(&got).unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&d);
    }
}
