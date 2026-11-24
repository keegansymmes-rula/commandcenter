// Every open GitHub PR you authored or are assigned on, across every repo —
// a dedicated section, not something bolted onto a ticket's detail view.
// Ticket-linked PRs show up here too if you authored/are assigned on them;
// this column doesn't care whether a PR traces back to a Jira ticket.
//
// Not focusable/dispatchable — only tickets can be the context for a
// dispatched agent, so this has no onFocus/focusedContext wiring.

import { useCallback, useEffect, useState } from "react";
import { pollFetch } from "./pollFetch.js";

const ROLE_LABEL = { author: "mine", assignee: "assigned" };

// On demand only: a PR is posted when this is clicked, never automatically.
// The server refuses a repeat, so this just reflects isAnnounced back.
function AnnounceButton({ pr, onAnnounced, onError }) {
  const [posting, setPosting] = useState(false);

  if (pr.isAnnounced) {
    return <span className="focus-item-status">posted</span>;
  }

  const announce = async () => {
    setPosting(true);
    try {
      const res = await fetch("/api/prs/announce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: pr.url }),
      });
      const data = await res.json();
      if (!data.ok) {
        onError(data.error);
        return;
      }
      onAnnounced(pr.url);
    } catch (err) {
      onError(err.message);
    } finally {
      setPosting(false);
    }
  };

  return (
    <button
      type="button"
      className="focus-item-spawn-btn"
      title="Post this PR to Slack"
      disabled={posting}
      onClick={announce}
    >
      {posting ? "posting…" : "post"}
    </button>
  );
}

export function PrColumn() {
  const [prs, setPrs] = useState([]);
  const [announceEnabled, setAnnounceEnabled] = useState(false);
  const [error, setError] = useState(null);

  const fetchPrs = useCallback(async () => {
    try {
      // Longer than the API's own 30s gh deadline, so a slow GitHub answers
      // (with whatever it found) instead of being cut off here first.
      const res = await pollFetch("/api/prs", 35_000);
      const data = await res.json();
      if (!data.ok) {
        setError(data.error);
        return;
      }
      setError(null);
      setPrs(data.prs || []);
      setAnnounceEnabled(Boolean(data.announceEnabled));
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    fetchPrs();
    const interval = setInterval(fetchPrs, 60000);
    return () => clearInterval(interval);
  }, [fetchPrs]);

  const markAnnounced = (url) =>
    setPrs((current) => current.map((pr) => (pr.url === url ? { ...pr, isAnnounced: true } : pr)));

  return (
    <div className="focus-column focus-column--prs">
      <div className="focus-column-head">
        <span className="focus-column-title">Pull Requests</span>
        <span className="focus-column-count">{prs.length}</span>
      </div>

      {error && <div className="focus-column-error">{error}</div>}

      <div className="focus-column-body">
        {prs.length === 0 && !error && (
          <div className="focus-column-empty">No open PRs.</div>
        )}
        {prs.map((pr) => (
          <div className="focus-item" key={pr.url}>
            <div className="focus-item-row">
              <a
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="focus-item-key"
              >
                {pr.repo}#{pr.number}
              </a>
              <span className="focus-item-summary">{pr.title}</span>
              {pr.isDraft && <span className="focus-item-status">draft</span>}
              {pr.roles.map((role) => (
                <span className="focus-item-status" key={role}>
                  {ROLE_LABEL[role] || role}
                </span>
              ))}
              {announceEnabled && (
                <AnnounceButton pr={pr} onAnnounced={markAnnounced} onError={setError} />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
