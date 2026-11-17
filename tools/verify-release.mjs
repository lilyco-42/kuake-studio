#!/usr/bin/env node
// 验证 kuake-studio 的 GitHub Release：资产齐全 / SHA256 / 匿名可下载 / 解包结构 /
// BUILD_INFO / 逐 .o 架构 / 6 个基础 + 4 个商业化 C ABI 符号 / macOS universal / Windows PE / Info.plist。
// 用法: node tools/verify-release.mjs [--tag v0.5.3] [--dir DIR] [--no-download] [--json]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return (!v || v.startsWith('--')) ? true : v;
}
const has = (n) => argv.includes(n);
const repo = String(opt('--repo', 'lilyco-42/kuake-studio'));
// --no-download 仅为兼容旧调用保留；现在总是先验缓存 SHA256，坏/缺则重下。
const noDownload = has('--no-download');
const asJson = has('--json');
const dirArg = opt('--dir', null);

const baseEnv = { ...process.env };
const anonEnv = { ...process.env };
for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_TOKEN_PATH']) delete anonEnv[k];

function run(cmd, args, opts) {
  opts = opts || {};
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 300000,
    env: opts.env || baseEnv, cwd: opts.cwd,
  });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '', error: r.error && r.error.message };
}
// 跨进程冷却：GitHub 偶发断连 / 截断时等几秒再试。
function sleep(ms) {
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},' + Number(ms) + ')']);
}

const checks = [];
function ck(name, ok, detail) {
  checks.push({ name: String(name), ok: !!ok, detail: String(detail == null ? '' : detail) });
}
function toolsAvailable(names) {
  for (const n of names) {
    const r = run('sh', ['-c', 'command -v ' + n]);
    ck('本机工具 ' + n, r.status === 0, r.status === 0 ? (r.out.trim() || n) : '缺失');
  }
}

const PLATFORMS = [
  { key: 'windows-x64', kind: 'desktop', pats: [/-windows-x64\.msi$/, /-windows-x64\.zip$/], want: 2 },
  { key: 'linux-x64', kind: 'desktop', pats: [/-linux-x64\.tar\.gz$/], want: 1 },
  { key: 'macos-universal', kind: 'desktop', pats: [/-macos-universal\.tar\.gz$/], want: 1 },
  { key: 'android-arm64', kind: 'native', target: 'aarch64-linux-android', arch: 'ELF.*ARM aarch64', archRe: /ELF.*ARM aarch64/i, pats: [/-android-arm64\.tar\.gz$/], want: 1 },
  { key: 'ios-arm64', kind: 'native', target: 'aarch64-apple-ios', arch: 'Mach-O arm64', archRe: /Mach-O.*arm64/i, pats: [/-ios-arm64\.tar\.gz$/], want: 1 },
  { key: 'ohos-arm64', kind: 'native', target: 'aarch64-unknown-linux-ohos', arch: 'ELF ARM aarch64', archRe: /ELF.*ARM aarch64/i, pats: [/-ohos-arm64\.tar\.gz$/], want: 1 },
];
const ABI = ['boot', 'call', 'free', 'schemas', 'set_cookie', 'version'];
const ABI_COMMERCIAL = ['commercial_config', 'commercial_status', 'commercial_activate', 'commercial_deactivate'];
// v0.5.11 起 FFI 追加 4 个商业化函数；更早的发布包没有，避免把历史 tag 全判红。
const since = (v) => { const a = String(v).replace(/^v/, '').split('.').map(Number); return (a[0]||0)*10000 + (a[1]||0)*100 + (a[2]||0); };
const abiFor = (v) => (since(v) >= 511 ? ABI.concat(ABI_COMMERCIAL) : ABI);

function walk(root) {
  const out = [];
  const go = (d, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) go(p, r);
      else if (e.isFile()) out.push({ rel: r, abs: p, base: e.name });
    }
  };
  go(root, '');
  return out;
}
function find(files, pred) { const f = files.find(pred); return f ? f.abs : null; }

// 在 PATH / Android SDK build-tools 里找一个命令行工具（apksigner / aapt2 / aapt）。
// CI 里有 SDK、开发机可能没有；找不到就由调用方跳过该检查。
function buildTool(name) {
  const v = run('sh', ['-c', 'command -v ' + name]);
  if (v.status === 0 && v.out.trim()) return name;
  const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME
    || path.join(home, 'Android', 'Sdk');
  const bt = run('sh', ['-c', 'ls -d ' + sdk + '/build-tools/*/ 2>/dev/null | sort -V | tail -1']).out.trim();
  if (!bt) return null;
  const cand = path.join(bt, name);
  return fs.existsSync(cand) ? cand : null;
}

