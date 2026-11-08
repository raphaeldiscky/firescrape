import { mkdir } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { httpUrl } from "../archive/discovery.js";
import { MEDIA_KINDS } from "../commands/archive.js";
import { buildRequest } from "../commands/scrape.js";
import { transcribeSettings, type TranscribeChoices } from "../commands/transcribe.js";
import type { Config } from "../config.js";
import { CdpEngine } from "../engines/cdp.js";
import { createEnginePool, type EnginePool } from "../engines/index.js";
import { resolveWhisper, whisperStatus } from "../transcribe/setup.js";
import { checkCdp } from "../ui/chrome.js";
import { listRuns } from "../ui/runs.js";
import { CaptureRecorder } from "./capture.js";
import { insideDataDir, readArchiveFile } from "./files.js";
import { JobRunner } from "./jobs.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Run a tool body; return its value as JSON text, or its error message as a tool error. */
async function respond(body: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const value = await body();
    return {
      content: [
        { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
    };
  }
}

const media = z
  .array(z.enum(MEDIA_KINDS))
  .optional()
  .describe("Media kinds to download (default: image, video, audio)");
const transcribe = z
  .boolean()
  .optional()
  .describe("Transcribe downloaded audio and video with whisper.cpp (default false)");
const workers = z
  .number()
  .int()
  .min(1)
  .max(4)
  .optional()
  .describe("Transcription workers (default 2)");
const language = z
  .string()
  .regex(/^(?:auto|[a-z]{2,3})$/)
  .optional()
  .describe("Spoken language code such as en, or auto (default)");

function choices(args: {
  workers?: number | undefined;
  language?: string | undefined;
}): TranscribeChoices {
  return {
    workers: args.workers ?? 2,
    language: args.language ?? "auto",
    model: undefined,
    cpu: false,
  };
}

export interface ServerDeps {
  config: Config;
  dataDir: string;
  pool?: EnginePool | undefined;
  jobs?: JobRunner | undefined;
}

export function createServer({ config, dataDir, ...deps }: ServerDeps) {
  const server = new McpServer({ name: "firescrape", version: "0.1.0" });
  const pool = deps.pool ?? createEnginePool(config, undefined);
  const jobs = deps.jobs ?? new JobRunner(config);
  const cdpUrl = config.cdp?.url ?? "http://localhost:9222";
  const cdp = (): CdpEngine => {
    const engine = pool.get("cdp");
    if (!(engine instanceof CdpEngine)) throw new Error("The CDP engine is unavailable");
    return engine;
  };
  const captures = new CaptureRecorder(
    config,
    {
      captureOpenTab: (req) => cdp().captureOpenTab(req),
      downloadHeaders: (url) => cdp().downloadHeaders(url),
    },
    dataDir,
  );

  const requireChrome = async (): Promise<void> => {
    const check = await checkCdp(cdpUrl);
    if (!check.ok)
      throw new Error(
        `No Chrome answered at ${cdpUrl} (${check.error}). Start it with \`task scraper:chrome\` and log in there first.`,
      );
  };
  const requireWhisper = (): void => {
    if (!whisperStatus(resolveWhisper(config)).ready)
      throw new Error(
        "Transcription is not set up on this machine. Run `task scraper` and choose Set up transcription.",
      );
  };

  server.registerTool(
    "scrape_page",
    {
      title: "Scrape one page",
      description:
        "Load one URL and return its content as markdown, with title and final URL. Uses your logged-in Chrome (engine cdp, default) or the self-hosted Firecrawl API (engine api). Nothing is saved; use archive_start or capture_page to keep pages.",
      inputSchema: {
        url: z.string().describe("http(s) URL"),
        engine: z.enum(["cdp", "api"]).optional(),
        onlyMainContent: z
          .boolean()
          .optional()
          .describe("Keep only the main article (default true)"),
        maxChars: z.number().int().min(100).max(200_000).optional().describe("Default 20000"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      respond(async () => {
        const url = httpUrl(args.url);
        if (!url) throw new Error("Provide an http(s) URL");
        const engineName = args.engine ?? "cdp";
        if (engineName === "cdp") await requireChrome();
        const req = buildRequest(url, config, "default", ["markdown"]);
        req.formats = ["markdown"];
        req.onlyMainContent = args.onlyMainContent ?? true;
        const data = await pool.get(engineName).scrape(req);
        const markdown = data.markdown ?? "";
        const maxChars = args.maxChars ?? 20_000;
        return {
          url: data.metadata?.["url"] ?? url,
          title: data.metadata?.["title"],
          statusCode: data.metadata?.["statusCode"],
          truncated: markdown.length > maxChars,
          markdown: markdown.slice(0, maxChars),
        };
      }),
  );

  server.registerTool(
    "archive_start",
    {
      title: "Archive sites in the background",
      description:
        "Crawl one or more sites by following their links, saving pages, media and optional transcripts under data/. Returns a jobId at once; poll job_status. One job runs at a time. To save pages reached by clicking instead of links, use capture_page.",
      inputSchema: {
        urls: z.array(z.string()).min(1).describe("Start URLs; each becomes its own run"),
        engine: z.enum(["cdp", "api"]).optional().describe("cdp = your logged-in Chrome (default)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10_000)
          .optional()
          .describe("Max pages per site (default 100)"),
        delayMs: z.number().int().min(0).optional().describe("Gap between pages (default 1000)"),
        media,
        maxMediaMb: z.number().positive().optional().describe("Largest media file (default 100)"),
        playMedia: z
          .boolean()
          .optional()
          .describe(
            "CDP only: click Play/Listen controls so on-demand audio loads (default false)",
          ),
        transcribe,
        workers,
        language,
      },
      annotations: { openWorldHint: true },
    },
    (args) =>
      respond(async () => {
        const urls = args.urls.map((raw) => {
          const url = httpUrl(raw);
          if (!url) throw new Error(`Not an http(s) URL: ${raw}`);
          return url;
        });
        const engine = args.engine ?? "cdp";
        if (args.playMedia && engine !== "cdp") throw new Error("playMedia requires engine cdp");
        if (engine === "cdp") await requireChrome();
        if (args.transcribe) requireWhisper();
        const id = jobs.start({
          kind: "archive",
          urls,
          engine,
          cdpUrl: undefined,
          playMedia: args.playMedia ?? false,
          limit: args.limit ?? 100,
          delayMs: args.delayMs ?? 1000,
          media: args.media ?? [...MEDIA_KINDS],
          maxMediaMb: args.maxMediaMb ?? 100,
          transcribe: args.transcribe ? choices(args) : undefined,
          out: dataDir,
          setupFirst: false,
        });
        return { jobId: id, note: "Poll job_status until running is false." };
      }),
  );

  server.registerTool(
    "transcribe_start",
    {
      title: "Transcribe past runs in the background",
      description:
        "Transcribe audio/video of archive runs or media files under data/ to TXT, SRT, VTT and JSON next to each file. Returns a jobId; poll job_status.",
      inputSchema: {
        inputs: z.array(z.string()).min(1).describe("Run folders or media files under data/"),
        workers,
        language,
      },
    },
    (args) =>
      respond(async () => {
        requireWhisper();
        const inputs = await Promise.all(args.inputs.map((p) => insideDataDir(dataDir, p)));
        const id = jobs.start({
          kind: "transcribe",
          inputs,
          choices: choices(args),
          setupFirst: false,
        });
        return { jobId: id, note: "Poll job_status until running is false." };
      }),
  );

  server.registerTool(
    "job_status",
    {
      title: "Job progress",
      description:
        "Progress of an archive or transcription job: pages, media and transcript counts, recent errors, run folders, and the final status once running is false. Without jobId, reports the open capture run.",
      inputSchema: { jobId: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      respond(async () => {
        if (!args.jobId) return captures.status() ?? { capture: "No capture run is open" };
        const status = jobs.status(args.jobId);
        if (!status) throw new Error(`Unknown job ${args.jobId}`);
        return status;
      }),
  );

  server.registerTool(
    "job_cancel",
    {
      title: "Cancel a job",
      description: "Stop a running job. Pages and media saved so far are kept.",
      inputSchema: { jobId: z.string() },
      annotations: { destructiveHint: false },
    },
    (args) =>
      respond(async () => {
        if (!(await jobs.cancel(args.jobId))) throw new Error(`Unknown job ${args.jobId}`);
        return jobs.status(args.jobId);
      }),
  );

  server.registerTool(
    "capture_page",
    {
      title: "Save the open tab",
      description:
        "Save the page currently open in your Chrome (for example after clicking through it with the Playwright browser tools) without reloading it: content, screenshot, its media, and optional transcripts. Pages from the same site go into one run until capture_finish. Pass url when several tabs are open. Media and transcription settings are fixed by the first capture of a run.",
      inputSchema: {
        url: z.string().optional().describe("Exact URL of the tab to save"),
        media,
        maxMediaMb: z.number().positive().optional().describe("Largest media file (default 100)"),
        transcribe,
        workers,
        language,
      },
      annotations: { openWorldHint: true },
    },
    (args) =>
      respond(async () => {
        await requireChrome();
        if (args.transcribe) requireWhisper();
        const settings = choices(args);
        return captures.capture(args.url, {
          media: args.media,
          maxMediaMb: args.maxMediaMb ?? 100,
          transcribe: args.transcribe
            ? { workers: settings.workers, settings: transcribeSettings(config, settings) }
            : undefined,
        });
      }),
  );

  server.registerTool(
    "capture_finish",
    {
      title: "Finish the capture run",
      description:
        "Wait for queued transcripts, then finalise the open capture run's manifest.json and index.md. Call when done capturing a site.",
      inputSchema: {},
    },
    () => respond(async () => (await captures.finish()) ?? { capture: "No capture run is open" }),
  );

  server.registerTool(
    "list_runs",
    {
      title: "List past runs",
      description:
        "Archive and capture runs under data/, newest first: folder, source URL, start time, status, pages saved, audio/video files and transcripts.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional().describe("Default 20") },
      annotations: { readOnlyHint: true },
    },
    (args) => respond(() => listRuns(dataDir, args.limit ?? 20, { mediaOnly: false })),
  );

  server.registerTool(
    "read_archive_file",
    {
      title: "Read a saved file",
      description:
        "Read a text file from data/: a run folder gives its index.md, a page folder its content.md; transcripts are the .txt next to each media file. Long files come in slices; pass nextOffset as offset to continue.",
      inputSchema: {
        path: z.string().describe("Absolute, or relative to data/"),
        offset: z.number().int().min(0).optional(),
        maxChars: z.number().int().min(100).max(200_000).optional().describe("Default 20000"),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => respond(() => readArchiveFile(dataDir, args.path, args.offset, args.maxChars)),
  );

  const close = async (): Promise<void> => {
    await jobs.cancelAll();
    await captures.finish().catch(() => {});
    await pool.closeAll();
  };
  return { server, close };
}

/** Serve the tools over stdio; stdout carries only the MCP protocol. */
export async function runMcpServer(config: Config, dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const { server, close } = createServer({ config, dataDir });
  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => (closing ??= close().then(() => server.close()));
  // oxlint-disable-next-line prefer-add-event-listener -- an SDK callback property, not an EventTarget
  server.server.onclose = () => {
    void shutdown();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  await server.connect(new StdioServerTransport());
}
