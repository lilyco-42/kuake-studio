import * as React from "react";
import { ExternalLink, Gift, Heart, MessageCircle, QrCode, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AdSlot } from "@/components/commercial/ad-slot";
import { LicenseBox } from "@/components/commercial/license-box";
import {
  markStartupDismissed,
  markStartupShown,
  readStartupState,
  shouldShowStartup,
  contactLines,
  safeExternalUrl,
} from "@/lib/commercial";
import { useI18n } from "@/lib/i18n";
import { useRunner } from "@/lib/store";

/**
 * 启动弹窗：联系方式（微信 lilyco42 / QQ 1957374829 / B 站）+ 赞助链接 + 两张赞助图。
 * 节奏完全由后端配置 + 本地最后一次显示时间决定；赞助者 / 点过「不再显示」后不弹。
 * 图片全部同源 /assets/sponsor/*，CSP 一个外域都不用开。
 */
export function StartupDialog() {
  const { booted, commercial, setTab } = useCommercialRunner();
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (!booted) return;
    const { lastShownAt, dismissed } = readStartupState();
    const show = shouldShowStartup(commercial, Date.now(), lastShownAt, dismissed);
    if (!show) return;
    const delay = Math.max(0, Math.min(10_000, commercial.config.startup.delay_ms || 0));
    const t = window.setTimeout(() => setOpen(true), delay);
    return () => window.clearTimeout(t);
    // commercial 只在握手时变化一次；之后激活授权会关掉它，不用重复排定时器
  }, [booted, commercial]);

  if (!booted) return null;
  const cfg = commercial.config;
  const contacts = contactLines(cfg.contact);

  const close = (permanent = false) => {
    setOpen(false);
    if (permanent) markStartupDismissed();
    else markStartupShown();
  };

  const openAbout = () => {
    close(false);
    setTab("about");
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(false); }}>
      <DialogContent className="max-h-[88vh] max-w-[min(92vw,560px)] gap-3 overflow-y-auto p-5 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Heart className="size-4 text-primary" />
            {t("startup.title")}
          </DialogTitle>
          <DialogDescription>{t("startup.intro")}</DialogDescription>
        </DialogHeader>

        {cfg.startup.notice ? (
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{cfg.startup.notice}</p>
        ) : null}

        {/* 联系方式：B 站是可点外链；微信 / QQ 是纯文本（避免诱导跳转） */}
        <div className="grid gap-1.5 rounded-lg border bg-card/50 p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium"><MessageCircle className="size-3.5" /> {t("startup.contact")}</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            {contacts.map((c) => (
              <div key={c.label} className="min-w-0">
                <span className="text-muted-foreground">{c.label}：</span>
                {c.href && safeExternalUrl(c.href) ? (
                  <a
                    href={safeExternalUrl(c.href)!}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-0.5 truncate text-primary hover:underline"
                  >
                    {c.value} <ExternalLink className="size-3" />
                  </a>
                ) : (
                  <span className="font-mono">{c.value}</span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 赞助图：按二维码实际内容命名，绝不写「支付宝」 */}
        <div className="grid gap-2 sm:grid-cols-2">
          {cfg.sponsor.links.map((l) => (
            <a
              key={l.id}
              href={safeExternalUrl(l.qr_url) ?? undefined}
              target="_blank"
              rel="noreferrer noopener"
              className="group grid justify-items-center gap-1.5 rounded-lg border bg-card p-2 text-center transition-colors hover:border-primary/50"
            >
              <img
                src={l.image}
                alt={l.name}
                className="h-40 w-auto rounded-md border bg-white object-contain"
                loading="lazy"
              />
              <span className="flex items-center gap-1 text-xs font-medium">
                <QrCode className="size-3.5 text-primary" /> {l.id === "wechat-pay" ? t("startup.pay") : t("startup.contactQr")}
              </span>
              <span className="text-[10.5px] leading-4 text-muted-foreground">{l.note}</span>
            </a>
          ))}
        </div>

        {/* 名利选其一 */}
        <div className="rounded-lg border border-primary/25 bg-primary/5 p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-primary">
            <Gift className="size-3.5" /> {t("startup.benefits")}
            <Badge variant="muted" className="ml-auto text-[10px]">{t("startup.edition")}</Badge>
          </p>
          <ul className="mt-1.5 grid gap-1 text-[11px] leading-4 text-muted-foreground">
            <li>· {cfg.sponsor.benefits.fame}</li>
            <li>· {cfg.sponsor.benefits.profit}</li>
            <li>· {cfg.sponsor.benefits.choose_one}</li>
          </ul>
        </div>

        <p className="text-[10.5px] leading-4 text-muted-foreground">{cfg.legal.summary}</p>

        <AdSlot slotId="startup" />

        <LicenseBox />

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" size="sm" className="text-xs" onClick={() => close(true)}>
            <X className="size-3.5" /> {t("startup.noMore")}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={openAbout}>{t("startup.about")}</Button>
            <Button size="sm" onClick={() => close(false)}>{t("startup.start")}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 只取需要的字段，避免把整个 RunnerCtx 传进弹窗；setTab 由 App 注入。 */
function useCommercialRunner() {
  // setTab 通过自定义事件解耦：App 监听后切到 about 页
  const runner = useRunner();
  const setTab = (_tab: string) => {
    window.dispatchEvent(new CustomEvent("kuake-studio:set-tab", { detail: _tab }));
  };
  return { booted: runner.booted, commercial: runner.commercial, setTab };
}
