import { describe, expect, it } from "vitest";
import {
  CONNECTION_ERROR_TEXT,
  chatPromptIsEmpty,
  endsInConnectionError,
  isAtChatPrompt,
} from "../api/lib/pane.js";

const BORDER = "─".repeat(60);
const ERROR_LINE = `  ⎿  ${CONNECTION_ERROR_TEXT}. The response above may be incomplete.`;

// The idle input box and footer Claude Code draws under the conversation.
const inputBox = (typed = "") => [
  BORDER,
  `❯ ${typed}`,
  BORDER,
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
];

const pane = (...content) => [...content, "", ...inputBox()].join("\n");

describe("endsInConnectionError", () => {
  it("is true when the error is the last thing above the input box", () => {
    expect(endsInConnectionError(pane("⏺ Reading the file", ERROR_LINE))).toBe(true);
  });

  it("tolerates a few status lines between the error and the box", () => {
    const text = pane(
      ERROR_LINE,
      "",
      "✻ Worked for 41s · done 4:05 PM",
      "      Update available! Run: brew upgrade claude-code@latest",
    );
    expect(endsInConnectionError(text)).toBe(true);
  });

  it("is false for ordinary output", () => {
    expect(endsInConnectionError(pane("⏺ All done", "  Tests pass."))).toBe(false);
  });

  it("is false for other API errors, so only the stable text matches", () => {
    expect(endsInConnectionError(pane("  ⎿  API Error: 529 Overloaded"))).toBe(false);
  });

  it("is false once the user's follow-up is echoed after the error", () => {
    expect(endsInConnectionError(pane(ERROR_LINE, "❯ continue"))).toBe(false);
  });

  it("is false once the agent has produced new output after the error", () => {
    expect(
      endsInConnectionError(pane(ERROR_LINE, "⏺ Picking up where I left off", "  Reading api/x.js")),
    ).toBe(false);
  });

  it("is false after a recovered error even though the old text is still on screen", () => {
    const text = pane(ERROR_LINE, "❯ continue", "⏺ Continuing", "⏺ Done", "  Pushed the branch.");
    expect(endsInConnectionError(text)).toBe(false);
  });

  it("is true when an older, recovered error is followed by a newer one", () => {
    const text = pane(ERROR_LINE, "❯ continue", "⏺ Working", ERROR_LINE);
    expect(endsInConnectionError(text)).toBe(true);
  });

  it("is false while a turn is running (retrying on its own)", () => {
    const text = [ERROR_LINE, "✻ Thinking… (3s · esc to interrupt)", ...inputBox()].join("\n");
    expect(endsInConnectionError(text)).toBe(false);
  });

  it("is false when too many lines have followed the error", () => {
    const filler = Array.from({ length: 10 }, (_, i) => `  line ${i}`);
    expect(endsInConnectionError(pane(ERROR_LINE, ...filler))).toBe(false);
  });

  it("stays true while the user has a draft typed in the box", () => {
    const text = [ERROR_LINE, "", ...inputBox("continue")].join("\n");
    expect(endsInConnectionError(text)).toBe(true);
  });

  it("is false when a permission dialog follows the error", () => {
    const text = [ERROR_LINE, "Do you want to proceed?", "❯ 1. Yes", "  2. No"].join("\n");
    expect(endsInConnectionError(text)).toBe(false);
  });

  it("only looks at the tail, so an old error deep in scrollback is ignored", () => {
    const text = `${ERROR_LINE}\n${"x".repeat(5000)}\n${pane("⏺ Fine")}`;
    expect(endsInConnectionError(text)).toBe(false);
  });

  it("handles a huge scrollback without scanning all of it", () => {
    const text = `${"filler line\n".repeat(200_000)}${pane(ERROR_LINE)}`;
    expect(endsInConnectionError(text)).toBe(true);
  });
});

describe("chatPromptIsEmpty", () => {
  it("is true for an empty framed prompt", () => {
    expect(chatPromptIsEmpty(inputBox().join("\n"))).toBe(true);
  });

  it("is false when a draft is typed", () => {
    expect(chatPromptIsEmpty(inputBox("half a thou").join("\n"))).toBe(false);
  });

  it("is false when there is no framed prompt at all", () => {
    expect(chatPromptIsEmpty("Do you want to proceed?\n❯ 1. Yes")).toBe(false);
  });
});

describe("isAtChatPrompt (shared with pearl-speak)", () => {
  it("matches the framed prompt and rejects a bare menu cursor", () => {
    expect(isAtChatPrompt(inputBox().join("\n"))).toBe(true);
    expect(isAtChatPrompt("Do you want to proceed?\n❯ 1. Yes\n  2. No")).toBe(false);
  });
});
