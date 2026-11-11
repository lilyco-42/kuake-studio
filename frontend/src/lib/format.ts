/** 字节数 → 人类可读（1024 进制，网盘口径） */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return "—";
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

/** 秒级或毫秒级时间戳 → 本地时间字符串。kuake 的 ctime/mtime 是秒，created_at/updated_at 是毫秒。 */
export function formatTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const ms = ts > 1e12 ? ts : ts * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

export function relativeTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const ms = ts > 1e12 ? ts : ts * 1000;
  const diff = Date.now() - ms;
  if (diff < 0) return formatTime(ts);
  const min = 60_000;
  if (diff < min) return "刚刚";
  if (diff < 60 * min) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < 24 * 60 * min) return `${Math.floor(diff / (60 * min))} 小时前`;
  if (diff < 30 * 24 * 60 * min) return `${Math.floor(diff / (24 * 60 * min))} 天前`;
  return formatTime(ts);
}

/** 网盘路径拼接：父目录已以 / 结尾时不再重复加 */
export function joinPath(dir: string, name: string): string {
  if (!dir || dir === "/") return `/${name}`;
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

export function parentPath(path: string): string {
  const clean = path.replace(/\/+$/, "");
  const idx = clean.lastIndexOf("/");
  if (idx <= 0) return "/";
  return clean.slice(0, idx);
}

export function splitPath(path: string): { label: string; path: string }[] {
  const crumbs: { label: string; path: string }[] = [{ label: "根目录", path: "/" }];
  const parts = path.split("/").filter(Boolean);
  let acc = "";
  for (const p of parts) {
    acc += `/${p}`;
    crumbs.push({ label: p, path: acc });
  }
  return crumbs;
}

export function downloadUrlToName(url: string): string {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "download");
  } catch {
    return "download";
  }
}
