/** 与 Rust 侧 lilyco-core::schema 一一对应 */
export type ArgKind =
  | { type: "flag" }
  | { type: "text" }
  | { type: "number"; min: number | null; max: number | null }
  | { type: "enum"; values: string[] }
  | { type: "path"; must_exist: boolean }
  | { type: "list"; item: ArgKind };

export type SafetyTier = "ReadOnly" | "Confirm" | "Token" | "NeverAuto";

export interface ArgSchema {
  name: string;
  about: string;
  kind: ArgKind;
  required: boolean;
  default: unknown;
}

export interface CommandSchema {
  name: string;
  about: string;
  args: ArgSchema[];
  subcommands: CommandSchema[];
  safety: SafetyTier;
}

/** kuake 返回的信封 */
export interface KuakeEnvelope<T = unknown> {
  success: boolean;
  code: string;
  message: string;
  data: T;
}

export interface KuakeFile {
  fid: string;
  file_name: string;
  path: string;
  size: number;
  ctime: number;
  mtime: number;
  dir: boolean;
  download_url: string;
  created_at: number;
  updated_at: number;
}

/** search 命令的命中项：与 list 完全同形，额外带高亮与「路径不可用」标记 */
export interface SearchHit extends KuakeFile {
  hl_file_name?: string;
  path_partial?: boolean;
}

export interface SearchData {
  list: SearchHit[];
  q: string;
  page: number;
  size: number;
  has_more: boolean;
}

export interface KuakeUser {
  avatarUri?: string;
  member_type?: string;
  nickname?: string;
  total_capacity?: number;
  use_capacity?: number;
  super_vip_exp_at?: number;
}

export interface KuakeShare {
  share_id?: string;
  pwd_id?: string;
  title?: string;
  share_url?: string;
  share_type?: number;
  status?: number;
  file_num?: number;
  all_file_num?: number;
  first_fid?: string;
  created_at?: number;
  expired_at?: number;
  expired_left?: number;
  expired_days?: number;
  click_pv?: number;
  save_pv?: number;
  download_pv?: number;
  first_file?: { file_name?: string; dir?: boolean; size?: number };
}

/** SSE 事件（lilyco-core::progress） */
export type RunEvent =
  | { type: "started"; total: number | null; message: string | null }
  | { type: "tick"; current: number; total: number | null; message: string | null; percent: number | null }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string }
  | { type: "telemetry"; key: string; value: unknown }
  | { type: "done"; result: unknown; duration_ms: number }
  | { type: "error"; code: number; message: string; kind: string | null };
