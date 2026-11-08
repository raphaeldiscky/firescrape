/* eslint-disable no-await-in-loop -- crawling, rate limits and per-run deduplication are sequential. */
import { basename, extname, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  discover,
  httpUrl,
  isPageUrl,
  mergeCaptured,
  type CapturedMedia,
  type MediaRef,
} from "../archive/discovery.js";
import { downloadMedia, retryDelay, type MediaResult } from "../archive/download.js";
import { TextReporter, type ArchiveReporter } from "../archive/reporter.js";
import { ensureApiReady } from "../archive/local-api.js";
import { createRun, pagePath, withoutExtension } from "../archive/paths.js";
import {
  saveManifest,
  savePage,
  type Manifest,
  type PageResult,
  type TranscriptEntry,
} from "../archive/storage.js";
import type { ScrapeRequest } from "../client.js";
import type { Config } from "../config.js";
import { createEnginePool, type Engine, type EngineName } from "../engines/index.js";
import type { ScrapeResponseData } from "../formats/types.js";
import { TranscribeQueue, type TranscribeRunner } from "../transcribe/queue.js";
import { assertWhisperReady } from "../transcribe/setup.js";
import type { TranscribeSettings } from "../transcribe/transcribe.js";
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
  /** Transcribe downloaded audio and video while the crawl continues. */
  transcribe?: ArchiveTranscribeOptions | undefined;
  /** Progress output; defaults to text lines on stderr. */
  reporter?: ArchiveReporter | undefined;
  signal?: AbortSignal;
}

export interface ArchiveTranscribeOptions {
  workers: number;
  settings: TranscribeSettings;
  /** Replaces whisper for tests. */
  runner?: TranscribeRunner;
}

const TRANSCRIBABLE = new Set<MediaResult["kind"]>(["audio", "video"]);

export function mediaHeaders(
  engine: Pick<Engine, "downloadHeaders">,
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
  if (opts.transcribe && !opts.transcribe.runner)
    assertWhisperReady(opts.transcribe.settings.whisper);
  const reporter = opts.reporter ?? new TextReporter();

  const pool = createEnginePool(opts.config, opts.cdpUrlOverride, { playMedia: opts.playMedia });
  try {
    const engine = pool.get(opts.engineName);
    if (opts.engineName === "api")
      await ensureApiReady(opts.config.apiUrl, opts.signal, (event) => reporter.setup(event));
    await engine.prepare?.();
    opts.signal?.throwIfAborted();
    const session = await ArchiveSession.open({
      sourceUrl,
      engineName: opts.engineName,
      out: opts.out,
      limit: opts.limit,
      maxMediaMb: opts.maxMediaMb,
      delayMs: opts.delayMs,
      playMedia: opts.playMedia ?? false,
      media: opts.media,
      transcribe: opts.transcribe,
      reporter,
      signal: opts.signal,
    });
    const { root, manifest } = session;
    const queue = [sourceUrl];
    const seen = new Set(queue);
    const finalUrls = new Set<string>();
    let origin = new URL(sourceUrl).origin;
    let nextAt = 0;
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
        let media: MediaResult[] = [];
        let backoff = 0;
        reporter.page(i + 1, opts.limit, url);
        try {
          const req = archiveRequest(url, opts.config, opts.profileName, opts.engineName);
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
            const page = pageContents(data, finalUrl);
            links = page.links;
            for (const link of links) {
              if (isPageUrl(link, origin) && !seen.has(link) && !finalUrls.has(link)) {
                seen.add(link);
                queue.push(link);
              }
            }
            const headers = mediaHeaders(engine, req.headers, url, finalUrl);
            media = await session.downloadPageMedia(result, page.media, headers);
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
          reporter.pageFailed(url, result.reason);
        }
        await session.record(result, data, links, media);
        nextAt = Date.now() + Math.max(opts.delayMs, backoff);
      }
      opts.signal?.throwIfAborted();
      await session.complete(
        queue.length > manifest.pages.length && manifest.pages.length >= opts.limit,
      );
    } catch (err) {
      manifest.status = opts.signal?.aborted ? "interrupted" : "partial";
      if (!opts.signal?.aborted) throw err;
    } finally {
      await session.close();
    }
    return { root, manifest };
  } finally {
    await pool.closeAll();
  }
}

