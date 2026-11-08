import { pagePath } from "../archive/paths.js";
import type { Manifest, PageResult } from "../archive/storage.js";
import {
  ArchiveSession,
  archiveRequest,
  mediaHeaders,
  pageContents,
  type ArchiveTranscribeOptions,
  type MediaKind,
} from "../commands/archive.js";
import type { Config } from "../config.js";
import type { CdpEngine } from "../engines/cdp.js";
import { DashboardReporter, DashboardStore, type DashboardState } from "../ui/dashboard.js";

export interface CaptureSettings {
  media?: MediaKind[] | undefined;
  maxMediaMb: number;
  transcribe?: ArchiveTranscribeOptions | undefined;
}

export interface CapturedPage {
  run: string;
  page: { url: string; title: string | undefined; path: string };
  media: string[];
  pagesInRun: number;
}

interface OpenRun {
  host: string;
  session: ArchiveSession;
  store: DashboardStore;
  paths: Set<string>;
}

/**
 * Saves tabs an agent has navigated to (by clicking, typing, ...) into an
 * archive run, one run per site. Pages are taken as they are; nothing reloads.
 */
export class CaptureRecorder {
  private open: OpenRun | undefined;
  /** Captures run one at a time, in call order. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: Config,
    private readonly engine: Pick<CdpEngine, "captureOpenTab" | "downloadHeaders">,
    private readonly dataDir: string,
  ) {}

  capture(url: string | undefined, settings: CaptureSettings): Promise<CapturedPage> {
    const next = this.queue.then(() => this.captureNow(url, settings));
    this.queue = next.catch(() => {});
    return next;
  }

  private async captureNow(
    url: string | undefined,
    settings: CaptureSettings,
  ): Promise<CapturedPage> {
    const req = archiveRequest(url ?? "about:blank", this.config, "default", "cdp");
    const data = await this.engine.captureOpenTab({ ...req, url });
    const finalUrl = String(data.metadata?.["url"]);
    const host = new URL(finalUrl).host;
    if (this.open && this.open.host !== host) await this.finish();
    const run = this.open ?? (this.open = await this.openRun(finalUrl, host, settings));

    // A single-page app can show different content at the same URL; keep each capture.
    let path = pagePath(finalUrl);
    for (let n = 2; run.paths.has(path); n++) path = `${pagePath(finalUrl)}-${n}`;
    run.paths.add(path);
    const title = typeof data.metadata?.["title"] === "string" ? data.metadata["title"] : undefined;
    const result: PageResult = {
      url: finalUrl,
      finalUrl,
      title: title ?? finalUrl,
      path,
      status: "saved",
    };
    const contents = pageContents(data, finalUrl);
    const media = await run.session.downloadPageMedia(
      result,
      contents.media,
      mediaHeaders(this.engine, undefined, finalUrl, finalUrl),
    );
    if (typeof data["warning"] === "string") result.warning = data["warning"];
    await run.session.record(result, data, contents.links, media);
    return {
      run: run.session.root,
      page: { url: finalUrl, title, path },
      media: result.media ?? [],
      pagesInRun: run.session.manifest.pages.length,
    };
  }

  private async openRun(
    sourceUrl: string,
    host: string,
    settings: CaptureSettings,
  ): Promise<OpenRun> {
    const store = new DashboardStore(`Capturing ${host}`, settings.transcribe?.workers ?? 0);
    const session = await ArchiveSession.open({
      sourceUrl,
      engineName: "cdp",
      out: this.dataDir,
      limit: 0,
      maxMediaMb: settings.maxMediaMb,
      delayMs: 0,
      playMedia: false,
      media: settings.media,
      transcribe: settings.transcribe,
      reporter: new DashboardReporter(store),
    });
    return { host, session, store, paths: new Set() };
  }

  /** Progress of the open capture run, if any. */
  status(): { run: string; pages: number; progress: Omit<DashboardState, "setup"> } | undefined {
    if (!this.open) return undefined;
    const { setup: _setup, ...progress } = this.open.store.getSnapshot();
    return {
      run: this.open.session.root,
      pages: this.open.session.manifest.pages.length,
      progress,
    };
  }

  /** Wait for transcripts and close the open run. */
  async finish(): Promise<{ run: string; status: Manifest["status"]; pages: number } | undefined> {
    const run = this.open;
    if (!run) return undefined;
    this.open = undefined;
    try {
      await run.session.complete();
    } finally {
      await run.session.close();
    }
    return {
      run: run.session.root,
      status: run.session.manifest.status,
      pages: run.session.manifest.pages.length,
    };
  }
}