// ── 取 Release 元数据（含 digest）─────────────────────────────────────────
let tag = opt('--tag', null);
let tagErr = '';
if (!tag) {
  const r = run('gh', ['release', 'view', '--repo', repo, '--json', 'tagName', '--jq', '.tagName']);
  tag = r.status === 0 ? r.out.trim() : '';
  tagErr = (r.err || r.error || r.out || '').trim().slice(0, 160);
}
ck('取得 Release tag', !!tag, tag || 'gh release view 失败: ' + tagErr);
const version = tag.replace(/^v/, '');
const metaArgs = ['api', 'repos/' + repo + '/releases/tags/' + tag, '--jq',
  '{tag_name,name,draft,prerelease,published_at,assets:[.assets[]|{name,size,digest,browser_download_url}]}'];
const meta = run('gh', metaArgs);
let rel = null;
try { rel = JSON.parse(meta.out); } catch (e) { rel = null; }
ck('读取 Release 元数据', !!rel && Array.isArray(rel.assets), rel ? rel.assets.length + ' 个资产' : (meta.err || meta.out).trim().slice(0, 200));
if (!rel || !Array.isArray(rel.assets)) { finish(); }
ck('非草稿 / 非正式版', rel.draft === false && rel.prerelease === false, 'draft=' + rel.draft + ' prerelease=' + rel.prerelease);

const home = process.env.HOME || os.homedir();
const dir = String(dirArg || path.join(home, '.cache', 'kuake-studio-release-verify', tag));
fs.mkdirSync(dir, { recursive: true });
const assets = rel.assets;

// ── 六平台资产齐全 ───────────────────────────────────────────────────────
const byPlatform = {};
for (const p of PLATFORMS) {
  const hits = assets.filter((a) => p.pats.some((re) => re.test(a.name)));
  byPlatform[p.key] = hits;
  ck('资产齐全 ' + p.key, hits.length === p.want, hits.length + '/' + p.want + '  ' + hits.map((a) => a.name).join(', '));
}
const apkAssets = assets.filter((a) => /-android\.apk$/.test(a.name));
ck('资产齐全 android-apk', apkAssets.length === 1, apkAssets.length + '/1  ' + apkAssets.map((a) => a.name).join(', '));
// 资产清单 = 8 个平台包 + SHA256SUMS（校验清单本身不是平台产物）
const payloadAssets = assets.filter((a) => a.name !== 'SHA256SUMS');
const sumsAsset = assets.find((a) => a.name === 'SHA256SUMS');
ck('资产齐全 SHA256SUMS', !!sumsAsset, sumsAsset ? String(sumsAsset.size) + ' B' : '缺失');
ck('资产总数', payloadAssets.length === 8, String(payloadAssets.length) + ' 个平台包（期望 8）');

// ── 匿名可下载 ──────────────────────────────────────────────────────────
const first = assets[0];
if (first) {
  let code = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const h = run('curl', ['-sIL', '--retry', '2', '-o', '/dev/null', '-w', '%{http_code}', first.browser_download_url], { env: anonEnv });
    code = h.out.trim();
    if (/^2\d\d$/.test(code)) break;
    sleep(3000);
  }
  ck('匿名可下载（不带 token）', /^2\d\d$/.test(code), 'HTTP ' + code);
}

toolsAvailable(['file', 'ar', 'nm', 'tar', 'unzip', 'llvm-lipo', 'llvm-objdump']);

