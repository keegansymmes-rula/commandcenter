// Statuses of a session whose tmux pane is still alive and unresolved. The
// stuck ones (needs_input, connection_error) and idle (agent stopped, waiting
// on the human) are not done, so the board keeps polling them, counts them as
// live, and a ticket keeps pointing at them. Mirrors LIVE_STATUSES in
// api/run-command.js.
export const LIVE_STATUSES = ["running", "needs_input", "idle", "connection_error"];

export function isLiveStatus(status) {
  return LIVE_STATUSES.includes(status);
}

// What a needs_input badge says on hover. The reason comes from the API
// (needsInputReason); a job from an older API has none, so it gets the generic
// wording. The note is the agent's own words and is only ever rendered as text.
export function needsInputTitle(job) {
  if (job.needsInputReason === "question") {
    const note = typeof job.needsInputNote === "string" ? job.needsInputNote.trim() : "";
    return note
      ? `Waiting for your reply: ${note}`
      : "The agent stopped and is waiting for your reply — open its terminal and answer";
  }
  if (job.needsInputReason === "permission") {
    return "A permission prompt or menu is waiting for your answer — open its terminal";
  }
  return "Waiting on you — open its terminal";
}
