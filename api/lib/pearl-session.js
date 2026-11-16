// Kept free of imports so short-lived CLIs (pearl-speak.js) can name
// Pearl's session without dragging in run-command.js, whose module-level
// job poller would keep their process alive forever.

// Configurable so the supervisor isn't stuck with the name "Pearl" on
// someone else's install — her tmux session is named off the same value so
// renaming doesn't collide with (or orphan) a session created under the old
// name.
export const PEARL_NAME = process.env.PEARL_NAME?.trim() || "Pearl";

export const SESSION = `ccenter-${
  PEARL_NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "pearl"
}`;

// Marks text the server types into the supervisor's prompt, which otherwise
// looks exactly like something the user typed. The briefing teaches her to
// treat a line starting with this as a status notice, never as a request.
export const NOTICE_TAG = "[cc-notice]";