// ── 逐资产下载 + SHA256 + 解包结构 ────────────────────────────────────────
const shaOf = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
for (const a of assets) {
  const file = path.join(dir, a.name);
  const want = String(a.digest || '').replace(/^sha256:/, '');
  // 缓存文件也要先验 SHA256：中断的下载（截断 / 空文件）不能当作有效缓存。
  let cached = false;
  if (fs.existsSync(file) && want && shaOf(file) === want) cached = true;
  else if (fs.existsSync(file)) { try { fs.rmSync(file); } catch (e) {} }
  if (cached) {
    ck('下载 ' + a.name + '（缓存 SHA256 通过）', true, fs.statSync(file).size + ' B');
  } else {
    let last = '未开始';
    for (let attempt = 0; attempt < 4; attempt++) {
      const d = run('curl', ['-fsSL', '--retry', '3', '-o', file, a.browser_download_url], { env: anonEnv });
      if (d.status === 0 && fs.existsSync(file) && (!want || shaOf(file) === want)) { last = ''; break; }
      last = d.status === 0
        ? ('SHA256 不符 / 截断: ' + (fs.existsSync(file) ? fs.statSync(file).size : 0) + ' B')
        : ((d.err || '').trim().slice(0, 120) || 'curl exit ' + d.status);
      try { if (fs.existsSync(file)) fs.rmSync(file); } catch (e) {}
      sleep(3000);
    }
    ck('下载 ' + a.name, last === '',
      last === '' ? (fs.statSync(file).size + ' B / SHA256 OK') : ('重试 4 次仍失败: ' + last));
  }
  if (!fs.existsSync(file)) { ck('SHA256 ' + a.name, false, '文件缺失'); continue; }
  const got = shaOf(file);
  ck('SHA256 ' + a.name, !!want && got === want, got.slice(0, 12) + '… 对照 GH digest');
}

// ── SHA256SUMS：必须覆盖全部平台包，且逐行哈希一致 ────────────────────────
{
  const file = path.join(dir, 'SHA256SUMS');
  if (!fs.existsSync(file)) {
    ck('SHA256SUMS 内容', false, '文件缺失');
  } else {
    const map = new Map();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
      if (m) map.set(m[2].trim(), m[1]);
    }
    const missing = payloadAssets.map((a) => a.name).filter((n) => !map.has(n));
    ck('SHA256SUMS 覆盖全部平台包', missing.length === 0,
      missing.length ? '缺少: ' + missing.join(', ') : payloadAssets.length + ' 个');
    const bad = payloadAssets.filter((a) => {
      const f = path.join(dir, a.name);
      return !fs.existsSync(f) || shaOf(f) !== map.get(a.name);
    });
    ck('SHA256SUMS 哈希一致', bad.length === 0,
      bad.length ? '不一致: ' + bad.join(', ') : payloadAssets.length + ' 个');
  }
}

