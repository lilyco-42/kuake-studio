import * as React from "react";
import { toast } from "sonner";
import {
  Check,
  Copy,
  ExternalLink,
  Link2,
  RefreshCw,
  Link2Off,
  DownloadCloud,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { CommandDialog } from "@/components/command-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useRunner } from "@/lib/store";
import { formatTime, relativeTime } from "@/lib/format";
import type { CommandSchema, KuakeShare } from "@/lib/types";
import { cn } from "@/lib/utils";

export function SharesView({ schemas }: { schemas: CommandSchema[] }) {
  const { run, booted } = useRunner();
  const [shares, setShares] = React.useState<KuakeShare[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [copiedId, setCopiedId] = React.useState<string | null>(null);
  const [revoke, setRevoke] = React.useState<KuakeShare | null>(null);
  const [saveOpen, setSaveOpen] = React.useState(false);

  const argsOf = React.useCallback(
    (name: string) => schemas.find((s) => s.name === name)?.args ?? [],
    [schemas],
  );

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await run<{ list: KuakeShare[] }>("share-list", { page: 1, size: 50 }, "分享列表");
      setShares(data?.list ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setShares([]);
    } finally {
      setLoading(false);
    }
  }, [run]);

  React.useEffect(() => {
    if (booted) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted]);

  const copy = async (s: KuakeShare) => {
    const url = s.share_url ?? "";
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(s.share_id ?? s.pwd_id ?? url);
      toast.success("链接已复制");
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      toast.error("剪贴板不可用，请手动复制");
    }
  };

  const isExpired = (s: KuakeShare) =>
    typeof s.expired_at === "number" && s.expired_at > 0 && s.expired_at < Date.now();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">我的分享</h2>
          <p className="text-[11.5px] text-muted-foreground">
            共 {shares.length} 条 · 取消后链接立即失效
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="icon-sm" onClick={() => void load()} title="刷新">
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setSaveOpen(true)}>
            <DownloadCloud className="size-4" />
            转存他人分享
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
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : shares.length === 0 ? (
          <div className="grid place-items-center gap-2 py-24 text-center">
            <Link2 className="size-8 text-muted-foreground/50" />
            <span className="text-sm text-muted-foreground">还没有分享链接</span>
            <span className="text-xs text-muted-foreground">在「文件」里选一个文件或文件夹即可创建</span>
          </div>
        ) : (
          <ul className="divide-y">
            {shares.map((s) => {
              const id = s.share_id ?? s.pwd_id ?? s.share_url ?? String(Math.random());
              const expired = isExpired(s);
              return (
                <li key={id} className="group flex items-center gap-3 px-4 py-3 hover:bg-accent/40">
                  <div className="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
                    <Link2 className="size-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {s.title || s.first_file?.file_name || "未命名分享"}
                      </span>
                      {expired ? (
                        <Badge variant="destructive">已过期</Badge>
                      ) : (
                        <Badge variant="success">有效</Badge>
                      )}
                      {typeof s.file_num === "number" && s.file_num > 1 && (
                        <Badge variant="muted">{s.file_num} 项</Badge>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-muted-foreground">
                      <span className="truncate font-mono">{s.share_url}</span>
                      <span>创建 {relativeTime(s.created_at)}</span>
                      {s.expired_at ? <span>到期 {formatTime(s.expired_at)}</span> : null}
                      <span>浏览 {Math.max(0, s.click_pv ?? 0)}</span>
                      <span>转存 {Math.max(0, s.save_pv ?? 0)}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="复制链接"
                      onClick={() => void copy(s)}
                    >
                      {copiedId === id ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
                    </Button>
                    {s.share_url && (
                      <Button variant="ghost" size="icon-sm" asChild title="在浏览器打开">
                        <a href={s.share_url} target="_blank" rel="noreferrer">
                          <ExternalLink className="size-4" />
                        </a>
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="取消分享"
                      onClick={() => setRevoke(s)}
                    >
                      <Link2Off className="size-4 text-destructive" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </ScrollArea>

      <CommandDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        title="转存他人分享"
        description="把别人分享的文件保存到你的网盘"
        cmd="share-save"
        args={argsOf("share-save")}
        submitLabel="转存"
        onSuccess={() => void load()}
      />

      <ConfirmDialog
        open={revoke !== null}
        onOpenChange={(o) => !o && setRevoke(null)}
        title="取消这条分享？"
        description={
          <>
            <span className="break-all font-mono">{revoke?.share_url ?? revoke?.title}</span>
            <br />
            取消后链接立刻失效，已转存的人不受影响。
          </>
        }
        confirmLabel="取消分享"
        onConfirm={async () => {
          const target = revoke;
          if (!target) return;
          const key = target.share_id ?? target.pwd_id;
          try {
            await run("share-delete", { targets: key ? [key] : [] }, "取消分享");
            toast.success("已取消");
            await load();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
          }
          setRevoke(null);
        }}
      />
    </div>
  );
}
