import { describe, expect, it } from "vitest";
import { focusTabs } from "../ui/src/focusTabs.js";

describe("focusTabs", () => {
  it("orders the tabs Tickets, Todos, Pull Requests, Review Requests, then the supervisor", () => {
    expect(focusTabs("Pearl").map((t) => t.label)).toEqual([
      "Tickets",
      "Todos",
      "Pull Requests",
      "Review Requests",
      "Pearl",
    ]);
  });

  it("labels the supervisor tab with its configured name, not a literal", () => {
    const tabs = focusTabs("Jarvis");
    expect(tabs.at(-1)).toEqual({ id: "pearl", label: "Jarvis" });
    expect(tabs.map((t) => t.label)).not.toContain("Pearl");
  });

  it("gives every tab a unique id", () => {
    const ids = focusTabs("x").map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
