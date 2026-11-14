/** 从拖拽事件里收集出待上传文件，支持文件夹递归。纯模块，便于 CDP / 单测直接调用。 */
export interface DroppedFile {
  /** 相对目标目录的路径，保留拖入时的文件夹层级，例如 "相册/2026/a.jpg" */
  relPath: string;
  /** 原始文件名，只用于后端暂存文件名 */
  name: string;
  file: File;
}

/** 单个路径段清洗：不允许分隔符、控制字符、点段，避免相对路径穿越或后端建出诡异目录名 */
function safeSegment(name: string): string {
  const cleaned = name
    .replace(/[\\/]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "_";
  return cleaned;
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

async function walkDirectory(entry: FileSystemDirectoryEntry, prefix: string): Promise<DroppedFile[]> {
  const reader = entry.createReader();
  const out: DroppedFile[] = [];
  // Chrome 的 readEntries 每批最多返回 100 条，必须一直读到空批次才算遍历完
  for (;;) {
    const batch = await readEntries(reader);
    if (batch.length === 0) break;
    for (const child of batch) {
      const nested = await walkEntry(child, prefix);
      for (const item of nested) out.push(item);
    }
  }
  return out;
}

async function walkEntry(entry: FileSystemEntry, parent: string): Promise<DroppedFile[]> {
  const segment = safeSegment(entry.name);
  const prefix = parent === "" ? segment : parent + "/" + segment;
  if (entry.isDirectory) return walkDirectory(entry as FileSystemDirectoryEntry, prefix);
  if (entry.isFile) {
    const f = await fileOf(entry as FileSystemFileEntry);
    return [{ relPath: prefix, name: f.name || segment, file: f }];
  }
  return [];
}

/** 只有拖的是文件/文件夹才接管，拖表格里的一段文字不弹遮罩 */
export function hasDroppedFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.types || []).includes("Files");
}

/**
 * 优先用 webkitGetAsEntry 递归展开文件夹（保住层级）；
 * 合成事件 / 不支持 entry 的浏览器回退到 dataTransfer.files。
 */
export async function collectDroppedFiles(dt: DataTransfer | null): Promise<DroppedFile[]> {
  if (!dt) return [];
  const fileItems = Array.from(dt.items || []).filter((it) => it.kind === "file");
  const entries = fileItems.map((it) =>
    typeof it.webkitGetAsEntry === "function" ? it.webkitGetAsEntry() : null,
  );
  if (entries.some((e) => e !== null)) {
    const out: DroppedFile[] = [];
    for (const entry of entries) {
      if (!entry) continue;
      const nested = await walkEntry(entry, "");
      for (const item of nested) out.push(item);
    }
    return out;
  }
  return Array.from(dt.files || []).map((f) => ({
    relPath: safeSegment(f.name),
    name: f.name,
    file: f,
  }));
}

/** 后端把「目标已存在」包成 SKIPPED，再转成一个中文错误；这里识别为跳过而不是失败 */
export function isSkippedError(e: unknown): boolean {
  return e instanceof Error && e.message.includes("文件已存在，跳过上传");
}

export function isAbortError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === "AbortError") return true;
  return e instanceof Error && (e.name === "AbortError" || e.message.toLowerCase().includes("aborted"));
}
