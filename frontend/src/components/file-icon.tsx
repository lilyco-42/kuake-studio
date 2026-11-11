import {
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  File as FileIcon,
  Folder,
} from "lucide-react";

import { cn } from "@/lib/utils";

/** 按扩展名给文件挑图标 —— 列表一眼扫下来能区分类型 */
export function fileIcon(name: string, dir: boolean, className?: string) {
  if (dir) return <Folder className={cn("size-4 text-primary", className)} />;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const cls = cn("size-4 text-muted-foreground", className);
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic"].includes(ext))
    return <FileImage className={cls} />;
  if (["mp4", "mkv", "mov", "avi", "webm", "flv", "ts"].includes(ext))
    return <FileVideo className={cls} />;
  if (["mp3", "flac", "wav", "aac", "m4a", "ogg", "opus"].includes(ext))
    return <FileAudio className={cls} />;
  if (["zip", "rar", "7z", "tar", "gz", "xz", "zst", "iso"].includes(ext))
    return <FileArchive className={cls} />;
  if (["rs", "ts", "tsx", "js", "jsx", "py", "go", "c", "h", "cpp", "json", "toml", "yaml", "yml", "sh", "html", "css"].includes(ext))
    return <FileCode className={cls} />;
  if (["xlsx", "xls", "csv", "numbers"].includes(ext)) return <FileSpreadsheet className={cls} />;
  if (["pdf", "doc", "docx", "md", "txt", "epub", "pptx", "ppt"].includes(ext))
    return <FileText className={cls} />;
  return <FileIcon className={cls} />;
}
