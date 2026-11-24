import * as React from "react";
import { toast } from "sonner";
import { Check, Copy, ExternalLink, Link2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";

export function ShareResultDialog({
  open,
  onOpenChange,
  links,
  title,
  onViewShares,
  onCreateAnother,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  links: string[];
  title?: string;
  onViewShares?: () => void;
  onCreateAnother?: () => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = React.useState<string | null>(null);

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      toast.success(t("shares.copied"));
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      toast.error(t("common.clipboardFail"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 break-all">
            <Link2 className="size-4 shrink-0" />
            {title || t("shareResult.title")}
          </DialogTitle>
          <DialogDescription>{t("shareResult.description")}</DialogDescription>
        </DialogHeader>

        {links.length ? (
          <ul className="grid max-h-64 gap-2 overflow-auto">
            {links.map((url) => (
              <li
                key={url}
                className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2"
              >
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-primary hover:underline"
                  title={url}
                >
                  <span className="truncate font-mono">{url}</span>
                  <ExternalLink className="size-3.5 shrink-0" />
                </a>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 gap-1 px-2 text-[11px]"
                  onClick={() => void copy(url)}
                  title={t("shares.copyLink")}
                >
                  {copied === url ? <Check className="size-3" /> : <Copy className="size-3" />}
                  {t("common.copy")}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="rounded-lg border border-dashed bg-muted/20 p-4 text-center text-xs text-muted-foreground">
            {t("shareResult.none")}
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2">
          {onCreateAnother ? (
            <Button variant="ghost" size="sm" onClick={onCreateAnother}>
              {t("shareResult.createAnother")}
            </Button>
          ) : null}
          {onViewShares ? (
            <Button variant="outline" size="sm" onClick={onViewShares}>
              {t("shareResult.viewShares")}
            </Button>
          ) : null}
          <Button size="sm" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
