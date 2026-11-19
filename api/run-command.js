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
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasBrainContent } from "./brain.js";
import {
  CONNECTION_ERROR_TEXT,
  DIALOG_QUESTION,
  chatPromptIsEmpty,
  endsInConnectionError,
  isAtChatPrompt,
} from "./lib/pane.js";
import { NOTICE_TAG, PEARL_NAME, SESSION as PEARL_SESSION } from "./lib/pearl-session.js";
import {
  findTranscript,
  inferAwaiting,
  inputBoxIsEmpty,
  QUIET_MS,
  readTranscriptTail,
  relayIfUndelivered,
  TMUX_TIMEOUT_MS,
} from "./lib/report-relay.js";

const MAX_LOG_CHARS = 100_000;
const SESSION_PREFIX = "ccenter-";
const JOBS_DIR = join(tmpdir(), "ccenter-jobs");
const POLL_INTERVAL_MS = 2000;

// Statuses where the tmux session is still alive and unresolved. needs_input
// and connection_error are stuck, and idle is the agent stopped and waiting on
// the human; none is done, so each still blocks a second dispatch and keeps
// the ticket row's jump-to-session button. Mirrors LIVE_STATUSES in
// ui/src/jobStatus.js.
const LIVE_STATUSES = new Set(["running", "needs_input", "idle", "connection_error"]);

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
const NEEDS_INPUT_MENU_CURSOR = /^\s*❯\s*\d+\./m;

function hasMenuCursor(paneText) {
  return NEEDS_INPUT_MENU_CURSOR.test(paneText.slice(-2000));
}

function needsInput(paneText) {
  const tail = paneText.slice(-2000);
  if (DIALOG_QUESTION.test(tail)) return true;
  return NEEDS_INPUT_MENU_CURSOR.test(tail);
}

function isLive(status) {
  return LIVE_STATUSES.has(status);
}

// A Claude Code API failure ("API Error: Connection lost mid-response") ends
// the turn and leaves the agent idle at its prompt: no exit code, no
// permission dialog, and the agent never reports because it believes it is
// waiting for the user. It is a status of its own (not a flag on "running")
// because every consumer already branches on status. needsInput() above looks
// for a dialog anywhere in the tail, so an old dialog still on screen matches
// it too; the poll therefore asks this first. It is true only when the error is
// the newest thing in the pane, which a newer dialog is not. The text matching
// and "is it still the latest state" rules live in lib/pane.js.
function connectionError(paneText) {
  return endsInConnectionError(paneText);
}

// What a live job's status should be, given its pane and (interactive only)
// the state its own hooks last wrote. A connection error is checked first: it
// is only true when the error is the newest thing in the pane, and it is the
// more specific fact whether or not a Stop hook also fired after it.
//
// After that, needs_input wins over idle on purpose: a prompt on screen is the
// more urgent fact, and the pane check is the only signal that can see one.
// Hooks alone can't tell "stopped" from "blocked on a permission dialog" — the
// Stop hook never fires for a turn that's still waiting on one, so the state
// stays "running" there and the pane decides.
//
// Once Stop has fired, though, the agent's own closing message is the last
// thing on screen, and it can contain "Do you want to ...?" as plain prose.
// So an idle session only counts as needs_input for a rendered menu (the
// "❯ 1." cursor), which prose doesn't produce, e.g. a menu the user opened
// with a slash command.
//
// A stopped session that is waiting on a reply in plain prose (a question,
// options, a `!` command to run) is told apart from one with nothing for the
// user to do by `awaiting`, which comes from the transcript, not the pane: the
// pane can't tell prose from a dialog, and shows grey suggested-prompt text in
// the input box that is neither a question nor a reply. The user's reply needs
// no pane signal either: UserPromptSubmit writes "running" and this stops being
// asked. It reuses needs_input, with `reason` saying which kind, so every
// consumer of that status keeps working.
//
// `turn` identifies which assistant message a question came from, so a job that
// asks a second question is not mistaken for the first one (see trackQuestion).
function resolveLiveState({ mode, paneText, hookState, awaiting = null }) {
  const state = (status, reason = null, note = null, turn = null) => ({ status, reason, note, turn });
  if (connectionError(paneText)) return state("connection_error");
  if (mode === "interactive" && hookState === "idle") {
    if (hasMenuCursor(paneText)) return state("needs_input", "permission");
    if (awaiting) return state("needs_input", "question", awaiting.note ?? null, awaiting.turn ?? null);
    return state("idle");
  }
  return needsInput(paneText) ? state("needs_input", "permission") : state("running");
}

