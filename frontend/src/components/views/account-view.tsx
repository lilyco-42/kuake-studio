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
import { useI18n } from "@/lib/i18n";
import { formatBytes, formatTime } from "@/lib/format";
import type { KuakeUser } from "@/lib/types";

export function AccountView() {
  const { run, booted, info } = useRunner();
  const { t } = useI18n();
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
        run<KuakeUser>("user", {}, t("op.user")),
        run<{ version?: string }>("version", {}, t("op.version")),
      ]);
      setUser(u);
      setVersion(v?.version ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [run, t]);

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
            <h2 className="text-sm font-medium">{t("nav.account")}</h2>
            <p className="text-[11.5px] text-muted-foreground">{t("account.subtitle")}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setLoginOpen(true)}>
              <QrCode className="size-4" />
              {t("account.qrLogin")}
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
              {t("common.refresh")}
            </Button>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-xs text-destructive">{error}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("account.errorHint")}
            </p>
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <User className="size-4" />
              {loading && !user ? <Skeleton className="h-5 w-28" /> : (user?.nickname ?? t("account.unknown"))}
            </CardTitle>
            <CardDescription className="flex flex-wrap items-center gap-2">
              {user?.member_type && (
                <Badge variant="success" className="gap-1">
                  <Crown className="size-3" />
                  {user.member_type}
                </Badge>
              )}
              {user?.super_vip_exp_at ? (
                <span>{t("account.vipExp", { time: formatTime(user.super_vip_exp_at) })}</span>
              ) : null}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex items-end justify-between text-xs">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <HardDrive className="size-3.5" />
                {t("account.capacity")}
              </span>
              <span className="tabular">
                {formatBytes(used)} / {formatBytes(total)} · {pct.toFixed(1)}%
              </span>
            </div>
            <Progress value={pct} />
            <p className="text-[11px] text-muted-foreground">
              {t("account.remaining", { size: formatBytes(Math.max(0, total - used)) })}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Terminal className="size-4" />
              {t("account.runtime")}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-xs">
            <Row k={t("about.backend")} v={t(info?.backend === "cli" ? "about.cli" : "about.native")} />
            <Separator />
            <Row k={t("account.backendVersion")} v={version ?? (loading ? t("account.reading") : "—")} />
            <Separator />
            {info?.backend === "cli" && (
              <>
                <Row k={t("account.kuakePath")} v={info?.kuake ?? "—"} mono />
                <Separator />
              </>
            )}
            <Row k={t("about.version")} v={info ? info.version : "—"} mono />
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
