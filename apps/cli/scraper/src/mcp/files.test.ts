import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insideDataDir, readArchiveFile } from "./files.js";

let base = "";
let data = "";

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "mcp-files-"));
  data = join(base, "data");
  await mkdir(join(data, "example.com/run/pages/a--1/media"), { recursive: true });
  await writeFile(join(data, "example.com/run/index.md"), "# example.com\n");
  await writeFile(join(data, "example.com/run/pages/a--1/content.md"), "page text");
  await writeFile(join(data, "example.com/run/pages/a--1/media/t--1.txt"), "0123456789");
  await writeFile(join(data, "example.com/run/pages/a--1/media/t--1.mp3"), "audio");
  await writeFile(join(base, "secret.md"), "outside");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("readArchiveFile", () => {
  it("reads a run's index.md, a page's content.md and a transcript", async () => {
    expect((await readArchiveFile(data, "example.com/run")).text).toBe("# example.com\n");
    expect((await readArchiveFile(data, "example.com/run/pages/a--1")).text).toBe("page text");
    const abs = join(data, "example.com/run/pages/a--1/media/t--1.txt");
    expect((await readArchiveFile(data, abs)).text).toBe("0123456789");
  });

  it("returns long files in slices", async () => {
    const path = "example.com/run/pages/a--1/media/t--1.txt";
    expect(await readArchiveFile(data, path, 0, 4)).toMatchObject({
      text: "0123",
      totalChars: 10,
      nextOffset: 4,
    });
    expect(await readArchiveFile(data, path, 8, 4)).toMatchObject({
      text: "89",
      nextOffset: undefined,
    });
  });

  it("refuses paths outside the data folder, including through symlinks", async () => {
    await expect(readArchiveFile(data, "../secret.md")).rejects.toThrow("Only files under");
    await expect(readArchiveFile(data, join(base, "secret.md"))).rejects.toThrow(
      "Only files under",
    );
    await symlink(join(base, "secret.md"), join(data, "link.md"));
    await expect(readArchiveFile(data, "link.md")).rejects.toThrow("Only files under");
    await expect(insideDataDir(data, "missing/file.md")).rejects.toThrow("Not found");
  });

  it("refuses binary media", async () => {
    await expect(
      readArchiveFile(data, "example.com/run/pages/a--1/media/t--1.mp3"),
    ).rejects.toThrow("Not a text file");
  });
});
