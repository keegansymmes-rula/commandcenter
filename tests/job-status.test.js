import { describe, expect, it } from "vitest";
import { __test__ } from "../api/run-command.js";
import { LIVE_STATUSES as UI_LIVE_STATUSES, isLiveStatus, needsInputTitle } from "../ui/src/jobStatus.js";

describe("isLiveStatus", () => {
  it.each(["running", "needs_input", "idle", "connection_error"])(
    "keeps polling a %s session",
    (status) => {
      expect(isLiveStatus(status)).toBe(true);
    },
  );

  it.each(["succeeded", "failed", undefined])("treats %s as finished", (status) => {
    expect(isLiveStatus(status)).toBe(false);
  });
});

describe("needsInputTitle", () => {
  it("says a reply is wanted, and quotes the agent's note, for a question", () => {
    const title = needsInputTitle({ needsInputReason: "question", needsInputNote: "  Pick option 1 or 2. " });
    expect(title).toBe("Waiting for your reply: Pick option 1 or 2.");
  });

  it("still says a reply is wanted when the agent gave no note", () => {
    expect(needsInputTitle({ needsInputReason: "question", needsInputNote: null })).toContain("waiting for your reply");
    expect(needsInputTitle({ needsInputReason: "question", needsInputNote: "   " })).toContain("waiting for your reply");
  });

  it("names a permission prompt for a permission job", () => {
    expect(needsInputTitle({ needsInputReason: "permission" })).toContain("permission prompt");
  });

  it("falls back to generic wording for a job from an API that sends no reason", () => {
    expect(needsInputTitle({})).toBe("Waiting on you — open its terminal");
  });
});

describe("live statuses", () => {
  // ui/src can't import from api/, so the dashboard keeps its own copy; this
  // is what stops the two from drifting.
  it("are the same in the dashboard as in the API", () => {
    expect([...UI_LIVE_STATUSES].sort()).toEqual([...__test__.LIVE_STATUSES].sort());
  });
});
