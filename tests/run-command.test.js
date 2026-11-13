import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeJob, __test__ } from "../api/run-command.js";

const {
  truncate,
  MAX_LOG_CHARS,
  sessionNameFor,
  idFromSessionName,
  innerCommand,
  needsInput,
  tryRelay,
  claimRelay,
  relayClaimPath,
} = __test__;

describe("truncate", () => {
  it("leaves a short log untouched", () => {
    expect(truncate("hello")).toBe("hello");
  });

  it("keeps the tail, not the head, once the cap is passed", () => {
    // The end of a command's output is where the failure and result are; the
    // beginning is setup noise.
    const log = `START${"x".repeat(MAX_LOG_CHARS)}END`;
    const result = truncate(log);
    expect(result).toContain("END");
    expect(result).not.toContain("START");
    expect(result).toContain("earlier output truncated");
  });

  it("keeps the result bounded", () => {
    const log = "y".repeat(MAX_LOG_CHARS * 3);
    // Bounded by the cap plus the notice line, not by the input size.
    expect(truncate(log).length).toBeLessThan(MAX_LOG_CHARS + 100);
  });

  it("does not truncate a log exactly at the cap", () => {
    const log = "z".repeat(MAX_LOG_CHARS);
    expect(truncate(log)).toBe(log);
  });
});

describe("sessionNameFor / idFromSessionName", () => {
  it("prefixes the id with ccenter-", () => {
    expect(sessionNameFor("abc-123")).toBe("ccenter-abc-123");
  });

  it("round-trips through idFromSessionName", () => {
    const id = "f3a9c1e2-0000-0000-0000-000000000000";
    expect(idFromSessionName(sessionNameFor(id))).toBe(id);
  });
});

describe("innerCommand", () => {
  it("reads the prompt from a file rather than inlining it", () => {
    const cmd = innerCommand({ promptFile: "/tmp/x.prompt", exitFile: "/tmp/x.exit" });
    expect(cmd).toContain("$(cat '/tmp/x.prompt')");
  });

  it("writes the exit code to the exit file", () => {
    const cmd = innerCommand({ promptFile: "/tmp/x.prompt", exitFile: "/tmp/x.exit" });
    expect(cmd).toContain("echo $? > '/tmp/x.exit'");
  });

  it("runs claude in --permission-mode auto", () => {
    const cmd = innerCommand({ promptFile: "/tmp/x.prompt", exitFile: "/tmp/x.exit" });
    expect(cmd).toContain("claude -p");
    expect(cmd).toContain("--permission-mode auto");
  });

  it("defaults to headless (-p, with exit-code capture) when mode is omitted", () => {
    const cmd = innerCommand({ promptFile: "/tmp/x.prompt", exitFile: "/tmp/x.exit" });
    expect(cmd).toContain("claude -p");
    expect(cmd).toContain("echo $? > '/tmp/x.exit'");
  });

  it("drops -p and exit-code capture entirely for interactive mode", () => {
    const cmd = innerCommand({
      promptFile: "/tmp/x.prompt",
      exitFile: "/tmp/x.exit",
      mode: "interactive",
    });
    expect(cmd).not.toContain("claude -p");
    expect(cmd).not.toContain("/tmp/x.exit");
    expect(cmd).toContain("claude \"$(cat '/tmp/x.prompt')\"");
    expect(cmd).toContain("--permission-mode auto");
  });
});

describe("innerCommand session id", () => {
  const base = { promptFile: "/tmp/x.prompt", exitFile: "/tmp/x.exit" };
  const uuid = "11111111-2222-3333-4444-555555555555";

  it("starts an interactive session with a known --session-id, so its transcript can be found", () => {
    const cmd = innerCommand({ ...base, mode: "interactive", sessionId: uuid });
    expect(cmd).toContain(`--session-id ${uuid}`);
  });

  it("puts the session id before any extra args", () => {
    const cmd = innerCommand({ ...base, mode: "interactive", sessionId: uuid, extraArgs: "--add-dir '/b'" });
    expect(cmd.indexOf("--session-id")).toBeLessThan(cmd.indexOf("--add-dir"));
  });

  it("leaves it off when none is given, and off headless runs", () => {
    expect(innerCommand({ ...base, mode: "interactive" })).not.toContain("--session-id");
    expect(innerCommand({ ...base, sessionId: uuid })).not.toContain("--session-id");
  });
});

describe("tryRelay", () => {
  it("never lets a relay failure escape into polling or closing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Reading status throws partway through relayIfUndelivered.
    const job = {
      id: "j",
      mode: "interactive",
      sessionId: "s",
      relay: null,
      get status() {
        throw new Error("boom");
      },
    };
    expect(() => tryRelay(job, { closing: true })).not.toThrow();
    expect(tryRelay(job)).toBe("error");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does nothing for a job with no relay to make", () => {
    expect(tryRelay({ id: "j", mode: "headless", relay: null, status: "running" })).toBe("not-applicable");
  });
});

