// Run a slash command inside a named tmux session and track it as a job.
//
// Each job gets its own tmux session (ccenter-<id>) instead of a
// bare child process. That buys two things a piped child process can't: a
// human can `tmux attach -t ccenter-<id>` and watch/drive the same pane
// the dashboard is polling — one source of truth, not a separate log that can
// drift from what attaching would show — and a session survives an API
// restart, so syncJobsFromTmux() can re-discover and keep listing it.
//
// `tmux new-session -d` returns as soon as the detached session exists; it
// does not wait for the inner command to finish. Completion is detected by
// polling, not by a child-process exit event, because there is no long-lived
// child here to listen to.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasBrainContent } from "./brain.js";
import { PEARL_NAME, SESSION as PEARL_SESSION } from "./lib/pearl-session.js";
import {
  findTranscript,
  inputBoxIsEmpty,
  readTranscriptTail,
  relayIfUndelivered,
  TMUX_TIMEOUT_MS,
} from "./lib/report-relay.js";

const MAX_LOG_CHARS = 100_000;
const SESSION_PREFIX = "ccenter-";
const JOBS_DIR = join(tmpdir(), "ccenter-jobs");
const POLL_INTERVAL_MS = 2000;

mkdirSync(JOBS_DIR, { recursive: true });

const jobs = new Map();

function truncate(text) {
  if (text.length <= MAX_LOG_CHARS) return text;
  return `…[earlier output truncated]\n${text.slice(-MAX_LOG_CHARS)}`;
}

// Headless (`-p`) still runs inside a tmux pty, so a tool permission check
// that `--permission-mode acceptEdits` doesn't cover (Bash, WebFetch, an
// AskUserQuestion call) renders its interactive prompt into that pane and
// then blocks forever — nobody is attached to answer it. There's no exit
// code or structured event for this (that needs `--output-format
// stream-json`, a bigger change), so this reads the one thing we already
// capture every poll: the pane's own tail.
//
// Verified against the installed `claude` binary's own strings rather than
// assumed: it contains "Do you want to proceed?", "Do you want to allow
// Claude to fetch this content?", "Do you want to allow this connection?",
// "Do you want to continue?", and "Do you want to use this API key?" — all
// "Do you want to ...?", so that's the pattern, not one hardcoded phrase.
// The bare "❯ N." cursor-menu line (that glyph is also genuinely present in
// the binary, not guessed) is the more general signal on top of it — any
// numbered choice sitting there with a selection cursor on it means
// something is waiting on a keypress, independent of the exact wording.
const NEEDS_INPUT_QUESTION = /Do you want to [^\n?]*\?/;
const NEEDS_INPUT_MENU_CURSOR = /^\s*❯\s*\d+\./m;

function needsInput(paneText) {
  const tail = paneText.slice(-2000);
  if (NEEDS_INPUT_QUESTION.test(tail)) return true;
  return NEEDS_INPUT_MENU_CURSOR.test(tail);
}

function sessionNameFor(id) {
  return `${SESSION_PREFIX}${id}`;
}

function idFromSessionName(name) {
  return name.slice(SESSION_PREFIX.length);
}

function promptFilePath(id) {
  return join(JOBS_DIR, `${id}.prompt`);
}

function exitFilePath(id) {
  return join(JOBS_DIR, `${id}.exit`);
}

function metaFilePath(id) {
  return join(JOBS_DIR, `${id}.meta.json`);
}

function relayClaimPath(id) {
  return join(JOBS_DIR, `${id}.relay`);
}

