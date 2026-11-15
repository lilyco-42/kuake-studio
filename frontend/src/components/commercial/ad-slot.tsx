import { Badge } from "@/components/ui/badge";
import { useRunner } from "@/lib/store";
import { visibleAdSlots } from "@/lib/commercial-core";
import { cn } from "@/lib/utils";

/**
 * 云端可配置广告位占位：只有后端开启且未赞助时才渲染。
 * 刻意只画占位框，不加载任何远端脚本 / iframe —— 远端配置能改文字与开关，
 * 改不了收款码、联系方式，也不能注入 HTML（见 commercial.rs::merge_cloud_config）。
 */
export function AdSlot({ slotId, className }: { slotId: string; className?: string }) {
  const { commercial } = useRunner();
  const slots = visibleAdSlots(commercial, slotId);
  if (slots.length === 0) return null;
  return (
    <div
      data-slot={"ad-" + slotId}
      className={cn(
        "flex min-h-14 items-center justify-center gap-2 rounded-lg border border-dashed border-border/70 bg-muted/30 px-3 py-2 text-center text-[11px] text-muted-foreground",
        className,
      )}
    >
      <Badge variant="muted" className="text-[10px]">广告位</Badge>
      <span>{slots[0].label}</span>
    </div>
  );
}
