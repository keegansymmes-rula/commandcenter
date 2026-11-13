# Command Center

A personal focus dashboard for Jira ticket work: tickets, personal todos,
open pull requests, and live agent sessions in one window. Each ticket row
can spawn its own Claude Code agent (headless or interactive); a persistent
supervisor agent (nicknamed "Pearl" by default, configurable) is one click
away in a real terminal.

## Install

```bash
./install.sh            # core setup only
./install.sh --all      # + everything below
./install.sh --mcp      # + Atlassian MCP registration
./install.sh --ptt      # + push-to-talk setup
./install.sh --memory   # + the supervisor's persistent memory (Basic Memory, ~0.5 GB)
```

Core (always runs): installs dependencies, creates `.env` from the
template, symlinks `commands/` into `~/.claude/commands`, and checks for
`tmux`, iTerm2, `gh`, and Hammerspoon (`tmux` and iTerm2 are required at
runtime — see Architecture below; `gh` and Hammerspoon are only needed for
the PR column and push-to-talk voice input, respectively).

Optional, off by default — pick what you actually use:

- `--mcp` registers the Atlassian MCP server with Claude Code (the
  supervisor's Jira work goes through it)
- `--ptt` sets up push-to-talk voice input for the supervisor agent (see
  Supervisor voice, below)
- `--memory` installs Basic Memory with `uv` for the supervisor's persistent
  memory, installing `uv` itself with Homebrew first if it isn't usable (see
  Supervisor memory, below)

