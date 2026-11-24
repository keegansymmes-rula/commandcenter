// Open GitHub PRs where you personally are a requested reviewer — a request
// made only to a team you belong to is left out (see searchReviewRequestedPrs
// in api/lib/pr.js). Same row look as PrColumn, minus the Slack "post"
// button: these are other people's PRs, and announcing one isn't this tab's job.
//
// Not focusable/dispatchable — only tickets can be the context for a
// dispatched agent.

import { useCallback, useEffect, useState } from "react";
import { fetchPanel } from "./fetchPanel.js";

export function ReviewRequestColumn() {
  const [prs, setPrs] = useState([]);
  const [error, setError] = useState(null);

  const fetchPrs = useCallback(async () => {
    try {
      const data = await fetchPanel("/api/review-requests");
      if (!data.ok) {
        setError(data.error);
        return;
      }
      setError(null);
      setPrs(data.prs || []);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    fetchPrs();
    const interval = setInterval(fetchPrs, 60000);
    return () => clearInterval(interval);
  }, [fetchPrs]);

  return (
    <div className="focus-column focus-column--reviews">
      <div className="focus-column-head">
        <span className="focus-column-title">Review Requests</span>
        <span className="focus-column-count">{prs.length}</span>
      </div>

      {error && <div className="focus-column-error">{error}</div>}

      <div className="focus-column-body">
        {prs.length === 0 && !error && (
          <div className="focus-column-empty">No review requests.</div>
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
              {pr.author && <span className="focus-item-status">{pr.author}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
