import * as React from "react";
import { CheckCircle2, KeyRound, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { activateLicense, deactivateLicense, looksLikeLicenseToken } from "@/lib/commercial";
import { useI18n } from "@/lib/i18n";
import { useRunner } from "@/lib/store";

/** 赞助授权码输入：ed25519 离线验签，不联网、不上传任何个人信息。 */
export function LicenseBox() {
  const { commercial, setCommercial } = useRunner();
  const { t } = useI18n();
  const [token, setToken] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const sponsored = commercial.sponsored;
  const claims = commercial.status.claims;

  const onActivate = async () => {
    const raw = token.trim();
    if (!looksLikeLicenseToken(raw)) {
      toast.error(t("license.badFormat"));
      return;
    }
    setBusy(true);
    try {
      setCommercial(await activateLicense(raw));
      setToken("");
      toast.success(t("license.success"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDeactivate = async () => {
    setBusy(true);
    try {
      setCommercial(await deactivateLicense());
      toast.message(t("license.removed"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (sponsored) {
    return (
      <div className="rounded-lg border border-success/40 bg-success/5 p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-success">
          <CheckCircle2 className="size-4" />
          {t("license.activated")}
          <Badge variant="success" className="ml-auto text-[10px]">{claims?.tier === "profit" ? t("license.tierProfit") : t("license.tierFame")}</Badge>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t("license.sponsor")}：{claims?.sub ?? "—"} · {t("license.activeHint")}
        </p>
        <Button variant="ghost" size="sm" className="mt-2 text-xs" disabled={busy} onClick={onDeactivate}>
          <XCircle className="size-3.5" /> {t("license.remove")}
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <Label htmlFor="license-token" className="text-xs">{t("license.title")}</Label>
      <div className="flex gap-2">
        <Input
          id="license-token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={t("license.placeholder")}
          className="h-8 font-mono text-xs"
          onKeyDown={(e) => { if (e.key === "Enter") void onActivate(); }}
        />
        <Button size="sm" disabled={busy || !token.trim()} onClick={() => void onActivate()}>
          <KeyRound className="size-3.5" /> {t("license.activate")}
        </Button>
      </div>
      <p className="text-[11px] leading-4 text-muted-foreground">
        {t("license.hint")}
      </p>
    </div>
  );
}
