#!/usr/bin/env node
// dump-cookies.mjs — 从本机 Chrome 的 Cookies SQLite 解出明文 cookie（不启动浏览器、不连 CDP）
//
// 原理（Linux / Chrome v10-v11）：
//   1. 口令 = keyring 里的 "Chrome Safe Storage"（KDE=kwallet 文件夹 "Chrome Keys"，GNOME=libsecret
//      schema chrome_libsecret_os_crypt_password_v2）。密钥 = PBKDF2-SHA1(口令,"saltysalt",1,16B)。
//   2. v10 = AES-128-CBC，IV=0x20*16，明文前 32B 是 sha256(host_key)，需剥掉。
//      v11 = AES-256-GCM，头部 12B nonce、尾部 16B tag。
//
// 用法：
//   ./dump-cookies.mjs                      # 打印 quark.cn 的 cookie 串
//   ./dump-cookies.mjs --json               # 明细 JSON
//   ./dump-cookies.mjs --verbose --out /tmp/ck.txt
//   ./dump-cookies.mjs --write-env          # 写进 ~/.config/kuake/.env 的 KUAKE_COOKIE
//   ./dump-cookies.mjs --domain example.com --profile ~/.config/chromium/Default
import { execFileSync } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const profile = opt("--profile", join(homedir(), ".config/google-chrome/Default"));
const domainFilter = opt("--domain", "quark.cn").replace(/^\./, "");
const dbPath = [join(profile, "Network/Cookies"), join(profile, "Cookies")].find((p) => existsSync(p));
if (!dbPath) { console.error("找不到 Cookies 数据库：" + profile); process.exit(1); }

// ---------- 1. 口令 ----------
function safeKey() {
  try {
    const s = execFileSync("kwallet-query", ["-r", "Chrome Safe Storage", "-f", "Chrome Keys", "kdewallet"], { encoding: "utf8", timeout: 8000 }).trim();
    if (s) return s;
  } catch {}
  for (const attrs of [["application", "chrome"], ["application", "chromium"]]) {
    try {
      const s = execFileSync("secret-tool", ["lookup", ...attrs], { encoding: "utf8", timeout: 8000 }).trim();
      if (s) return s;
    } catch {}
  }
  return "peanuts";
}
const password = opt("--password", safeKey());

// ---------- 2. 读 DB（先拷贝，绕开 Chrome 的写锁） ----------
const snap = join(tmpdir(), "dump-cookies-" + process.pid + ".db");
copyFileSync(dbPath, snap);
let rows;
try {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(snap, { readOnly: true });
  rows = db.prepare(
    "select host_key, name, path, hex(encrypted_value) h, value, cast(expires_utc as text) exp, " +
    "is_secure, is_httponly from cookies where host_key like ? order by host_key, name"
  ).all("%" + domainFilter + "%");
  db.close();
} finally { rmSync(snap, { force: true }); }

