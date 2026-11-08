import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { DashboardState } from "../ui/dashboard.js";
import { executePlan, storeFor, type ExecuteDeps } from "../ui/execute.js";
import type { ArchiveRunPlan, TranscribeRunPlan } from "../ui/wizard.js";

type JobPlan = ArchiveRunPlan | TranscribeRunPlan;

interface Job {
  id: string;
  kind: JobPlan["kind"];
  startedAt: string;
  finishedAt?: string | undefined;
  exitCode?: number | undefined;
  /** Every run folder the job created, in order (one per archived site). */
  runs: string[];
  controller: AbortController;
  state: () => DashboardState;
  done: Promise<void>;
}

export interface JobStatus {
  id: string;
  kind: JobPlan["kind"];
  running: boolean;
  startedAt: string;
  finishedAt?: string | undefined;
  /** 0 completed, 1 failed or partial, 130 cancelled. */
  exitCode?: number | undefined;
  runs: string[];
  progress: Omit<DashboardState, "setup">;
}

/**
 * Background archive and transcription jobs for the MCP server. One job runs at
 * a time: jobs share the browser and the GPU.
 */
export class JobRunner {
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly config: Config,
    private readonly execute: ExecuteDeps | undefined = undefined,
  ) {}

  running(): Job | undefined {
    return [...this.jobs.values()].find((job) => job.exitCode === undefined);
  }

  start(plan: JobPlan): string {
    const busy = this.running();
    if (busy)
      throw new Error(
        `Job ${busy.id} (${busy.kind}) is still running; wait for it or cancel it first`,
      );
    const id = randomUUID().slice(0, 8);
    const store = storeFor(plan);
    const runs: string[] = [];
    store.subscribe(() => {
      const root = store.getSnapshot().root;
      if (root && !runs.includes(root)) runs.push(root);
    });
    const controller = new AbortController();
    const job: Job = {
      id,
      kind: plan.kind,
      startedAt: new Date().toISOString(),
      runs,
      controller,
      state: store.getSnapshot,
      done: Promise.resolve(),
    };
    job.done = executePlan(plan, this.config, store, controller.signal, this.execute).then(
      (code) => {
        job.exitCode = code;
        job.finishedAt = new Date().toISOString();
      },
    );
    this.jobs.set(id, job);
    return id;
  }

  status(id: string): JobStatus | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const { setup: _setup, ...progress } = job.state();
    return {
      id: job.id,
      kind: job.kind,
      running: job.exitCode === undefined,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      exitCode: job.exitCode,
      runs: [...job.runs],
      progress,
    };
  }

  /** Stop a job; pages and media saved so far are kept. Resolves once it has stopped. */
  async cancel(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.controller.abort();
    await job.done;
    return true;
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.jobs.keys()].map((id) => this.cancel(id)));
  }
}
