---
description: Report back to the supervisor agent (Pearl by default) when a dispatched task ends. Use when you were dispatched by Command Center and you've finished, failed, or are stopping because you're blocked.
---

# Command Center: reporting back to the supervisor

The supervisor doesn't poll for results. Your message is how it learns how
the task went, and it relays that to the user. Your prompt names it (`Pearl`
unless the install renamed it).

## When

Send exactly one report, when the task ends, whichever way it ends:

- **Done**: the work is finished.
- **Failed**: you tried and couldn't, and you're not going to keep trying.
- **Blocked**: you need a decision, access, or information only a human
  can give.

Don't send progress updates along the way, and don't wait for a reply
after you send.

## How

```
SendMessage({ to: "<name from your prompt>", message: "..." })
```

Use the name your prompt gives, exactly. If it names none, use `Pearl`.

## If the send is denied or errors

The auto mode classifier sometimes blocks `SendMessage`. A denial is not a
reason to stop quietly, because then nobody learns the work is done.

1. Retry once, with the same name and message.
2. If that fails too, don't try again. Start your final output with
   `UNDELIVERED to <name>:` followed by the report, so the user sees it in
   the pane.

Never retry more than once. (Command Center also passes your last message to
the supervisor if you go idle without having reported, so make the final
message stand on its own either way.)

## What to say

One or two sentences: what happened, and whether anything needs the user's
attention. Make the first sentence stand on its own. The supervisor may relay
it as-is.

- Done: "NEV-1234 is done: PR #482 drops the insurance section, tests pass.
  Nothing needs the user."
- Blocked: "NEV-1234 is blocked: the partner sandbox rejects our API key.
  The user needs to request a new one."
- Failed: "Couldn't reproduce the timeout locally after three approaches.
  Needs the user to decide whether to pull production logs."

Lead with the ticket key when there is one. Name any PR, branch, or file the user
would need to look at.
