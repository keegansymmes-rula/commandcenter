import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPrUrl, searchMyPrs } from "../api/lib/pr.js";

describe("searchMyPrs", () => {
  const originalPath = process.env.PATH;
  let dir;

  function fakeGh(script) {
    dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
    const bin = join(dir, "gh");
    writeFileSync(bin, `#!/bin/sh\n${script}\n`);
    chmodSync(bin, 0o755);
    process.env.PATH = `${dir}:${originalPath}`;
  }

  afterEach(() => {
    process.env.PATH = originalPath;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("parses gh's JSON output", async () => {
    fakeGh(`echo '[{"number":7,"url":"https://github.com/a/b/pull/7"}]'`);
    expect(await searchMyPrs()).toEqual([
      { number: 7, url: "https://github.com/a/b/pull/7" },
    ]);
  });

  it("returns [] when gh fails or prints junk", async () => {
    fakeGh("exit 1");
    expect(await searchMyPrs()).toEqual([]);
    fakeGh("echo not-json");
    expect(await searchMyPrs()).toEqual([]);
  });

  it("does not block the event loop while gh is slow", async () => {
    fakeGh("sleep 1; echo '[]'");
    const pending = searchMyPrs();
    // A synchronous exec would hold the loop for the full second, so this
    // timer could not fire before the search settled.
    const winner = await Promise.race([
      new Promise((r) => setTimeout(() => r("timer"), 100)),
      pending.then(() => "search"),
    ]);
    expect(winner).toBe("timer");
    await pending;
  });
});

describe("isPrUrl", () => {
  it("accepts a GitHub PR URL", () => {
    expect(isPrUrl("https://github.com/pathccm/partner-service/pull/123")).toBe(true);
  });

  it("rejects non-PR GitHub URLs", () => {
    expect(isPrUrl("https://github.com/pathccm/partner-service/issues/123")).toBe(false);
    expect(isPrUrl("https://github.com/pathccm/partner-service")).toBe(false);
  });

  it("rejects anything that could break out of the shell quoting", () => {
    expect(isPrUrl("https://github.com/a/b/pull/1'; rm -rf ~; '")).toBe(false);
    expect(isPrUrl("https://github.com/a/b/pull/1 --repo x")).toBe(false);
    expect(isPrUrl("https://github.com/a/b/pull/1\nwhoami")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isPrUrl(undefined)).toBe(false);
    expect(isPrUrl({ url: "https://github.com/a/b/pull/1" })).toBe(false);
  });
});
