import * as React from "react";
import { toast } from "sonner";
import {
  Check,
  Copy,
  CornerDownRight,
  FileSearch,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";

import { fileIcon } from "@/components/file-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useRunner } from "@/lib/store";
import { formatBytes, parentPath, relativeTime } from "@/lib/format";
import type { SearchData, SearchHit } from "@/lib/types";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#x27": "'",
};

/** 与后端 decode_name 同口径：先解 HTML 实体，再把 %XX 按 UTF-8 字节解出来。 */
function decodeName(input: string): string {
  const s = input.replace(/&(amp|lt|gt|quot|apos|nbsp|#39|#x27);/gi, (m, key) => {
    const v = ENTITIES[String(key).toLowerCase()];
    return v === undefined ? m : v;
  });
  if (!s.includes("%")) return s;
  const bytes: number[] = [];
  const enc = new TextEncoder();
  const dec = new TextDecoder("utf-8", { fatal: false });
  let buf = "";
  const flush = () => {
    if (buf) {
      for (const b of enc.encode(buf)) bytes.push(b);
      buf = "";
    }
  };
  for (let i = 0; i < s.length; ) {
    if (s[i] === "%" && i + 2 < s.length && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
      flush();
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      buf += s[i];
      i += 1;
    }
  }
  flush();
  return dec.decode(new Uint8Array(bytes));
}

type Part = { text: string; hit: boolean };

/** hl_file_name 是转义过的 <hl>…</hl> 纯文本：拆成片段后交给 React 渲染，绝不走 innerHTML。 */
function highlight(raw: string | undefined, fallback: string): Part[] {
  const s = raw ? decodeName(raw) : fallback;
  const parts: Part[] = [];
  const re = new RegExp("<hl>|</hl>", "gi");
  let last = 0;
  let hit = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) parts.push({ text: s.slice(last, m.index), hit });
    hit = m[0].toLowerCase() === "<hl>";
    last = re.lastIndex;
  }
  if (last < s.length) parts.push({ text: s.slice(last), hit });
  return parts.length > 0 ? parts : [{ text: fallback, hit: false }];
}

function HighlightedName({ raw, name }: { raw?: string; name: string }) {
  return (
    <span className="min-w-0 truncate text-sm font-medium">
      {highlight(raw, name).map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-sm bg-primary/25 px-0.5 text-foreground">
            {p.text}
          </mark>
        ) : (
          <React.Fragment key={i}>{p.text}</React.Fragment>
        ),
      )}
    </span>
  );
}

