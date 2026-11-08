import { describe, expect, it, vi } from "vitest";
import type { ArchiveOptions } from "../commands/archive.js";
import type { Config } from "../config.js";
import type { ExecuteDeps } from "../ui/execute.js";
import type { ArchiveRunPlan } from "../ui/wizard.js";
import { JobRunner } from "./jobs.js";

const config = { transcribe: { whisperBin: "/w/whisper-cli", model: "/w/model.bin" } } as Config;

const plan: ArchiveRunPlan = {
  kind: "archive",
  urls: ["https://a.test/", "https://b.test/"],
  engine: "cdp",
  cdpUrl: undefined,
  playMedia: false,
  limit: 5,
  delayMs: 0,
  media: ["audio"],
  maxMediaMb: 10,
  transcribe: undefined,
  out: "/data",
  setupFirst: false,
};

type ArchiveResult = Awaited<ReturnType<ExecuteDeps["archive"]>>;

/** An archive that reports progress, then waits for `release` (or an abort). */
function gatedDeps() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const deps: ExecuteDeps = {
    install: vi.fn(),
    transcribe: vi.fn(),
    archive: vi.fn(async (opts: ArchiveOptions): Promise<ArchiveResult> => {
      const root = `/data/${new URL(opts.url).host}/run`;
      opts.reporter?.started(root);
      opts.reporter?.page(1, opts.limit, opts.url);
      await Promise.race([
        gate,
        new Promise((resolve) => opts.signal?.addEventListener("abort", resolve)),
      ]);
      const status = opts.signal?.aborted ? "interrupted" : "completed";
      return { root, manifest: { status } } as ArchiveResult;
    }),
  };
  return { deps, release: () => release() };
}

describe("JobRunner", () => {
  it("runs an archive in the background and reports progress and run folders", async () => {
    const { deps, release } = gatedDeps();
    const jobs = new JobRunner(config, deps);
    const id = jobs.start(plan);

    await vi.waitFor(() => expect(jobs.status(id)?.progress.pages?.url).toBe("https://a.test/"));
    expect(jobs.status(id)).toMatchObject({
      kind: "archive",
      running: true,
      runs: ["/data/a.test/run"],
    });

    release();
    await vi.waitFor(() => expect(jobs.status(id)?.running).toBe(false));
    expect(jobs.status(id)).toMatchObject({
      exitCode: 0,
      runs: ["/data/a.test/run", "/data/b.test/run"],
      progress: { done: { status: "completed" } },
    });
  });

  it("refuses a second job while one is running", async () => {
    const { deps, release } = gatedDeps();
    const jobs = new JobRunner(config, deps);
    const id = jobs.start(plan);
    expect(() => jobs.start(plan)).toThrow(`Job ${id} (archive) is still running`);
    release();
    await vi.waitFor(() => expect(jobs.status(id)?.running).toBe(false));
    expect(() => jobs.start(plan)).not.toThrow();
  });

  it("cancels a running job and keeps it queryable", async () => {
    const { deps } = gatedDeps();
    const jobs = new JobRunner(config, deps);
    const id = jobs.start(plan);
    expect(await jobs.cancel(id)).toBe(true);
    expect(jobs.status(id)).toMatchObject({ running: false, exitCode: 130 });
    expect(deps.archive).toHaveBeenCalledTimes(1);
    expect(await jobs.cancel("missing")).toBe(false);
    expect(jobs.status("missing")).toBeUndefined();
  });

  it("reports a failed job with its error", async () => {
    const deps: ExecuteDeps = {
      install: vi.fn(),
      transcribe: vi.fn(),
      archive: vi.fn(async () => {
        throw new Error("CDP connect failed at http://localhost:9222");
      }),
    };
    const jobs = new JobRunner(config, deps);
    const id = jobs.start({ ...plan, urls: ["https://a.test/"] });
    await vi.waitFor(() => expect(jobs.status(id)?.running).toBe(false));
    expect(jobs.status(id)).toMatchObject({
      exitCode: 1,
      progress: {
        done: { status: "failed", detail: "CDP connect failed at http://localhost:9222" },
      },
    });
  });
});
