// Personal todo list, backed by Jira issues carrying a dedicated label
// (same account as the Tickets column — no separate credential to manage).
// Degrades to an explicit "not configured" message when Jira itself isn't.
//
// Not focusable/dispatchable — only tickets can be the context for a
// dispatched agent, so this has no onFocus/focusedContext wiring.

import { useCallback, useEffect, useState } from "react";
import { daysUntil, dueTone, formatDue } from "./dueDate.js";
import { pollFetch } from "./pollFetch.js";

export function TodoColumn({ jiraBaseUrl }) {
  const [tasks, setTasks] = useState([]);
  const [notConfigured, setNotConfigured] = useState(false);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState("");
  const [dueDraft, setDueDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const fetchTasks = useCallback(async () => {
    try {
      const res = await pollFetch("/api/todos");
      const data = await res.json();
      if (!data.ok) {
        setNotConfigured(true);
        setError(data.error);
        return;
      }
      setNotConfigured(false);
      setError(null);
      setTasks(data.tasks || []);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
    const interval = setInterval(fetchTasks, 30000);
    return () => clearInterval(interval);
  }, [fetchTasks]);

  const complete = async (key) => {
    setTasks((prev) => prev.filter((t) => t.key !== key));
    try {
      const res = await fetch(`/api/todos/${key}/complete`, { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error);
        fetchTasks();
      }
    } catch (err) {
      setError(err.message);
      fetchTasks();
    }
  };

  const addTask = async (e) => {
    e.preventDefault();
    if (!draft.trim()) return;
    setAdding(true);
    try {
      const res = await fetch("/api/todos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: draft.trim(),
          dueDate: dueDraft || undefined,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setDraft("");
        setDueDraft("");
        fetchTasks();
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  };

  // Soonest due date first; no due date sorts last rather than first — an
  // undated todo isn't more urgent than one with a date on it.
  const sorted = [...tasks].sort((a, b) => {
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  });

  return (
    <div className="focus-column focus-column--todos">
      <div className="focus-column-head">
        <span className="focus-column-title">Todos</span>
        <span className="focus-column-count">{tasks.length}</span>
      </div>

      {notConfigured ? (
        <div className="focus-column-empty">
          Jira isn't configured. Set JIRA_EMAIL / JIRA_API_TOKEN / JIRA_DOMAIN
          to enable this column.
        </div>
      ) : (
        <>
          <form className="focus-add-form focus-add-form--todo" onSubmit={addTask}>
            <input
              className="focus-add-input"
              placeholder="Add a todo…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={adding}
            />
            <input
              type="date"
              className="focus-add-due"
              value={dueDraft}
              onChange={(e) => setDueDraft(e.target.value)}
              disabled={adding}
              title="Due date (optional)"
            />
          </form>

          {error && <div className="focus-column-error">{error}</div>}

          <div className="focus-column-body">
            {sorted.length === 0 && (
              <div className="focus-column-empty">Nothing on your list.</div>
            )}
            {sorted.map((task) => {
              const days = daysUntil(task.dueDate);
              const tone = dueTone(days);
              return (
                <div className="focus-item" key={task.key}>
                  <div className="focus-item-row">
                    <button
                      type="button"
                      className="focus-item-checkbox"
                      title="Complete"
                      onClick={() => complete(task.key)}
                    >
                      ○
                    </button>
                    {jiraBaseUrl ? (
                      <a
                        href={`${jiraBaseUrl}/${task.key}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="focus-item-key"
                      >
                        {task.key}
                      </a>
                    ) : (
                      <span className="focus-item-key">{task.key}</span>
                    )}
                    <span className="focus-item-summary">{task.summary}</span>
                    {task.dueDate && (
                      <span className={`focus-item-due focus-item-due--${tone}`}>
                        {formatDue(task.dueDate, days)}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