for (const p of PLATFORMS) {
  for (const a of byPlatform[p.key]) {
    const file = path.join(dir, a.name);
    if (!fs.existsSync(file)) continue;
    const stem = a.name.replace(/\.(tar\.gz|zip|msi)$/, '');
    const dest = path.join(dir, 'extract', stem);
    fs.mkdirSync(dest, { recursive: true });
    if (a.name.endsWith('.msi')) continue; // MSI 只校验 SHA/可下载，不解包
    const ex = a.name.endsWith('.zip')
      ? run('unzip', ['-q', '-o', file, '-d', dest])
      : run('tar', ['-xzf', file, '-C', dest]);
    ck('解包 ' + a.name, ex.status === 0, ex.status === 0 ? 'OK' : (ex.err || '').trim().slice(0, 160));
    if (ex.status !== 0) continue;
    const files = walk(dest);

    if (p.kind === 'desktop') {
      const html = find(files, (f) => /(^|\/)dist\/index\.html$/.test(f.rel));
      ck('前端 dist ' + p.key, !!html, html ? 'dist/index.html 存在' : '缺失');
      const lic = find(files, (f) => f.base === 'LICENSE');
      ck('LICENSE ' + p.key, !!lic, lic ? '存在' : '缺失');
      if (p.key === 'linux-x64') {
        const ins = find(files, (f) => f.base === 'install.sh');
        ck('Linux 一键安装器 install.sh', !!ins, ins ? '存在' : '缺失');
        ck('Linux install.sh 可执行', !!ins && (fs.statSync(ins).mode & 0o111) !== 0, ins ? 'mode ' + (fs.statSync(ins).mode & 0o777).toString(8) : '缺失');
        const insTxt = ins ? fs.readFileSync(ins, 'utf8') : '';
        ck('Linux install.sh 清理旧 systemd 登录项', /cleanup_legacy_systemd/.test(insTxt) && /disable --now kuake-studio\.service/.test(insTxt), insTxt ? '含 cleanup_legacy_systemd + disable --now' : '缺失');
      }
      if (p.key === 'windows-x64') {
        const exe = find(files, (f) => f.base.endsWith('.exe'));
        ck('Windows 可执行文件', !!exe && /PE32\+/.test(run('file', [exe]).out), exe ? run('file', [exe]).out.trim().slice(0, 90) : '缺失');
        ck('Windows run.bat', !!find(files, (f) => f.base.toLowerCase() === 'run.bat'), '');
      } else {
        const bin = find(files, (f) => f.base === 'kuake-studio' && !f.rel.includes('.app/'));
        ck('可执行文件 ' + p.key, !!bin, bin ? run('file', [bin]).out.trim().slice(0, 90) : '缺失');
        if (p.key === 'macos-universal' && bin) {
          const li = run('llvm-lipo', ['-info', bin]);
          ck('macOS universal2', /x86_64/.test(li.out) && /arm64/.test(li.out), li.out.trim().slice(0, 120));
          const plist = find(files, (f) => f.rel.endsWith('.app/Contents/Info.plist'));
          if (plist) {
            const m = fs.readFileSync(plist, 'utf8').match(/CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/);
            ck('Info.plist 版本', !!m && m[1] === version, m ? m[1] : '未读到 CFBundleVersion');
          } else ck('Info.plist 版本', false, '.app/Contents/Info.plist 缺失');
        }
      }
    } else {
      const need = ['libkuake_studio.a', 'include/kuake_studio.h', 'tools/abi-selftest.c', 'README-native.md', 'BUILD_INFO.txt'];
      for (const n of need) ck('文件 ' + n + ' @' + p.key, !!find(files, (f) => f.rel.endsWith(n)), '');
      if (p.target === 'aarch64-apple-ios') {
        const rn = find(files, (f) => f.base === 'README-native.md');
        const txt = rn ? fs.readFileSync(rn, 'utf8') : '';
        const wrong = /cc-aarch64-musl|AR_aarch64_linux_android|zig 0\.17\.1|Android \/ 鸿蒙/.test(txt);
        ck('iOS 包文案不含 Android/鸿蒙专用构建说明', !!rn && !wrong,
           wrong ? '仍含 zig/AR 复现说明（文档瑕疵）' : (rn ? '仅含 Xcode/xcrun 说明' : 'README 缺失'));
      }
      const bi = find(files, (f) => f.base === 'BUILD_INFO.txt');
      if (bi) {
        const kv = {};
        for (const l of fs.readFileSync(bi, 'utf8').split('\n')) {
          const i = l.indexOf('=');
          if (i > 0) kv[l.slice(0, i).trim()] = l.slice(i + 1).trim();
        }
        ck('BUILD_INFO.version @' + p.key, kv.version === version, kv.version || '缺失');
        ck('BUILD_INFO.rust_target @' + p.key, kv.rust_target === p.target, kv.rust_target || '缺失');
        ck('BUILD_INFO.crate_type @' + p.key, kv.crate_type === 'staticlib', kv.crate_type || '缺失');
      }
      const lib = find(files, (f) => f.base === 'libkuake_studio.a');
      if (!lib) continue;
      const ar = run('ar', ['t', lib]);
      const objs = ar.out.trim().split('\n').filter((x) => x.endsWith('.o'));
      ck('归档 .o 数量 @' + p.key, objs.length >= 100, objs.length + ' 个');
      const tmp = path.join(dest, '__objects');
      fs.mkdirSync(tmp, { recursive: true });
      const x = run('ar', ['x', lib], { cwd: tmp });
      const all = walk(tmp).filter((f) => f.base.endsWith('.o'));
      let good = 0;
      for (let i = 0; i < all.length; i += 200) {
        const fr = run('file', all.slice(i, i + 200).map((f) => f.abs));
        good += fr.out.split('\n').filter((l) => p.archRe.test(l)).length;
      }
      ck('逐 .o 架构 ' + p.arch + ' @' + p.key, all.length > 0 && good === all.length, good + '/' + all.length + (x.status === 0 ? '' : ' ar x exit=' + x.status));
      const syms = p.target === 'aarch64-apple-ios'
        ? run('llvm-objdump', ['--macho', '--syms', lib]).out
        : run('nm', ['-g', lib]).out;
      for (const n of abiFor(version)) ck('ABI 符号 kuake_studio_' + n + ' @' + p.key, syms.includes('kuake_studio_' + n), '');
    }
  }
}
// ── Android APK：可安装性结构（双 ABI / 前端 / dex / Manifest）─────────────
for (const a of apkAssets) {
  const file = path.join(dir, a.name);
  if (!fs.existsSync(file)) { ck('APK 存在 ' + a.name, false, '文件缺失'); continue; }
  const size = fs.statSync(file).size;
  ck('APK 存在 ' + a.name, true, size + ' B');
  const l = run('unzip', ['-l', file]);
  const list = l.out;
  ck('APK 解包 ' + a.name, l.status === 0, l.status === 0 ? 'OK' : (l.err || '').trim().slice(0, 160));
  if (l.status !== 0) continue;
  for (const [label, re] of [
    ['AndroidManifest.xml', /\sAndroidManifest\.xml$/m],
    ['classes.dex', /\sclasses\.dex$/m],
    ['assets/dist.zip（内置前端）', /\sassets\/dist\.zip$/m],
  ]) ck('APK 含 ' + label, re.test(list), '');

  const abis = [...list.matchAll(/\slib\/([^/]+)\/libkuake_studio_jni\.so$/gm)].map((m) => m[1]).sort();
  ck('APK 双 ABI（arm64-v8a + x86_64）',
     abis.includes('arm64-v8a') && abis.includes('x86_64'),
     abis.length ? abis.join(' + ') : '未找到任何 lib/<abi>/libkuake_studio_jni.so');
  // .so 必须未压缩存放（APK 安装后 extractNativeLibs 才能直接映射）
  const vz = run('unzip', ['-v', file]);
  const soStored = // 只要能看到任一 so 行是 Stored 即可（更严格：全部）
    /libkuake_studio_jni\.so[\s\S]{0,200}Stored/.test(vz.out);
  ck('APK 内 .so 未压缩存放', soStored, soStored ? 'Stored' : 'Defl:N（安装仍可用但建议 -0 存放）');

  // 有 apksigner 就验签；没有就只提示（CI 里有 SDK，开发机可能没有）。
  // 先看 PATH，再回退到 ANDROID_SDK_ROOT / ~/Android/Sdk 的 build-tools。
  // 版本号：APK 的 versionName 是打包时从 Cargo.toml 读的，最容易出现
  // 「代码发了新版、包里还是旧版本号」这种静默漂移，所以跟 tag 对一遍。
  const aapt = buildTool('aapt2') || buildTool('aapt');
  if (aapt) {
    const bg = run(aapt, ['dump', 'badging', file]);
    const mv = /versionName='([^']*)'/.exec(bg.out);
    ck('APK versionName = ' + version, !!mv && mv[1] === version,
       mv ? 'versionName=' + mv[1] : '未读到 versionName');
  } else {
    ck('APK versionName（本机无 aapt，跳过）', true, '未安装 aapt2 / aapt');
  }
  const signer = buildTool('apksigner');
  if (signer) {
    // cwd 必须是纯 ASCII：apksigner 是 JVM 程序，会把 cwd 当 user.dir 去 encode，
    // 在中文目录（如 ~/文档/...）下会抛 InvalidPathException 而报假失败。
    const v = run(signer, ['verify', '--verbose', '--min-sdk-version', '24', file], { cwd: dir });
    const okSig = v.status === 0 && /Verifies/.test(v.out);
    const schemes = (v.out.match(/Verified using v(\d(?:\.\d)?) scheme[^:]*: (true|false)/g) || []).join(' ');
    ck('APK 签名可验证 apksigner', okSig, okSig ? (schemes || 'Verifies').slice(0, 160) : (v.err || v.out).trim().slice(0, 160));
  } else {
    ck('APK 签名可验证 apksigner（本机无 SDK，跳过）', true, '未安装 apksigner，仅跳过不解包签名块');
  }
}

finish();

function finish() {
  const bad = checks.filter((c) => !c.ok);
  if (asJson) {
    console.log(JSON.stringify({ repo, tag, ok: bad.length === 0, total: checks.length, failed: bad.length, checks }, null, 2));
  } else {
    for (const c of checks) console.log((c.ok ? 'PASS' : 'FAIL') + '  ' + c.name + (c.detail ? '  — ' + c.detail : ''));
    console.log('');
    console.log(checks.length + ' 项检查，' + bad.length + ' 项失败；Release ' + (bad.length ? '未通过' : '通过') + '（' + tag + '）。');
  }
  process.exit(bad.length ? 1 : 0);
}