// The only shell-interpolated parts are paths we generated ourselves
// (uuid-based, no quotes/spaces) — the arbitrary user prompt text goes
// through `cat` on a file, never through shell string interpolation, so it
// can contain quotes, newlines, anything, without an escaping hazard.
//
// "headless" (`-p`) runs once and exits — the exit code is captured so
// polling can tell completion from a glance at a file. "interactive" drops
// `-p` entirely: the prompt is still the first message, but the session
// then stays open for a human to keep talking to it, same as Pearl. There's
// deliberately no exit-code capture for interactive — it isn't "done" when
// Claude's reply finishes, only when the human closes it (or exits the
// shell themselves, which the existing "tmux session ended" handling in
// pollRunningJobs already covers, just without a numeric exit code).
//
// --permission-mode auto (not acceptEdits) — same mode Pearl runs in, so
// every spawned agent (headless, interactive, or Pearl herself) behaves
// consistently rather than each path having its own permission posture.
//
// extraArgs is a pre-quoted string fragment (e.g. `--add-dir '/path'`), not
// an array — it's spliced into a shell string built by this same function,
// so the caller quotes it the same way promptFile/exitFile already are.
//
// An interactive session is started with a --session-id we choose, so its
// transcript path is known up front (~/.claude/projects/*/<id>.jsonl) and
// report-relay.js can read it without guessing which session is whose.
function innerCommand({ promptFile, exitFile, mode, extraArgs = "", sessionId }) {
  const suffix = extraArgs ? ` ${extraArgs}` : "";
  if (mode === "interactive") {
    const session = sessionId ? ` --session-id ${sessionId}` : "";
    return `claude "$(cat '${promptFile}')" --permission-mode auto${session}${suffix}`;
  }
  return `claude -p "$(cat '${promptFile}')" --permission-mode auto${suffix}; echo $? > '${exitFile}'`;
}

function writeMetaFile(id, meta) {
  try {
    writeFileSync(metaFilePath(id), JSON.stringify(meta), "utf-8");
  } catch {
    // Metadata is a recovery aid, not load-bearing for the job that's about
    // to run — a write failure here shouldn't block starting it.
  }
}

function readMetaFile(id) {
  try {
    return JSON.parse(readFileSync(metaFilePath(id), "utf-8"));
  } catch {
    return null;
  }
}

// The one thing that makes a relay at-most-once: creating the file fails if it
// already exists, atomically, so of two API processes (DASHBOARD_PORT allows
// it) or two polls only one gets to paste. EEXIST means someone else holds it;
// any other error propagates so the relay aborts instead of sending unclaimed.
function claimRelay(id) {
  try {
    writeFileSync(relayClaimPath(id), String(process.pid), { flag: "wx" });
    return true;
  } catch (err) {
    if (err.code === "EEXIST") return false;
    throw err;
  }
}

// Read-modify-write so persisting the relay state doesn't clobber the rest of
// the recovery metadata. This is the displayed outcome, not the guard: a lost
// write here can't cause a second paste, because the claim file already exists. A job adopted without a meta file has no session id
// and is never relayed, so there is nothing to merge into.
function persistRelay(job) {
  const meta = readMetaFile(job.id);
  if (!meta) return;
  writeMetaFile(job.id, { ...meta, relay: job.relay });
}

