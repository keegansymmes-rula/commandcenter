// The personal focus workspace: tickets, todos, and live agent sessions in
// one window. Each ticket row spawns its own agent (full ticket context,
// composed server-side) via its own button; the dispatch bar at the bottom
// is for general, ticket-less instructions. Replaces the old all-stacks
// ops-monitoring layout.
//
// Tickets/Todos/PRs are tabs in one pane rather than three side-by-side
// columns — four-plus equal-width columns stopped working once PRs joined
// Tickets/Todos/Sessions: everything got too narrow to read (titles
// truncated hard) while still stretching to full viewport height despite
// short lists. Sessions+Dispatch stay as their own persistent pane —
// that's the thing you watch while working, not something to tab away from.
// All three tab contents stay mounted (just hidden) so switching is instant
// and each one's own polling isn't restarted by a tab switch.

import { useState, useEffect, useCallback, useMemo } from "react";
import { latestOnly } from "./latestOnly.js";
import { isLiveStatus } from "./jobStatus.js";
import { TicketColumn } from "./TicketColumn.jsx";
import { TodoColumn } from "./TodoColumn.jsx";
import { PrColumn } from "./PrColumn.jsx";
import { SessionColumn } from "./SessionColumn.jsx";
import { DispatchBar } from "./DispatchBar.jsx";
import { DispatchModeDialog } from "./DispatchModeDialog.jsx";
import { PearlButton } from "./PearlButton.jsx";
import { PearlConfigColumn } from "./PearlConfigColumn.jsx";
import logo from "./assets/command-center-logo.webp";

