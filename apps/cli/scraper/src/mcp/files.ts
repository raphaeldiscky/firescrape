import { realpath, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

/** Text files an agent may read back from an archive. */
const READABLE = new Set([".md", ".txt", ".json", ".srt", ".vtt", ".html"]);

/**
 * Resolve `path` (absolute, or relative to `dataDir`) and require that it stays
 * inside `dataDir` after following symlinks. Throws on anything outside.
 */
export async function insideDataDir(dataDir: string, path: string): Promise<string> {
  const root = await realpath(dataDir);
  let target: string;
  try {
    target = await realpath(isAbsolute(path) ? path : join(root, path));
  } catch {
    throw new Error(`Not found: ${path}`);
  }
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`Only files under ${root} can be read: ${path}`);
  return target;
}

export interface FileSlice {
  path: string;
  text: string;
  offset: number;
  totalChars: number;
  /** Where the next slice starts, when there is more. */
  nextOffset?: number | undefined;
}

/**
 * Read a text file from the archive. A run or page directory reads its
 * `index.md` or `content.md`. Long files come back in `maxChars` slices.
 */
export async function readArchiveFile(
  dataDir: string,
  path: string,
  offset = 0,
  maxChars = 20_000,
): Promise<FileSlice> {
  let target = await insideDataDir(dataDir, path);
  if ((await stat(target)).isDirectory()) {
    const index = join(target, "index.md");
    const content = join(target, "content.md");
    const pick = await stat(index).then(
      () => index,
      () => content,
    );
    target = await insideDataDir(dataDir, pick);
  }
  if (!READABLE.has(extname(target).toLowerCase()))
    throw new Error(`Not a text file (${[...READABLE].join(", ")}): ${path}`);
  const full = await readFile(target, "utf8");
  const start = Math.max(0, Math.min(offset, full.length));
  const end = Math.min(full.length, start + maxChars);
  return {
    path: resolve(target),
    text: full.slice(start, end),
    offset: start,
    totalChars: full.length,
    nextOffset: end < full.length ? end : undefined,
  };
}
