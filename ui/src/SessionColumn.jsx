// Live/past agent runs, as a feed of closed cards — no expand, no inline
// log. A session's whole reason for existing here is "jump to it or don't";
// the log itself lives in the actual tmux pane, one click away. The one
// exception is Brain View: a card gets a link that opens its canvas page in
// a new tab once the agent has actually written something to it (every
// session has the capability; most never use it), since that's content
// meant to be read here, not in the pane.

import { useEffect, useState } from "react";
import { StatusIcon } from "./StatusIcon.jsx";
import { LIVE_STATUSES } from "./jobStatus.js";

function useOpenInIterm(jobId) {
  const [state, setState] = useState("idle"); // idle | opening | error
  const [error, setError] = useState(null);

  const open = async () => {
    setState("opening");
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/open-terminal`, { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        setState("error");
        setError(data.error);
        return;
      }
      setState("idle");
    } catch (err) {
      setState("error");
      setError(err.message);
    }
  };

  return { state, error, open };
}

export function OpenInIterm({ jobId }) {
  const { state, error, open } = useOpenInIterm(jobId);

  return (
    <button
      type="button"
      className="session-attach"
      title={state === "error" ? error : "Open a real iTerm2 window attached to this session"}
      onClick={open}
    >
      {state === "opening" ? "opening…" : state === "error" ? "failed" : "↗ iTerm"}
    </button>
  );
}

function SessionCard({ job, onClose }) {
  const { state, error, open } = useOpenInIterm(job.id);
  const [closing, setClosing] = useState(false);
  const title = job.title || job.ticketKey || "General dispatch";
  const canOpen = Boolean(job.tmuxSession);

  const close = async (e) => {
    e.stopPropagation();
    setClosing(true);
    const ok = await onClose(job.id);
    // On success the row unmounts once it drops out of the jobs list, so
    // there's nothing left to reset. On failure it needs to go back to
    // clickable — otherwise a transient failure disables this button for
    // good with no way to retry.
    if (!ok) setClosing(false);
  };

  return (
    <div className={`session-row session-row--${job.status}`}>
      <button
        type="button"
        className="session-row-main"
        onClick={open}
        disabled={!canOpen || state === "opening"}
        title={state === "error" ? error : canOpen ? "Open a real iTerm2 window attached to this session" : undefined}
      >
        <span className={`session-status session-status--${job.status}`}>
          <StatusIcon status={job.status} />
        </span>
        <span className="session-title">{title}</span>
        <span className="session-time">
          {new Date(job.startedAt).toLocaleTimeString()}
        </span>
        {job.mode === "interactive" && job.status === "running" && (
          <span className="session-interactive" title="Won't finish on its own — close it when you're done">
            interactive
          </span>
        )}
        {job.status === "needs_input" && (
          <span className="session-needs-input">needs input</span>
        )}
        {job.status === "connection_error" && (
          <span
            className="session-needs-input"
            title="Claude Code lost its connection mid-response and is idle — open the terminal and tell it to continue"
          >
            connection lost
          </span>
        )}
        {job.exitCode !== null && job.exitCode !== 0 && (
          <span className="session-exit">exit {job.exitCode}</span>
        )}
        {state === "opening" && <span className="session-opening">opening…</span>}
      </button>
      {job.status === "connection_error" && canOpen && (
        <button
          type="button"
          className="session-attach"
          title="Open this session's terminal so you can tell it to continue"
          onClick={open}
          disabled={state === "opening"}
        >
          ↗ continue
        </button>
      )}
      {job.hasBrain && (
        <a
          className="session-brain"
          href={`#/brain/${job.id}`}
          target="_blank"
          rel="noreferrer"
          title="Open this session's brain view"
          onClick={(e) => e.stopPropagation()}
        >
          🧠
        </a>
      )}
      <button
        type="button"
        className="session-close"
        title="Close this session"
        onClick={close}
        disabled={closing}
      >
        ✕
      </button>
    </div>
  );
}

export function SessionColumn({ jobs, onRefresh, onClose }) {
  // needs_input and connection_error are still unresolved, not done — keep
  // polling them the same as running, so a session that gets unstuck (or
  // times out) updates without a manual refresh.
  const isLive = (j) => LIVE_STATUSES.includes(j.status);
  const hasRunning = jobs.some((j) => j.status === "running");
  const hasNeedsInput = jobs.some((j) => j.status === "needs_input");
  const hasConnectionError = jobs.some((j) => j.status === "connection_error");
  const hasLive = jobs.some(isLive);

  useEffect(() => {
    if (!hasLive) return;
    const interval = setInterval(onRefresh, 3000);
    return () => clearInterval(interval);
  }, [hasLive, onRefresh]);

  return (
    <div className="focus-column focus-column--sessions">
      <div className="focus-column-head">
        <span className="focus-column-title">Sessions</span>
        {hasRunning && <span className="focus-column-live">running</span>}
        {/* A column of only stuck sessions (no "running" left) still needs
            its own flag — otherwise nothing in the header says anything
            needs attention. */}
        {hasNeedsInput && (
          <span className="focus-column-live focus-column-live--needs-input">
            needs input
          </span>
        )}
        {hasConnectionError && (
          <span className="focus-column-live focus-column-live--needs-input">
            connection lost
          </span>
        )}
      </div>

      <div className="focus-column-body">
        {jobs.length === 0 && (
          <div className="focus-column-empty">
            No agents dispatched yet — focus something and send a prompt.
          </div>
        )}
        {jobs.map((job) => (
          <SessionCard job={job} onClose={onClose} key={job.id} />
        ))}
      </div>
    </div>
  );
}
