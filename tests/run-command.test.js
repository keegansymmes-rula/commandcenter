import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeJob, __test__ } from "../api/run-command.js";

const {
  truncate,
  MAX_LOG_CHARS,
  sessionNameFor,
  idFromSessionName,
  innerCommand,
  needsInput,
  isLive,
  resolveLiveStatus,
  hookSettings,
  stateFilePath,
  readHookState,
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

describe("resolveLiveStatus", () => {
  const prompt = "Bash command\n  rm -rf dist/\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No";
  const calm = "All done. Anything else?\n";

  it("is idle for an interactive session whose hooks say the agent stopped", () => {
    expect(resolveLiveStatus({ mode: "interactive", paneText: calm, hookState: "idle" })).toBe("idle");
  });

  it("stays running while the hooks say the agent is working", () => {
    expect(resolveLiveStatus({ mode: "interactive", paneText: calm, hookState: "running" })).toBe("running");
  });

  it("stays running when there is no hook state yet (session predates the hooks)", () => {
    expect(resolveLiveStatus({ mode: "interactive", paneText: calm, hookState: null })).toBe("running");
  });

  it("keeps needs_input over idle when a prompt is on screen", () => {
    expect(resolveLiveStatus({ mode: "interactive", paneText: prompt, hookState: "idle" })).toBe("needs_input");
    expect(resolveLiveStatus({ mode: "interactive", paneText: prompt, hookState: "running" })).toBe("needs_input");
  });

  it("keeps needs_input for a bare menu cursor on an idle session", () => {
    const menu = "Select a model:\n❯ 1. Opus\n  2. Sonnet\n";
    expect(resolveLiveStatus({ mode: "interactive", paneText: menu, hookState: "idle" })).toBe("needs_input");
  });

  it("stays idle when the closing message is a plain-text question", () => {
    const closing = "All done. Do you want to continue with the follow-up ticket?\n";
    expect(resolveLiveStatus({ mode: "interactive", paneText: closing, hookState: "idle" })).toBe("idle");
  });

  it("never reports idle for a headless job, whatever the hook state says", () => {
    expect(resolveLiveStatus({ mode: "headless", paneText: calm, hookState: "idle" })).toBe("running");
  });
});

describe("isLive", () => {
  it.each(["running", "needs_input", "idle"])("treats %s as a live session", (status) => {
    expect(isLive(status)).toBe(true);
  });

  it.each(["succeeded", "failed", undefined])("treats %s as finished", (status) => {
    expect(isLive(status)).toBe(false);
  });
});

describe("interactive hook state", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-hooks-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Runs a hook's command string the way Claude Code would: through a shell.
  function runHook(settings, event) {
    const [{ hooks }] = settings.hooks[event];
    execFileSync("sh", ["-c", hooks[0].command]);
  }

  it("wires Stop to idle, and UserPromptSubmit and PreToolUse back to running", () => {
    const stateFile = join(dir, "job.state");
    const settings = JSON.parse(hookSettings(stateFile));

    runHook(settings, "Stop");
    expect(readFileSync(stateFile, "utf-8")).toBe("idle");

    runHook(settings, "UserPromptSubmit");
    expect(readFileSync(stateFile, "utf-8")).toBe("running");

    runHook(settings, "Stop");
    runHook(settings, "PreToolUse");
    expect(readFileSync(stateFile, "utf-8")).toBe("running");
  });

  it("survives a state path with a space in it", () => {
    const stateFile = join(dir, "with space.state");
    runHook(JSON.parse(hookSettings(stateFile)), "Stop");
    expect(readFileSync(stateFile, "utf-8")).toBe("idle");
  });

  it("passes the settings to claude as one intact argument for interactive jobs", () => {
    const promptFile = join(dir, "job.prompt");
    const stateFile = join(dir, "job.state");
    writeFileSync(promptFile, "do the thing", "utf-8");

    const cmd = innerCommand({ promptFile, exitFile: join(dir, "job.exit"), stateFile, mode: "interactive" });
    // Stand in for the real binary: print each argument on its own line.
    const out = execFileSync("bash", ["-c", `claude() { printf '%s\\n' "$@"; }; ${cmd}`], {
      encoding: "utf-8",
    }).split("\n");

    const flag = out.indexOf("--settings");
    expect(flag).toBeGreaterThan(-1);
    expect(JSON.parse(out[flag + 1])).toEqual(JSON.parse(hookSettings(stateFile)));
  });

  it("does not add hooks to a headless job", () => {
    const cmd = innerCommand({
      promptFile: "/tmp/x.prompt",
      exitFile: "/tmp/x.exit",
      stateFile: "/tmp/x.state",
      mode: "headless",
    });
    expect(cmd).not.toContain("--settings");
  });

  it("reads back only the two states the hooks write", () => {
    const id = `test-${process.pid}-${Date.now()}`;
    const path = stateFilePath(id);
    try {
      expect(readHookState(id)).toBeNull();
      writeFileSync(path, "idle");
      expect(readHookState(id)).toBe("idle");
      writeFileSync(path, "running\n");
      expect(readHookState(id)).toBe("running");
      writeFileSync(path, "garbage");
      expect(readHookState(id)).toBeNull();
    } finally {
      rmSync(path, { force: true });
    }
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
