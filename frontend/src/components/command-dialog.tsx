import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SchemaForm, initialValues, type FormValues } from "@/components/schema-form";
import { useRunner } from "@/lib/store";
import type { ArgSchema } from "@/lib/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** 命令名（对应后端 registry 里的 key） */
  cmd: string;
  /** 命令的参数 schema */
  args: ArgSchema[];
  /** 预填值（路径之类由当前上下文带进来） */
  preset?: FormValues;
  /** 这些参数不出现在表单里（值由 preset 提供） */
  hide?: string[];
  submitLabel?: string;
  destructive?: boolean;
  onSuccess?: (data: unknown) => void;
}

/**
 * 通用命令对话框：完全由 schema 驱动。
 * 想加一条新命令的 UI 入口时，不需要写新组件 —— 传 cmd + schema 即可。
 */
export function CommandDialog({
  open,
  onOpenChange,
  title,
  description,
  cmd,
  args,
  preset,
  hide,
  submitLabel = "执行",
  destructive,
  onSuccess,
}: Props) {
  const { run } = useRunner();
  const [values, setValues] = React.useState<FormValues>({});
  const [pending, setPending] = React.useState(false);

  // 每次打开都重置成「schema 默认值 + preset」，避免上一次的残留
  React.useEffect(() => {
    if (open) {
      setValues({ ...initialValues(args), ...(preset ?? {}) });
      setPending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cmd]);

  const submit = async () => {
    setPending(true);
    try {
      // 只发 schema 里声明过的键：preset 里多余的（如 UI 辅助字段）不能混进去
      const allowed = new Set(args.map((a) => a.name));
      const payload: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(values)) {
        if (!allowed.has(k)) continue;
        if (v === "" || v === undefined) continue;
        payload[k] = v;
      }
      const data = await run(cmd, payload, title);
      onSuccess?.(data);
      onOpenChange(false);
      toast.success(`${title}成功`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <SchemaForm
          args={args}
          values={values}
          onChange={setValues}
          hide={hide}
          disabled={pending}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            取消
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={submit}
            disabled={pending}
          >
            {pending ? "执行中…" : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