/** The fixed formats an archive captures, whatever the profile asks for. */
export function archiveRequest(
  url: string,
  config: Config,
  profileName: string,
  engineName: EngineName,
): ScrapeRequest {
  const req = buildRequest(url, config, profileName, []);
  req.formats = [
    "markdown",
    "html",
    "rawHtml",
    "links",
    ...(engineName === "cdp" ? ["screenshot"] : []),
  ];
  req.onlyMainContent = false;
  req.actions = undefined;
  return req;
}

/** Links and media references found in a scraped page. */
export function pageContents(
  data: ScrapeResponseData,
  finalUrl: string,
): { links: string[]; media: MediaRef[] } {
  const discovered = discover(data.rawHtml ?? data.html ?? "", finalUrl);
  const media = mergeCaptured(
    discovered.media,
    Array.isArray(data["mediaRequests"]) ? (data["mediaRequests"] as CapturedMedia[]) : undefined,
  );
  const links = [
    ...new Set([
      ...discovered.links,
      ...(data.links ?? [])
        .map((link) => httpUrl(link, finalUrl))
        .filter((link): link is string => Boolean(link)),
    ]),
  ];
  return { links, media };
}

export interface ArchiveSessionOptions {
  sourceUrl: string;
  engineName: EngineName;
  out: string | undefined;
  /** Recorded in the manifest; the session itself does not count pages. */
  limit: number;
  maxMediaMb: number;
  delayMs: number;
  playMedia: boolean;
  media?: MediaKind[] | undefined;
  transcribe?: ArchiveTranscribeOptions | undefined;
  reporter: ArchiveReporter;
  signal?: AbortSignal | undefined;
}

/**
 * One archive run folder: saves pages, downloads each page's media into its
 * folder (once per run), and transcribes audio/video in the background. The
 * crawler feeds it pages it visits; MCP captures feed it tabs an agent opened.
 */
export class ArchiveSession {
  private readonly transcripts = new Map<string, TranscriptEntry>();
  private readonly assets = new Map<string, MediaResult>();
  private readonly transcriber: TranscribeQueue | undefined;
  private readonly wanted: MediaKind[];

  private constructor(
    readonly root: string,
    readonly manifest: Manifest,
    private readonly opts: ArchiveSessionOptions,
  ) {
    this.wanted = opts.media ?? [...MEDIA_KINDS];
    this.transcriber = opts.transcribe
      ? new TranscribeQueue({
          workers: opts.transcribe.workers,
          settings: opts.transcribe.settings,
          signal: opts.signal,
          onEvent: (event) => opts.reporter.transcription(event),
          ...(opts.transcribe.runner ? { runner: opts.transcribe.runner } : {}),
        })
      : undefined;
  }

  static async open(opts: ArchiveSessionOptions): Promise<ArchiveSession> {
    const root = await createRun(opts.sourceUrl, opts.out);
    opts.reporter.started(root);
    const manifest: Manifest = {
      sourceUrl: opts.sourceUrl,
      engine: opts.engineName,
      startedAt: new Date().toISOString(),
      status: "running",
      settings: {
        limit: opts.limit,
        maxMediaMb: opts.maxMediaMb,
        delayMs: opts.delayMs,
        playMedia: opts.playMedia,
        media: opts.media ?? [...MEDIA_KINDS],
        ...(opts.transcribe
          ? {
              transcribe: {
                workers: opts.transcribe.workers,
                language: opts.transcribe.settings.language,
                model: basename(opts.transcribe.settings.whisper.model),
              },
            }
          : {}),
      },
      limitReached: false,
      pages: [],
      assets: [],
      ...(opts.transcribe ? { transcripts: [] } : {}),
    };
    await saveManifest(root, manifest);
    return new ArchiveSession(root, manifest, opts);
  }

  private selected(kind: MediaResult["kind"]): boolean {
    return this.wanted.includes(kind === "embed" ? "video" : kind);
  }

