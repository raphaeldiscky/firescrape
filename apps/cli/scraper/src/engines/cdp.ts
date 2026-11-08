import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright";
import TurndownService from "turndown";
import type { CapturedMedia } from "../archive/discovery.js";
import type { ScrapeRequest } from "../client.js";
import type { ScrapeResponseData } from "../formats/types.js";
import type { Engine } from "./types.js";

const DEFAULT_TIMEOUT = 30_000;

const STRIP_SELECTORS: readonly string[] = [
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "head",
  "meta",
  "link",
  "object",
  "embed",
  "video",
  "audio",
  "canvas",
  "template",
  "nav",
  "footer",
  "header",
  "aside",
  "[role='banner']",
  "[role='navigation']",
  "[role='complementary']",
  "[role='contentinfo']",
  "[class*='ad-']",
  "[class*='-ad']",
  "[id*='ad-']",
  "[id*='-ad']",
  "[class*='modal']",
  "[class*='popup']",
  "[class*='overlay']",
  "[class*='cookie']",
  "[class*='consent']",
  "[class*='gdpr']",
  "[class*='banner']",
  "[class*='subscribe']",
  "[class*='newsletter']",
  "[class*='breadcrumb']",
  "[class*='social']",
  "[class*='share']",
  "[class*='related']",
  "[class*='widget']",
];

// Accessible names of controls that start page audio/video ("Play", "Listen", ...).
const PLAY_CONTROL = /\b(?:play|listen|start audio)\b/i;
const MAX_PLAY_CLICKS = 3;

export interface CdpEngineOptions {
  /** Click visible play controls so media that loads only on demand is requested. */
  playMedia?: boolean | undefined;
  /** How long to wait for media after clicking play. */
  mediaWaitMs?: number | undefined;
  /** Extra time after the first media response for related requests. */
  mediaSettleMs?: number | undefined;
}

const MEDIA_EXTENSIONS: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  weba: "audio/webm",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  ogv: "video/ogg",
};

/** A media type guessed from the URL's file extension, for requests seen without headers. */
export function mediaTypeFromUrl(url: string): string | undefined {
  try {
    const ext = /\.([a-z0-9]+)$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
    return ext ? MEDIA_EXTENSIONS[ext] : undefined;
  } catch {
    return undefined;
  }
}

function mediaResponse(response: Response): CapturedMedia | undefined {
  const url = response.url();
  if (!/^https?:/i.test(url)) return undefined;
  const contentType = response.headers()["content-type"] ?? "";
  const media =
    response.request().resourceType() === "media" ||
    /^(?:audio|video)\//i.test(contentType) ||
    /(?:mpegurl|dash\+xml)/i.test(contentType);
  if (!media) return undefined;
  return contentType ? { url, contentType } : { url };
}

