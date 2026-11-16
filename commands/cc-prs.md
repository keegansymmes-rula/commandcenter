---
description: List the user's open pull requests and post one to their Slack channel through Command Center. Use when the user asks about their PRs, what needs their review, or to announce or post a specific PR.
---

# Command Center: pull requests

Use the API base from your briefing (default `http://localhost:3789`).

## List

`GET /api/prs` returns `{ok, prs, announceEnabled}`: every open PR the user
authored or is assigned to, across all repos.

| Field | Meaning |
|---|---|
| `repo`, `number`, `title`, `url` | The PR |
| `isDraft` | Drafts aren't ready for review |
| `updatedAt` | Last activity |
| `roles` | `author`, `assignee`, or both |
| `isAnnounced` | Already posted to Slack |

## Review requests

`GET /api/review-requests` returns `{ok, prs}`: every open PR, across all
repos, where GitHub asks the user **personally** for review. A request made
only to a team they belong to is not included. Use it for "what needs my
review?"; `GET /api/prs` is only the user's own PRs.

| Field | Meaning |
|---|---|
| `repo`, `number`, `title`, `url` | The PR |
| `author` | Who opened it (`null` if the account is gone) |
| `isDraft` | Drafts aren't ready for review |
| `updatedAt` | Last activity (list is newest first) |

`{ok: false, error}` means `gh` failed (not logged in, timeout). That is not
an empty queue, so tell the user instead of saying nothing needs review.
Never announce one of these to Slack: they are other people's PRs.

## Announce one

```bash
curl -s -X POST "$API/api/prs/announce" -H 'Content-Type: application/json' \
  -d '{"url": "https://github.com/owner/repo/pull/123"}'
```

**Only post a PR when the user asks for that specific PR.** Never on your own
initiative, never in bulk, and never to "catch up" on unannounced ones.
Posting puts it in front of their team.

- `alreadyPosted: true` means it was posted before. Nothing was sent again,
  so a repeat ask is harmless.
- 400 `SLACK_WORKFLOW_URL_PR_ANNOUNCE is not set` (or
  `announceEnabled: false` in the list) means announcing isn't configured.
  Tell the user.
- 404 means `gh` couldn't load the PR. Check the URL with them.