  // Queue a fresh audio/video download; the crawl continues while workers transcribe.
  private transcribe(asset: MediaResult): void {
    const { transcriber, transcripts, root } = this;
    if (!transcriber || asset.status !== "downloaded" || !asset.path) return;
    if (!TRANSCRIBABLE.has(asset.kind) || transcripts.has(asset.path)) return;
    const entry: TranscriptEntry = { asset: asset.url, media: asset.path, status: "queued" };
    transcripts.set(asset.path, entry);
    void transcriber
      .add({
        input: join(root, asset.path),
        // Transcripts sit next to their media, inside the page folder.
        base: join(root, withoutExtension(asset.path)),
        label: basename(asset.path, extname(asset.path)),
      })
      .then((result) => {
        entry.status = result.status;
        entry.files = result.files?.map((file) => relative(root, file));
        entry.language = result.language;
        entry.durationSec = result.durationSec;
        entry.segments = result.segments;
        entry.reason = result.reason;
      });
  }

  /**
   * Download a page's media into its folder (media seen on an earlier page is
   * reused) and record its audio/video on `result.media`.
   */
  async downloadPageMedia(
    result: PageResult,
    refs: MediaRef[],
    headers: (url: string) => Promise<Record<string, string>>,
  ): Promise<MediaResult[]> {
    const { reporter } = this.opts;
    const media: MediaResult[] = [];
    reporter.pageCaptured(refs.length);
    try {
      for (const [index, ref] of refs.entries()) {
        let asset = this.assets.get(ref.url);
        const reused = Boolean(asset && !(asset.kind === "embed" && ref.kind !== "embed"));
        reporter.mediaStarted(index + 1, refs.length, ref.url, reused);
        if (!this.selected(ref.kind)) {
          asset = { ...ref, status: "skipped", reason: "Media type not selected" };
          this.assets.set(ref.url, asset);
        } else if (!asset || !reused) {
          asset = await downloadMedia(ref, {
            root: this.root,
            pageDir: result.path,
            maxBytes: this.opts.maxMediaMb * 1_000_000,
            headers,
            signal: this.opts.signal,
            onProgress: (progress) => reporter.mediaProgress(progress),
          });
          this.assets.set(ref.url, asset);
          this.transcribe(asset);
        }
        reporter.mediaFinished(asset, reused);
        media.push(asset);
      }
    } finally {
      reporter.mediaDone();
    }
    const playable = media
      .filter((a) => TRANSCRIBABLE.has(a.kind) && a.status === "downloaded" && a.path)
      .map((a) => a.path!);
    if (playable.length > 0) result.media = [...new Set(playable)];
    return media;
  }

  /** Save a page's files and add it to the manifest and index. */
  async record(
    result: PageResult,
    data: ScrapeResponseData,
    links: string[],
    media: MediaResult[],
  ): Promise<void> {
    await savePage(this.root, result, data, links, media);
    this.manifest.pages.push(result);
    this.sync();
    await saveManifest(this.root, this.manifest);
  }

  private sync(): void {
    this.manifest.assets = [...this.assets.values()];
    if (this.transcriber) this.manifest.transcripts = [...this.transcripts.values()];
  }

  /** Wait for transcripts, then mark the run completed or partial. */
  async complete(limitReached = false): Promise<void> {
    await this.transcriber?.drain();
    this.opts.signal?.throwIfAborted();
    this.manifest.limitReached = limitReached;
    this.manifest.status =
      this.manifest.pages.some((p) => p.status === "failed") ||
      [...this.assets.values()].some((a) => a.status === "failed") ||
      [...this.transcripts.values()].some((t) => t.status === "failed")
        ? "partial"
        : "completed";
  }

  /** Always call last: settles transcription and writes the final manifest. */
  async close(): Promise<void> {
    // On errors or Ctrl+C the queue settles quickly: aborted jobs end as "Interrupted".
    await this.transcriber?.drain();
    this.manifest.finishedAt = new Date().toISOString();
    this.sync();
    await saveManifest(this.root, this.manifest);
    this.opts.reporter.finished(this.manifest.status, join(this.root, "index.md"));
  }
}
