import * as React from "react";
import { toast } from "sonner";
import { Check, Copy, ExternalLink, Link2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useRunner } from "@/lib/store";
import { useI18n } from "@/lib/i18n";
import { formatBytes, formatTime, joinPath } from "@/lib/format";
import { indexSharesByPath, sharesForItem, type ShareListResult } from "@/lib/share-links";
import type { CommandSchema, KuakeFile, KuakeShare } from "@/lib/types";

/** 详情弹窗：常用字段做成表格，原始返回折叠在下面（kuake info 字段多且随版本变） */
export function InfoDialog({
  item,
  baseDir,
  schemas = [],
  onCreateShare,
  onClose,
}: {
  item: KuakeFile | null;
  baseDir: string;
  schemas?: CommandSchema[];
  onCreateShare?: () => void;
  onClose: () => void;
}) {
  const { run } = useRunner();
  const { t } = useI18n();
  const [detail, setDetail] = React.useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [shares, setShares] = React.useState<KuakeShare[]>([]);
  const [shareLoading, setShareLoading] = React.useState(false);
  const [copied, setCopied] = React.useState<string | null>(null);
  const canListShares = schemas.some((s) => s.name === "share-list");

  const path = item ? item.path || joinPath(baseDir, item.file_name) : "";

  React.useEffect(() => {
    if (!item) {
      setDetail(null);
      return;
    }
    let alive = true;
    setLoading(true);
    run<Record<string, unknown>>("info", { path }, "查看详情")
      .then((d) => alive && setDetail(d))
      .catch(() => alive && setDetail(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.fid, path]);

  React.useEffect(() => {
    if (!item || !canListShares) {
      setShares([]);
      return;
    }
    let alive = true;
    setShareLoading(true);
    run<ShareListResult>("share-list", { page: 1, size: 100 }, t("op.list"))
      .then((d) => {
        if (!alive) return;
        const index = indexSharesByPath(d?.list ?? [], [item], baseDir);
        setShares(sharesForItem(index, item, baseDir));
      })
      .catch(() => alive && setShares([]))
      .finally(() => alive && setShareLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.fid, path, baseDir, canListShares, run, t]);

  const copyShare = async (s: KuakeShare) => {
    if (!s.share_url) return;
    try {
      await navigator.clipboard.writeText(s.share_url);
      setCopied(s.share_url);
      toast.success(t("shares.copied"));
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      toast.error(t("common.clipboardFail"));
    }
  };

  if (!item) return null;

  const rows: [string, string][] = [
    ["文件名", item.file_name],
    ["类型", item.dir ? "文件夹" : "文件"],
    ["大小", item.dir ? "—" : formatBytes(item.size)],
    ["路径", path],
    ["fid", item.fid || "—"],
    ["创建", formatTime(item.ctime || item.created_at)],
    ["修改", formatTime(item.mtime || item.updated_at)],
  ];

  return (
    <Dialog open={item !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="break-all">{item.file_name}</DialogTitle>
          <DialogDescription>{item.dir ? "文件夹" : "文件"}</DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[4rem_1fr] gap-x-3 gap-y-2 text-sm">
          {rows.map(([k, v]) => (
            <React.Fragment key={k}>
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="break-all font-mono text-xs leading-5">{v}</dd>
            </React.Fragment>
          ))}
        </dl>

        {canListShares ? (
          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-medium">
              <Link2 className="size-3.5" />
              {t("files.shareLinks")}
              <span className="text-[10px] font-normal text-muted-foreground">
                {t("files.shareRecentHint")}
              </span>
              {onCreateShare ? (
                <Button variant="outline" size="sm" className="ml-auto h-7 gap-1 text-[11px]" onClick={onCreateShare}>
                  <Link2 className="size-3" /> {t("files.createShare")}
                </Button>
              ) : null}
            </div>
            {shareLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : shares.length ? (
              <ul className="grid gap-1.5">
                {shares.map((s) =>
                  s.share_url ? (
                    <li key={s.share_url} className="flex min-w-0 items-center gap-2 rounded-md bg-background/70 px-2 py-1.5">
                      <a
                        href={s.share_url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-primary hover:underline"
                        title={s.share_url}
                      >
                        <span className="truncate font-mono">{s.share_url}</span>
                        <ExternalLink className="size-3 shrink-0" />
                      </a>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-6 shrink-0"
                        title={t("shares.copyLink")}
                        onClick={() => void copyShare(s)}
                      >
                        {copied === s.share_url ? (
                          <Check className="size-3 text-success" />
                        ) : (
                          <Copy className="size-3" />
                        )}
                      </Button>
                    </li>
                  ) : null,
                )}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">{t("files.shareNone")}</p>
            )}
          </div>
        ) : null}

        {loading && <Skeleton className="h-16 w-full" />}
        {detail && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">原始返回</summary>
            <pre className="mt-2 max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-[10.5px]">
              {JSON.stringify(detail, null, 2)}
            </pre>
          </details>
        )}

        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            关闭
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
