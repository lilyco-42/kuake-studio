import * as React from "react";
import {
  BadgeCheck,
  CloudCog,
  ExternalLink,
  Gift,
  Heart,
  MessageCircle,
  RefreshCw,
  Scale,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { AdSlot } from "@/components/commercial/ad-slot";
import { LicenseBox } from "@/components/commercial/license-box";
import { contactLines, safeExternalUrl } from "@/lib/commercial-core";
import { refreshCloudConfig } from "@/lib/commercial";
import { useI18n } from "@/lib/i18n";
import { useRunner } from "@/lib/store";

const REPO = "https://github.com/lilyco-42/kuake-studio";

function Row({ label, value, href }: { label: string; value: React.ReactNode; href?: string | null }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex min-w-0 items-center gap-1 truncate text-primary hover:underline"
        >
          {value} <ExternalLink className="size-3 shrink-0" />
        </a>
      ) : (
        <span className="min-w-0 truncate text-right font-mono">{value}</span>
      )}
    </div>
  );
}

export function AboutView() {
  const { info, commercial, setCommercial } = useRunner();
  const { t, lang } = useI18n();
  const [refreshing, setRefreshing] = React.useState(false);
  const cfg = commercial.config;
  const cloud = cfg.cloud;

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      setCommercial(await refreshCloudConfig());
      toast.success(t("about.refreshOk"));
    } catch (e) {
      toast.error(t("about.refreshFail") + ": " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
      <div className="mx-auto grid max-w-4xl gap-4">
        <div>
          <h2 className="text-lg font-semibold">{t("about.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("about.subtitle")}</p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {/* 联系方式 */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm"><MessageCircle className="size-4 text-primary" /> {t("about.contact")}</CardTitle>
              <CardDescription className="text-[11px]">{t("about.contactChannels")}</CardDescription>
            </CardHeader>
            <CardContent className="text-xs">
              {contactLines(cfg.contact).map((c) => (
                <Row
                  key={c.label}
                  label={c.label}
                  value={c.value}
                  href={c.href ? safeExternalUrl(c.href) : null}
                />
              ))}
              <Separator className="my-2" />
              <Row label={t("about.version")} value={"v" + (info?.version ?? "?")} />
              <Row label={t("about.backend")} value={t(info?.backend === "cli" ? "about.cli" : "about.native")} />
              <Row label={t("about.repo")} value="lilyco-42/kuake-studio" href={REPO} />
            </CardContent>
          </Card>

          {/* 赞助二维码 */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm"><Heart className="size-4 text-primary" /> {t("about.images")}</CardTitle>
              <CardDescription className="text-[11px]">{t("about.sameOrigin")}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3">
                {cfg.sponsor.links.map((l) => (
                  <a
                    key={l.id}
                    href={safeExternalUrl(l.qr_url) ?? undefined}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="grid justify-items-center gap-1 rounded-lg border p-2 text-center transition-colors hover:border-primary/50"
                  >
                    <img src={l.image} alt={l.name} className="h-32 w-auto rounded bg-white object-contain" loading="lazy" />
                    <span className="text-[11px] font-medium">{l.name}</span>
                    <span className="text-[10px] leading-3 text-muted-foreground">{l.note}</span>
                  </a>
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted-foreground">{t("about.shared")}</span>
                <a
                  href={safeExternalUrl(cfg.sponsor.shared_repo) ?? undefined}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
                >
                  shared/master <ExternalLink className="size-3" />
                </a>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 名利选其一 */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm"><Gift className="size-4 text-primary" /> {t("about.benefits")} · {cfg.sponsor.benefits.title}</CardTitle>
            <CardDescription className="text-[11px]">{cfg.sponsor.benefits.choose_one}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-xs md:grid-cols-2">
            <div className="rounded-lg border bg-muted/30 p-3">
              <Badge variant="muted" className="mb-1.5 text-[10px]">{t("license.tierFame")}</Badge>
              <p className="leading-5 text-muted-foreground">{cfg.sponsor.benefits.fame}</p>
            </div>
            <div className="rounded-lg border bg-muted/30 p-3">
              <Badge variant="success" className="mb-1.5 text-[10px]">{t("license.tierProfit")}</Badge>
              <p className="leading-5 text-muted-foreground">{cfg.sponsor.benefits.profit}</p>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 md:grid-cols-2">
          {/* 许可与商用 */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm"><Scale className="size-4 text-primary" /> {t("about.legal")}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-xs">
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="muted" className="text-[10px]">{t("about.openSource")}</Badge>
                <Badge variant="muted" className="text-[10px]">{t("about.commercial")}</Badge>
                <Badge variant="outline" className="text-[10px]">{t("about.noResale")}</Badge>
              </div>
              <p className="leading-5 text-muted-foreground">
                {lang === "en" ? t("legal.summaryEn") : cfg.legal.summary}
              </p>
              <p className="text-[10.5px] text-muted-foreground">LICENSE · {cfg.legal.edition}</p>
            </CardContent>
          </Card>

          {/* 云端推送 */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm"><CloudCog className="size-4 text-primary" /> {t("about.cloud")}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-xs">
              <p className="leading-5 text-muted-foreground">
                {cloud.enabled
                  ? t("about.cloudOn", { sec: cloud.refresh_interval_sec })
                  : t("about.cloudOff")}
              </p>
              {cloud.last_refresh ? (
                <Row label={t("about.cloudLast")} value={new Date(cloud.last_refresh * 1000).toLocaleString()} />
              ) : null}
              {cloud.last_error ? <Row label={t("about.cloudError")} value={cloud.last_error} /> : null}
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10.5px] text-muted-foreground">
                  {cloud.enabled ? "KUAKE_STUDIO_CLOUD_CONFIG_URL" : "offline"}
                </span>
                <Button variant="outline" size="sm" disabled={refreshing || !cloud.enabled} onClick={() => void onRefresh()}>
                  <RefreshCw className={"size-3.5 " + (refreshing ? "animate-spin" : "")} /> {t("about.refresh")}
                </Button>
              </div>
              <p className="text-[10.5px] leading-4 text-muted-foreground">
                {t("about.cloudWhitelist")}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* 许可证入口 + 广告位 */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              {commercial.sponsored ? <BadgeCheck className="size-4 text-success" /> : <ShieldCheck className="size-4 text-primary" />}
              {t("about.license")}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <LicenseBox />
            <AdSlot slotId="about" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
