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
import { useI18n } from "@/lib/i18n";
import { formatBytes, formatTime, relativeTime } from "@/lib/format";
import type { RecycleData, RecycleItem } from "@/lib/types";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;
const MAX_PURGE_ONCE = 50;

type Pending = { kind: "restore" | "purge"; items: RecycleItem[] };

export function RecycleView() {
  const { run, booted } = useRunner();
  const { t, lang } = useI18n();
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
      if (!data) throw new Error(t("common.noData"));
      return data;
    },
    [run, t],
  );

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await drain(1, t("recycle.listOp"));
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
  }, [drain, t]);

  React.useEffect(() => {
    if (booted) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const data = await drain(page + 1, t("recycle.listMore"));
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
      toast.error(t("recycle.maxPurge", { n: MAX_PURGE_ONCE }));
      setPending(null);
      return;
    }
    try {
      const purge = job.kind === "purge";
      await run(purge ? "recycle-purge" : "recycle-restore", { records: ids }, t(purge ? "recycle.purge" : "recycle.restore"));
      toast.success(t(purge ? "recycle.donePurge" : "recycle.doneRestore", { n: ids.length }));
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
          <h2 className="text-sm font-medium">{t("nav.recycle")}</h2>
          <p className="text-[11.5px] text-muted-foreground">
            {total > 0 ? t("recycle.count", { n: total }) : t("recycle.empty")} · {t("recycle.keepHint")}
            {deep > 0 ? " · " + t("recycle.deep", { n: deep }) : ""}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {selected.length > 0 ? (
            <>
              <span className="hidden text-[11.5px] text-muted-foreground sm:inline">
                {t("common.selected", { n: selected.length })}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setPending({ kind: "restore", items: chosen })}
              >
                <RotateCcw className="size-4" />
                {t("recycle.restore")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-destructive hover:text-destructive"
                onClick={() => setPending({ kind: "purge", items: chosen })}
              >
                <Trash2 className="size-4" />
                {t("recycle.purge")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
                {t("common.clearSelection")}
              </Button>
            </>
          ) : null}
          <Button variant="ghost" size="icon-sm" onClick={() => void load()} title={t("common.refresh")}>
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {error ? (
          <div className="m-4 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
            <p className="text-sm font-medium text-destructive">{t("common.readError")}</p>
            <p className="mt-1 break-all text-xs text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>
              {t("common.retry")}
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
            <span className="text-sm text-muted-foreground">{t("recycle.emptyTitle")}</span>
            <span className="text-xs text-muted-foreground">{t("recycle.emptyHint")}</span>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b px-4 py-2">
              <Checkbox
                checked={allChecked}
                onCheckedChange={() => toggleAll()}
                aria-label={t("recycle.selectAll")}
              />
              <span className="text-[11.5px] text-muted-foreground">
                {allChecked ? t("recycle.deselectAll") : t("recycle.selectPage")}
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
                      aria-label={t("recycle.selectItem", { name: it.file_name })}
                    />
                    <div className="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
                      {fileIcon(it.file_name, it.dir, "size-4 text-muted-foreground")}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{it.file_name}</span>
                        {urgent ? (
                          <Badge variant="destructive">
                            {it.remain_days <= 0 ? t("recycle.clearing") : t("recycle.remain", { n: it.remain_days })}
                          </Badge>
                        ) : (
                          <Badge variant="muted">{t("recycle.remain", { n: it.remain_days })}</Badge>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-muted-foreground">
                        <span>{it.dir ? t("common.folder") : formatBytes(it.size)}</span>
                        <span title={formatTime(it.deleted_at)}>
                          {t("recycle.deletedAt", { time: relativeTime(it.deleted_at, lang) })}
                        </span>
                        <span>{t("recycle.expiresAt", { time: formatTime(it.move_deep_recycle_at) })}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={t("recycle.restoreOne")}
                        onClick={() => setPending({ kind: "restore", items: [it] })}
                      >
                        <RotateCcw className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={t("recycle.purgeOne")}
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
                  {loadingMore ? t("common.loading") : t("common.loadMore")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </ScrollArea>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending?.kind === "purge" ? t("recycle.confirmPurge") : t("recycle.confirmRestore")}
        description={
          <>
            {pending && pending.items.length <= 3
              ? t("recycle.confirmList", {
                  n: pending.items.length,
                  list: pending.items.map((it) => it.file_name).join(lang === "en" ? ", " : "、"),
                })
              : t("recycle.confirmCount", { n: pending?.items.length ?? 0 })}
            <br />
            {pending?.kind === "purge" ? t("recycle.purgeHint") : t("recycle.restoreHint")}
          </>
        }
        confirmLabel={pending?.kind === "purge" ? t("recycle.purge") : t("recycle.restore")}
        destructive={pending?.kind === "purge"}
        onConfirm={doAction}
      />
    </div>
  );
}
