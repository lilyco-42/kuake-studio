import * as React from "react";
import { toast } from "sonner";
import {
  Check,
  Copy,
  CornerDownRight,
  ExternalLink,
  FileSearch,
  Info,
  Link2,
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
import { useI18n } from "@/lib/i18n";
import { formatBytes, parentPath, relativeTime } from "@/lib/format";
import type { CommandSchema, KuakeShare, SearchData, SearchHit } from "@/lib/types";
import { indexSharesByPath, sharesForItem, type ShareListResult } from "@/lib/share-links";
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

export function SearchView({
  onOpenDir,
  onOpenItem,
  onShare,
  schemas = [],
  compact = false,
}: {
  onOpenDir: (path: string) => void;
  onOpenItem?: (item: SearchHit) => void;
  onShare?: (item: SearchHit) => void;
  schemas?: CommandSchema[];
  compact?: boolean;
}) {
  const { run, booted } = useRunner();
  const { t, lang } = useI18n();
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
  const [shareIndex, setShareIndex] = React.useState<Map<string, KuakeShare[]>>(new Map());
  const canListShares = schemas.some((s) => s.name === "share-list");

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
    run<SearchData>("search", { q: term, page: 1, size: PAGE_SIZE }, t("op.search"))
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

  React.useEffect(() => {
    if (!canListShares || hits.length === 0) {
      setShareIndex(new Map());
      return;
    }
    let alive = true;
    run<ShareListResult>("share-list", { page: 1, size: 100 }, t("op.list"))
      .then((d) => {
        if (!alive) return;
        setShareIndex(indexSharesByPath(d?.list ?? [], hits.slice(0, 50)));
      })
      .catch(() => alive && setShareIndex(new Map()));
    return () => {
      alive = false;
    };
  }, [hits, canListShares, run, t]);

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
        t("search.page", { n: next }),
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
      toast.success(t("search.copied"));
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      toast.error(t("common.clipboardFail"));
    }
  };

  const jump = (h: SearchHit) => {
    if (!h.path || h.path_partial) return;
    onOpenDir(parentPath(h.path));
  };

  const usable = (h: SearchHit) => Boolean(h.path) && !h.path_partial;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", compact && "max-h-[46vh]")}>
      <div className={cn("border-b px-4", compact ? "py-2" : "py-3")}>
        <form onSubmit={submit} className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus={!compact}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("search.placeholder")}
              className="pl-8 pr-8"
              aria-label={t("search.ariaLabel")}
            />
            {q ? (
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setQ("")}
                title={t("search.clear")}
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          <Button type="submit" size="sm" className="gap-1.5" disabled={!q.trim() || loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            {t("search.button")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!term || loading}
            onClick={() => setNonce((n) => n + 1)}
            title={t("search.research")}
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
        </form>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>{t("search.try")}</span>
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
          <span className="ml-auto">{t("search.tips")}</span>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {!term ? (
          <div className="grid place-items-center gap-2 py-24 text-center">
            <FileSearch className="size-8 text-muted-foreground/50" />
            <span className="text-sm text-muted-foreground">{t("search.emptyTitle")}</span>
            <span className="text-xs text-muted-foreground">{t("search.emptyHint")}</span>
          </div>
        ) : error ? (
          <div className="m-4 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
            <p className="text-sm font-medium text-destructive">{t("search.failed")}</p>
            <p className="mt-1 break-all text-xs text-muted-foreground">{error}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setNonce((n) => n + 1)}
            >
              {t("common.retry")}
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
            <span className="text-sm text-muted-foreground">{t("search.noMatch", { term })}</span>
            <span className="text-xs text-muted-foreground">{t("search.noMatchHint")}</span>
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-2 border-b px-4 py-2 text-[11.5px] text-muted-foreground">
              <span>
                {t("search.loadedPre")} <span className="font-medium text-foreground">{hits.length}</span> {t("search.loadedPost")}
              </span>
              <span>·</span>
              <span className="truncate">{t("search.keyword", { term })}</span>
              <span className="ml-auto">{t("search.page", { n: page })}</span>
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
                          <Badge variant="muted">{t("search.dir")}</Badge>
                        ) : null}
                        {h.path_partial ? (
                          <Badge variant="outline">{t("search.pathUnavailable")}</Badge>
                        ) : null}
                      </div>
                      <div
                        className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
                        title={h.path || undefined}
                      >
                        {h.path || t("search.noPath")}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                        <span>{h.dir ? "—" : formatBytes(h.size)}</span>
                        <span>{relativeTime(h.mtime || h.updated_at, lang)}</span>
                        {sharesForItem(shareIndex, h)
                          .filter((s) => Boolean(s.share_url))
                          .slice(0, 2)
                          .map((s) => (
                            <a
                              key={s.share_url}
                              href={s.share_url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 rounded bg-success/10 px-1.5 py-0.5 text-[10px] text-success hover:underline"
                              title={s.share_url}
                            >
                              <Link2 className="size-3" />
                              {t("search.linkedShare")}
                              <ExternalLink className="size-2.5" />
                            </a>
                          ))}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {onOpenItem ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title={t("search.details")}
                          onClick={() => onOpenItem(h)}
                        >
                          <Info className="size-4" />
                        </Button>
                      ) : null}
                      {onShare ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title={t("files.createShare")}
                          onClick={() => onShare(h)}
                        >
                          <Link2 className="size-4" />
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!usable(h)}
                        onClick={() => void copyPath(h)}
                        title={usable(h) ? t("search.copyFullPath") : t("search.pathUnavailable")}
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
                        title={usable(h) ? t("search.jumpDir") : t("search.pathUnavailable")}
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
                  {t("search.loadMore", { n: page + 1 })}
                </Button>
              ) : (
                <span className="text-[11px] text-muted-foreground">
                  {t("search.lastPage")}
                </span>
              )}
            </div>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
