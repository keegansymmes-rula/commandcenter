import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { searchMyPrs, searchReviewRequestedPrs, viewPr } from "../api/lib/pr.js";

// These run a real fake `gh` on PATH. tests/pr.test.js mocks execFile for the
// whole module, which would stub out the child process these tests need, so
// the two live in separate files.

const originalPath = process.env.PATH;
let dir = null;

function fakeGh(script) {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
  const bin = join(dir, "gh");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  process.env.PATH = `${dir}:${originalPath}`;
}

// Records its pid, ignores SIGTERM, then stalls. exec keeps both the pid and
// the ignored disposition, so only SIGKILL ends it.
function stalledGh() {
  fakeGh(`echo $$ > "$(dirname "$0")/pid"\ntrap '' TERM\nexec sleep 30`);
  return join(dir, "pid");
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Long enough that the fake gh has started and written its pid before the
// deadline kills it, even when the machine is busy; a 300ms deadline raced
// the script's own startup and flaked.
const DEADLINE_MS = "1500";

async function readPid(pidFile, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!existsSync(pidFile) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return Number(readFileSync(pidFile, "utf-8").trim());
}

async function waitUntilDead(pid, ms = 3000) {
  const deadline = Date.now() + ms;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isAlive(pid);
}

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.GH_TIMEOUT_MS;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("searchMyPrs", () => {
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

  it("gives up on a stalled gh at the deadline and kills it even when it ignores SIGTERM", async () => {
    const pidFile = stalledGh();
    process.env.GH_TIMEOUT_MS = DEADLINE_MS;

    const started = Date.now();
    expect(await searchMyPrs()).toEqual([]);
    expect(Date.now() - started).toBeLessThan(8000);

    const pid = await readPid(pidFile);
    expect(await waitUntilDead(pid)).toBe(true);
  });
});

describe("searchReviewRequestedPrs deadline", () => {
  it("rejects at the shared deadline and kills a gh that ignores SIGTERM", async () => {
    const pidFile = stalledGh();
    process.env.GH_TIMEOUT_MS = DEADLINE_MS;

    const started = Date.now();
    await expect(searchReviewRequestedPrs()).rejects.toThrow(/gh search failed/);
    expect(Date.now() - started).toBeLessThan(8000);

    const pid = await readPid(pidFile);
    expect(await waitUntilDead(pid)).toBe(true);
  });
});

describe("synchronous runner timeout (via viewPr)", () => {
  it("returns null at the deadline and kills a gh that ignores SIGTERM", async () => {
    const pidFile = stalledGh();
    process.env.GH_TIMEOUT_MS = DEADLINE_MS;

    const started = Date.now();
    expect(viewPr("https://github.com/a/b/pull/1")).toBeNull();
    expect(Date.now() - started).toBeLessThan(8000);

    const pid = await readPid(pidFile);
    expect(await waitUntilDead(pid)).toBe(true);
  });
});
