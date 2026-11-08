/* eslint-disable no-await-in-loop -- crawling, rate limits and per-run deduplication are sequential. */
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  discover,
  httpUrl,
  isPageUrl,
  mergeCaptured,
  type CapturedMedia,
} from "../archive/discovery.js";
import { downloadMedia, retryDelay, type MediaResult } from "../archive/download.js";
import { MediaProgress } from "../archive/media-progress.js";
import { ensureApiReady } from "../archive/local-api.js";
import { createRun, pagePath } from "../archive/paths.js";
import { saveManifest, savePage, type Manifest, type PageResult } from "../archive/storage.js";
import type { Config } from "../config.js";
import { createEnginePool, type Engine, type EngineName } from "../engines/index.js";
import type { ScrapeResponseData } from "../formats/types.js";
import { buildRequest } from "./scrape.js";

export const MEDIA_KINDS = ["image", "video", "audio"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Parse a comma-separated `--media` value such as "audio,video". */
export function parseMediaKinds(value: string): MediaKind[] {
  const kinds = value
    .split(",")
    .map((kind) => kind.trim().toLowerCase())
    .filter(Boolean);
  const invalid = kinds.filter((kind) => !(MEDIA_KINDS as readonly string[]).includes(kind));
  if (invalid.length > 0 || kinds.length === 0)
    throw new Error(`--media expects a list of ${MEDIA_KINDS.join(", ")}; got "${value}"`);
  return [...new Set(kinds as MediaKind[])];
}

export interface ArchiveOptions {
  url: string;
  config: Config;
  profileName: string;
  engineName: EngineName;
  cdpUrlOverride: string | undefined;
  out: string | undefined;
  limit: number;
  maxMediaMb: number;
  delayMs: number;
  /** CDP only: click play controls so on-demand audio/video is requested. */
  playMedia?: boolean;
  /** Media kinds to download; defaults to all. Embedded players count as video. */
  media?: MediaKind[] | undefined;
  signal?: AbortSignal;
}

export function mediaHeaders(
  engine: Engine,
  configured: Record<string, string> | undefined,
  sourceUrl: string,
  pageUrl: string,
): (url: string) => Promise<Record<string, string>> {
  return async (url) => {
    const target = new URL(url);
    const page = new URL(pageUrl);
    const headers = new Headers(await engine.downloadHeaders?.(url));
    if (target.origin === new URL(sourceUrl).origin) {
      for (const [key, value] of Object.entries(configured ?? {})) {
        if (!["host", "content-length", "connection"].includes(key.toLowerCase()))
          headers.set(key, value);
      }
    }
    if (!(page.protocol === "https:" && target.protocol === "http:")) {
      headers.set("Referer", target.origin === page.origin ? page.href : `${page.origin}/`);
    }
    return Object.fromEntries(headers);
  };
}

export async function runArchive(
  opts: ArchiveOptions,
): Promise<{ root: string; manifest: Manifest }> {
  const sourceUrl = httpUrl(opts.url);
  if (!sourceUrl) throw new Error("Provide a valid HTTP(S) URL without embedded credentials");
  if (
    !Number.isSafeInteger(opts.limit) ||
    opts.limit < 1 ||
    !Number.isFinite(opts.maxMediaMb) ||
    opts.maxMediaMb <= 0 ||
    opts.maxMediaMb * 1_000_000 > Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(opts.delayMs) ||
    opts.delayMs < 0
  )
    throw new Error("Invalid archive limits");
  if (opts.out === "-") throw new Error("Archive output must be a directory, not stdout");
  if (opts.playMedia && opts.engineName !== "cdp")
    throw new Error("--play-media requires the CDP engine");

  const wanted = opts.media ?? [...MEDIA_KINDS];
  const selected = (kind: MediaResult["kind"]): boolean =>
    wanted.includes(kind === "embed" ? "video" : kind);

  const pool = createEnginePool(opts.config, opts.cdpUrlOverride, { playMedia: opts.playMedia });
  try {
    const engine = pool.get(opts.engineName);
    if (opts.engineName === "api") await ensureApiReady(opts.config.apiUrl, opts.signal);
    await engine.prepare?.();
    opts.signal?.throwIfAborted();
    const root = await createRun(sourceUrl, opts.out);
    process.stderr.write(`Archive directory: ${root}\n`);
    const manifest: Manifest = {
      sourceUrl,
      engine: opts.engineName,
      startedAt: new Date().toISOString(),
      status: "running",
      settings: {
        limit: opts.limit,
        maxMediaMb: opts.maxMediaMb,
        delayMs: opts.delayMs,
        playMedia: opts.playMedia ?? false,
        media: wanted,
      },
      limitReached: false,
      pages: [],
      assets: [],
    };
    const queue = [sourceUrl];
    const seen = new Set(queue);
    const finalUrls = new Set<string>();
    const assets = new Map<string, MediaResult>();
    let origin = new URL(sourceUrl).origin;
    let nextAt = 0;
    await saveManifest(root, manifest);
    try {
      // Visit links breadth-first until the queue is exhausted or --limit attempts
      // are reached (default 100). Failures/redirects count too; this is not a depth limit.
      for (let i = 0; i < queue.length && i < opts.limit; i++) {
        opts.signal?.throwIfAborted();
        await sleep(Math.max(0, nextAt - Date.now()), undefined, { signal: opts.signal });
        const url = queue[i]!;
        const result: PageResult = { url, path: pagePath(url), status: "failed" };
        let data: ScrapeResponseData = {};
        let links: string[] = [];
        const media: MediaResult[] = [];
        let backoff = 0;
        process.stderr.write(`[${i + 1}/${opts.limit}] ${url}\n`);
        try {
          const req = buildRequest(url, opts.config, opts.profileName, []);
          req.formats = [
            "markdown",
            "html",
            "rawHtml",
            "links",
            ...(opts.engineName === "cdp" ? ["screenshot"] : []),
          ];
          req.onlyMainContent = false;
          req.actions = undefined;
          data = await engine.scrape(req, opts.signal);
          const finalUrl = httpUrl(String(data.metadata?.["url"] ?? url)) ?? url;
          result.finalUrl = finalUrl;
          result.title = String(data.metadata?.["title"] ?? finalUrl);
          const status = Number(data.metadata?.["statusCode"] ?? 200);
          if (status === 429) backoff = retryDelay(String(data.metadata?.["retryAfter"] ?? ""));
          if (status >= 400) throw new Error(`Page returned HTTP ${status}`);
          // A seed redirect (e.g. apex to www) establishes the crawl's origin.
          if (i === 0) origin = new URL(finalUrl).origin;
          if (new URL(finalUrl).origin !== origin || !isPageUrl(finalUrl, origin)) {
            result.status = "skipped";
            result.reason = "Redirect outside crawl scope";
          } else if (finalUrls.has(finalUrl)) {
            result.status = "skipped";
            result.reason = "Duplicate redirect target";
          } else {
            finalUrls.add(finalUrl);
            const discovered = discover(data.rawHtml ?? data.html ?? "", finalUrl);
            const pageMedia = mergeCaptured(
              discovered.media,
              Array.isArray(data["mediaRequests"])
                ? (data["mediaRequests"] as CapturedMedia[])
                : undefined,
            );
            links = [
              ...new Set([
                ...discovered.links,
                ...(data.links ?? [])
                  .map((link) => httpUrl(link, finalUrl))
                  .filter((link): link is string => Boolean(link)),
              ]),
            ];
            for (const link of links) {
              if (isPageUrl(link, origin) && !seen.has(link) && !finalUrls.has(link)) {
                seen.add(link);
                queue.push(link);
              }
            }
            const headers = mediaHeaders(engine, req.headers, url, finalUrl);
            process.stderr.write(`  captured page; ${pageMedia.length} media items to process\n`);
            const progress = new MediaProgress();
            try {
              for (const [index, ref] of pageMedia.entries()) {
                let asset = assets.get(ref.url);
                const reused = Boolean(asset && !(asset.kind === "embed" && ref.kind !== "embed"));
                progress.start(index + 1, pageMedia.length, ref.url, reused);
                if (!selected(ref.kind)) {
                  asset = { ...ref, status: "skipped", reason: "Media type not selected" };
                  assets.set(ref.url, asset);
                } else if (!asset || !reused) {
                  asset = await downloadMedia(ref, {
                    root,
                    maxBytes: opts.maxMediaMb * 1_000_000,
                    headers,
                    signal: opts.signal,
                    onProgress: progress.update,
                  });
                  assets.set(ref.url, asset);
                }
                progress.finish(asset, reused);
                media.push(asset);
              }
            } finally {
              progress.stop();
            }
            result.status = "saved";
          }
          if (typeof data["warning"] === "string") result.warning = data["warning"];
          else if (opts.engineName === "api")
            result.warning =
              "Screenshot not requested: self-hosted API engine support is unavailable";
        } catch (err) {
          result.status = "failed";
          result.reason = opts.signal?.aborted
            ? "Interrupted"
            : err instanceof Error
              ? err.message
              : String(err);
          process.stderr.write(`FAIL ${url}: ${result.reason}\n`);
        }
        await savePage(root, result, data, links, media);
        manifest.pages.push(result);
        manifest.assets = [...assets.values()];
        await saveManifest(root, manifest);
        nextAt = Date.now() + Math.max(opts.delayMs, backoff);
      }
      opts.signal?.throwIfAborted();
      manifest.limitReached =
        queue.length > manifest.pages.length && manifest.pages.length >= opts.limit;
      manifest.status =
        manifest.pages.some((p) => p.status === "failed") ||
        manifest.assets.some((a) => a.status === "failed")
          ? "partial"
          : "completed";
    } catch (err) {
      manifest.status = opts.signal?.aborted ? "interrupted" : "partial";
      if (!opts.signal?.aborted) throw err;
    } finally {
      manifest.finishedAt = new Date().toISOString();
      manifest.assets = [...assets.values()];
      await saveManifest(root, manifest);
      process.stderr.write(`Archive ${manifest.status}: ${join(root, "index.md")}\n`);
    }
    return { root, manifest };
  } finally {
    await pool.closeAll();
  }
}
