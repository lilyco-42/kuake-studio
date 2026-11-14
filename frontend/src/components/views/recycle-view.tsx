import * as React from "react";
import { toast } from "sonner";
import { RefreshCw, RotateCcw, Trash2, Trash } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { fileIcon } from "@/components/file-icon";
import { useRunner } from "@/lib/store";
import { formatBytes, formatTime, relativeTime } from "@/lib/format";
import type { RecycleData, RecycleItem } from "@/lib/types";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;
const MAX_PURGE_ONCE = 50;

type Pending = { kind: "restore" | "purge"; items: RecycleItem[] };

export function RecycleView() {
  const { run, booted } = useRunner();
  const [items, setItems] = React.useState<RecycleItem[]>([]);
  const [total, setTotal] = React.useState(0);
  const [deep, setDeep] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<Pending | null>(null);

  const drain = React.useCallback(
    async (nextPage: number, label: string): Promise<RecycleData> => {
      const data = await run<RecycleData>(
        "recycle-list",
        { page: nextPage, size: PAGE_SIZE },
        label,
      );
      if (!data) throw new Error("后端没有返回数据");
      return data;
    },
    [run],
  );

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await drain(1, "回收站列表");
      setItems(data.list ?? []);
      setTotal(data.total ?? (data.list ?? []).length);
      setDeep(data.deep_recycle_count ?? 0);
      setPage(data.page || 1);
      setHasMore(Boolean(data.has_more));
      // 刷新后把已经不存在的勾选清掉
      const alive = new Set((data.list ?? []).map((it) => it.record_id));
      setSelected((cur) => cur.filter((id) => alive.has(id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
      setTotal(0);
      setDeep(0);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [drain]);

  React.useEffect(() => {
    if (booted) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const data = await drain(page + 1, "回收站列表（更多）");
      setItems((cur) => {
        const seen = new Set(cur.map((it) => it.record_id));
        return [...cur, ...(data.list ?? []).filter((it) => !seen.has(it.record_id))];
      });
      if (typeof data.total === "number") setTotal(data.total);
      setPage(data.page || page + 1);
      setHasMore(Boolean(data.has_more));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const allChecked = items.length > 0 && selected.length === items.length;
  const toggleAll = () => setSelected(allChecked ? [] : items.map((it) => it.record_id));
  const toggleOne = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const chosen = React.useMemo(
    () => items.filter((it) => selected.includes(it.record_id)),
    [items, selected],
  );

  const doAction = async () => {
    const job = pending;
    if (!job) return;
    const ids = job.items.map((it) => it.record_id);
    if (ids.length === 0) return;
    if (job.kind === "purge" && ids.length > MAX_PURGE_ONCE) {
      toast.error(`一次最多永久删除 ${MAX_PURGE_ONCE} 项，请分批操作`);
      setPending(null);
      return;
    }
    try {
      const verb = job.kind === "purge" ? "永久删除" : "恢复";
      await run(job.kind === "purge" ? "recycle-purge" : "recycle-restore", { records: ids }, verb);
      toast.success(`已${verb} ${ids.length} 项`);
      setSelected([]);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    setPending(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">回收站</h2>
          <p className="text-[11.5px] text-muted-foreground">
            {total > 0 ? `共 ${total} 项` : "空"} · 删除后保留 30 天，之后自动清除
            {deep > 0 ? ` · 深度回收站还有 ${deep} 项` : ""}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {selected.length > 0 ? (
            <>
              <span className="hidden text-[11.5px] text-muted-foreground sm:inline">
                已选 {selected.length} 项
              </span>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setPending({ kind: "restore", items: chosen })}
              >
                <RotateCcw className="size-4" />
                恢复
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-destructive hover:text-destructive"
                onClick={() => setPending({ kind: "purge", items: chosen })}
              >
                <Trash2 className="size-4" />
                永久删除
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
                清空选择
              </Button>
            </>
          ) : null}
          <Button variant="ghost" size="icon-sm" onClick={() => void load()} title="刷新">
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {error ? (
          <div className="m-4 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
            <p className="text-sm font-medium text-destructive">读取失败</p>
            <p className="mt-1 break-all text-xs text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>
              重试
            </Button>
          </div>
        ) : loading ? (
          <div className="grid gap-2 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="grid place-items-center gap-2 py-24 text-center">
            <Trash className="size-8 text-muted-foreground/50" />
            <span className="text-sm text-muted-foreground">回收站是空的</span>
            <span className="text-xs text-muted-foreground">在「文件」里删除的东西会先放到这里</span>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b px-4 py-2">
              <Checkbox
                checked={allChecked}
                onCheckedChange={() => toggleAll()}
                aria-label="全选"
              />
              <span className="text-[11.5px] text-muted-foreground">
                {allChecked ? "取消全选" : "全选本页"}
              </span>
            </div>
            <ul className="divide-y">
              {items.map((it) => {
                const checked = selected.includes(it.record_id);
                const urgent = it.remain_days <= 3;
                return (
                  <li
                    key={it.record_id}
                    className={cn(
                      "flex items-center gap-3 px-4 py-2.5 hover:bg-accent/40",
                      checked && "bg-accent/30",
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggleOne(it.record_id)}
                      aria-label={`选择 ${it.file_name}`}
                    />
                    <div className="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
                      {fileIcon(it.file_name, it.dir, "size-4 text-muted-foreground")}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{it.file_name}</span>
                        {urgent ? (
                          <Badge variant="destructive">
                            {it.remain_days <= 0 ? "即将清除" : `还剩 ${it.remain_days} 天`}
                          </Badge>
                        ) : (
                          <Badge variant="muted">还剩 {it.remain_days} 天</Badge>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-muted-foreground">
                        <span>{it.dir ? "文件夹" : formatBytes(it.size)}</span>
                        <span title={formatTime(it.deleted_at)}>
                          删除于 {relativeTime(it.deleted_at)}
                        </span>
                        <span>到期 {formatTime(it.move_deep_recycle_at)}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="恢复这项"
                        onClick={() => setPending({ kind: "restore", items: [it] })}
                      >
                        <RotateCcw className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="永久删除这项"
                        onClick={() => setPending({ kind: "purge", items: [it] })}
                      >
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
            {hasMore ? (
              <div className="p-3 text-center">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? "加载中…" : "加载更多"}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </ScrollArea>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending?.kind === "purge" ? "永久删除这些条目？" : "恢复到原目录？"}
        description={
          <>
            共 <b>{pending?.items.length ?? 0}</b> 项
            {pending && pending.items.length <= 3 ? (
              <>
                ：<span className="break-all">{pending.items.map((it) => it.file_name).join("、")}</span>
              </>
            ) : null}
            <br />
            {pending?.kind === "purge"
              ? "永久删除后无法恢复，也无法再从回收站找回。"
              : "文件会回到删除前所在的目录。"}
          </>
        }
        confirmLabel={pending?.kind === "purge" ? "永久删除" : "恢复"}
        destructive={pending?.kind === "purge"}
        onConfirm={doAction}
      />
    </div>
  );
}
