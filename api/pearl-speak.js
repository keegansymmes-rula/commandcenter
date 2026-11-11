// Pearl's on-demand speech. The Stop hook (wired in only for her own
// session — see pearl.js's --settings arg) runs this with no subcommand and
// caches her condensed reply; it's only spoken when the user asks via a hotkey
// (`say`), or when a turn was started by voice (`ask`, for a dictation tool
// that can shell out directly with the text already known; `preflight` +
// `voice`, the push-to-talk pair driven by Superwhisper's CLI — see
// .plans/push-to-talk-wispr.md). `hush` cuts speech off. Dispatched jobs
// never load this.

// Hammerspoon launches this directly via hs.task with its own explicit
// (and minimal) environment — PEARL_NAME never reaches it that way, so
// without this SESSION below would default to "ccenter-pearl" even when
// the live supervisor has been renamed via .env. Must run before the
// pearl-session.js import evaluates, same ordering reason as server.js.
import "./lib/load-env.js";

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAtChatPrompt } from "./lib/pane.js";
import { SESSION } from "./lib/pearl-session.js";

const TMUX = "/opt/homebrew/bin/tmux";

// Superwhisper's CLI (installed separately via its install-cli.sh, not by
// the app bundle itself) lands in ~/.local/bin, not on the minimal PATH a
// global hotkey tool like Hammerspoon runs with — same reasoning as TMUX
// above. Overridable in case the install lands somewhere else.
const SUPERWHISPER_BIN =
  process.env.PEARL_SUPERWHISPER_BIN?.trim() || join(homedir(), ".local/bin/superwhisper");

// Set this to a mode key (Superwhisper Settings → that mode → its key) once
// the user has configured one with a local voice model and no language-model
// stage. `preflight` switches to it before every recording so Pearl's voice
// path can't silently end up on whatever mode happens to be active
// elsewhere — which, out of the box, uses Superwhisper's cloud model. Left
// unset, `preflight` just uses whatever mode is already active: the easier
// path to a mistake, but not this script's call to force without a key.
const SUPERWHISPER_MODE = process.env.PEARL_SUPERWHISPER_MODE?.trim() || "";

// Below this, a reply is already short enough to just speak — skipping the
// haiku round-trip saves the latency/cost on the common SOUL.md-style
// one-line confirmation.
const SUMMARIZE_THRESHOLD_CHARS = 80;

// Ceiling for what gets spoken when condensing fails, so a summarize
// timeout can't turn into reading a whole multi-paragraph reply aloud.
const FALLBACK_MAX_CHARS = 250;

// Overridable so tests/manual verification can point at a throwaway
// directory instead of the real ~/.pearl a live Pearl session reads from.
const STATE_DIR = process.env.PEARL_STATE_DIR?.trim() || join(homedir(), ".pearl");
const LAST_REPLY_PATH = join(STATE_DIR, "last-reply.txt");
const SAY_PID_PATH = join(STATE_DIR, "say.pid");
// Set by `ask` so the reply to a spoken message is spoken back; the next
// Stop hook consumes it.
const SPEAK_NEXT_PATH = join(STATE_DIR, "speak-next");
// Set by `preflight` right before Superwhisper starts recording; `voice`
// reads and clears it once that recording's transcript shows up.
const VOICE_BASELINE_PATH = join(STATE_DIR, "voice-baseline.json");

export function extractLastAssistantText(lines) {
  let lastAssistant = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type === "assistant") lastAssistant = entry;
  }

  const blocks = lastAssistant?.message?.content;
  if (!Array.isArray(blocks)) return "";

  return blocks
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function cleanForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function truncateForSpeech(text) {
  const firstSentence = text.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] ?? text;
  return firstSentence.length <= FALLBACK_MAX_CHARS
    ? firstSentence
    : `${firstSentence.slice(0, FALLBACK_MAX_CHARS).trimEnd()}…`;
}

// Condenses a long reply down to its core idea before speaking it, so
// Pearl doesn't read whole paragraphs aloud. Falls back to the reply's
// opening sentence on any failure (timeout, no auth, etc.) — losing the
// condensing is better than losing the message.
export function summarizeForSpeech(text) {
  if (text.length < SUMMARIZE_THRESHOLD_CHARS) return text;

  try {
    const summary = execFileSync(
      "claude",
      [
        "-p",
        // "Summarize" made haiku narrate from outside ("Pearl says..."); asking
        // for a first-person rewrite keeps the spoken line in her own voice.
        `Rewrite this message as one short spoken sentence, in the speaker's own first-person voice, talking directly to the listener. Don't describe the message or mention who wrote it. No preamble, no quotes, just the sentence:\n\n${text}`,
        "--model",
        "haiku",
      ],
      { encoding: "utf-8", timeout: 10_000 },
    ).trim();
    return summary || truncateForSpeech(text);
  } catch {
    return truncateForSpeech(text);
  }
}

