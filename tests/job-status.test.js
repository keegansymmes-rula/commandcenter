import { describe, expect, it } from "vitest";
import { isLiveStatus } from "../ui/src/jobStatus.js";

describe("isLiveStatus", () => {
  it.each(["running", "needs_input", "idle"])("keeps polling a %s session", (status) => {
    expect(isLiveStatus(status)).toBe(true);
  });

  it.each(["succeeded", "failed", undefined])("treats %s as finished", (status) => {
    expect(isLiveStatus(status)).toBe(false);
  });
});
