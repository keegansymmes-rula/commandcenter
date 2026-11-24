# CLAUDE.md

Personal focus dashboard: Jira tickets, todos, open PRs, and live agent
sessions, with per-ticket agent dispatch and the Pearl supervisor agent.
See README.md for setup, architecture, and feature docs.

## Commands

- `npm run dev` — API on 3789 (`node --watch`) and Vite on 5173
- `npm test` — Vitest, pinned to `pool: "threads"` in `vitest.config.js`
  (the default forks pool crashes before running anything on Node 20.5 and
  24.18 both — a tinypool IPC-deserialize bug, not a single-Node-version
  issue).
- `npm run build` — Vite build of `ui/`

## Layout

- `api/server.js` — every REST route lives here
- `api/pearl.js` — Pearl's tmux session and her briefing
- `api/run-command.js` — dispatched agents as tmux-backed jobs
- `api/brain.js` — Brain View canvas storage under `~/.commandcenter/brain/`
- `api/lib/pearl-memory.js` — Pearl's memory: runs the Basic Memory CLI for
  the `/api/memory` routes. It must stay local-only (fixed child env, pinned
  embedding provider, blanked `OPENAI_API_KEY`). Not an MCP server: the
  org's managed MCP policy blocks unapproved servers.
- `api/pearl-speak.js` — Pearl's Stop-hook speech and push-to-talk input
- `api/lib/` — Jira client (`jira.js`), lifecycle labels (`labels.js`,
  canonical), config/env loading, PR and Slack helpers
- `ui/src/` — React dashboard, one component per column
- `commands/` — Claude Code commands symlinked into `~/.claude/commands` by
  `install.sh`; dispatch depends on `/automodel` resolving. The `cc-*` files
  are one skill per dashboard capability (see Pearl, below)
- `tests/` — Vitest, covering `api/` and the pure parts of `ui/`

## Conventions

- ES modules throughout (`"type": "module"`). One-off Node snippets need
  `node --input-type=module -e` with `import`, not `require`.
- Comments explain why — design history, a rejected approach, a race being
  avoided. Match that density; don't narrate what the code does.
- Write actions (dispatch, Pearl, closing a live session, Slack posts) always
  run — no env gate, no UI toggle.
- macOS only: tmux for every session, `osascript` to open iTerm2.

## Pearl

- Three places, three jobs: `SOUL.md` is her personality only; `briefing()`
  in `api/pearl.js` says who she is, where things are, which skill covers
  what, and the rules that must hold even if a skill never loads (never
  post a PR unprompted, never save PHI to memory); the `commands/cc-*.md`
  skills say how to use each capability. Keep each kind of content in its
  place.
- `SOUL.md` is per-user and gitignored. The shipped default is
  `SOUL.example.md`, which `install.sh` copies on first run; personality
  changes meant for everyone go there. Keep it free of any one person's
  name or preferences — the project has to deploy for anyone.
- The briefing must stay a single line (it's passed as the `claude` prompt
  argument, and `tests/pearl.test.js` asserts no newlines).
- When you add or change an API route, update the matching `cc-*` skill in
  the same change. A new capability gets its own skill and a pointer in the
  briefing (`tests/pearl.test.js` checks every pointer has a file).
- Briefing and SOUL.md edits only reach her after a restart (↻ in the
  dashboard, or `POST /api/pearl/refresh`). Skill edits don't need one:
  she reads a skill when she loads it. A new skill file needs
  `./install.sh` to symlink it.
- Her session is pinned to Opus in `auto` permission mode and named
  `PEARL_NAME` so dispatched agents can `SendMessage` her.

## Gotchas

- If an older API server still holds port 3789, `npm run dev` serves the UI
  against the stale server and new routes 404. The server prints the
  `lsof`/`kill` recipe on `EADDRINUSE`.
- If the dashboard intermittently hangs or shows "Failed to fetch" (a click
  on a session does nothing, `curl localhost:5173` sometimes stalls with
  connect time 0), check `netstat -an -p tcp | grep -c TIME_WAIT`. On one Mac
  TIME_WAIT entries were never reaped (4,000+ per port, none expiring),
  which pins ephemeral ports and stalls any new `::1` connection that draws
  one. `vite.config.js` keeps the dev proxy on a keep-alive agent and
  IPv4 loopback so it doesn't add to the pile; a reboot clears what's there.
  Any loop that opens a fresh connection per request (`curl` in a `while`)
  adds to it.
- Push-to-talk must only ever use a local-only Superwhisper mode. See
  `.plans/push-to-talk-wispr.md` before touching `pearl-speak.js` voice
  paths or `hammerspoon/pearl-ptt.lua`.
- Pearl's speech relays through a throwaway, off-screen iTerm2 window
  (session name `pearl-voice-relay`) so `say` can reach a Personal Voice —
  see `pearl-speak.js`'s speech section. Don't name any iTerm2 session that
  yourself — `pearl-speak.js` sweeps up any window with that name on its
  next invocation.