export class CdpEngine implements Engine {
  readonly name = "cdp";
  private browser: Browser | null = null;
  private userAgent: string | undefined;
  private readonly turndown = (() => {
    const td = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    });
    td.remove(["script", "style", "noscript", "iframe", "head", "meta", "link"] as Parameters<
      typeof td.remove
    >[0]);
    td.addRule("svg", { filter: "svg" as never, replacement: () => "" });
    return td;
  })();

  constructor(
    private readonly cdpUrl: string,
    private readonly options: CdpEngineOptions = {},
  ) {}

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    try {
      this.browser = await chromium.connectOverCDP(this.cdpUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `CDP connect failed at ${this.cdpUrl}: ${msg}\n` +
          `Launch Chrome first:\n` +
          `  google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.scraper-chrome" &\n` +
          `Then verify: curl -s ${this.cdpUrl}/json/version`,
      );
    }
    return this.browser;
  }

  private async getContext(browser: Browser): Promise<BrowserContext> {
    const existing = browser.contexts();
    if (existing.length > 0 && existing[0]) return existing[0];
    return browser.newContext();
  }

  /**
   * Run Readability over the cleaned HTML in Node-side JSDOM. Returns
   * extracted article HTML or `null` if the page isn't article-shaped.
   */
  private extractMainContent(html: string, url: string): string | null {
    try {
      const dom = new JSDOM(html, { url });
      const article = new Readability(dom.window.document).parse();
      return article?.content ?? null;
    } catch {
      return null;
    }
  }

  async prepare(): Promise<void> {
    await this.ensureBrowser();
  }

  async downloadHeaders(url: string): Promise<Record<string, string>> {
    const context = await this.getContext(await this.ensureBrowser());
    const cookies = await context.cookies(url);
    const headers: Record<string, string> = {};
    if (cookies.length > 0)
      headers["Cookie"] = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    if (this.userAgent) headers["User-Agent"] = this.userAgent;
    return headers;
  }

  async scrape(req: ScrapeRequest, signal?: AbortSignal): Promise<ScrapeResponseData> {
    const browser = await this.ensureBrowser();
    const context = await this.getContext(browser);
    const page = await context.newPage();
    const abort = (): void => {
      void page.close().catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      // tsx/esbuild injects a `__name` helper for class-name preservation; when
      // Playwright serializes our evaluate() callbacks via .toString(), the
      // helper calls get carried into the browser where __name is undefined.
      // Shim it as a no-op before any page script runs.
      await page.addInitScript(() => {
        const g = globalThis as unknown as { __name?: (fn: unknown) => unknown };
        if (!g.__name) g.__name = (fn) => fn;
      });
      const captured = new Map<string, CapturedMedia>();
      const mediaWaiters: (() => void)[] = [];
      page.on("response", (response: Response) => {
        const media = mediaResponse(response);
        if (!media || captured.has(media.url)) return;
        captured.set(media.url, media);
        for (const resolve of mediaWaiters.splice(0)) resolve();
      });
      const nextMedia = (): Promise<void> =>
        new Promise((resolve) => {
          mediaWaiters.push(resolve);
        });
      if (req.headers && Object.keys(req.headers).length > 0) {
        await page.setExtraHTTPHeaders(req.headers);
      }
      const response = await page.goto(req.url, {
        waitUntil: "domcontentloaded",
        timeout: req.timeout ?? DEFAULT_TIMEOUT,
      });
      if (req.waitFor && req.waitFor > 0) {
        await page.waitForTimeout(req.waitFor);
      }

      const warnings: string[] = [];
      const readyTimeout = req.timeout && req.timeout > 0 ? req.timeout : DEFAULT_TIMEOUT;
      const readyDeadline = Date.now() + readyTimeout;
      const remaining = (): number => Math.max(1, readyDeadline - Date.now());
      try {
        await page.waitForLoadState("networkidle", { timeout: remaining() });
        // A full-page screenshot includes below-fold images, which lazy loading
        // otherwise leaves blank without issuing their requests.
        await page.evaluate(() => {
          for (const image of document.images) image.loading = "eager";
        });
        await page.waitForFunction(
          () =>
            (!document.fonts || document.fonts.status === "loaded") &&
            [...document.images].every((image) => image.complete),
          undefined,
          { timeout: remaining() },
        );
      } catch (err) {
        signal?.throwIfAborted();
        if (!(err instanceof Error) || err.name !== "TimeoutError") throw err;
        warnings.push(
          `Page readiness timed out after ${readyTimeout} ms; some content may still be loading.`,
        );
      }

      const ready = warnings.length === 0;
      if (this.options.playMedia) {
        const warning = await this.playMedia(page, nextMedia, signal);
        if (warning) warnings.push(warning);
      }

      return await this.capture(page, req, {
        response,
        warnings,
        ready,
        mediaRequests: () => [...captured.values()],
        signal,
      });
    } finally {
      signal?.removeEventListener("abort", abort);
      if (!page.isClosed()) await page.close();
    }
  }

  /**
   * Read a loaded page into scrape formats. The live DOM is never changed:
   * cleaning runs on a clone, so this is safe on a tab someone else drives.
   */
  private async capture(
    page: Page,
    req: ScrapeRequest,
    opts: {
      response?: Response | null | undefined;
      warnings: string[];
      ready: boolean;
      /** Read at the end, so media requested during capture are included. */
      mediaRequests: () => CapturedMedia[];
      signal?: AbortSignal | undefined;
    },
  ): Promise<ScrapeResponseData> {
    const { response, warnings, signal } = opts;
    const rawHtml = await page.content();
    const wantedFormats = new Set(req.formats ?? ["markdown"]);
    const out: ScrapeResponseData = {};
    const meta = await page.evaluate(() => {
      const get = (sel: string): string | undefined =>
        (document.querySelector(sel) as HTMLMetaElement | null)?.content ?? undefined;
      return {
        title: document.title || undefined,
        description: get('meta[name="description"]'),
        ogTitle: get('meta[property="og:title"]'),
        ogDescription: get('meta[property="og:description"]'),
      };
    });
    this.userAgent = await page.evaluate(() => navigator.userAgent);
    out.metadata = {
      ...meta,
      sourceURL: req.url,
      url: page.url(),
      statusCode: response?.status() ?? null,
      retryAfter: response?.headers()["retry-after"],
      captureReady: opts.ready,
    };
    if (wantedFormats.has("links")) {
      out.links = await page.evaluate(() =>
        [
          ...new Set(
            [...document.querySelectorAll("a[href]")].map((a) => (a as HTMLAnchorElement).href),
          ),
        ].filter((h) => /^https?:/.test(h)),
      );
    }
    if (wantedFormats.has("screenshot")) {
      try {
        const buf = await page.screenshot({
          fullPage: true,
          type: "png",
          animations: "disabled",
        });
        out.screenshot = `data:image/png;base64,${buf.toString("base64")}`;
      } catch (err) {
        signal?.throwIfAborted();
        warnings.push(
          `Screenshot unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Strip noise nodes + dangerous attributes from a clone of the DOM.
    // Mirrors removeUnwantedElements.ts in the API.
    const cleaned = await page.evaluate((selectors: string[]) => {
      const root = document.documentElement.cloneNode(true) as HTMLElement;
      for (const sel of selectors) {
        for (const el of root.querySelectorAll(sel)) el.remove();
      }
      for (const el of root.querySelectorAll("*")) {
        // Snapshot first — removing during live NamedNodeMap iteration skips entries.
        const names = Array.from(el.attributes, (a) => a.name);
        for (const name of names) {
          if (name.startsWith("on") || name === "style") {
            el.removeAttribute(name);
          }
        }
      }
      const doctype = document.doctype
        ? new XMLSerializer().serializeToString(document.doctype)
        : "";
      const main =
        root.querySelector("main") ??
        root.querySelector("article") ??
        root.querySelector("[role='main']");
      return { html: doctype + root.outerHTML, main: main?.outerHTML ?? null };
    }, STRIP_SELECTORS as string[]);

    let html = cleaned.html;
    if (req.onlyMainContent) {
      // Readability first; when the page isn't article-shaped, fall back to a
      // structural selector so we still narrow the scope.
      html = this.extractMainContent(cleaned.html, req.url) ?? cleaned.main ?? html;
    }

    if (wantedFormats.has("html")) out.html = html;
    if (wantedFormats.has("rawHtml")) out.rawHtml = rawHtml;
    if (wantedFormats.has("markdown")) out.markdown = this.turndown.turndown(html);

    const mediaRequests = opts.mediaRequests();
    if (mediaRequests.length > 0) out["mediaRequests"] = mediaRequests;
    if (warnings.length > 0) out["warning"] = warnings.join(" ");
    return out;
  }

  /** Open tabs in the shared browser, for picking one to capture. */
  async openTabs(): Promise<Array<{ url: string; title: string }>> {
    const browser = await this.ensureBrowser();
    return Promise.all(
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .map(async (page) => ({ url: page.url(), title: await page.title().catch(() => "") })),
    );
  }

  /**
   * Capture a tab that is already open (for example one an agent clicked to)
   * without reloading it, so state built up by clicks is kept. `url` picks the
   * tab; without it there must be exactly one http(s) tab.
   */
  async captureOpenTab(
    req: Omit<ScrapeRequest, "url"> & { url?: string | undefined },
  ): Promise<ScrapeResponseData> {
    const browser = await this.ensureBrowser();
    const tabs = browser
      .contexts()
      .flatMap((context) => context.pages())
      .filter((page) => /^https?:/i.test(page.url()));
    const matches = req.url ? tabs.filter((page) => page.url() === req.url) : tabs;
    if (matches.length !== 1) {
      const open = tabs.map((page) => page.url()).join(", ") || "none";
      throw new Error(
        req.url
          ? `${matches.length === 0 ? "No" : "More than one"} open tab at ${req.url}; open tabs: ${open}`
          : `Pass the tab's url: ${tabs.length === 0 ? "no" : tabs.length} http(s) tabs are open (${open})`,
      );
    }
    const page = matches[0]!;
    // This tab was not opened by scrape(), so it lacks the `__name` shim (see
    // scrape's addInitScript). A string is not rewritten by tsx/esbuild.
    await page.evaluate("globalThis.__name ??= (fn) => fn");
    // Media the page loaded before this call: what the browser recorded as resources.
    const loaded = await page.evaluate(() =>
      performance.getEntriesByType("resource").map((entry) => entry.name),
    );
    const mediaRequests = loaded
      .map((url) => ({ url, contentType: mediaTypeFromUrl(url) }))
      .filter((m): m is CapturedMedia & { contentType: string } => m.contentType !== undefined);
    return this.capture(
      page,
      { ...req, url: page.url() },
      {
        warnings: [],
        ready: true,
        mediaRequests: () => mediaRequests,
      },
    );
  }

  /**
   * Click up to three visible play controls, wait for the media they request,
   * then pause playback. Returns a warning when nothing could be played.
   */
  private async playMedia(
    page: Page,
    nextMedia: () => Promise<void>,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const controls = page
      .getByRole("button", { name: PLAY_CONTROL })
      .or(page.locator('[aria-label*="play" i]'));
    const count = Math.min(await controls.count(), MAX_PLAY_CLICKS);
    const arrived = nextMedia();
    let clicked = 0;
    for (let i = 0; i < count; i++) {
      const control = controls.nth(i);
      try {
        // eslint-disable-next-line no-await-in-loop -- one click can hide or replace the next control.
        if (!(await control.isVisible())) continue;
        // eslint-disable-next-line no-await-in-loop -- clicks must happen in page order.
        await control.click({ timeout: 5_000 });
        clicked++;
      } catch {
        signal?.throwIfAborted();
      }
    }
    if (clicked === 0) return "Play media: no visible play control found.";
    const waitMs = this.options.mediaWaitMs ?? 10_000;
    const settleMs = this.options.mediaSettleMs ?? 1_000;
    // Cancel the losing timer so a finished run is not kept alive by it.
    const timer = new AbortController();
    const requested = await Promise.race([
      arrived.then(() => true),
      sleep(waitMs, false, {
        signal: AbortSignal.any([timer.signal, ...(signal ? [signal] : [])]),
      }).catch(() => false),
    ]);
    timer.abort();
    signal?.throwIfAborted();
    if (requested) await sleep(settleMs, undefined, signal ? { signal } : undefined);
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("audio, video")) (el as HTMLMediaElement).pause();
    });
    return requested
      ? undefined
      : `Play media: clicked ${clicked} control(s) but no audio or video was requested within ${waitMs} ms.`;
  }

  async close(): Promise<void> {
    if (this.browser && this.browser.isConnected()) {
      await this.browser.close();
    }
    this.browser = null;
  }
}
