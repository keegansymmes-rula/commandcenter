import { afterEach, describe, expect, it, vi } from "vitest";
import { pollFetch } from "../ui/src/pollFetch.js";

describe("pollFetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("abandons a request the server never answers once the deadline passes", async () => {
    // A fetch that only ends when its signal aborts, like a connection that
    // never completes.
    vi.stubGlobal(
      "fetch",
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );

    const started = Date.now();
    await expect(pollFetch("/api/tickets", 50)).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("passes a prompt response straight through", async () => {
    const response = { ok: true };
    vi.stubGlobal("fetch", async () => response);
    expect(await pollFetch("/api/tickets", 50)).toBe(response);
  });
});