describe("claimRelay", () => {
  const id = `claim-test-${process.pid}`;

  afterEach(() => {
    rmSync(relayClaimPath(id), { force: true });
  });

  it("succeeds once and then reports the claim as held, atomically", () => {
    expect(claimRelay(id)).toBe(true);
    expect(claimRelay(id)).toBe(false);
  });

  it("raises on a failure that is not 'already claimed', so the relay aborts", () => {
    // A path under a directory that does not exist fails with ENOENT, not EEXIST.
    expect(() => claimRelay("missing-dir/nested/id")).toThrow();
  });
});

describe("needsInput", () => {
  it("is false for ordinary output", () => {
    expect(needsInput("Reading file...\nEditing foo.js\nDone.")).toBe(false);
  });

  it("detects Claude Code's permission-dialog phrasing", () => {
    const pane = [
      "Bash command",
      "  rm -rf dist/",
      "",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No, and tell Claude what to do differently",
    ].join("\n");
    expect(needsInput(pane)).toBe(true);
  });

  it("detects a bare numbered-menu cursor as a generic signal", () => {
    const pane = ["Pick one:", "❯ 1. Yes", "  2. No"].join("\n");
    expect(needsInput(pane)).toBe(true);
  });

  // Each phrasing below is copied from a string actually present in the
  // installed `claude` binary (verified via `strings`), not guessed —
  // they're different tool types' permission dialogs, all matching the
  // same "Do you want to ...?" shape the detector looks for.
  it.each([
    "Do you want to allow Claude to fetch this content?",
    "Do you want to allow this connection?",
    "Do you want to continue?",
    "Do you want to use this API key?",
  ])("detects the %j permission-dialog variant", (question) => {
    expect(needsInput(`Some tool output\n${question}\n❯ 1. Yes`)).toBe(true);
  });

  it("does not false-positive on a question that isn't a permission prompt", () => {
    expect(needsInput("Do you want fries with that? Just kidding, done.")).toBe(false);
  });

  it("only looks at the tail, not the whole scrollback", () => {
    const stale = "Do you want to proceed?\n❯ 1. Yes\n";
    const pane = stale + "x".repeat(3000) + "\nAll done, nothing pending.";
    expect(needsInput(pane)).toBe(false);
  });
});

describe("syncJobsFromTmux", () => {
  const originalPearlName = process.env.PEARL_NAME;

  afterEach(() => {
    if (originalPearlName === undefined) delete process.env.PEARL_NAME;
    else process.env.PEARL_NAME = originalPearlName;
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  // Loads a fresh copy of run-command.js (and, transitively, pearl-session.js)
  // so PEARL_NAME is re-read, with tmux's session list stubbed rather than
  // shelling out for real.
  async function loadWithSessions(sessionNames) {
    vi.doMock("node:child_process", () => ({
      execFileSync: (cmd, args) => {
        if (cmd === "tmux" && args[0] === "list-sessions") {
          return sessionNames.join("\n");
        }
        throw new Error(`unexpected execFileSync call in test: ${cmd} ${args.join(" ")}`);
      },
    }));
    vi.resetModules();
    const mod = await import("../api/run-command.js");
    return mod.__test__;
  }

  it("does not adopt the supervisor's own session under a non-default PEARL_NAME", async () => {
    process.env.PEARL_NAME = "Jarvis";
    const t = await loadWithSessions(["ccenter-jarvis", "ccenter-abc123"]);
    t.syncJobsFromTmux();
    expect(t.jobs.has("jarvis")).toBe(false);
    expect(t.jobs.has("abc123")).toBe(true);
  });

  it("still skips the default ccenter-pearl session when PEARL_NAME is unset", async () => {
    delete process.env.PEARL_NAME;
    const t = await loadWithSessions(["ccenter-pearl", "ccenter-abc123"]);
    t.syncJobsFromTmux();
    expect(t.jobs.has("pearl")).toBe(false);
    expect(t.jobs.has("abc123")).toBe(true);
  });
});

describe("serializeJob", () => {
  const job = {
    id: "abc",
    ticketKey: "PROJ-1",
    tmuxSession: "ccenter-abc",
    prompt: "/cleanup-main PROJ-1 --yes",
    status: "running",
    log: "lots of output",
  };

  it("omits the log by default so the job list stays small", () => {
    const result = serializeJob(job);
    expect(result).not.toHaveProperty("log");
    expect(result).toMatchObject({ id: "abc", ticketKey: "PROJ-1" });
  });

  it("includes the tmux session name so the UI can show an attach command", () => {
    expect(serializeJob(job).tmuxSession).toBe("ccenter-abc");
  });

  it("includes the log on request", () => {
    expect(serializeJob(job, { includeLog: true }).log).toBe("lots of output");
  });

  it("returns null for a missing job", () => {
    expect(serializeJob(null)).toBeNull();
    expect(serializeJob(undefined)).toBeNull();
  });

  it("does not mutate the job it serializes", () => {
    serializeJob(job);
    expect(job.log).toBe("lots of output");
  });
});
