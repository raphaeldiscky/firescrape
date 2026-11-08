import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dir = "";
let client: Client;
const protocolErrors: Error[] = [];

type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
async function call(name: string, args: Record<string, unknown> = {}): Promise<TextResult> {
  return (await client.callTool({ name, arguments: args })) as TextResult;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcp-server-"));
  const run = join(dir, "example.com/2026-11-08-run");
  await mkdir(join(run, "pages/a--1"), { recursive: true });
  await writeFile(join(run, "index.md"), "# example.com\n");
  await writeFile(join(run, "pages/a--1/content.md"), "page text");
  await writeFile(
    join(run, "manifest.json"),
    JSON.stringify({
      sourceUrl: "https://example.com/",
      startedAt: "2026-11-08T00:00:00Z",
      status: "completed",
      pages: [{ url: "https://example.com/", path: "pages/a--1", status: "saved" }],
      assets: [],
    }),
  );
  await writeFile(join(dir, "..", "mcp-outside.md"), "outside");

  const transport = new StdioClientTransport({
    command: join(process.cwd(), "node_modules/.bin/tsx"),
    // Nothing listens on port 1, so CDP checks fail fast.
    args: ["src/cli.ts", "--cdp-url", "http://127.0.0.1:1", "mcp", "--data-dir", dir],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  client = new Client({ name: "test", version: "0" });
  // Any stdout line that is not JSON-RPC surfaces here.
  // oxlint-disable-next-line prefer-add-event-listener -- an SDK callback property, not an EventTarget
  client.onerror = (err) => protocolErrors.push(err);
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client?.close();
  await rm(dir, { recursive: true, force: true });
  await rm(join(dir, "..", "mcp-outside.md"), { force: true });
});

describe("MCP server over stdio", () => {
  it("lists the scraper tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual([
      "archive_start",
      "capture_finish",
      "capture_page",
      "job_cancel",
      "job_status",
      "list_runs",
      "read_archive_file",
      "scrape_page",
      "transcribe_start",
    ]);
  });

  it("lists runs and reads their files", async () => {
    const runs = JSON.parse((await call("list_runs")).content[0]!.text) as Array<{
      sourceUrl: string;
      status: string;
      pages: number;
    }>;
    expect(runs).toMatchObject([
      { sourceUrl: "https://example.com/", status: "completed", pages: 1 },
    ]);

    const index = JSON.parse(
      (await call("read_archive_file", { path: "example.com/2026-11-08-run" })).content[0]!.text,
    ) as { text: string };
    expect(index.text).toBe("# example.com\n");
    const page = await call("read_archive_file", { path: "example.com/2026-11-08-run/pages/a--1" });
    expect(page.content[0]!.text).toContain("page text");
  });

  it("returns tool errors instead of crashing", async () => {
    const outside = await call("read_archive_file", { path: "../mcp-outside.md" });
    expect(outside.isError).toBe(true);
    expect(outside.content[0]!.text).toContain("Only files under");

    const noChrome = await call("archive_start", { urls: ["https://example.com/"] });
    expect(noChrome.isError).toBe(true);
    expect(noChrome.content[0]!.text).toContain("task scraper:chrome");

    const badUrl = await call("archive_start", { urls: ["ftp://x"], engine: "api" });
    expect(badUrl.content[0]!.text).toBe("Not an http(s) URL: ftp://x");

    expect((await call("job_status", { jobId: "nope" })).content[0]!.text).toBe("Unknown job nope");
    expect((await call("job_status")).content[0]!.text).toContain("No capture run is open");
    expect((await call("capture_finish")).content[0]!.text).toContain("No capture run is open");
  });

  it("keeps stdout to the MCP protocol", () => {
    expect(protocolErrors).toEqual([]);
  });
});
