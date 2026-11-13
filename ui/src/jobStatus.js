// A session whose tmux pane is still up. needs_input (blocked on a prompt) and
// idle (agent stopped, waiting on the human) are unresolved, not done, so the
// dashboard keeps polling them and a ticket keeps pointing at them.
const LIVE_STATUSES = new Set(["running", "needs_input", "idle"]);

export function isLiveStatus(status) {
  return LIVE_STATUSES.has(status);
}