export function SearchView({ onOpenDir }: { onOpenDir: (path: string) => void }) {
  const { run, booted } = useRunner();
  const [q, setQ] = React.useState("");
  const [term, setTerm] = React.useState("");
  const [nonce, setNonce] = React.useState(0);
  const [hits, setHits] = React.useState<SearchHit[]>([]);
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);

  // 停手 350ms 才发请求：每敲一个字就打一次全盘搜索太贵了
  React.useEffect(() => {
    const t = window.setTimeout(() => setTerm(q.trim()), 350);
    return () => window.clearTimeout(t);
  }, [q]);

  React.useEffect(() => {
    if (!booted) return;
    if (!term) {
      setHits([]);
      setHasMore(false);
      setError(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    run<SearchData>("search", { q: term, page: 1, size: PAGE_SIZE }, "搜索 " + term)
      .then((d) => {
        if (!alive) return;
        setHits(d?.list ?? []);
        setPage(1);
        setHasMore(Boolean(d?.has_more));
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setHits([]);
        setHasMore(false);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // nonce 让「同关键词按回车 / 点重试」也能强制重跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted, term, nonce, run]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTerm(q.trim());
    setNonce((n) => n + 1);
  };

  const loadMore = async () => {
    if (!term || !hasMore || loadingMore || loading) return;
    const next = page + 1;
    setLoadingMore(true);
    setError(null);
    try {
      const d = await run<SearchData>(
        "search",
        { q: term, page: next, size: PAGE_SIZE },
        "搜索 " + term + " · 第 " + next + " 页",
      );
      setHits((prev) => [...prev, ...(d?.list ?? [])]);
      setPage(next);
      setHasMore(Boolean(d?.has_more));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const copyPath = async (h: SearchHit) => {
    if (!h.path || h.path_partial) return;
    try {
      await navigator.clipboard.writeText(h.path);
      setCopied(h.fid);
      toast.success("完整路径已复制");
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      toast.error("剪贴板不可用，请手动复制");
    }
  };

  const jump = (h: SearchHit) => {
    if (!h.path || h.path_partial) return;
    onOpenDir(parentPath(h.path));
  };

  const usable = (h: SearchHit) => Boolean(h.path) && !h.path_partial;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b px-4 py-3">
        <form onSubmit={submit} className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="按文件名搜索整个网盘…"
              className="pl-8 pr-8"
              aria-label="搜索关键词"
            />
            {q ? (
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setQ("")}
                title="清空"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          <Button type="submit" size="sm" className="gap-1.5" disabled={!q.trim() || loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            搜索
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!term || loading}
            onClick={() => setNonce((n) => n + 1)}
            title="重新搜索"
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
        </form>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>试试</span>
          {["README", ".md", "2026"].map((s) => (
            <button
              key={s}
              type="button"
              className="rounded-md border px-1.5 py-0.5 font-mono hover:bg-muted"
              onClick={() => setQ(s)}
            >
              {s}
            </button>
          ))}
          <span className="ml-auto">按 Enter 立即搜索 · 命中处高亮 · 结果给出完整路径</span>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {!term ? (
          <div className="grid place-items-center gap-2 py-24 text-center">
            <FileSearch className="size-8 text-muted-foreground/50" />
            <span className="text-sm text-muted-foreground">输入关键词，跨整个网盘找文件</span>
            <span className="text-xs text-muted-foreground">
              空关键词会被挡掉（夸克会把它当成「最近文件」返回）
            </span>
          </div>
        ) : error ? (
          <div className="m-4 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
            <p className="text-sm font-medium text-destructive">搜索失败</p>
            <p className="mt-1 break-all text-xs text-muted-foreground">{error}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setNonce((n) => n + 1)}
            >
              重试
            </Button>
          </div>
        ) : loading ? (
          <div className="grid gap-2 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : hits.length === 0 ? (
          <div className="grid place-items-center gap-2 py-24 text-center">
            <Search className="size-8 text-muted-foreground/50" />
            <span className="text-sm text-muted-foreground">没有匹配「{term}」的文件</span>
            <span className="text-xs text-muted-foreground">换个关键词，或检查一下拼写</span>
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-2 border-b px-4 py-2 text-[11.5px] text-muted-foreground">
              <span>
                已加载 <span className="font-medium text-foreground">{hits.length}</span> 条
              </span>
              <span>·</span>
              <span className="truncate">关键词「{term}」</span>
              <span className="ml-auto">第 {page} 页</span>
            </div>
            <ul className="divide-y">
              {hits.map((h, i) => (
                <li key={h.fid || i} className="group hover:bg-muted/40">
                  <div className="flex items-start gap-3 px-4 py-3">
                    <div className="mt-0.5 shrink-0">{fileIcon(h.file_name, h.dir)}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <HighlightedName raw={h.hl_file_name} name={h.file_name} />
                        {h.dir ? (
                          <Badge variant="muted">目录</Badge>
                        ) : null}
                        {h.path_partial ? (
                          <Badge variant="outline">路径不可用</Badge>
                        ) : null}
                      </div>
                      <div
                        className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
                        title={h.path || undefined}
                      >
                        {h.path || "祖先链反查失败，已禁用复制路径 / 跳转，避免半截路径触发写操作"}
                      </div>
                      <div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground">
                        <span>{h.dir ? "—" : formatBytes(h.size)}</span>
                        <span>{relativeTime(h.mtime || h.updated_at)}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!usable(h)}
                        onClick={() => void copyPath(h)}
                        title={usable(h) ? "复制完整路径" : "路径不可用"}
                      >
                        {copied === h.fid ? (
                          <Check className="size-4 text-success" />
                        ) : (
                          <Copy className="size-4" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!usable(h)}
                        onClick={() => jump(h)}
                        title={usable(h) ? "跳到所在目录" : "路径不可用"}
                      >
                        <CornerDownRight className="size-4" />
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="grid place-items-center gap-2 border-t px-4 py-4">
              {hasMore ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? <Loader2 className="size-4 animate-spin" /> : null}
                  加载更多（第 {page + 1} 页）
                </Button>
              ) : (
                <span className="text-[11px] text-muted-foreground">
                  已到最后一页 · 接口不返回总数，短页即止
                </span>
              )}
            </div>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
