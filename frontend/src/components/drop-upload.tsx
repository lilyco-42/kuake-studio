import * as React from "react";
import { toast } from "sonner";
import { CircleCheck, CircleX, Loader2, Square, UploadCloud, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { uploadTempRaw } from "@/lib/api";
import { useRunner } from "@/lib/store";
import { formatBytes, joinPath } from "@/lib/format";
import {
  collectDroppedFiles,
  hasDroppedFiles,
  isAbortError,
  isSkippedError,
  type DroppedFile,
} from "@/lib/drop";

type ItemState = "pending" | "staging" | "uploading" | "done" | "skipped" | "failed" | "cancelled";

interface QueueItem {
  id: number;
  relPath: string;
  name: string;
  size: number;
  /** 落盘那一刻的目录，避免上传途中导航导致目标漂移 */
  destDir: string;
  state: ItemState;
  file: File;
  error?: string;
}

const ACTIVE: ItemState[] = ["pending", "staging", "uploading"];
const isActive = (s: ItemState): boolean => ACTIVE.includes(s);

const STATE_LABEL: Record<ItemState, string> = {
  pending: "排队",
  staging: "暂存",
  uploading: "上传中",
  done: "完成",
  skipped: "跳过",
  failed: "失败",
  cancelled: "已停止",
};

function variantOf(s: ItemState): "default" | "secondary" | "destructive" | "outline" | "success" | "muted" {
  if (s === "done") return "success";
  if (s === "failed") return "destructive";
  if (s === "skipped" || s === "cancelled") return "muted";
  if (s === "uploading") return "secondary";
  return "outline";
}

let nextId = 0;

/**
 * 文件页的拖拽上传外壳：接管 drag 事件、显示队列、逐文件走
 * /api/upload/raw 暂存 → run("upload", {file, dest})。
 * 不新增后端命令，点「上传」按钮的加密上传仍走 UploadDialog。
 */
export function DropUpload({
  dirPath,
  onDone,
  children,
}: {
  dirPath: string;
  onDone: () => void;
  children: React.ReactNode;
}) {
  const { run, cancel } = useRunner();
  const [queue, setQueue] = React.useState<QueueItem[]>([]);
  const [hover, setHover] = React.useState(false);
  const itemsRef = React.useRef<QueueItem[]>([]);
  const runningRef = React.useRef(false);
  const stoppedRef = React.useRef(false);
  const controllerRef = React.useRef<AbortController | null>(null);
  const depthRef = React.useRef(0);
  const onDoneRef = React.useRef(onDone);
  onDoneRef.current = onDone;

  const patch = React.useCallback((id: number, changes: Partial<QueueItem>) => {
    itemsRef.current = itemsRef.current.map((it) => (it.id === id ? { ...it, ...changes } : it));
    setQueue(itemsRef.current.slice());
  }, []);

  const processOne = React.useCallback(
    async (item: QueueItem): Promise<ItemState> => {
      patch(item.id, { state: "staging" });
      try {
        const staged = await uploadTempRaw(item.name, item.file, controllerRef.current?.signal);
        if (stoppedRef.current) {
          patch(item.id, { state: "cancelled" });
          return "cancelled";
        }
        patch(item.id, { state: "uploading" });
        await run(
          "upload",
          { file: staged.path, dest: joinPath(item.destDir, item.relPath) },
          "上传 " + item.relPath,
        );
        if (stoppedRef.current) {
          patch(item.id, { state: "cancelled" });
          return "cancelled";
        }
        patch(item.id, { state: "done" });
        return "done";
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (stoppedRef.current || isAbortError(e)) {
          patch(item.id, { state: "cancelled" });
          return "cancelled";
        }
        if (isSkippedError(e)) {
          patch(item.id, { state: "skipped", error: msg });
          return "skipped";
        }
        patch(item.id, { state: "failed", error: msg });
        return "failed";
      }
    },
    [patch, run],
  );

  const pump = React.useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    let changed = false;
    try {
      for (;;) {
        if (stoppedRef.current) break;
        const item = itemsRef.current.find((it) => it.state === "pending");
        if (!item) break;
        const result = await processOne(item);
        if (result === "done" || result === "skipped") changed = true;
      }
    } finally {
      runningRef.current = false;
    }
    if (changed) onDoneRef.current();
  }, [processOne]);

  const enqueue = React.useCallback(
    (dropped: DroppedFile[]) => {
      if (dropped.length === 0) return;
      if (stoppedRef.current || !controllerRef.current) {
        stoppedRef.current = false;
        controllerRef.current = new AbortController();
      }
      const activePaths = new Set(
        itemsRef.current.filter((it) => isActive(it.state)).map((it) => it.relPath),
      );
      const fresh: QueueItem[] = dropped
        .filter((d) => !activePaths.has(d.relPath))
        .map((d) => ({
          id: ++nextId,
          relPath: d.relPath,
          name: d.name,
          size: d.file.size,
          destDir: dirPath,
          state: "pending",
          file: d.file,
        }));
      if (fresh.length === 0) return;
      const freshPaths = new Set(fresh.map((it) => it.relPath));
      // 同名旧记录（已完成/失败）替换掉，队列里始终只留一条
      itemsRef.current = itemsRef.current.filter((it) => !freshPaths.has(it.relPath)).concat(fresh);
      setQueue(itemsRef.current.slice());
      toast.message("已加入上传队列：" + fresh.length + " 个文件");
      void pump();
    },
    [dirPath, pump],
  );

  const stopAll = () => {
    stoppedRef.current = true;
    controllerRef.current?.abort();
    const hasRun = itemsRef.current.some((it) => it.state === "uploading");
    itemsRef.current = itemsRef.current.map((it) =>
      isActive(it.state) ? { ...it, state: "cancelled" } : it,
    );
    setQueue(itemsRef.current.slice());
    if (hasRun) void cancel();
    toast.message("已停止上传队列");
  };

  const clearAll = () => {
    itemsRef.current = [];
    setQueue([]);
    depthRef.current = 0;
  };

  const onDragEnter = (e: React.DragEvent) => {
    if (!hasDroppedFiles(e.dataTransfer)) return;
    e.preventDefault();
    depthRef.current += 1;
    setHover(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!hasDroppedFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!hasDroppedFiles(e.dataTransfer)) return;
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setHover(false);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!hasDroppedFiles(e.dataTransfer)) return;
    e.preventDefault();
    depthRef.current = 0;
    setHover(false);
    const dt = e.dataTransfer;
    void (async () => {
      try {
        enqueue(await collectDroppedFiles(dt));
      } catch (err) {
        toast.error("读取拖拽内容失败：" + (err instanceof Error ? err.message : String(err)));
      }
    })();
  };

  const total = queue.length;
  const finished = queue.filter((it) => !isActive(it.state)).length;
  const doneCount = queue.filter((it) => it.state === "done").length;
  const skippedCount = queue.filter((it) => it.state === "skipped").length;
  const failedCount = queue.filter((it) => it.state === "failed").length;
  const busy = queue.some((it) => isActive(it.state));
  const percent = total === 0 ? 0 : Math.round((finished / total) * 100);

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}

      {hover && (
        <div className="pointer-events-none absolute inset-2 z-40 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-primary/10 text-primary shadow-inner">
          <UploadCloud className="size-9" />
          <div className="text-sm font-medium">松手即上传到当前目录</div>
          <div className="text-xs opacity-80">支持整文件夹，保留层级；单文件上限 2 GiB</div>
        </div>
      )}

      {total > 0 && (
        <div className="absolute bottom-4 right-4 z-30 w-[min(30rem,calc(100%-2rem))] rounded-xl border bg-background/95 p-3 shadow-xl backdrop-blur">
          <div className="flex items-center gap-2">
            <UploadCloud className="size-4 shrink-0 text-primary" />
            <span className="shrink-0 text-sm font-medium">拖拽上传</span>
            <span className="truncate text-xs text-muted-foreground">
              {finished + "/" + total + " · 完成 " + doneCount + " · 跳过 " + skippedCount + " · 失败 " + failedCount}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {busy ? (
                <Button variant="ghost" size="icon-sm" title="停止队列" onClick={stopAll}>
                  <Square className="size-3.5" />
                </Button>
              ) : (
                <Button variant="ghost" size="icon-sm" title="关闭面板" onClick={clearAll}>
                  <X className="size-4" />
                </Button>
              )}
            </div>
          </div>
          <Progress value={percent} className="mt-2 h-1.5" />
          <ScrollArea className="mt-2 max-h-52">
            <ul className="space-y-1 pr-2">
              {queue.map((it) => (
                <li
                  key={it.id}
                  title={it.error ?? it.relPath}
                  className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-muted/60"
                >
                  {isActive(it.state) ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
                  ) : it.state === "done" ? (
                    <CircleCheck className="size-3.5 shrink-0 text-emerald-500" />
                  ) : it.state === "failed" ? (
                    <CircleX className="size-3.5 shrink-0 text-destructive" />
                  ) : (
                    <span className="size-3.5 shrink-0 rounded-full border" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{it.relPath}</span>
                  <span className="shrink-0 text-muted-foreground">{formatBytes(it.size)}</span>
                  <Badge variant={variantOf(it.state)} className="shrink-0 px-1.5 py-0 text-[10px]">
                    {STATE_LABEL[it.state]}
                  </Badge>
                </li>
              ))}
            </ul>
          </ScrollArea>
          <div className="mt-2 text-[11px] text-muted-foreground">同名文件自动跳过；缺失的目标目录由后端自动创建</div>
        </div>
      )}
    </div>
  );
}
