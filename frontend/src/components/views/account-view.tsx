import * as React from "react";
import { Crown, HardDrive, QrCode, RefreshCw, Terminal, User } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { LoginDialog } from "@/components/login-dialog";
import { useRunner } from "@/lib/store";
import { formatBytes, formatTime } from "@/lib/format";
import type { KuakeUser } from "@/lib/types";

export function AccountView() {
  const { run, booted, info } = useRunner();
  const [user, setUser] = React.useState<KuakeUser | null>(null);
  const [version, setVersion] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [loginOpen, setLoginOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [u, v] = await Promise.all([
        run<KuakeUser>("user", {}, "账号信息"),
        run<{ version?: string }>("version", {}, "kuake 版本"),
      ]);
      setUser(u);
      setVersion(v?.version ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [run]);

  React.useEffect(() => {
    if (booted) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted]);

  const total = user?.total_capacity ?? 0;
  const used = user?.use_capacity ?? 0;
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto grid max-w-3xl gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">账号</h2>
            <p className="text-[11.5px] text-muted-foreground">容量、会员状态与运行环境</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setLoginOpen(true)}>
              <QrCode className="size-4" />
              扫码登录
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
              刷新
            </Button>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-xs text-destructive">{error}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              多为登录态过期。点右上角「扫码登录」即可刷新；或更新 KUAKE_COOKIE 后重启。
            </p>
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <User className="size-4" />
              {loading && !user ? <Skeleton className="h-5 w-28" /> : (user?.nickname ?? "未知账号")}
            </CardTitle>
            <CardDescription className="flex flex-wrap items-center gap-2">
              {user?.member_type && (
                <Badge variant="success" className="gap-1">
                  <Crown className="size-3" />
                  {user.member_type}
                </Badge>
              )}
              {user?.super_vip_exp_at ? (
                <span>会员到期 {formatTime(user.super_vip_exp_at)}</span>
              ) : null}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex items-end justify-between text-xs">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <HardDrive className="size-3.5" />
                容量
              </span>
              <span className="tabular">
                {formatBytes(used)} / {formatBytes(total)} · {pct.toFixed(1)}%
              </span>
            </div>
            <Progress value={pct} />
            <p className="text-[11px] text-muted-foreground">
              剩余 {formatBytes(Math.max(0, total - used))}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Terminal className="size-4" />
              运行环境
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-xs">
            <Row k="网盘后端" v={info?.backend === "cli" ? "kuake CLI 子进程" : "内置原生 API（无需 kuake.exe）"} />
            <Separator />
            <Row k="后端版本" v={version ?? (loading ? "读取中…" : "—")} />
            <Separator />
            {info?.backend === "cli" && (
              <>
                <Row k="kuake 路径" v={info?.kuake ?? "—"} mono />
                <Separator />
              </>
            )}
            <Row k="客户端版本" v={info ? info.version : "—"} mono />
          </CardContent>
        </Card>

        <LoginDialog
          open={loginOpen}
          onOpenChange={setLoginOpen}
          onSuccess={() => void load()}
        />
      </div>
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{k}</span>
      <span className={mono ? "break-all text-right font-mono text-[11px]" : "text-right"}>{v}</span>
    </div>
  );
}
