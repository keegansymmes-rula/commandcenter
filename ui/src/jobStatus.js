// Statuses of a session whose tmux pane is still alive and unresolved. The
// stuck ones (needs_input, connection_error) and idle (agent stopped, waiting
// on the human) are not done, so the board keeps polling them, counts them as
// live, and a ticket keeps pointing at them. Mirrors LIVE_STATUSES in
// api/run-command.js.
export const LIVE_STATUSES = ["running", "needs_input", "idle", "connection_error"];

export function isLiveStatus(status) {
  return LIVE_STATUSES.includes(status);
}
