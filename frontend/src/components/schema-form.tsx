import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ArgSchema } from "@/lib/types";

export type FormValues = Record<string, unknown>;

/**
 * 枚举值的展示文案。后端把「分享有效期」做成真枚举后，值是 "0"/"1"/"7"/"30"，
 * 直接显示数字对用户没意义，这里补一层人类可读的标签（值本身照旧原样回传）。
 */
const ENUM_LABELS: Record<string, string> = {
  "0": "永久有效",
  "1": "1 天",
  "7": "7 天",
  "30": "30 天",
};

function enumLabel(v: string): string {
  return ENUM_LABELS[v] ?? v;
}

/** 从 schema 的 default 生成初值（前端不硬编码任何命令参数） */
export function initialValues(args: ArgSchema[]): FormValues {
  const out: FormValues = {};
  for (const a of args) {
    if (a.default !== null && a.default !== undefined) out[a.name] = a.default;
    else if (a.kind.type === "flag") out[a.name] = false;
  }
  return out;
}

interface Props {
  args: ArgSchema[];
  values: FormValues;
  onChange: (next: FormValues) => void;
  /** 只显示这些参数名（按需精简表单） */
  only?: string[];
  /** 隐藏这些参数名（如由上下文自动填充的 path） */
  hide?: string[];
  className?: string;
  disabled?: boolean;
}

/**
 * 表单渲染器：ArgKind → 控件
 * flag→Switch，text→Input，number→带 min/max 的 Input，enum→Select，
 * path→Input（附提示），list→每行一项的 Textarea。
 *
 * 这套映射就是「schema 驱动 UI」的核心：后端加参数，前端自动出控件。
 */
export function SchemaForm({ args, values, onChange, only, hide, className, disabled }: Props) {
  const visible = args.filter(
    (a) => (!only || only.includes(a.name)) && (!hide || !hide.includes(a.name)),
  );

  const set = (name: string, value: unknown) => onChange({ ...values, [name]: value });

  if (visible.length === 0) return null;

  return (
    <div className={cn("grid gap-4", className)}>
      {visible.map((arg) => {
        const id = `field-${arg.name}`;
        const val = values[arg.name];
        return (
          <div key={arg.name} className="grid gap-1.5">
            {arg.kind.type !== "flag" && (
              <Label htmlFor={id} className="gap-1">
                <span>{arg.about || arg.name}</span>
                <code className="rounded bg-muted px-1 py-0.5 text-[10px] font-normal text-muted-foreground">
                  {arg.name}
                </code>
                {arg.required && <span className="text-destructive">*</span>}
              </Label>
            )}

            {arg.kind.type === "flag" && (
              <label
                htmlFor={id}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <span className="text-sm">{arg.about || arg.name}</span>
                <Switch
                  id={id}
                  checked={Boolean(val)}
                  onCheckedChange={(c) => set(arg.name, c)}
                  disabled={disabled}
                />
              </label>
            )}

            {arg.kind.type === "text" && (
              <Input
                id={id}
                value={String(val ?? "")}
                onChange={(e) => set(arg.name, e.target.value)}
                placeholder={arg.about}
                disabled={disabled}
              />
            )}

            {arg.kind.type === "path" && (
              <Input
                id={id}
                value={String(val ?? "")}
                onChange={(e) => set(arg.name, e.target.value)}
                placeholder={arg.kind.must_exist ? "本机文件绝对路径（须存在）" : "路径"}
                className="font-mono text-xs"
                disabled={disabled}
              />
            )}

            {arg.kind.type === "number" && (
              <Input
                id={id}
                type="number"
                min={arg.kind.min ?? undefined}
                max={arg.kind.max ?? undefined}
                value={val === undefined || val === null ? "" : String(val)}
                onChange={(e) =>
                  set(arg.name, e.target.value === "" ? "" : Number(e.target.value))
                }
                disabled={disabled}
              />
            )}

            {arg.kind.type === "enum" && (
              <Select
                value={String(val ?? arg.kind.values[0] ?? "")}
                onValueChange={(v) => set(arg.name, v)}
                disabled={disabled}
              >
                <SelectTrigger id={id} className="w-full">
                  <SelectValue placeholder="请选择" />
                </SelectTrigger>
                <SelectContent>
                  {arg.kind.values.map((v) => (
                    <SelectItem key={v} value={v}>
                      {enumLabel(v)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {arg.kind.type === "list" && (
              <Textarea
                id={id}
                value={Array.isArray(val) ? (val as string[]).join("\n") : String(val ?? "")}
                onChange={(e) =>
                  set(
                    arg.name,
                    e.target.value
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  )
                }
                placeholder="每行一个"
                className="min-h-20 font-mono text-xs"
                disabled={disabled}
              />
            )}

            {arg.kind.type === "number" && (arg.kind.min !== null || arg.kind.max !== null) && (
              <p className="text-[11px] text-muted-foreground">
                范围 {arg.kind.min ?? "−∞"} ~ {arg.kind.max ?? "∞"}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
