// Pure readers for a captured Claude Code tmux pane. Kept free of imports so
// run-command.js (whose tests stub `node:child_process`) and pearl-speak.js
// (a short-lived CLI) can both use it without pulling in each other.

const isBorder = (line) => line?.startsWith("─") ?? false;

// The chat input is a `❯` line framed by `─` borders. A bare `❯ 1. Yes` menu
// cursor (a permission dialog) has no borders, so it is not the chat prompt.
// Returns the index of that line, or -1.
function chatPromptIndex(lines) {
  const index = lines.findLastIndex((line) => line.startsWith("❯"));
  if (index <= 0) return -1;
  return isBorder(lines[index - 1]) && isBorder(lines[index + 1]) ? index : -1;
}

export function isAtChatPrompt(paneText) {
  return chatPromptIndex(paneText.split("\n")) !== -1;
}

// True only when nothing is typed after the `❯`. Injecting into a prompt with
// a half-written draft would splice our text into it and submit the lot.
export function chatPromptIsEmpty(paneText) {
  const lines = paneText.split("\n");
  const index = chatPromptIndex(lines);
  if (index === -1) return false;
  return lines[index].slice(1).trim() === "";
}

export const CONNECTION_ERROR_TEXT = "API Error: Connection lost mid-response";

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

// True when the pane's latest state is the connection-lost error: the text is
// above the input box, nothing has superseded it, and no turn is running. An
// older occurrence the agent recovered from fails the "nothing after it" test.
export function endsInConnectionError(paneText) {
  const tail = paneText.slice(-TAIL_CHARS);
  if (!tail.includes(CONNECTION_ERROR_TEXT)) return false;

  const lines = tail.split("\n");
  const promptAt = chatPromptIndex(lines);
  // Exclude the top border too. With no input box (a dialog, a dead pane) the
  // whole tail counts as content, and any `❯` menu line then supersedes.
  const content = promptAt === -1 ? lines : lines.slice(0, promptAt - 1);
  const footer = promptAt === -1 ? [] : lines.slice(promptAt - 1);

  const shown = content.filter((line) => line.trim() !== "");
  const errorAt = shown.findLastIndex((line) => line.includes(CONNECTION_ERROR_TEXT));
  if (errorAt === -1) return false;

  const after = shown.slice(errorAt + 1);
  if (after.length > MAX_LINES_AFTER_ERROR) return false;
  if (after.some((line) => SUPERSEDED.test(line))) return false;
  return ![...after, ...footer].some((line) => line.includes(WORKING));
}
