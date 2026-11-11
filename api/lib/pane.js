// Pure readers for a captured Claude Code tmux pane. Kept free of imports so
// run-command.js (whose tests stub `node:child_process`) and pearl-speak.js
// (a short-lived CLI) can both use it without pulling in each other.

const isBorder = (line) => line?.startsWith("─") ?? false;

// A wrapped or multi-line draft grows the input box by a row per line; past
// this many rows between the borders it is not treated as an input box.
const MAX_INPUT_ROWS = 12;

// The framed chat input: a `❯` line with a `─` border directly above and the
// next `─` border below (continuation rows of a long draft sit in between).
// A bare `❯ 1. Yes` menu cursor (a permission dialog) has no borders, so it
// is not an input box. Returns the border and prompt indices, or null.
function inputBlock(lines) {
  const prompt = lines.findLastIndex((line) => line.startsWith("❯"));
  if (prompt <= 0 || !isBorder(lines[prompt - 1])) return null;
  for (let i = prompt + 1; i < lines.length && i <= prompt + MAX_INPUT_ROWS + 1; i += 1) {
    if (isBorder(lines[i])) return { top: prompt - 1, prompt, bottom: i };
  }
  return null;
}

// Typing blind into a TUI is only safe at a single-row prompt: continuation
// rows mean a draft is in progress, and an `Enter` would submit it.
export function isAtChatPrompt(paneText) {
  const block = inputBlock(paneText.split("\n"));
  return block !== null && block.bottom === block.prompt + 1;
}

// True only when nothing is typed anywhere in the box: not after the `❯` and
// not on any continuation row. Injecting into a prompt with a half-written
// draft would splice our text into it and submit the lot.
export function chatPromptIsEmpty(paneText) {
  const lines = paneText.split("\n");
  const block = inputBlock(lines);
  if (block === null) return false;
  if (lines[block.prompt].slice(1).trim() !== "") return false;
  return lines.slice(block.prompt + 1, block.bottom).every((line) => line.trim() === "");
}

export const CONNECTION_ERROR_TEXT = "API Error: Connection lost mid-response";

// Tolerates the error being broken across rows: the TUI word-wraps at spaces
// (and indents continuation rows), and a narrow terminal can split inside a
// word. Optional whitespace, newlines included, between every character
// covers both. Linear, since each `\s*` is followed by a non-space literal.
const CONNECTION_ERROR_PATTERN = new RegExp(
  [...CONNECTION_ERROR_TEXT]
    .filter((ch) => ch !== " ")
    .map((ch) => ch.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"))
    .join("\\s*"),
  "g",
);

// Only the pane's tail is examined: this runs on every poll for every live
// job, and the whole scrollback (up to 100k+ chars) is irrelevant to whether
// the error is still the latest thing on screen.
const TAIL_CHARS = 4000;
// The TUI can print a few status lines between the error and the input box
// ("Worked for 41s", an update notice). More than this and something else has
// been happening since.
const MAX_LINES_AFTER_ERROR = 6;
// A submitted user message (`❯ continue`) or new assistant output (`⏺`/`●`)
// after the error means the session moved on, even if it has since gone idle.
const SUPERSEDED = /^\s*(?:❯|>|⏺|●)(?:\s|$)/;
// Shown on the spinner line while a turn is running, so a session that is
// retrying on its own is not stuck.
const WORKING = "esc to interrupt";

// Index, into `shown`, of the row the last occurrence of the error ends on, or
// -1. Matching runs on the rows joined with newlines so a wrapped error still
// matches, then the match end is mapped back to its row.
function lastErrorRow(shown) {
  const flat = shown.join("\n");
  let end = -1;
  for (const match of flat.matchAll(CONNECTION_ERROR_PATTERN)) {
    end = match.index + match[0].length;
  }
  if (end === -1) return -1;

  let rowStart = 0;
  for (let row = 0; row < shown.length; row += 1) {
    const rowEnd = rowStart + shown[row].length;
    if (end <= rowEnd) return row;
    rowStart = rowEnd + 1;
  }
  return -1;
}

// True when the pane's latest state is the connection-lost error: the text is
// above the input box, nothing has superseded it, and no turn is running. An
// older occurrence the agent recovered from fails the "nothing after it" test.
export function endsInConnectionError(paneText) {
  const lines = paneText.slice(-TAIL_CHARS).split("\n");
  const block = inputBlock(lines);
  // The whole box, continuation rows included, is chrome, not conversation.
  // With no input box (a dialog, a dead pane) the whole tail counts as
  // content, and any `❯` menu line then supersedes.
  const content = block === null ? lines : lines.slice(0, block.top);
  const footer = block === null ? [] : lines.slice(block.top);

  const shown = content.filter((line) => line.trim() !== "");
  const errorRow = lastErrorRow(shown);
  if (errorRow === -1) return false;

  const after = shown.slice(errorRow + 1);
  if (after.length > MAX_LINES_AFTER_ERROR) return false;
  if (after.some((line) => SUPERSEDED.test(line))) return false;
  return ![...after, ...footer].some((line) => line.includes(WORKING));
}
