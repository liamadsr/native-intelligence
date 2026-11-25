# Continuing an old coding chat

The owner, 2026-11-25: "Right now if coding sessions are older than 24 hours it doesn't let me
make updates to them … The chat still loads, so the conversation is still accessible; I don't
see why not let the user continue the conversation."

## What a message continues, and what it doesn't

| How the chat ended | The person's next message |
| --- | --- |
| **Sat idle for 24 hours** (`expired`, "it sat idle for 24 hours") | **Picks it up again** |
| **Stopped** (`cancelled` with no reason: the person's Stop) | **Picks it up again** |
| Failed (`failed`, any reason) | Starts a new chat |
| Cancelled for a reason: its folder or Mac removed, the Mac full, another job took the folder, its Mac couldn't pick it up again | Starts a new chat |
| Never ran: a queue no Mac claimed in 6 hours, a loop's 15 minutes, a card's wait for a slot | Starts a new chat |
| A job a loop started (unattended) | Never picked up again, by anyone |

Only the person's own message picks a chat up again. Its author comes from the signed-in route
(`/api/local-agent/sessions/[id]/messages`, and the activity steer route), never from the
request. The chat agent's `message_local_agent` and a loop's fire send as the agent, and an
ended chat refuses them as before. The rule is one pure function,
`isContinuableEnd` in `web/src/lib/local-agent/transcript-view.ts`, which the server and the
composer both read.

## How it works

- **The message revives the row** (`reviveSession` in `store.ts`). One CAS, on the signed-in
  person's own row, from exactly the ended state it read, back to `waiting`. Its end and its
  stop are cleared, and its activity becomes now. The message then takes the ordinary idle path:
  the next turn in the ledger, then the doorbell.
- **The Mac resumes the same session in the same folder.** Its relay resumes the parked job,
  fetching a fresh model token through the usual authenticated route. The relay sends the
  message, and Rust launches the job's own eve or coding-agent session in its worktree.
- **Refused up front, in a plain line:**
  - the folder is no longer shared;
  - the Mac was removed;
  - another live chat holds the folder.
- **Refused by the Mac at send time:** the Mac acks the message failed with its reason, and the
  chat ends again (`endRefusedRevival` in `device.ts`). It ends `cancelled` with "your Mac
  couldn't pick it up again (…)", which is not continuable, so the next message is a new chat.
  The reasons include:
  - the job's copy was tidied after 14 days;
  - the job is unknown on that Mac;
  - the folder is unshared there;
  - the worktree is missing;
  - the coding agent's session was refused.
- **The Mac is offline:** the message waits. If nothing takes it in 24 hours, the row goes back
  to "sat idle" and can be picked up again later.

## Credentials

- The 24-hour idle expiry stays. What it ends is the minting: an ended row gets no model token
  (the `model-token` route) and passes no relay check (`checkSessionToken`). Both checks are
  unchanged.
- A token still lives 2 hours and is checked against the row's status on every call. So no
  session keeps minting tokens with nobody there. Minting starts again only after the person's
  own authenticated message, and only through the Mac's own authenticated refresh.

## Not changed

- No migration.
- No desktop change: Rust already resumes a job that has a session, whatever its status.
- The relay is part of the web app.

A possible follow-up for a signed desktop release: don't let tidying move a Stopped job's
worktree to the Trash before 14 days. Today that happens at once, but only when it loses
nothing, so such a chat can't be picked up again and says why.
