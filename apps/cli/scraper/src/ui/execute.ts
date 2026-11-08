import { runArchive } from "../commands/archive.js";
import { runTranscribe, transcribeSettings } from "../commands/transcribe.js";
import type { Config } from "../config.js";
import { resolveUserPath } from "../lib/paths.js";
import { installWhisper } from "../transcribe/install.js";
import { whisperHome } from "../transcribe/setup.js";
import { DashboardReporter, DashboardStore } from "./dashboard.js";
import type { ArchiveRunPlan, RunPlan } from "./wizard.js";

export interface ExecuteDeps {
  archive: typeof runArchive;
  transcribe: typeof runTranscribe;
  install: typeof installWhisper;
}

const REAL: ExecuteDeps = {
  archive: runArchive,
  transcribe: runTranscribe,
  install: installWhisper,
};

/** A dashboard sized for the plan: one row per transcription worker. */
export function storeFor(plan: RunPlan): DashboardStore {
  if (plan.kind === "setup") return new DashboardStore("Setting up transcription");
  if (plan.kind === "transcribe") return new DashboardStore("Transcribing", plan.choices.workers);
  const title =
    plan.urls.length === 1 ? `Archiving ${plan.urls[0]}` : `Archiving ${plan.urls.length} sites`;
  return new DashboardStore(title, plan.transcribe?.workers ?? 0);
}

/** Run what the wizard chose, reporting into `store`; resolves to the process exit code. */
export async function executePlan(
  plan: RunPlan,
  config: Config,
  store: DashboardStore,
  signal: AbortSignal,
  deps: ExecuteDeps = REAL,
): Promise<number> {
  try {
    if (plan.kind === "setup" || plan.setupFirst) {
      const paths = await deps.install({ onEvent: (e) => store.setup(e), signal });
      store.update((s) => ({
        ...s,
        setup: { label: `whisper.cpp is ready (${whisperHome()})`, log: [] },
      }));
      if (plan.kind === "setup") {
        store.finish("completed", `whisper-cli ${paths.bin}, model ${paths.model}`);
        return 0;
      }
    }

    if (plan.kind === "archive") return await archiveAll(plan, config, store, signal, deps);

    const results = await deps.transcribe({
      inputs: plan.inputs.map((p) => resolveUserPath(p)),
      workers: plan.choices.workers,
      settings: transcribeSettings(config, plan.choices),
      onEvent: (e) => store.transcription(e),
      signal,
    });
    const failed = results.filter((r) => r.status === "failed").length;
    const done = results.filter((r) => r.status === "transcribed").length;
    const skipped = results.length - failed - done;
    const status = signal.aborted ? "interrupted" : failed > 0 ? "partial" : "completed";
    store.finish(
      status,
      `${done} transcribed, ${skipped} skipped, ${failed} failed; transcripts are next to each media file`,
    );
    return signal.aborted ? 130 : failed > 0 ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.finish(signal.aborted ? "interrupted" : "failed", message);
    return signal.aborted ? 130 : 1;
  }
}

/** Archive each URL as its own run; a failed site is reported and the next one still runs. */
async function archiveAll(
  plan: ArchiveRunPlan,
  config: Config,
  store: DashboardStore,
  signal: AbortSignal,
  deps: ExecuteDeps,
): Promise<number> {
  const total = plan.urls.length;
  let archived = 0;
  let failed = 0;
  let interrupted = false;
  for (const [i, url] of plan.urls.entries()) {
    if (signal.aborted || interrupted) break;
    if (total > 1)
      store.update((s) => ({
        ...s,
        title: `Archiving ${i + 1}/${total}: ${url}`,
        root: undefined,
        pages: undefined,
        done: undefined,
      }));
    try {
      // eslint-disable-next-line no-await-in-loop -- sites are archived one after another.
      const { manifest } = await deps.archive({
        url,
        config,
        profileName: "default",
        engineName: plan.engine,
        cdpUrlOverride: plan.cdpUrl,
        out: resolveUserPath(plan.out),
        limit: plan.limit,
        maxMediaMb: plan.maxMediaMb,
        delayMs: plan.delayMs,
        playMedia: plan.playMedia,
        media: plan.media,
        transcribe: plan.transcribe && {
          workers: plan.transcribe.workers,
          settings: transcribeSettings(config, plan.transcribe),
        },
        reporter: new DashboardReporter(store),
        signal,
      });
      if (manifest.status === "completed") archived++;
      else if (manifest.status === "interrupted") interrupted = true;
      else failed++;
    } catch (err) {
      if (signal.aborted) throw err;
      if (total === 1) throw err;
      failed++;
      store.error(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  interrupted ||= signal.aborted;
  if (total > 1)
    store.finish(
      interrupted ? "interrupted" : failed > 0 ? "partial" : "completed",
      `${archived} of ${total} sites archived, ${failed} failed or partial; runs are under ${plan.out}`,
    );
  return interrupted ? 130 : failed > 0 ? 1 : 0;
}
