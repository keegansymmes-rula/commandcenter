// A poll that waits forever is worse than one that fails: connections to the
// API intermittently stall (never reaching the server), the browser allows only
// six per host, and a handful of hung polls with no deadline queued every later
// poll behind them, so the dashboard silently stopped updating. A deadline
// frees the slot and the next interval retries.
export function pollFetch(url, timeoutMs = 15_000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}
