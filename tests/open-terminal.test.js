import { describe, expect, it, vi } from "vitest";
import { OPEN_TERMINAL_TIMEOUT_MS, openTerminal } from "../ui/src/openTerminal.js";

const jsonResponse = (body, status = 200) => ({ status, json: async () => body });

describe("openTerminal", () => {
  it("POSTs to the job's open-terminal route and reports success", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const result = await openTerminal("job-1", { fetchImpl });
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/jobs/job-1/open-terminal");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes the API's own error message through", async () => {
    const fetchImpl = async () => jsonResponse({ ok: false, error: "Unknown job" }, 400);
    expect(await openTerminal("gone", { fetchImpl })).toEqual({ ok: false, error: "Unknown job" });
  });

  it("falls back to the status when the API gives no message", async () => {
    const fetchImpl = async () => jsonResponse({ ok: false }, 500);
    expect(await openTerminal("job-1", { fetchImpl })).toEqual({
      ok: false,
      error: "Open failed (500)",
    });
  });

  it("turns a network failure into a readable error instead of throwing", async () => {
    const fetchImpl = async () => {
      throw new TypeError("Failed to fetch");
    };
    const result = await openTerminal("job-1", { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Couldn't reach the dashboard API");
    expect(result.error).toContain("Failed to fetch");
  });

  it("turns a non-JSON response into an error instead of throwing", async () => {
    const fetchImpl = async () => ({
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    const result = await openTerminal("job-1", { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Couldn't reach the dashboard API");
  });

  it("gives up on a request that never answers, so the row can recover", async () => {
    // A fetch that only settles when its signal aborts: the shape of a request
    // stuck in SYN_SENT or waiting on a proxy that never responds.
    const fetchImpl = (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    const result = await openTerminal("job-1", { fetchImpl, timeoutMs: 20 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/didn't answer within/);
  });

  it("encodes the job id so it can't alter the path", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    await openTerminal("a/b?c", { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/jobs/a%2Fb%3Fc/open-terminal");
  });

  it("allows longer than a normal osascript run before timing out", () => {
    expect(OPEN_TERMINAL_TIMEOUT_MS).toBeGreaterThanOrEqual(10000);
  });
});
