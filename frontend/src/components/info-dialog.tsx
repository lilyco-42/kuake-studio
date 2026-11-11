import * as React from "react";

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
import { formatBytes, formatTime, joinPath } from "@/lib/format";
import type { KuakeFile } from "@/lib/types";

/** 详情弹窗：常用字段做成表格，原始返回折叠在下面（kuake info 字段多且随版本变） */
export function InfoDialog({
  item,
  baseDir,
  onClose,
}: {
  item: KuakeFile | null;
  baseDir: string;
  onClose: () => void;
}) {
  const { run } = useRunner();
  const [detail, setDetail] = React.useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = React.useState(false);

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