function listLiveSessionNames() {
  try {
    const out = execFileSync(
      "tmux",
      ["list-sessions", "-F", "#{session_name}"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    // No tmux server running yet, or it has zero sessions — both report as a
    // non-zero exit, not an empty list. Expected and frequent (every poll
    // tick until the first job starts), so stderr is suppressed above rather
    // than left to print tmux's "no server running" noise every 2s.
    return [];
  }
}

// Adopts any live ccenter-* session this process doesn't already know
// about — one started by a previous (now-dead) API process, or one started
// outside the dashboard entirely that happens to match the naming scheme.
// Metadata is recovered from JOBS_DIR when present; otherwise the job is
// shown with what's actually knowable (the session exists and is running).
function syncJobsFromTmux() {
  for (const session of listLiveSessionNames()) {
    if (!session.startsWith(SESSION_PREFIX)) continue;
    // Pearl's singleton session shares this naming convention but isn't a
    // per-dispatch job — she's a persistent supervisor (see pearl.js) and
    // would otherwise show up here forever stuck at "running" with a
    // garbled prompt. Compared against the computed SESSION (not the
    // literal "ccenter-pearl") so a renamed supervisor (PEARL_NAME) is still
    // recognized as itself instead of being adopted as a job.
    if (session === PEARL_SESSION) continue;
    const id = idFromSessionName(session);
    if (jobs.has(id)) continue;

    const meta = readMetaFile(id);
    jobs.set(id, {
      id,
      ticketKey: meta?.ticketKey ?? null,
      title: meta?.title ?? null,
      prompt: meta?.prompt ?? "(tmux session adopted — no local metadata)",
      cwd: meta?.cwd ?? null,
      mode: meta?.mode ?? "headless",
      sessionId: meta?.sessionId ?? null,
      relay: meta?.relay ?? null,
      tmuxSession: session,
      status: "running",
      startedAt: meta?.startedAt ?? null,
      finishedAt: null,
      exitCode: null,
      log: "",
      error: null,
    });
  }
}

// What the supervisor's terminal can take right now. "busy" covers both a
// question on screen (typing would answer it) and text already in the input
// box (pasting would splice into it), and also a tmux call that timed out, so
// the caller retries rather than giving up on a transient hiccup.
function supervisorState() {
  try {
    execFileSync("tmux", ["has-session", "-t", PEARL_SESSION], {
      stdio: "ignore",
      timeout: TMUX_TIMEOUT_MS,
    });
  } catch (err) {
    return err.code === "ETIMEDOUT" ? "busy" : "absent";
  }
  try {
    const pane = execFileSync("tmux", ["capture-pane", "-t", PEARL_SESSION, "-p"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: TMUX_TIMEOUT_MS,
    });
    return needsInput(pane) || !inputBoxIsEmpty(pane) ? "busy" : "ready";
  } catch {
    return "busy";
  }
}

// Types into the supervisor's terminal, which pearl.js deliberately avoids
// for driving her (a TUI can't be typed into blind). It is acceptable here
// because supervisorState() has just confirmed she is at an empty prompt, and
// the text is a single sanitized line. A bracketed paste plus Enter in one tmux
// invocation, so nothing can interleave between the paste and the submit.
function deliverToSupervisor(message) {
  const buffer = `ccrelay-${process.pid}`;
  execFileSync("tmux", ["load-buffer", "-b", buffer, "-"], {
    input: message,
    stdio: ["pipe", "ignore", "ignore"],
    timeout: TMUX_TIMEOUT_MS,
  });
  execFileSync(
    "tmux",
    ["paste-buffer", "-p", "-d", "-b", buffer, "-t", PEARL_SESSION, ";", "send-keys", "-t", PEARL_SESSION, "Enter"],
    { stdio: "ignore", timeout: TMUX_TIMEOUT_MS },
  );
}

const relayDeps = {
  supervisorName: PEARL_NAME,
  now: () => Date.now(),
  readPersisted: readMetaFile,
  persist: persistRelay,
  claim: claimRelay,
  locateTranscript: findTranscript,
  readTranscript: readTranscriptTail,
  supervisorState,
  deliver: deliverToSupervisor,
  log: (message) => console.warn(`[relay] ${message}`),
};

// A relay is a courtesy on top of polling and closing, never part of them: any
// failure here is logged and swallowed so it can't stop a job from being
// polled or closed.
function tryRelay(job, options) {
  try {
    return relayIfUndelivered(job, relayDeps, options);
  } catch (err) {
    console.warn(`[relay] job ${job.id}: ${err.message}`);
    return "error";
  }
}

function finish(job, { exitCode, error }) {
  job.exitCode = exitCode;
  job.error = error ?? job.error;
  job.status = exitCode === 0 ? "succeeded" : "failed";
  job.finishedAt = new Date().toISOString();
}

function pollRunningJobs() {
  syncJobsFromTmux();

  for (const job of jobs.values()) {
    if (job.status !== "running" && job.status !== "needs_input") continue;

    let pane;
    try {
      pane = execFileSync(
        "tmux",
        ["capture-pane", "-t", job.tmuxSession, "-p", "-S", "-"],
        { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
      );
    } catch (err) {
      // The session is gone without ever writing an exit marker — e.g.
      // someone ran `tmux kill-session` by hand.
      finish(job, { exitCode: null, error: `tmux session ended: ${err.message}` });
      continue;
    }

    job.log = truncate(pane);

    if (existsSync(exitFilePath(job.id))) {
      const raw = readFileSync(exitFilePath(job.id), "utf-8").trim();
      const code = Number.parseInt(raw, 10);
      finish(job, { exitCode: Number.isNaN(code) ? null : code });
      continue;
    }

    // Finishing takes priority over this — a prompt that got answered and
    // then exited shouldn't flicker back to "needs input" on its last poll.
    job.status = needsInput(pane) ? "needs_input" : "running";
    if (job.status === "running") tryRelay(job);
  }
}

syncJobsFromTmux();
setInterval(pollRunningJobs, POLL_INTERVAL_MS);

// Start a command. Returns the job record immediately; the caller polls it.
//
// `cwd` is the ticket's resolved repo root: these commands operate on branches
// and worktrees, so running them from the dashboard's own directory would
// target the wrong repo.
//
// `id` is optional — the caller passes one in when it needs the job's id
// before the job exists (the brain dir path goes into both composedPrompt
// and extraArgs before this is called; every /api/dispatch call does this
// now). Defaults to a fresh uuid otherwise.
//
// `extraArgs` is a pre-quoted shell string fragment appended to the `claude`
// invocation (currently just the brain dir's `--add-dir`).
export function startCommandJob({
  id = randomUUID(),
  ticketKey,
  title,
  prompt,
  cwd,
  now,
  mode = "headless",
  extraArgs = "",
}) {
  const session = sessionNameFor(id);
  const sessionId = mode === "interactive" ? randomUUID() : null;

  const job = {
    id,
    ticketKey,
    title,
    prompt,
    cwd,
    mode,
    sessionId,
    relay: null,
    tmuxSession: session,
    status: "running",
    startedAt: now,
    finishedAt: null,
    exitCode: null,
    log: "",
    error: null,
  };
  jobs.set(id, job);

  writeFileSync(promptFilePath(id), prompt, "utf-8");
  writeMetaFile(id, { id, ticketKey, title, prompt, cwd, mode, sessionId, startedAt: now });

  try {
    execFileSync("tmux", [
      "new-session",
      "-d",
      "-s",
      session,
      "-c",
      cwd,
      "bash",
      "-c",
      innerCommand({ promptFile: promptFilePath(id), exitFile: exitFilePath(id), mode, extraArgs, sessionId }),
    ]);
    // Without this, tmux kills the pane the instant the inner command exits —
    // attaching a few seconds late would show nothing, and the final output
    // (the result a human most wants) would already be gone.
    execFileSync("tmux", ["set-option", "-t", session, "remain-on-exit", "on"]);
  } catch (err) {
    finish(job, { exitCode: null, error: err.message });
  }

  return job;
}

// Serializable view of a job. The log is only included on request so the job
// list stays small. hasBrain is checked on disk rather than tracked on the
// job object — it survives an API restart (syncJobsFromTmux adopts a job
// with no meta file) the same way the brain dir itself does. Every job has a
// brain dir now (see server.js /api/dispatch), so this reflects whether the
// agent actually wrote to it, not whether one exists.
export function serializeJob(job, { includeLog = false } = {}) {
  if (!job) return null;
  const { log, ...rest } = job;
  const withBrain = { ...rest, hasBrain: hasBrainContent(job.id) };
  return includeLog ? { ...withBrain, log } : withBrain;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function listJobs() {
  syncJobsFromTmux();
  return [...jobs.values()];
}

// Jobs still running, keyed by ticket. Used to stop a second run being started
// against a ticket that already has one in flight.
export function findRunningJobForTicket(ticketKey) {
  for (const job of jobs.values()) {
    // needs_input is still a live session (stuck, not done) — it should
    // still block a second dispatch and still show the ticket row's
    // jump-to-session button instead of reverting to "spawn".
    if (job.ticketKey === ticketKey && (job.status === "running" || job.status === "needs_input")) {
      return job;
    }
  }
  return null;
}

// ttys of iTerm2 panes currently attached to `session`, per tmux itself —
// the same source of truth tmux uses to decide whether a session has a live
// client. Empty whenever the session doesn't exist or nothing is attached
// (both report as a non-zero exit from `list-clients`), which just means
// there's nothing to find a window for, not an error worth surfacing.
function attachedTtys(session) {
  try {
    const out = execFileSync("tmux", ["list-clients", "-t", session], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .map((line) => line.split(":")[0].trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Brings an already-open iTerm2 window to the front instead of creating a
// new one, if one of its panes' ttys matches a tty tmux reports as attached
// to the session. Returns false (not an error) when nothing matches, so the
// caller falls back to creating a window the same way it always has.
function focusExistingWindow(ttys) {
  // ttys come from tmux's own `list-clients` output, never user input, so
  // interpolating them into the AppleScript source is safe — same reasoning
  // as the shell-command paths above.
  const ttyChecks = ttys.map((tty) => `tty of s is "${tty}"`).join(" or ");

  const script = `
tell application "iTerm"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if ${ttyChecks} then
          select w
          select t
          return true
        end if
      end repeat
    end repeat
  end repeat
  return false
end tell`;

  try {
    const out = execFileSync("osascript", ["-e", script], { encoding: "utf-8" });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

// Opens a real iTerm2 window on this machine and attaches it to the given
// tmux session, reusing an already-attached window instead of creating a
// duplicate one if the session already has an open iTerm2 pane. Only
// meaningful when the dashboard's own server process is running on the same
// Mac as the person clicking the button — same trust model as the rest of
// this app, which assumes a single local user and has no auth of its own.
// Shared by openInIterm (per-job) and pearl.js (her one persistent session)
// rather than duplicated between them.
export function openSessionInIterm(session) {
  if (process.platform !== "darwin") {
    return { ok: false, error: "Opening iTerm is only supported on macOS" };
  }

  const ttys = attachedTtys(session);
  if (ttys.length > 0 && focusExistingWindow(ttys)) {
    return { ok: true };
  }

  // `session` is always our own uuid-derived or fixed string (never user
  // input), so interpolating it into the AppleScript source is safe — same
  // reasoning as the shell-command paths above.
  // `activate` matters, not just cosmetically: without it, iTerm may not be
  // the frontmost app yet when "current window" resolves, and that
  // resolution can land on whatever window actually is frontmost instead of
  // the one just created — the window still gets created, but the attach
  // command gets typed nowhere visible.
  const script = `
tell application "iTerm"
  activate
  create window with default profile
  tell current session of current window
    write text "tmux attach -t ${session}"
  end tell
end tell`;

  try {
    execFileSync("osascript", ["-e", script]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function openInIterm(id) {
  const job = jobs.get(id);
  if (!job) return { ok: false, error: "Unknown job" };
  return openSessionInIterm(job.tmuxSession);
}

// Closing always removes the job from the list, live or not — there's no
// separate "dismiss a finished card" action, just this one. For a live job
// it also kills the underlying tmux session first; a job that's already
// finished has none to kill.
export function closeJob(id) {
  const job = jobs.get(id);
  if (!job) return { ok: false, error: "Unknown job" };

  // Last chance to tell the supervisor what an idle session said: once the
  // job is deleted below, nothing will. Only acts on a session that finished
  // its turn without reporting; a working or needs_input one is left alone.
  tryRelay(job, { closing: true });

  // Always kill the tmux session, not just for running/needs_input jobs.
  // `remain-on-exit` deliberately keeps a finished job's pane alive (so a
  // human can still attach and read it) — closing a finished card without
  // killing it would leave that session an orphan with no job record, and
  // syncJobsFromTmux would then re-adopt it on the next poll with no meta
  // file, forcing status back to "running" with startedAt: null. That's
  // exactly the zombie this bug produced before this was unconditional.
  try {
    execFileSync("tmux", ["kill-session", "-t", job.tmuxSession]);
  } catch (err) {
    // kill-session also fails if the session is already gone — confirm
    // that's actually why before reporting success. Otherwise this deletes
    // the job record while the real agent keeps running, now unmonitored.
    const stillAlive = (() => {
      try {
        execFileSync("tmux", ["has-session", "-t", job.tmuxSession], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })();
    if (stillAlive) {
      return { ok: false, error: `Failed to close session: ${err.message}` };
    }
  }

  jobs.delete(id);
  for (const path of [promptFilePath(id), exitFilePath(id), metaFilePath(id), relayClaimPath(id)]) {
    try {
      unlinkSync(path);
    } catch {
      // Best-effort cleanup, same as writeMetaFile's own failure handling.
    }
  }

  return { ok: true };
}

export const __test__ = {
  jobs,
  MAX_LOG_CHARS,
  truncate,
  sessionNameFor,
  idFromSessionName,
  innerCommand,
  needsInput,
  syncJobsFromTmux,
  supervisorState,
  deliverToSupervisor,
  persistRelay,
  claimRelay,
  relayClaimPath,
  tryRelay,
};
