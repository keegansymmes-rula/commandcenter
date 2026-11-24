// Shared fetch for the on-demand panels.
//
// Exists for one failure mode: a 404 here almost never means "no such data", it
// means the browser is talking to an API server older than the UI. `npm run dev`
// runs Vite and the API under `concurrently`, and if a previous server still
// holds port 3789 the new one exits while Vite happily proxies to the old one.
// Every panel added since that server started then 404s. "API error: 404" sends
// you looking for a missing route; the real fix is restarting the server.

import { pollFetch } from "./pollFetch.js";

export function panelErrorMessage(status, endpoint) {
  if (status === 404) {
    return `${endpoint} returned 404 — the API server is likely older than this UI. Restart it (npm run dev:api); if it won't start, an old server still holds the port.`;
  }
  return `API error: ${status}`;
}

// Throws on a non-2xx so callers keep their existing try/catch shape. Polled
// panels pass timeoutMs so a stalled request frees its browser connection
// slot (see pollFetch); one-off loads leave it off and wait as before.
export async function fetchPanel(endpoint, timeoutMs) {
  const res = timeoutMs ? await pollFetch(endpoint, timeoutMs) : await fetch(endpoint);
  if (!res.ok) throw new Error(panelErrorMessage(res.status, endpoint));
  return res.json();
}