function resolveLiveStatus(args) {
  return resolveLiveState(args).status;
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

function stateFilePath(id) {
  return join(JOBS_DIR, `${id}.state`);
}

// "idle" or "running", as last written by the session's own hooks; null when
// the file doesn't exist (headless job, or an interactive one started before
// these hooks existed) or holds anything else.
function readHookState(id) {
  try {
    const state = readFileSync(stateFilePath(id), "utf-8").trim();
    return state === "idle" || state === "running" ? state : null;
  } catch {
    return null;
  }
}

// Interactive sessions report their own turn boundaries through Claude Code
// hooks, scoped to this one session via --settings (an additional settings
// source, same trick as Pearl's speech hook in pearl.js) so nothing in
// ~/.claude/settings.json is touched. Stop fires when the agent finishes its
// turn and sits at the prompt; UserPromptSubmit fires the moment the human
// types again. PreToolUse also flips back to running because another Stop
// hook can block a stop and make the agent carry on without any new prompt;
// without it the card would read idle while work continues. The command
// quotes the path with double quotes (escaped by JSON.stringify) so the whole
// settings blob can sit inside single quotes in the shell string.
function hookSettings(stateFile) {
  const write = (state) => ({
    hooks: [{ type: "command", command: `printf ${state} > "${stateFile}"` }],
  });
  return JSON.stringify({
    hooks: {
      Stop: [write("idle")],
      UserPromptSubmit: [write("running")],
      PreToolUse: [write("running")],
    },
  });
}

function relayClaimPath(id) {
  return join(JOBS_DIR, `${id}.relay`);
}

// Present while the supervisor has been told about the job's current
// connection error (or we gave up trying). On disk rather than on the job so
// an API restart (`node --watch` restarts on every edit) does not re-announce
// a session that is still stuck. Ids come from tmux session names, which can
// hold anything, so an id outside SAFE_ID gets no marker (null) rather than a
// path that could leave JOBS_DIR.
const SAFE_ID = /^[A-Za-z0-9-]+$/;

function connectionErrorMarkerPath(id) {
  return SAFE_ID.test(id) ? join(JOBS_DIR, `${id}.connection-error`) : null;
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
// pollRunningJobs already covers, just without a numeric exit code). What it
// does get is hookSettings' state file, so the dashboard can tell "agent
// stopped, waiting on the human" (idle) from "agent working" (running).
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
function innerCommand({ promptFile, exitFile, stateFile, mode, extraArgs = "", sessionId }) {
  const suffix = extraArgs ? ` ${extraArgs}` : "";
  if (mode === "interactive") {
    const session = sessionId ? ` --session-id ${sessionId}` : "";
    const hooks = stateFile ? ` --settings '${hookSettings(stateFile)}'` : "";
    return `claude "$(cat '${promptFile}')" --permission-mode auto${session}${hooks}${suffix}`;
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
      needsInputReason: null,
      needsInputNote: null,
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

// Like tryRelay, a courtesy that must never break the poll: when the transcript
// can't be read the session simply stays idle, which is what it showed before.
function tryAwaiting(job) {
  try {
    return inferAwaiting(job, relayDeps);
  } catch (err) {
    console.warn(`[awaiting] job ${job.id}: ${err.message}`);
    return null;
  }
}

function finish(job, { exitCode, error }) {
  job.exitCode = exitCode;
  job.error = error ?? job.error;
  job.status = exitCode === 0 ? "succeeded" : "failed";
  job.finishedAt = new Date().toISOString();
}

// Retries stop after ~1 minute of polls: a supervisor that is stuck on a
// dialog for longer than that is already asking for the human, and the
// session still shows connection_error in the dashboard and /api/jobs.
const NOTICE_MAX_ATTEMPTS = 30;
const TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

// Fixed text plus the job id (and a ticket key only if it has the Jira key
// shape). The title and prompt are deliberately left out: they come from
// Jira and the user, and this string is typed into a supervisor agent's
// input as if the user had written it. NOTICE_TAG is how she tells it apart.
function connectionErrorNotice(job) {
  const ticket = job.ticketKey && TICKET_KEY.test(job.ticketKey) ? ` (${job.ticketKey})` : "";
  return (
    `${NOTICE_TAG} Agent session ${job.id}${ticket} hit "${CONNECTION_ERROR_TEXT}" ` +
    `and is idle at its prompt; its job status is connection_error. Tell the user, and offer to ` +
    `open its terminal (POST /api/jobs/${job.id}/open-terminal) so they can tell it to continue. ` +
    `This is a one-time notice for this error, so don't poll for it.`
  );
}

// The only server-to-supervisor channel is typing into her tmux pane (the
// approach pearl-speak.js uses for voice), which is only safe at an empty,
// framed chat prompt. Anywhere else (a dialog, a half-written draft, no
// session) this declines and the caller retries on the next poll.
function sendNoticeToSupervisor(text) {
  try {
    const pane = execFileSync("tmux", ["capture-pane", "-t", PEARL_SESSION, "-p"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: TMUX_TIMEOUT_MS,
    });
    if (!isAtChatPrompt(pane) || !chatPromptIsEmpty(pane)) return false;

    // One tmux invocation (`;` separates commands) so a failure cannot leave
    // the text typed without the Enter.
    execFileSync(
      "tmux",
      ["send-keys", "-t", PEARL_SESSION, "-l", text, ";", "send-keys", "-t", PEARL_SESSION, "Enter"],
      { stdio: "ignore", timeout: TMUX_TIMEOUT_MS },
    );
    return true;
  } catch {
    return false;
  }
}

// One notice per occurrence: once the supervisor has been told (or we gave
// up) that is recorded on the job and in the marker file, and both are
// cleared as soon as the job leaves connection_error, so a later, separate
// error announces itself again. The in-memory flag is what holds if the
// marker cannot be written (jobs dir gone, disk full); the file only carries
// the state across an API restart.
function trackConnectionError(job) {
  const marker = connectionErrorMarkerPath(job.id);

  if (job.status !== "connection_error") {
    job.noticeAttempts = 0;
    job.noticeDone = false;
    // existsSync first: this runs for every live job on every poll, and
    // almost always there is nothing to remove.
    if (marker && existsSync(marker)) {
      try {
        unlinkSync(marker);
      } catch {
        // Best-effort; worst case the next occurrence is not announced.
      }
    }
    return;
  }

  if (job.noticeDone || (marker && existsSync(marker))) {
    job.noticeDone = true;
    return;
  }

  job.noticeAttempts = (job.noticeAttempts ?? 0) + 1;
  const deliverable = SAFE_ID.test(job.id);
  if (deliverable && sendNoticeToSupervisor(connectionErrorNotice(job))) {
    job.noticeDone = true;
    writeMarker(marker, "notified");
  } else if (!deliverable || job.noticeAttempts >= NOTICE_MAX_ATTEMPTS) {
    console.warn(`connection_error notice for job ${job.id} not delivered; giving up`);
    job.noticeDone = true;
    writeMarker(marker, "gave up");
  }
}

function writeMarker(path, content) {
  if (!path) return;
  try {
    writeFileSync(path, `${content} ${new Date().toISOString()}\n`, "utf-8");
  } catch {
    // Dedupe across an API restart is lost; within this process the job's
    // noticeDone flag still holds. Not worth failing the poll over.
  }
}

// A session that stopped waiting on the user's reply (needs_input, reason
// "question") is announced to the supervisor like a connection error is, with
// two differences. Many sessions can stop at once (a batch finishing), and each
// notice is a turn the supervisor has to take, so the sessions that are due are
// folded into one line that names at most a few of them. And the line is held
// back briefly and rate-limited, so a Stop-hook continuation that flips the
// session straight back to running is never announced, and sessions trickling
// in cannot become a stream of lines.
//
// Two API processes (DASHBOARD_PORT allows it) must not both announce the same
// question or each keep their own rate limit, so the part that decides and
// sends runs under a lock file, rechecks the markers once it holds it, and
// reads the time of the last notice from a file both processes share.
const QUESTION_NOTICE_DELAY_MS = QUIET_MS;
const QUESTION_NOTICE_MIN_GAP_MS = 60_000;
const QUESTION_NOTICE_MAX_IDS = 5;
// A sender holds the lock for one tmux round trip (a few seconds at most), so
// a lock older than this belongs to a process that died holding it.
const QUESTION_LOCK_STALE_MS = 30_000;
let lastQuestionNoticeSent = 0;

function questionNoticeMarkerPath(id) {
  return SAFE_ID.test(id) ? join(JOBS_DIR, `${id}.needs-input-notice`) : null;
}

const questionNoticeLastPath = join(JOBS_DIR, "question-notice.last");
const questionNoticeLockPath = join(JOBS_DIR, "question-notice.lock");

// The marker says which assistant message the announced question came from, so
// a later question from the same session is a new one even when no poll saw the
// session leave the state in between (a quick reply, or the API being down).
function questionMarkerTurn(path) {
  try {
    const match = /turn=(\S+)/.exec(readFileSync(path, "utf-8"));
    return match && match[1] !== "-" ? match[1] : null;
  } catch {
    return null;
  }
}

// True when the marker on disk is for the question the job is waiting on now.
// Without an identity on either side there is nothing to tell them apart by,
// and the marker counts, which is how a job without a transcript id behaves.
function markerIsForCurrentQuestion(marker, job) {
  const turn = job.needsInputTurn ?? null;
  const marked = questionMarkerTurn(marker);
  return turn === null || marked === null || marked === turn;
}

function writeQuestionMarker(job, label) {
  const path = questionNoticeMarkerPath(job.id);
  if (!path) return;
  try {
    writeFileSync(path, `${label} turn=${job.needsInputTurn ?? "-"} ${new Date().toISOString()}\n`, "utf-8");
  } catch {
    // Dedupe across an API restart is lost; within this process the job's
    // questionNoticeDone flag still holds.
  }
}

function removeQuietly(path) {
  try {
    unlinkSync(path);
  } catch {
    // Best-effort; worst case a later question is not announced.
  }
}

function readLastQuestionNoticeAt() {
  try {
    const value = Number.parseInt(readFileSync(questionNoticeLastPath, "utf-8"), 10);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

// Runs `fn` while holding the lock file; skips this poll when another process
// holds it. Returns whether `fn` ran. A lock that cannot be created for any
// other reason (jobs dir gone, disk full) does not stop the notice: that is the
// same best-effort stance the markers take.
function withQuestionLock(now, fn) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(questionNoticeLockPath, String(now), { flag: "wx" });
      break;
    } catch (err) {
      if (err.code !== "EEXIST") {
        fn();
        return true;
      }
      let heldAt = Number.NaN;
      try {
        heldAt = Number.parseInt(readFileSync(questionNoticeLockPath, "utf-8"), 10);
        if (!Number.isFinite(heldAt)) heldAt = statSync(questionNoticeLockPath).mtimeMs;
      } catch {
        // Gone already: the next attempt takes it.
      }
      if (Number.isFinite(heldAt) && Math.abs(now - heldAt) <= QUESTION_LOCK_STALE_MS) return false;
      removeQuietly(questionNoticeLockPath);
      if (attempt === 1) return false;
    }
  }
  try {
    fn();
  } finally {
    removeQuietly(questionNoticeLockPath);
  }
  return true;
}

function isWaitingOnReply(job) {
  return job.status === "needs_input" && job.needsInputReason === "question";
}

// Fixed text plus job ids and Jira-shaped ticket keys. The agent's note and the
// job title are left out for the same reason as in connectionErrorNotice: this
// line is typed into the supervisor as if the user had written it.
function questionNotice(batch) {
  const shown = batch.slice(0, QUESTION_NOTICE_MAX_IDS).map((job) => {
    const ticket = job.ticketKey && TICKET_KEY.test(job.ticketKey) ? ` (${job.ticketKey})` : "";
    return `${job.id}${ticket}`;
  });
  const more =
    batch.length > shown.length ? ` and ${batch.length - shown.length} more (list them with GET /api/jobs)` : "";
  const one = batch.length === 1;
  return (
    `${NOTICE_TAG} ${batch.length} agent ${one ? "session has" : "sessions have"} stopped and ` +
    `${one ? "is" : "are"} waiting for the user's reply (job status needs_input, needsInputReason question): ` +
    `${shown.join(", ")}${more}. Tell the user, and offer to open ${one ? "its terminal" : "their terminals"} ` +
    `(POST /api/jobs/<id>/open-terminal) so they can answer. This is a one-time notice, so don't poll for it.`
  );
}

// Per job, every poll: when it entered the state, which question it is, and
// whether that question was already announced (kept on disk too, so an API
// restart does not announce it again). All of it resets as soon as the job
// leaves the state. It also resets when the question changes without a poll
// having seen the job leave: the user answered and the agent asked again
// within one poll interval, or while the API was down.
function trackQuestion(job, now) {
  const marker = questionNoticeMarkerPath(job.id);

  if (!isWaitingOnReply(job)) {
    job.questionSince = null;
    job.questionTurn = undefined;
    job.questionNoticeDone = false;
    job.questionNoticeAttempts = 0;
    // existsSync first: this runs for every live job on every poll, and
    // almost always there is nothing to remove.
    if (marker && existsSync(marker)) removeQuietly(marker);
    return;
  }

  const turn = job.needsInputTurn ?? null;
  if (job.questionSince == null) {
    job.questionSince = now;
  } else if (job.questionTurn !== turn) {
    job.questionSince = now;
    job.questionNoticeDone = false;
    job.questionNoticeAttempts = 0;
    if (marker) removeQuietly(marker);
  }
  job.questionTurn = turn;

  if (!job.questionNoticeDone && marker && existsSync(marker)) {
    if (markerIsForCurrentQuestion(marker, job)) job.questionNoticeDone = true;
    else removeQuietly(marker);
  }
}

function announceQuestions(now) {
  const due = [...jobs.values()]
    .filter(
      (job) =>
        isLive(job.status) &&
        isWaitingOnReply(job) &&
        !job.questionNoticeDone &&
        job.questionSince != null &&
        now - job.questionSince >= QUESTION_NOTICE_DELAY_MS,
    )
    .sort((a, b) => a.questionSince - b.questionSince);
  if (due.length === 0) return;

  withQuestionLock(now, () => deliverQuestions(now, due));
}

// Runs under the lock. Everything it decides on is read again here, because
// another process may have announced or rate-limited since this poll started.
function deliverQuestions(now, due) {
  // A last notice time in the future means the clock moved (or the file is
  // stale); it cannot be a reason to stay silent.
  const sinceLast = now - Math.max(lastQuestionNoticeSent, readLastQuestionNoticeAt());
  if (sinceLast >= 0 && sinceLast < QUESTION_NOTICE_MIN_GAP_MS) return;

  const batch = [];
  for (const job of due) {
    const marker = questionNoticeMarkerPath(job.id);
    // An id outside SAFE_ID can't be named in a typed line or given a marker.
    if (!marker) {
      job.questionNoticeDone = true;
    } else if (existsSync(marker) && markerIsForCurrentQuestion(marker, job)) {
      job.questionNoticeDone = true;
    } else {
      batch.push(job);
    }
  }
  if (batch.length === 0) return;

  if (sendNoticeToSupervisor(questionNotice(batch))) {
    lastQuestionNoticeSent = now;
    try {
      writeFileSync(questionNoticeLastPath, String(now), "utf-8");
    } catch {
      // The in-memory time still limits this process.
    }
    for (const job of batch) {
      job.questionNoticeDone = true;
      writeQuestionMarker(job, "notified");
    }
    return;
  }

  // The supervisor is busy or mid-draft; retry on the next poll, for about a
  // minute, then give up on the job (the dashboard still shows it).
  for (const job of batch) {
    job.questionNoticeAttempts = (job.questionNoticeAttempts ?? 0) + 1;
    if (job.questionNoticeAttempts >= NOTICE_MAX_ATTEMPTS) {
      console.warn(`needs_input notice for job ${job.id} not delivered; giving up`);
      job.questionNoticeDone = true;
      writeQuestionMarker(job, "gave-up");
    }
  }
}

function pollRunningJobs() {
  syncJobsFromTmux();
  const now = Date.now();

  for (const job of jobs.values()) {
    if (!isLive(job.status)) continue;

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
    // Between the stuck states, whichever is latest in the pane wins:
    // connectionError() is true only when nothing (a dialog included) follows
    // the error, and needsInput() alone cannot tell an old dialog from a live
    // one, so resolveLiveStatus asks the connection error first.
    const hookState = job.mode === "interactive" ? readHookState(job.id) : null;
    const state = resolveLiveState({
      mode: job.mode,
      paneText: pane,
      hookState,
      awaiting: hookState === "idle" ? tryAwaiting(job) : null,
    });
    job.status = state.status;
    job.needsInputReason = state.reason;
    job.needsInputNote = state.note;
    job.needsInputTurn = state.turn;
    trackConnectionError(job);
    trackQuestion(job, now);
    // A "running" or "idle" job is relayed: idle is exactly the session that
    // stopped its turn, which is the one that may have ended without reporting
    // (relayIfUndelivered checks the transcript, not this status). Skipping
    // idle would leave the relay firing only at close. connection_error and a
    // needs_input question already have their own supervisor notices, and
    // needs_input is waiting on a human.
    if (job.status === "running" || job.status === "idle") tryRelay(job);
  }

  announceQuestions(now);
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
    needsInputReason: null,
    needsInputNote: null,
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
      innerCommand({
        promptFile: promptFilePath(id),
        exitFile: exitFilePath(id),
        stateFile: stateFilePath(id),
        mode,
        extraArgs,
        sessionId,
      }),
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
  // The notice fields are poller bookkeeping, not part of the job's API shape.
  const {
    log,
    noticeAttempts,
    noticeDone,
    questionSince,
    questionTurn,
    questionNoticeDone,
    questionNoticeAttempts,
    needsInputTurn,
    ...rest
  } = job;
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
    // needs_input, idle and connection_error are still live sessions (stuck
    // or waiting, not done) — they should still block a second dispatch and
    // still show the ticket row's jump-to-session button instead of reverting
    // to "spawn".
    if (job.ticketKey === ticketKey && isLive(job.status)) {
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

  // Always kill the tmux session, not just for live jobs.
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
  // relayClaimPath(id) is deliberately left behind: it is the at-most-once
  // guard, and another API instance still holding this job would relay it
  // again if the claim were gone along with the metadata.
  for (const path of [
    promptFilePath(id),
    exitFilePath(id),
    metaFilePath(id),
    stateFilePath(id),
    connectionErrorMarkerPath(id),
    questionNoticeMarkerPath(id),
  ].filter(Boolean)) {
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
  isLive,
  resolveLiveStatus,
  resolveLiveState,
  hookSettings,
  stateFilePath,
  readHookState,
  connectionError,
  connectionErrorMarkerPath,
  connectionErrorNotice,
  questionNotice,
  questionNoticeMarkerPath,
  questionNoticeLastPath,
  questionNoticeLockPath,
  QUESTION_LOCK_STALE_MS,
  QUESTION_NOTICE_DELAY_MS,
  QUESTION_NOTICE_MIN_GAP_MS,
  QUESTION_NOTICE_MAX_IDS,
  pollRunningJobs,
  syncJobsFromTmux,
  supervisorState,
  deliverToSupervisor,
  persistRelay,
  claimRelay,
  relayClaimPath,
  tryRelay,
  NOTICE_MAX_ATTEMPTS,
  LIVE_STATUSES,
};