// ---------- 3. 解密 ----------
const CHROME_EPOCH_MS = 11644473600000n;
function decrypt(hostKey, encHex) {
  const buf = Buffer.from(encHex, "hex");
  const prefix = buf.subarray(0, 3).toString("latin1"); // "v10" / "v11" / 空
  const body = buf.subarray(prefix.startsWith("v1") ? 3 : 0);
  const digest = createHash("sha256").update(hostKey).digest();
  const strip = (v) => (v.length > 32 && v.subarray(0, 32).equals(digest) ? v.subarray(32) : v);
  const utf8 = (b) => b.toString("utf8");

  // 依次尝试各家实际用过的组合。Chrome 在 Linux 上即使打 "v11" 前缀，也常是
  // AES-128-CBC + sha256(host_key) 前导（见下文 CBC 分支），所以两种都要试。
  const tries = [];
  if (body.length > 12 + 16 + 1) {           // AES-GCM：头 12B nonce / 尾 16B tag
    tries.push(() => {
      const d = createDecipheriv("aes-256-gcm", pbkdf2Sync(password, "saltysalt", 1, 32, "sha1"), body.subarray(0, 12));
      d.setAuthTag(body.subarray(-16));
      return strip(Buffer.concat([d.update(body.subarray(12, -16)), d.final()]));
    });
    tries.push(() => {
      const d = createDecipheriv("aes-128-gcm", pbkdf2Sync(password, "saltysalt", 1, 16, "sha1"), body.subarray(0, 12));
      d.setAuthTag(body.subarray(-16));
      return strip(Buffer.concat([d.update(body.subarray(12, -16)), d.final()]));
    });
  }
  for (const len of [16, 32]) {              // AES-CBC：IV = 0x20 * 16
    tries.push(() => {
      const d = createDecipheriv(len === 16 ? "aes-128-cbc" : "aes-256-cbc",
        pbkdf2Sync(password, "saltysalt", 1, len, "sha1"), Buffer.alloc(16, 0x20));
      return strip(Buffer.concat([d.update(body), d.final()]));
    });
  }
  let lastErr;
  for (const t of tries) {
    try {
      const v = t();
      const str = utf8(v);
      if (!str.includes("\uFFFD")) return str; // 乱码说明这组参数不对，继续试下一个
      lastErr = new Error("解密结果含非法 UTF-8");
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("解密失败");
}

const out = [];
let failed = 0;
for (const r of rows) {
  let value;
  try { value = r.value && r.value.length ? r.value : decrypt(r.host_key, r.h); }
  catch { failed++; continue; }
  const expMs = Number(BigInt(String(r.exp)) / 1000n - CHROME_EPOCH_MS);
  out.push({
    name: r.name, domain: r.host_key, path: r.path, value,
    expires: expMs ? new Date(expMs).toISOString() : null,
    expired: expMs ? expMs * 1000 < Date.now() : false,
  });
}

// ---------- 4. 输出 ----------
// 同名去重：只要未过期且值最长的（__puus 在不同 path 有不同值）
const usable = out.filter((c) => !c.expired && c.value);
const byName = new Map();
for (const c of usable) {
  const cur = byName.get(c.name);
  if (!cur || c.value.length > cur.value.length) byName.set(c.name, c);
}
const cookieString = [...byName.values()].map((c) => c.name + "=" + c.value).join("; ");

if (flag("--json")) {
  console.log(JSON.stringify({ database: dbPath, passwordFromKeyring: password !== "peanuts", total: out.length, failed, cookies: out }, null, 2));
} else {
  console.log(cookieString);
  if (flag("--verbose")) {
    console.error("# db=" + dbPath + "  total=" + out.length + " failed=" + failed + " usable=" + byName.size);
    for (const c of out) console.error("# " + (c.expired ? "EXPIRED " : "ok      ") + c.name.padEnd(20) + c.domain.padEnd(16) + "len=" + c.value.length + " exp=" + (c.expires || "session"));
  }
}

const outPath = opt("--out", null);
if (outPath) { mkdirSync(dirname(outPath), { recursive: true }); writeFileSync(outPath, cookieString + "\n"); console.error("已写入 " + outPath); }

if (flag("--write-env")) {
  const envPath = opt("--env", join(homedir(), ".config/kuake/.env"));
  mkdirSync(dirname(envPath), { recursive: true });
  let lines = existsSync(envPath) ? readFileSync(envPath, "utf8").split("\n") : [];
  lines = lines.filter((l) => l && !l.startsWith("KUAKE_COOKIE="));
  // 必须加引号：cookie 里有空格和分号，裸写会被 shell 的 source/export 拆开
  lines.push("KUAKE_COOKIE='" + cookieString.replace(/'/g, "'\\''") + "'");
  writeFileSync(envPath, lines.join("\n") + "\n", { mode: 0o600 });
  console.error("已更新 " + envPath + " 的 KUAKE_COOKIE（" + cookieString.length + " 字符）");
}
