// Statuses of a session whose tmux pane is still alive and unresolved. The
// stuck ones (needs_input, connection_error) are not done, so the board keeps
// polling them and counts them as live. Mirrors LIVE_STATUSES in
// api/run-command.js.
export const LIVE_STATUSES = ["running", "needs_input", "connection_error"];
