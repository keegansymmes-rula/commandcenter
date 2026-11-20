// Asks the API to open an iTerm2 window on a job's tmux session. Always
// resolves to { ok, error }, never throws or hangs: a request with no timeout
// that never answers sat on one of the browser's few connections per host,
// kept the row stuck on "opening…", and starved the jobs poll behind it.

export const OPEN_TERMINAL_TIMEOUT_MS = 15000;

export async function openTerminal(
  jobId,
  { fetchImpl = fetch, timeoutMs = OPEN_TERMINAL_TIMEOUT_MS } = {},
) {
  try {
    const res = await fetchImpl(`/api/jobs/${encodeURIComponent(jobId)}/open-terminal`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json();
    if (!data.ok) return { ok: false, error: data.error || `Open failed (${res.status})` };
    return { ok: true };
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      return {
        ok: false,
        error: `The dashboard API didn't answer within ${Math.round(timeoutMs / 1000)}s`,
      };
    }
    return { ok: false, error: `Couldn't reach the dashboard API (${err?.message ?? err})` };
  }
}
