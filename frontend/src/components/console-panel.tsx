import * as React from "react";
import { ChevronDown, ChevronUp, Trash2, Terminal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useRunner } from "@/lib/store";
import { cn } from "@/lib/utils";

/** 底部活动日志：所有 kuake 调用（含 stdout 进度、错误、耗时）都汇到这里 */
export function ConsolePanel() {
  const { logs, clearLogs, busy, progress } = useRunner();
  const [open, setOpen] = React.useState(true);
  const endRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "end" });
  }, [logs, open]);

  const errCount = logs.filter((l) => l.kind === "err").length;

  return (
    <div className="border-t bg-card/40 backdrop-blur">
      {busy && <Progress value={progress ?? 0} className="h-0.5 rounded-none" />}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => setOpen((o) => !o)}
        >
          <Terminal className="size-3.5" />
          活动日志
          {errCount > 0 && (
            <span className="rounded bg-destructive/15 px-1 text-[10px] text-destructive">
              {errCount}
            </span>
          )}
          {open ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
        </Button>
        {busy && (
          <span className="truncate text-xs text-muted-foreground">
            正在执行：{busy}
            {progress !== null && ` · ${Math.round(progress)}%`}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <span className="text-[11px] text-muted-foreground">{logs.length} 行</span>
          <Button variant="ghost" size="icon-sm" className="size-7" onClick={clearLogs}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      {open && (
        <div className="h-44 overflow-y-auto border-t px-3 py-2 font-mono text-[11.5px] leading-relaxed">
          {logs.length === 0 && (
            <p className="text-muted-foreground">暂无活动。任何操作都会在这里留痕。</p>
          )}
          {logs.map((l) => (
            <div
              key={l.id}
              className={cn(
                "flex gap-2",
                l.kind === "err" && "text-destructive",
                l.kind === "ok" && "text-success",
                l.kind === "tick" && "text-muted-foreground",
              )}
            >
              <span className="shrink-0 text-muted-foreground/60 tabular">
                {new Date(l.at).toLocaleTimeString("zh-CN", { hour12: false })}
              </span>
              <span className="whitespace-pre-wrap break-all">{l.text}</span>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}