export function FocusBoard() {
  const [activeTab, setActiveTab] = useState("tickets");
  const [tickets, setTickets] = useState([]);
  const [jiraBaseUrl, setJiraBaseUrl] = useState(null);
  const [pearlName, setPearlName] = useState("Pearl");
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dispatchError, setDispatchError] = useState(null);

  const fetchTickets = useCallback(async () => {
    try {
      const res = await fetch("/api/tickets");
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();
      setTickets(data.tickets || []);
      setJiraBaseUrl(data.jiraBaseUrl);
      if (data.pearlName) setPearlName(data.pearlName);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Polled from here (10s) and from SessionColumn (3s while jobs are live);
  // latestOnly keeps an older in-flight response from overwriting a newer one.
  const fetchJobs = useMemo(
    () =>
      latestOnly(
        async () => {
          try {
            const res = await fetch("/api/jobs", {
              signal: AbortSignal.timeout(8000),
            });
            if (!res.ok) return null;
            const data = await res.json();
            return data.jobs || [];
          } catch {
            // Job history is supplementary — a failure here shouldn't blank the board.
            return null;
          }
        },
        (list) => {
          if (list) setJobs(list);
        },
      ),
    [],
  );

  const closeSession = useCallback(
    async (jobId) => {
      try {
        const res = await fetch(`/api/jobs/${jobId}/close`, { method: "POST" });
        const data = await res.json();
        if (!data.ok) {
          setDispatchError(data.error || "Failed to close session");
          return false;
        }
        await fetchJobs();
        // Closing a ticket's live session should swap its row's button back
        // to "spawn" right away, not on the next 10s poll.
        await fetchTickets();
        return true;
      } catch (err) {
        setDispatchError(err.message);
        return false;
      }
    },
    [fetchJobs, fetchTickets],
  );

  const dispatch = useCallback(
    async (prompt, context = { type: "none" }, mode = "headless") => {
      setDispatchError(null);
      try {
        const res = await fetch("/api/dispatch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, context, mode }),
        });
        const data = await res.json();
        if (!data.ok) {
          setDispatchError(data.error || "Failed to dispatch");
          return false;
        }
        await fetchJobs();
        // A ticket's row needs its activeJobId right away to swap in the
        // session-jump button, not on the next 10s poll.
        if (context.type === "ticket") await fetchTickets();
        // Interactive only exists so a human can drive it — open the
        // terminal immediately instead of leaving the human to go find
        // the row and click iTerm themselves right after asking for it.
        if (mode === "interactive" && data.job?.id) {
          fetch(`/api/jobs/${data.job.id}/open-terminal`, { method: "POST" });
        }
        return true;
      } catch (err) {
        setDispatchError(err.message);
        return false;
      }
    },
    [fetchJobs, fetchTickets],
  );

  const spawnAgent = useCallback(
    (ticket, mode = "headless") =>
      dispatch(
        "Pick this up and move it forward.",
        { type: "ticket", key: ticket.key },
        mode,
      ),
    [dispatch],
  );

  // The headless/interactive choice is asked exactly once, the same way,
  // regardless of what triggered it — a ticket row's spawn button and the
  // general dispatch bar both call this instead of picking a mode
  // themselves. `resolve` is the Promise executor for whichever caller is
  // waiting, so DispatchBar's existing await-then-clear-the-textarea logic
  // keeps working unmodified: it's still just awaiting a boolean, it just
  // doesn't resolve until the dialog closes.
  const [pendingAction, setPendingAction] = useState(null);

  const requestMode = useCallback((action) => {
    return new Promise((resolve) => {
      setPendingAction({ ...action, resolve });
    });
  }, []);

  const requestSpawn = useCallback(
    (ticket) => requestMode({ kind: "ticket", ticket }),
    [requestMode],
  );

  const requestDispatch = useCallback(
    (prompt) => requestMode({ kind: "general", prompt }),
    [requestMode],
  );

  const chooseMode = async (mode) => {
    const action = pendingAction;
    setPendingAction(null);
    const ok =
      action.kind === "ticket"
        ? await spawnAgent(action.ticket, mode)
        : await dispatch(action.prompt, { type: "none" }, mode);
    action.resolve(ok);
  };

  const cancelMode = () => {
    const action = pendingAction;
    setPendingAction(null);
    action.resolve(false);
  };

  useEffect(() => {
    const refresh = () => {
      fetchTickets();
      fetchJobs();
    };
    refresh();

    // Jobs poll on the ticket cadence so sessions dispatched through the API
    // show up without a reload; SessionColumn adds its faster loop on top once
    // something is live.
    let interval = null;
    const start = () => {
      if (interval === null) interval = setInterval(refresh, 10000);
    };
    const stop = () => {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        refresh();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [fetchTickets, fetchJobs]);

  // needs_input and idle are stuck or waiting, not finished — only an actual
  // live→done transition should trigger a refetch here (a ticket's
  // activeJobId clearing), not a running→needs_input or running→idle one.
  const liveJobCount = jobs.filter((j) => isLiveStatus(j.status)).length;
  useEffect(() => {
    if (liveJobCount === 0 && jobs.length > 0) fetchTickets();
  }, [liveJobCount, jobs.length, fetchTickets]);

  if (loading) return <div className="loading">Loading focus board...</div>;
  if (error) return <div className="error">Error: {error}</div>;

  const tabs = [
    { id: "tickets", label: "Tickets" },
    { id: "todos", label: "Todos" },
    { id: "prs", label: "Pull Requests" },
    { id: "pearl", label: pearlName },
  ];

  return (
    <div className="focus-board">
      <div className="focus-header">
        <h1 className="focus-wordmark">
          <img src={logo} alt="Orders Cap'n?" className="focus-wordmark-logo" />
          <span className="focus-wordmark-text">Command Center</span>
        </h1>
        <div className="focus-header-actions">
          <PearlButton name={pearlName} />
          <button className="btn" onClick={fetchTickets}>
            Refresh
          </button>
        </div>
      </div>

      <div className="focus-columns">
        <div className="focus-tabbed-pane">
          <div className="focus-tabs">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`focus-tab focus-tab--${tab.id}${activeTab === tab.id ? " focus-tab--active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="focus-tab-panels">
            <div className={`focus-tab-panel${activeTab === "tickets" ? "" : " focus-tab-panel--hidden"}`}>
              <TicketColumn
                tickets={tickets}
                jiraBaseUrl={jiraBaseUrl}
                onSpawnAgent={requestSpawn}
              />
            </div>
            <div className={`focus-tab-panel${activeTab === "todos" ? "" : " focus-tab-panel--hidden"}`}>
              <TodoColumn jiraBaseUrl={jiraBaseUrl} />
            </div>
            <div className={`focus-tab-panel${activeTab === "prs" ? "" : " focus-tab-panel--hidden"}`}>
              <PrColumn />
            </div>
            <div className={`focus-tab-panel${activeTab === "pearl" ? "" : " focus-tab-panel--hidden"}`}>
              <PearlConfigColumn name={pearlName} />
            </div>
          </div>
        </div>

        <div className="focus-column-sessions-stack">
          <SessionColumn jobs={jobs} onRefresh={fetchJobs} onClose={closeSession} />
          <DispatchBar onDispatch={requestDispatch} error={dispatchError} />
        </div>
      </div>

      {pendingAction && (
        <DispatchModeDialog
          label={
            pendingAction.kind === "ticket"
              ? `Spawn an agent on ${pendingAction.ticket.key}`
              : "Dispatch a general agent"
          }
          onChoose={chooseMode}
          onCancel={cancelMode}
        />
      )}
    </div>
  );
}