function readPid() {
  try {
    const pid = Number.parseInt(readFileSync(SAY_PID_PATH, "utf-8"), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function hush() {
  const pid = readPid();
  rmSync(SAY_PID_PATH, { force: true });
  if (!pid) return;

  try {
    process.kill(pid);
  } catch {
    // Already finished speaking — nothing to stop.
  }
}

export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// `say` run as a direct child of this (tmux-backed, headless) process never
// reaches a Personal Voice or Siri's "natural" voices — confirmed by ear
// that the identical `say` invocation run inside a plain (non-tmux) iTerm2
// window does. AVSpeechSynthesizer's own per-app authorization route is a
// dead end here: it needs the `com.apple.developer.personal-voice`
// entitlement, which AMFI refuses to load on anything short of a paid-
// account provisioning profile — no ad-hoc build can get it. Relaying
// through a throwaway iTerm2 window sidesteps all of that, since it's
// `say` itself (unmodified) doing the speaking either way. The window is
// moved off-screen so it never flashes onto the display, but it's still a
// real GUI window — that appears to be what the eligibility check actually
// wants, not foreground focus.
const SPEAK_BUFFER_PATH = join(STATE_DIR, "speak-buffer.txt");
const SPEAK_SCRIPT_PATH = join(STATE_DIR, "speak-run.sh");
const OSASCRIPT = "/usr/bin/osascript";
// Tags every relay session so a leftover window (say hung, the self-close
// line never ran, iTerm2 crashed) can be found and swept up later without
// ever touching a window that happens to be the user's own.
const RELAY_SESSION_NAME = "pearl-voice-relay";
// Upper bound on one utterance's `say` call, independent of hush() — if
// say ever hangs, this is what still gets the relay window closed instead
// of leaking it forever. Well above anything summarizeForSpeech/
// truncateForSpeech would ever hand it.
const RELAY_WATCHDOG_SECONDS = 60;

// `application ... is running` (rather than a bare `tell application`,
// which auto-launches it) is what lets both this and the reaper below
// skip cleanly instead of launching iTerm2 just to find out it isn't open.
export function isITermRunning() {
  try {
    return (
      execFileSync(OSASCRIPT, ["-e", 'application "iTerm2" is running'], {
        encoding: "utf-8",
      }).trim() === "true"
    );
  } catch {
    return false;
  }
}

// Run once per pearl-speak.js invocation (main(), below) so a window
// orphaned by a crash — this process killed mid-utterance, iTerm2 itself
// restarting, anything short of the watchdog or hush() getting to it —
// doesn't sit there (off-screen, so invisible) indefinitely. Start equals
// recover: nothing here depends on a previous run having shut down clean.
//
// Gated on readPid() being dead/absent: a `hush` invocation reaps too
// (every command does), and at that exact moment the recorded say pid is
// still alive by definition — that's what's being hushed. Sweeping on
// name alone would close that legitimate, still-speaking window out from
// under it instead of leaving hush()'s own kill (and the script's `wait`
// unblocking) to close it properly. Only reap once there's no live
// speech to protect — at that point any window still carrying the marker
// is guaranteed orphaned.
function reapOrphanedRelayWindows() {
  if (!isITermRunning()) return;
  if (isPidAlive(readPid())) return;
  try {
    execFileSync(OSASCRIPT, [
      "-e",
      `tell application "iTerm2"
  repeat with w in windows
    try
      if (name of current session of w) is "${RELAY_SESSION_NAME}" then close w
    end try
  end repeat
end tell`,
    ]);
  } catch {
    // reliability-allow err-no-swallow: best-effort cleanup of a cosmetic
    // leak (an invisible, off-screen window) — failing here shouldn't
    // block speech, and there's nothing more specific to log than
    // "osascript failed," already implied by this being unreachable.
  }
}

// Backgrounding `say` and capturing $! (not the shell's own $$) is what
// puts say's real OS pid in SAY_PID_PATH, so hush()'s process.kill() still
// stops the right process exactly as it does for a direct spawn — and
// since `wait` unblocks as soon as that pid dies, hush() killing it is
// also what makes the window close itself promptly on interrupt, not just
// on natural completion. The watchdog subshell is the fallback for "say
// hangs and nothing ever interrupts it": it force-kills the same pid
// after RELAY_WATCHDOG_SECONDS, which unblocks `wait` the same way.
export function buildRelayScript(sayArgs, windowId) {
  return [
    "#!/bin/bash",
    `/usr/bin/say ${sayArgs.map(shQuote).join(" ")} < ${shQuote(SPEAK_BUFFER_PATH)} &`,
    "SAY_PID=$!",
    `echo $SAY_PID > ${shQuote(SAY_PID_PATH)}`,
    `( sleep ${RELAY_WATCHDOG_SECONDS}; kill -9 $SAY_PID ) 2>/dev/null &`,
    "WATCHDOG_PID=$!",
    "wait $SAY_PID 2>/dev/null",
    "kill $WATCHDOG_PID 2>/dev/null",
    `osascript -e 'tell application "iTerm2" to close (window id ${windowId})'`,
    "",
  ].join("\n");
}

// Two round trips: the window has to exist before we can address it by id
// in the script that runs inside it (and that it closes itself with).
function speakViaITermWindow(sayArgs, bufferContent) {
  writeFileSync(SPEAK_BUFFER_PATH, bufferContent);

  const windowId = execFileSync(
    OSASCRIPT,
    [
      "-e",
      `tell application "iTerm2"
  set w to (create window with default profile)
  set bounds of w to {-3000, -3000, -2500, -2700}
  set name of current session of w to "${RELAY_SESSION_NAME}"
  return id of w
end tell`,
    ],
    { encoding: "utf-8" },
  ).trim();

  writeFileSync(SPEAK_SCRIPT_PATH, buildRelayScript(sayArgs, windowId), { mode: 0o755 });

  execFileSync(OSASCRIPT, [
    "-e",
    `tell application "iTerm2" to tell current session of (window id ${windowId}) to write text "bash ${SPEAK_SCRIPT_PATH}"`,
  ]);
}

function speakDirect(sayArgs, bufferContent) {
  const child = spawn("/usr/bin/say", sayArgs, {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  writeFileSync(SAY_PID_PATH, String(child.pid));
  child.stdin.write(bufferContent);
  child.stdin.end();
  child.unref();
}

function speak(text) {
  hush();

  // Siri/Personal voices aren't addressable via `say -v`; omitting -v uses
  // whatever's set as the system voice in Spoken Content.
  const voice = process.env.PEARL_VOICE?.trim();
  const rate = process.env.PEARL_SPEECH_RATE?.trim() || "210";
  // `say` has no volume flag; the embedded [[volm]] command is the only knob.
  const volume = process.env.PEARL_SPEECH_VOLUME?.trim() || "0.4";
  const tone = process.env.PEARL_SPEECH_TONE?.trim() || "/System/Library/Sounds/Hero.aiff";
  const voiceArgs = voice ? ["-v", voice] : [];
  const sayArgs = [...voiceArgs, "-r", rate];
  const bufferContent = `[[volm ${volume}]] ${text}`;

  // Sync so the tone finishes before speech starts; a missing sound file
  // shouldn't cost the message itself.
  try {
    execFileSync("/usr/bin/afplay", ["-v", volume, tone]);
  } catch {}

  // isITermRunning() keeps a closed iTerm2 from ever being launched just
  // to relay through it — direct spawn is the path whenever it's not
  // already open, not only when the relay itself errors out.
  if (isITermRunning()) {
    try {
      speakViaITermWindow(sayArgs, bufferContent);
      return;
    } catch {
      // Automation permission not granted yet, a transient AppleEvent
      // failure, anything else — fall back below. Not Personal-Voice-
      // capable, but Pearl still speaks.
    }
  }
  speakDirect(sayArgs, bufferContent);
}

function speakLastReply() {
  let text;
  try {
    text = readFileSync(LAST_REPLY_PATH, "utf-8").trim();
  } catch {
    return;
  }
  if (text) speak(text);
}

async function captureReply() {
  const stdin = await new Promise((res) => {
    let data = "";
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => res(data));
  });

  let hookInput;
  try {
    hookInput = JSON.parse(stdin);
  } catch {
    return;
  }

  const transcriptPath = hookInput?.transcript_path;
  if (!transcriptPath) return;

  let content;
  try {
    content = readFileSync(transcriptPath, "utf-8");
  } catch {
    return;
  }

  const text = cleanForSpeech(extractLastAssistantText(content.split("\n")));
  if (!text) return;

  const spoken = summarizeForSpeech(text);
  writeFileSync(LAST_REPLY_PATH, spoken);

  if (existsSync(SPEAK_NEXT_PATH)) {
    rmSync(SPEAK_NEXT_PATH, { force: true });
    speak(spoken);
  }
}

// Typing blind into a TUI is only safe when her chat input box is showing:
// a `❯` line framed by the box's top and bottom borders. A permission
// dialog or menu also uses `❯` for its cursor, but not between borders —
// injecting text plus Enter there could answer the dialog. The check lives
// in lib/pane.js so run-command.js can share it; re-exported for callers
// of this module.
export { isAtChatPrompt };

function capturePane() {
  return execFileSync(TMUX, ["capture-pane", "-p", "-t", SESSION], { encoding: "utf-8" });
}

// Shared by `ask` (text already known) and `voice` (text fetched from
// Superwhisper after the fact) — the one place that actually injects
// something into Pearl's pane, so the isAtChatPrompt guard only needs
// maintaining here.
function sendToChat(message) {
  let pane;
  try {
    pane = capturePane();
  } catch {
    speak("I'm not running, Boss.");
    return;
  }

  if (!isAtChatPrompt(pane)) {
    speak("I'm stuck on a prompt, Boss. Check my window.");
    return;
  }

  hush();
  writeFileSync(SPEAK_NEXT_PATH, "");
  execFileSync(TMUX, ["send-keys", "-t", SESSION, "-l", message]);
  execFileSync(TMUX, ["send-keys", "-t", SESSION, "Enter"]);
}

function ask() {
  const message = process.argv.slice(3).join(" ").trim();
  if (!message) return;
  sendToChat(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Raw (not `--json`-wrapped-in-an-array — `read --json` is a single
// object) snapshot of Superwhisper's latest transcription, used as an
// opaque comparison token: `voice()` just needs to tell "a new one
// appeared" from "nothing's landed yet", not parse anything here.
function latestTranscriptSnapshot() {
  try {
    return execFileSync(SUPERWHISPER_BIN, ["read", "--json"], { encoding: "utf-8" });
  } catch {
    return "";
  }
}

// `rawResult`, not `llmResult` — Pearl should get what the user actually said,
// not a mode's language-model cleanup pass (which, depending on how that
// mode is configured, might not even be a local call).
export function transcriptText(snapshot) {
  try {
    return (JSON.parse(snapshot)?.rawResult ?? "").trim();
  } catch {
    return "";
  }
}

// Run on key-down, before Superwhisper starts recording: refuses before
// any audio is captured, same as `ask` refuses before typing anything.
// Also pins the mode (if configured) and records what "nothing new yet"
// looks like, so `voice()` can recognize this recording's transcript once
// it lands instead of re-sending whatever was already in the history.
function preflight() {
  let pane;
  try {
    pane = capturePane();
  } catch {
    speak("I'm not running, Boss.");
    process.exitCode = 1;
    return;
  }

  if (!isAtChatPrompt(pane)) {
    speak("I'm stuck on a prompt, Boss. Check my window.");
    process.exitCode = 1;
    return;
  }

  if (SUPERWHISPER_MODE) {
    // Refuse rather than record: whatever mode is active instead could be
    // a cloud one, and audio must never leave the machine.
    try {
      execFileSync(SUPERWHISPER_BIN, ["switch", SUPERWHISPER_MODE]);
    } catch {
      speak("I couldn't switch Superwhisper to local mode, Boss. Not recording.");
      process.exitCode = 1;
      return;
    }
  }

  writeFileSync(VOICE_BASELINE_PATH, latestTranscriptSnapshot());
}

const VOICE_TIMEOUT_MS = 10_000;
const VOICE_POLL_INTERVAL_MS = 300;

// Run on key-up, after Superwhisper has been told to stop: polls for the
// just-finished transcription to show up, then sends it exactly like
// `ask` would. Bounded so a recording that never produced a transcript
// (silence, a dropped `start`) just times out instead of eventually
// sending something stale.
async function voice() {
  let baseline;
  try {
    baseline = readFileSync(VOICE_BASELINE_PATH, "utf-8");
  } catch {
    return;
  }
  rmSync(VOICE_BASELINE_PATH, { force: true });

  const deadline = Date.now() + VOICE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(VOICE_POLL_INTERVAL_MS);

    const latest = latestTranscriptSnapshot();
    if (!latest || latest === baseline) continue;

    const text = transcriptText(latest);
    if (text) sendToChat(text);
    return;
  }
}

const COMMANDS = {
  ask,
  preflight,
  voice,
  say: speakLastReply,
  hush,
};

async function main() {
  if (process.platform !== "darwin") return;

  mkdirSync(STATE_DIR, { recursive: true });
  reapOrphanedRelayWindows();
  const command = COMMANDS[process.argv[2]];
  if (command) return command();
  return captureReply();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
