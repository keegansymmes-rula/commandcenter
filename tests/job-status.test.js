import { describe, expect, it } from "vitest";
import { __test__ } from "../api/run-command.js";
import { LIVE_STATUSES as UI_LIVE_STATUSES } from "../ui/src/jobStatus.js";

describe("live statuses", () => {
  // ui/src can't import from api/, so the dashboard keeps its own copy; this
  // is what stops the two from drifting.
  it("are the same in the dashboard as in the API", () => {
    expect([...UI_LIVE_STATUSES].sort()).toEqual([...__test__.LIVE_STATUSES].sort());
  });
});
