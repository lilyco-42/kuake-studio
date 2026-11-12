#!/usr/bin/env node
// dump-kuake-cli-json.mjs — 自己在本机把 kuake CLI 的 JSON 输出采集成一份快照
// 只读命令；不写网盘、不写仓库。默认落 ~/.local/share/kuake-studio/，权限 600。
// 用法: node tools/dump-kuake-cli-json.mjs [--out <path>] [--kuake <path>] [--redact-only] [--markdown [path]] [--stdout]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const arg = (k, fb) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : fb; };
const has = (k) => argv.includes(k);
const home = process.env.HOME || os.homedir();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kuakeBin = arg("--kuake", path.join(home, ".local/bin/kuake"));
const outFile = arg("--out", path.join(home, ".local/share/kuake-studio/kuake-cli-json.json"));

// 凭据：与 run.sh 一致，~/.config/kuake/.env 优先；绝不打印值。
function loadCredential() {
  const envPath = path.join(home, ".config/kuake/.env");
  const out = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(KUAKE_[A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  }
  for (const k of ["KUAKE_COOKIE", "KUAKE_PUS", "KUAKE_PUUS"]) {
    if (!out[k] && process.env[k]) out[k] = process.env[k].trim();
  }
  if (!out.KUAKE_COOKIE && !(out.KUAKE_PUS && out.KUAKE_PUUS)) throw new Error("找不到 KUAKE_COOKIE / KUAKE_PUS+KUAKE_PUUS");
  return out;
}
const cred = loadCredential();
const env = { ...process.env, HOME: home, ...cred, PATH: `${process.env.PATH || ""}:${path.join(home, ".local/bin")}` };
delete env.KUAKE_STUDIO_BACKEND;

function callOnce(args) {
  const r = spawnSync(kuakeBin, args, { env, encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  return { exit: r.status, stdout: r.stdout || "", stderr: r.stderr || "", signal: r.signal || null };
}
// 只读命令偶发 401/限流：最多重试 4 次，直到拿到 success:true 的稳定信封。
function call(args, expectSuccess = true) {
  let last = callOnce(args);
  for (let attempt = 1; attempt < 4; attempt++) {
    const env = parseEnvelope(last.stdout);
    const lines = last.stdout.split(/\r?\n/).filter((x) => x.trim());
    const nd = lines.length > 1 && lines.every((x) => { try { const o = JSON.parse(x); return o && typeof o === "object" && !Array.isArray(o); } catch { return false; } });
    const usable = nd || (env && env.success === expectSuccess);
    if (usable) return last;
    // 让夸克冷却一下再试
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},1200)"], { stdio: "ignore" });
    last = callOnce(args);
  }
  return last;
}
function parseEnvelope(stdout) {
  const t = stdout.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch {}
  // 容忍「上传进度」之类的前置脏行：从第一个 { 开始用 deserializer 流式取第一个对象
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (start < 0) { if (c === "{") { start = i; depth = 1; } continue; }
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++; else if (c === "}") { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}
function parseNdjson(stdout) {
  return stdout.split(/\r?\n/).filter((x) => x.trim()).map((x) => { try { return JSON.parse(x); } catch { return { _raw: x }; } });
}

// 只读命令，绝不产生副作用（create/upload/share 只给缺参错误信封）。
const CASES = [
  { id: "version", args: ["version"] },
  { id: "user", args: ["user"] },
  { id: "list-root", args: ["list", "/"] },
  { id: "list-subdir", args: ["list", "/06_待整理"] },
  { id: "info-root", args: ["info", "/"] },
  { id: "info-file", args: ["info", "/README_夸克网盘分类说明.md"] },
  { id: "share-list", args: ["share-list", "1", "2"] },
  { id: "download-url-only", args: ["download", "/README_夸克网盘分类说明.md"] },
  { id: "list-stream-ndjson", args: ["list", "/", "--stream"], ndjson: true },
  { id: "error-create-noargs", args: ["create"] },
  { id: "error-upload-noargs", args: ["upload"] },
  { id: "error-share-noargs", args: ["share"] },
  { id: "error-info-missing", args: ["info", "/__kuake_studio_dump_missing__"] },
];

const SENSITIVE = /^(download_url|upload_url|avatarUri|mobilekps|stoken|share_url|pwd_id|share_id|fid|first_fid|obj_key|upload_id|auth_info|auth_key|callback|service_ticket|token|cookie|md5|sha1|Signature|file_struct|task_id|passcode|share_token|fid_token|share_fid_token|nickname|file_name|title|path|path_info|dir_name|name|pdir_fid|kuake_bin|__dt|__t)$/i;
// 每次采集都会变的字段（倒计时 / 服务器时间戳），归一后文档才稳定可复现。
const VOLATILE = /^(expired_left|timestamp|server_cur_time|cur_time|request_id|_timestamp)$/i;
function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "args" && Array.isArray(x)) {
        o[k] = x.map((a) => typeof a === "string" && a.startsWith("/") && a !== "/" ? "<path>" : a);
      } else if (VOLATILE.test(k)) {
        o[k] = "<volatile>";
      } else if (SENSITIVE.test(k) && (typeof x === "string" || typeof x === "number")) {
        o[k] = "<redacted>";
      } else o[k] = redact(x);
    }
    return o;
  }
  return v;
}

