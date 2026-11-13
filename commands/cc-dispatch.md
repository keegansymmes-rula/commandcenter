---
description: Start, track, and close Command Center agent sessions. Use when the user asks to dispatch or spin up an agent (for a ticket or a free-form task), asks how a running agent is doing, or asks to open, stop, or close a session.
---

# Command Center: dispatching agents

Every agent session runs in its own tmux session, tracked as a *job*. Use the
API base from your briefing (default `http://localhost:3789`).

## Start an agent

```bash
curl -s -X POST "$API/api/dispatch" -H 'Content-Type: application/json' \
  -d '{"prompt": "...", "context": {"type": "ticket", "key": "NEV-1234"}, "mode": "interactive"}'
```

- `prompt` (required): the instruction. Write it the way you'd brief a
  colleague: what to do, why, and what done looks like.
- `context`: `{"type": "ticket", "key": "..."}` to work a ticket, or
  `{"type": "none"}` for a free-form task.
- `mode`: `"interactive"` or `"headless"`. The API defaults to headless, but
  **always pass `"interactive"`** unless the user says otherwise. Headless runs
  exit silently the first time they hit a permission prompt.

What the dashboard adds for you, so don't repeat it in `prompt`:

- For a ticket: the ticket's full detail (status, labels, links, due date,
  description) goes on top, and the agent runs in the ticket's repo:
  `$DEV_ROOT/<name>` from its `repo:<name>` label, else its parent's, else a
  `Repo: <name>` line in the description, else `DEV_ROOT` itself.
- `/automodel` first, so the agent sizes its own model.
- A live Brain View canvas the agent may use to show its thinking.
- An instruction to send you a status via `SendMessage` when it finishes,
  fails, or gets blocked.

Responses:

| Status | Meaning | What to do |
|---|---|---|
| 200 `{ok: true, job}` | Started. `job.id` identifies it. | Tell the user it's running |
| 409 `{jobId}` | That ticket already has a running job | Report that job instead of starting another |
| 400 | Unknown ticket, or its `repo:` label names a repo that isn't cloned | Relay the error. Don't guess a repo |

An interactive dispatch through the API does **not** open a terminal. If the user
wants to watch or drive it, open one (below).

### Before you dispatch

- Don't default to `/ticket-work` for ticket work. Ask, or brief the agent
  ad hoc, unless the user names the lifecycle.
- Parallel agents on the same repo must each work in their own git worktree
  off a fresh `origin/main`. Say so in each `prompt`; they must never touch
  the main checkout's working tree.

## Track agents

Don't poll. Agents message you through `SendMessage` when they finish or get
stuck. Check status when the user asks, or when you're expecting a report that
hasn't come.

- `GET /api/jobs`: every job, newest first, without logs.
- `GET /api/jobs/:id`: one job, including `log` (the session's terminal
  output, last 100k characters).

| `status` | Meaning |
|---|---|
| `running` | Working |
| `needs_input` | Waiting on a permission prompt or question. Nothing moves until a human answers it, so tell the user and offer to open the terminal |
| `idle` | Interactive only. The agent finished its turn and is sitting at the prompt with nothing pending. The session stays open until a human closes it. Flips back to `running` when someone types into it |
| `succeeded` | Exited 0 (headless) |
| `failed` | Exited non-zero, or its session ended unexpectedly. Read `log` and `error` before reporting |

Interactive jobs never reach `succeeded`: they go `idle` once the agent
stops, then stay open until a human closes them. An `idle` job is waiting on
the user, not stuck, but it can also mean the agent asked a question in plain
text, so read `log` before calling the work done. Its `SendMessage` report is
the signal it finished. A job started before `idle` existed keeps reporting
`running`, and so does one the user interrupted with Esc (that skips the
hook).

`hasBrain: true` means the agent wrote to its Brain View canvas. The user can
open it from the session's card in the dashboard.

## Open a terminal

```bash
curl -s -X POST "$API/api/jobs/$ID/open-terminal"
```

Opens an iTerm2 window attached to the session, or focuses one that's
already attached.

## Close a session

```bash
curl -s -X POST "$API/api/jobs/$ID/close"
```

This **kills a live agent** and removes the job from the list. Confirm with
the user before closing anything `running`, `needs_input`, or `idle` (an idle
session may still hold work the user wants to continue). Closing a finished
job just tidies the list, so no confirmation is needed.