`install.sh` defaults `DEV_ROOT` to commandcenter's own parent directory
(it's always a repo under your `DEV_ROOT`) — adjust it if that's wrong.
Then fill in `.env`:

- `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_DOMAIN` — Jira Cloud credentials
- `TODO_PROJECT_KEY` — Jira project key new todos get created in. No
  default (a project key is specific to one person's Jira instance); the
  Todos column's add-todo form returns a clear error until this is set.
- Everything else in `.env.example` is optional, with sane defaults.

## Run

```bash
npm run dev
```

Starts the API (port 3789) and the Vite dev server (port 5173). Open
`http://localhost:5173`.

## Architecture

```
api/
  server.js         Fastify REST API — tickets, todos, PRs, jobs, dispatch
  pearl.js          The supervisor agent: ensures its tmux session exists,
                     opens a real terminal into it
  pearl-speak.js    The supervisor's on-demand speech and push-to-talk input
  run-command.js    Spawns dispatched agents in their own tmux sessions,
                     tracks them as jobs
  brain.js          Per-job Brain View canvas storage
  lib/              Jira REST client, label/stack helpers, ADF→text,
                     Slack PR announce, etc.
commands/           Claude Code commands symlinked into ~/.claude/commands
                     by install.sh: /automodel, plus one /cc-* skill per
                     dashboard capability
hammerspoon/        Push-to-talk hotkey glue for the supervisor agent
ui/                 React dashboard (Vite)
tests/              Vitest suite for api/ and ui/ pure logic
```

Dispatched agents and the supervisor agent both run as real `tmux` sessions
so you can attach to and drive them directly from a terminal, not just
watch a log — and opening that terminal window uses `osascript` to drive
iTerm2. Both are macOS-only requirements.

Write actions (dispatching an agent, running the supervisor agent, ticket
cleanup/promote) always run — there's no env gate or UI toggle to disable
them.

## Dispatch

`POST /api/dispatch` with `{ prompt, context, mode, brain }` starts an
agent in its own tmux session. `context` is `{ type: "ticket", key }` or
`{ type: "none" }`; a ticket dispatch prepends the ticket's full detail and
runs in the repo resolved from its labels or description, falling back to
`DEV_ROOT`. `mode` is `headless` (the default) or `interactive`. One
running job per ticket; a second dispatch returns 409.

Every dispatched prompt starts with `/automodel`
(`commands/automodel.md`), so the agent picks haiku, sonnet, or opus for
the task before starting it, and ends with an instruction to report back to
the supervisor agent via `SendMessage` (retrying once if it is denied, then
putting the report in the session's final output as `UNDELIVERED to <name>:`).

### Report relay

The auto mode classifier sometimes denies a session's `SendMessage`, and a
session that obeys the denial just stops. So the API server watches each
interactive job: when its session goes idle (or the job is closed while idle)
without a report having reached the supervisor, it types a one-line relay of
the session's last message into the supervisor's terminal. The relay is capped
at a few hundred characters, labelled as automated, and sent at most once per
job; `needs_input` and still-working jobs are never relayed.

Detection reads the session's transcript, not the terminal. Interactive jobs
start with a known `--session-id`, so the transcript is
`~/.claude/projects/*/<session-id>.jsonl`. A session is idle when its last
turn ended (`end_turn`, no tool call pending) and the file has been quiet for
15 seconds. A report counts as delivered only if a `SendMessage` to the
supervisor has a successful result; a denial is recorded as an error. The relay
waits (about a minute, then skips) if the supervisor's input box holds text or a
question is on screen, and skips if it isn't running. Whether a relay was sent
is stored with the job's metadata, so it survives an API restart.

## Brain View

Every dispatched agent gets a live canvas at
`~/.commandcenter/brain/<jobId>/canvas.md`, which it can rewrite as it
works — the dashboard renders it on its own page (markdown plus Mermaid,
with raw HTML escaped), served from `GET /api/jobs/:id/brain`. A non-empty
`canvas.html` beside it takes precedence and is shown as a full page in a
sandboxed iframe (no same-origin, no network). The agent decides whether to use it,
not a human at dispatch time: a session card only gets a link to it once
the canvas actually has content, so a session that was never asked to show
its thinking — the common case — doesn't surface one.

## Skills

How the supervisor agent and dispatched agents use each dashboard capability
lives in one skill per capability, in `commands/`, loaded only when needed:

| Skill | Used by | Covers |
|---|---|---|
| `/cc-dispatch` | Supervisor agent | Starting, tracking, and closing agent sessions |
| `/cc-tickets` | Supervisor agent | Reading the user's tickets; changing them through `api/lib/jira.js` |
| `/cc-todos` | Supervisor agent | Listing, adding, and completing todos |
| `/cc-prs` | Supervisor agent | Listing open PRs; posting one to Slack |
| `/cc-memory` | Supervisor agent | Searching and saving its memory |
| `/cc-brain-view` | Dispatched agents | Using the Brain View canvas |
| `/cc-report` | Dispatched agents | Reporting back to the supervisor agent when done |

The supervisor's briefing and each dispatched prompt carry a pointer to the
right skills, plus the few rules that must hold even if a skill never loads.
Run `./install.sh` after adding a skill so it gets symlinked.

## SOUL.md

Who the supervisor agent is and how you want it to work, kept separate from
the mechanical API briefing (`api/pearl.js`) so personality/preferences
don't require editing code. Each install has its own: `install.sh` copies
the neutral `SOUL.example.md` to `SOUL.md` the first time, and `SOUL.md` is
gitignored, so your edits stay yours. Edit it from the dashboard's
supervisor tab, or directly — it's read fresh every time it spins up. The ↻
button next to its name restarts its session so edits take effect,
discarding its current conversation.

The supervisor agent runs pinned to Opus in `auto` permission mode. Its
name comes from `PEARL_NAME` in `.env` (default `Pearl`) and drives both
its tmux session — `ccenter-<slugified-name>`, e.g. `ccenter-pearl` by
default — and the `SendMessage({to: PEARL_NAME})` address dispatched agents
use to reach it. Hammerspoon launches `pearl-speak.js` directly with its
own minimal environment, so it (and `server.js`) load `.env` explicitly
rather than relying on it being inherited.

## Supervisor memory

With `./install.sh --memory`, the supervisor agent gets persistent memory
that survives restarts: [Basic Memory](https://github.com/basicmachines-co/basic-memory),
which the API drives through its CLI (`api/lib/pearl-memory.js`) and exposes
as routes it calls like the rest of the dashboard:

- `GET /api/memory/search?q=<question>&limit=<1-25>` — ranked notes
- `GET /api/memory/note?id=<permalink>` — one full note
- `POST /api/memory` with `{ title, content, overwrite }` — save one;
  a title that already exists returns 409 unless `overwrite` is true

It isn't an MCP server because the org's managed MCP policy blocks servers
that aren't on its allowlist. It saves deliberately — decisions, standing
preferences, outcomes worth knowing later — and searches before answering
anything that depends on earlier context. Saves take about 3 seconds and run
one at a time.

Everything stays on this machine. Memories are Markdown files under
`~/.commandcenter/memory/notes/`, indexed in SQLite with sqlite-vec, and
embedded locally with FastEmbed (`bge-small-en-v1.5`, downloaded once). The
CLI runs with a fixed environment, not the API's own: the local embedding
provider is pinned, `OPENAI_API_KEY` is blank, and the API's Jira
credentials never reach it. It's told never to save credentials or PHI.

To see or fix what it remembers, open the notes in any editor. If
basic-memory isn't installed, the supervisor agent runs without memory and
its briefing doesn't mention it. Restart it (↻) after installing.

Optional env: `PEARL_MEMORY_BIN` when `uv` installs tools somewhere other
than `~/.local/bin`.

## Supervisor voice

A Stop hook, scoped to the supervisor's session only, caches a condensed
version of each reply. `api/pearl-speak.js` speaks it on demand (`say`),
stops it (`hush`), and handles voice input: `ask "<text>"` from any
dictation tool, or the `preflight`/`voice` push-to-talk pair driven by
Superwhisper's CLI through `hammerspoon/pearl-ptt.lua` (held Insert key).
`./install.sh --ptt` auto-generates `hammerspoon/pearl-ptt.local.lua`
(gitignored) with the machine-specific paths this needs and wires it into
`~/.hammerspoon/init.lua` idempotently. Superwhisper must still be set up
with a local-only mode by hand; see `.plans/push-to-talk-wispr.md` for why
and how.

If your Spoken Content voice (System Settings → Accessibility → Spoken
Content) is a Personal Voice or one of Siri's "natural" voices, `say` can't
reach it directly — those only exist behind `AVSpeechSynthesizer`'s own
per-app authorization, which `say` never asks for and architecturally can't
be made to. Building a small signed app around `AVSpeechSynthesizer` doesn't
get there either: actually speaking with a Personal Voice needs the
`com.apple.developer.personal-voice` entitlement, which only a paid Apple
Developer provisioning profile can grant — AMFI refuses to even load an
ad-hoc-signed binary that claims it. What does work, confirmed by ear: the
identical `say` call run inside a plain iTerm2 window *outside* tmux reaches
the Personal Voice fine. So when iTerm2 is running, `pearl-speak.js` relays
`say` through a throwaway iTerm2 window — moved off-screen so nothing
flashes onto the display — instead of running it as a direct child of its
own (tmux-backed) process; the window closes itself once `say` finishes (or
is interrupted via `hush`), and any window orphaned by a crash gets swept up
automatically the next time the supervisor agent speaks. If iTerm2 isn't
running, or the relay fails for any reason, `pearl-speak.js` falls back to
the old direct `say` spawn — not Personal-Voice-capable, but it still
speaks.

Optional env: `PEARL_VOICE`, `PEARL_SPEECH_RATE`, `PEARL_SPEECH_VOLUME`,
`PEARL_SPEECH_TONE`, `PEARL_SUPERWHISPER_BIN`, `PEARL_SUPERWHISPER_MODE`,
`PEARL_STATE_DIR` (overrides `~/.pearl`, for testing).

## Slack PR announcements

Set `SLACK_WORKFLOW_URL_PR_ANNOUNCE` to a Slack Workflow Builder trigger URL
(`hooks.slack.com/triggers/...`) to post PRs to a Slack channel on demand.
Unset, the feature is off. Nothing posts automatically: each PR card gets a
**post** button, and the supervisor agent can post one when asked
(`POST /api/prs/announce` with `{ "url": "<PR URL>" }`). It sends a flat JSON
payload — the Slack workflow owns the channel and the message formatting.
The existing workflow declares a single `text` input; a workflow that wants
to lay out the message itself can use the other fields instead:

- `text` — `:pr-review-request: <title>` plus the PR URL on the next line
- `title` — PR title
- `url` — PR URL
- `repo` — `owner/name`
- `number` — PR number (as a string)

Each PR posts at most once. Posted PRs are recorded by URL in
`~/.commandcenter/slack-posted-prs.json`; asking again for one already there
returns `alreadyPosted` without posting.