const snap = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, node: process.version, kuake_bin: kuakeBin },
  credential: Object.keys(cred),
  cases: [],
};
for (const c of CASES) {
  const expectSuccess = !c.id.startsWith("error-");
  const r = call(c.args, expectSuccess);
  if (r.exit !== 0 && !c.id.startsWith("error-")) {
    throw new Error(`用例 ${c.id} 重试 4 次仍失败（exit=${r.exit}），未写出半成品快照：${(r.stdout || r.stderr).slice(0, 200)}`);
  }
  const item = { id: c.id, args: c.args, exit: r.exit, stdout_bytes: Buffer.byteLength(r.stdout), stderr_bytes: Buffer.byteLength(r.stderr) };
  if (c.ndjson) { item.format = "ndjson"; const arr = parseNdjson(r.stdout); item.count = arr.length; item.data = arr; }
  else { item.format = "json"; item.data = parseEnvelope(r.stdout); item.parse_ok = item.data !== null; }
  if (r.stderr.trim()) item.stderr_preview = r.stderr.trim().slice(0, 300);
  snap.cases.push(item);
}
// help 走 stderr 且不是 JSON，单独存 usage 文本。
const help = call(["help"]);
snap.usage = help.stderr.trim();

fs.mkdirSync(path.dirname(outFile), { recursive: true });
const redacted = JSON.stringify(redact(snap), null, 2) + "\n";
for (const part of Object.values(cred).join(";").split(";").map((x) => x.trim()).filter((x) => x.length > 8)) {
  if (redacted.includes(part)) throw new Error("脱敏副本疑似包含凭据片段，已中止");
}
const redOnly = has("--redact-only");
const redFile = redOnly ? outFile : outFile.replace(/\.json$/, ".redacted.json");
if (!redOnly) {
  fs.writeFileSync(outFile, JSON.stringify(snap, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(outFile, 0o600);
}
fs.writeFileSync(redFile, redacted, { mode: 0o644 });

function markdown(snap) {
  const Q = String.fromCharCode(96);
  const L = [];
  const a = (x) => L.push(x);
  const tick = (x) => Q + x + Q;
  a("# kuake CLI JSON 形状快照");
  a("");
  a("由 " + tick("tools/dump-kuake-cli-json.mjs --markdown") + " 生成（只写脱敏后的结构）。");
  a("签名直链、fid、stoken、昵称、文件名、路径等敏感字段替换为 " + tick("<redacted>") + " / " + tick("<path>") + "；");
  a("倒计时、服务器时间戳等每次都变的字段替换为 " + tick("<volatile>") + "，文档可重复生成且零 diff。");
  a("原始快照默认在 " + tick("~/.local/share/kuake-studio/kuake-cli-json.json") + "（权限 600，**不要提交进 git**）。");
  a("");
  a("采集用例：" + snap.cases.length + " 个，全是只读命令或缺参错误，不写网盘；失败用例会重试后收录。");
  a("");
  a("| 用例 | argv | exit | 格式 |");
  a("|---|---|---:|---|");
  for (const c of snap.cases) a("| " + tick(c.id) + " | " + tick(c.args.join(" ")) + " | " + c.exit + " | " + c.format + (c.count ? "(" + c.count + " 行)" : "") + " |");
  a("");
  a("## 顶层信封");
  a("");
  const ok = { success: true, code: "OK", message: "...", data: null };
  const bad = { success: false, code: "INVALID_ARGS | FILE_NOT_FOUND", message: "..." };
  a("成功：" + tick(JSON.stringify(ok)) + "；");
  a("失败：" + tick(JSON.stringify(bad)) + "（失败态没有 data）。");
  a(tick("data") + " 的形状按命令不同，见下。" + tick("list / --stream") + " 例外，是 **NDJSON**（每行一个信封）。");
  a("");
  a("## 各命令信封骨架（脱敏）");
  a("");
  for (const c of snap.cases) {
    a("### " + tick(c.id));
    a("");
    a("```json");
    a(JSON.stringify(c.format === "ndjson" ? (c.data?.[0] ?? null) : c.data, null, 2));
    a("```");
    a("");
  }
  a("## kuake help（stderr，非 JSON）");
  a("");
  a("```text");
  a(snap.usage || "");
  a("```");
  a("");
  a("> 备注：" + tick("--cli ... --json") + " 是 kuake-studio 自己的 lilyco CLI 包装；" + tick("--json") + " 要放最后。");
  a("> 默认后端已是内置原生夸克 API，只有显式 " + tick("KUAKE_STUDIO_BACKEND=cli") + " 才真的 fork 本机 kuake 子进程。");
  return L.join("\n") + "\n";
}

const mdIdx = argv.indexOf("--markdown");
if (mdIdx >= 0) {
  const next = argv[mdIdx + 1];
  const mdPath = next && !next.startsWith("--") ? path.resolve(next) : path.join(repoRoot, "docs/kuake-cli-json-shapes.md");
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, markdown(redact(snap)), { mode: 0o644 });
  console.log("[dump] 脱敏形状文档 -> " + mdPath + " (" + fs.statSync(mdPath).size + " B)");
}

if (has("--stdout")) console.log(redacted);
else {
  if (redOnly) console.log(`[dump] ${snap.cases.length} 个用例 -> ${outFile} (仅脱敏, ${fs.statSync(outFile).size} B, 644)`);
  else {
    console.log(`[dump] ${snap.cases.length} 个用例 -> ${outFile} (${fs.statSync(outFile).size} B, 600)`);
    console.log(`[dump] 脱敏副本 -> ${redFile} (${fs.statSync(redFile).size} B)`);
  }
  for (const c of snap.cases) {
    const shape = c.format === "ndjson" ? `${c.count} 行` : c.parse_ok ? "OK" : "PARSE_FAIL";
    console.log(`  ${c.id.padEnd(24)} exit=${c.exit} ${c.format}=${shape} ${c.stdout_bytes}B`);
  }
  console.log(`[dump] usage ${snap.usage.length} 字符（kuake help 走 stderr）`);
}
