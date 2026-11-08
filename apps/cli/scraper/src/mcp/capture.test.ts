import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Manifest } from "../archive/storage.js";
import type { Config } from "../config.js";
import type { ScrapeResponseData } from "../formats/types.js";
import { CaptureRecorder } from "./capture.js";

const config = { profiles: {}, domains: {} } as unknown as Config;
let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcp-capture-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A browser whose single tab shows `tabs[i]` on the i-th capture. */
function browser(tabs: Array<{ url: string; title: string; body: string }>) {
  let i = 0;
  return {
    captureOpenTab: vi.fn(async (): Promise<ScrapeResponseData> => {
      const tab = tabs[i++]!;
      const html = `<html><head><title>${tab.title}</title></head><body>${tab.body}</body></html>`;
      return {
        metadata: { url: tab.url, title: tab.title },
        markdown: tab.body,
        html,
        rawHtml: html,
        links: [],
      };
    }),
    downloadHeaders: vi.fn(async () => ({})),
  };
}

describe("CaptureRecorder", () => {
  it("saves each capture of a site into one run, keeping repeat visits to the same URL", async () => {
    const engine = browser([
      { url: "https://quiz.test/test/1", title: "Question 1", body: "<p>Q1</p>" },
      { url: "https://quiz.test/test/1", title: "Question 2", body: "<p>Q2</p>" },
    ]);
    const recorder = new CaptureRecorder(config, engine, dir);
    const first = await recorder.capture(undefined, { maxMediaMb: 10 });
    const second = await recorder.capture(undefined, { maxMediaMb: 10 });
    expect(second.run).toBe(first.run);
    expect(second.page.path).toBe(`${first.page.path}-2`);
    expect(second.pagesInRun).toBe(2);
    expect(recorder.status()).toMatchObject({ run: first.run, pages: 2 });

    const finished = await recorder.finish();
    expect(finished).toEqual({ run: first.run, status: "completed", pages: 2 });
    expect(recorder.status()).toBeUndefined();
    const manifest = JSON.parse(
      await readFile(join(first.run, "manifest.json"), "utf8"),
    ) as Manifest;
    expect(manifest.pages.map((p) => [p.title, p.status])).toEqual([
      ["Question 1", "saved"],
      ["Question 2", "saved"],
    ]);
    expect(await readFile(join(first.run, second.page.path, "content.md"), "utf8")).toBe(
      "<p>Q2</p>",
    );
  });

  it("starts a new run when the agent moves to another site", async () => {
    const engine = browser([
      { url: "https://a.test/", title: "A", body: "a" },
      { url: "https://b.test/", title: "B", body: "b" },
    ]);
    const recorder = new CaptureRecorder(config, engine, dir);
    const a = await recorder.capture(undefined, { maxMediaMb: 10 });
    const b = await recorder.capture(undefined, { maxMediaMb: 10 });
    expect(b.run).not.toBe(a.run);
    expect(b.run).toContain(join(dir, "b.test"));
    const closed = JSON.parse(await readFile(join(a.run, "manifest.json"), "utf8")) as Manifest;
    expect(closed.status).toBe("completed");
    expect(closed.finishedAt).toBeDefined();
    await recorder.finish();
  });
});
