import type { KuakeFile, KuakeShare } from '@/lib/types';

export type ShareListResult = { list?: KuakeShare[] };

const SEP = String.fromCharCode(92);

/** 网盘路径归一：反斜杠转正斜杠、去尾部斜杠、补前导斜杠。 */
export function normalizeCloudPath(input: string | null | undefined): string {
  let s = String(input || '').replaceAll(SEP, '/');
  while (s.length > 0 && s.charAt(s.length - 1) === '/') s = s.slice(0, -1);
  if (!s) return '/';
  return s.charAt(0) === '/' ? s : '/' + s;
}

function parentCloudPath(path: string): string {
  const s = normalizeCloudPath(path);
  if (s === '/') return '/';
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
}

function fullItemPath(item: Pick<KuakeFile, 'path' | 'file_name'>, baseDir: string): string {
  if (item.path) return normalizeCloudPath(item.path);
  const clean = normalizeCloudPath(baseDir);
  return clean === '/' ? '/' + item.file_name : clean + '/' + item.file_name;
}

function sameName(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return normalizeCloudPath(a) === normalizeCloudPath(b);
}

function parentMatches(share: KuakeShare, itemPath: string): boolean {
  const p = share.path_info;
  if (!p) return true;
  const normalized = normalizeCloudPath(p);
  return normalized === parentCloudPath(itemPath) || normalized === itemPath;
}

function matches(share: KuakeShare, item: Pick<KuakeFile, 'path' | 'file_name'>, baseDir: string): boolean {
  const itemPath = fullItemPath(item, baseDir);
  const names = [share.first_file && share.first_file.file_name, share.title].filter(Boolean);
  if (!names.some((n) => sameName(n as string, item.file_name))) return false;
  return parentMatches(share, itemPath);
}

/**
 * 把最近分享列表按网盘路径建索引。夸克的分享列表没有直接给完整路径，
 * 只能用 first_file.file_name / title + path_info 做保守匹配；匹配不到就不显示，
 * 绝不把别人的分享误挂到当前文件上。
 */
export function indexSharesByPath(
  shares: KuakeShare[],
  items: Array<Pick<KuakeFile, 'path' | 'file_name'>>,
  baseDir = '/',
): Map<string, KuakeShare[]> {
  const out = new Map<string, KuakeShare[]>();
  for (const item of items) {
    const key = fullItemPath(item, baseDir);
    const seen = new Set<string>();
    const hits = shares.filter((s) => {
      if (!matches(s, item, baseDir)) return false;
      const id = s.pwd_id || s.share_id || s.share_url || JSON.stringify(s);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (hits.length) out.set(key, hits);
  }
  return out;
}

export function sharesForItem(
  index: Map<string, KuakeShare[]>,
  item: Pick<KuakeFile, 'path' | 'file_name'>,
  baseDir = '/',
): KuakeShare[] {
  return index.get(fullItemPath(item, baseDir)) || [];
}
