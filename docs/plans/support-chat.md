# Support chat: a direct line to everyone who signs up

Branch `claude/support-chat`, migration 715. Not merged, not rolled out.

## What you asked for

> "The other thing I want to take a look at is how Macro automatically starts a chat between
> their support team and whoever sign up so you have a direct route to talk to customers … so we
> can build the same thing, this way I can talk directly with whoever sign up and help them
> onboard" (2026-11-23)

Built from what your screenshot shows, and nothing of Macro's code: when someone signs up,
a conversation named **"Native Intelligence Support x <their name>"** is waiting in their team
chat. It opens with a line saying when it was made, then a short welcome from one of us that
@-mentions them. We answer every one of these from our own team chat.

## How it works

Team chat belongs to a workspace. A new customer is in their own workspace and we are in ours,
and nobody is added to anybody's workspace for this.

- **The conversation lives in the customer's workspace**, as a new kind of conversation,
  `support`. The customer is its one member, like a DM with themselves. Nobody else in their
  workspace can see it.
- **Our support team is the deployment's admins** (`ADMIN_EMAILS`). No new setting. The database
  can't read `ADMIN_EMAILS`, so it keeps its own list (`support_staff`): an admin is added when
  they open team chat, with the name and picture customers will see, and anyone who stops
  being an admin is taken off the next time an admin opens it.
- **Our staff reach support conversations and nothing else.** The database has a rule for
  each thing staff may read: the conversation, its messages, and files the customer posted in
  it. Each checks that the conversation is a support one and that the reader is on the team.
  Staff write only through two database functions: post, and take down their own message.
- **At sign-up**, right after the first workspace is made, the database starts the
  conversation and posts the welcome. One per account, ever (a unique key): a retry or a
  second start changes nothing. If anything goes wrong, the sign-up still works. An account
  made since support chat began that still has none (it signed up before any admin was on
  the team, or the start failed) gets it the first time it opens team chat.
- **The name never comes from their email address.** "Native Intelligence Support x <their
  name>" uses the name they go by; when that is only their address's first part (the
  sign-up's default), it is just "Native Intelligence Support".

## What each side sees

**The customer**, in their team chat:

- "Native Intelligence Support x Ana Ruiz", pinned first in Favorites in the side panel, and
  first under Channels in the card's own list. A life-buoy icon.
- "Native Intelligence Support x Ana Ruiz created · November 23, 2026", then our welcome:
  our person's name and picture, a **Support** label, and "@Ana Ruiz" highlighted.
- They can write, attach files, mute it or mute it for a while, and **delete it**, after a
  confirmation (Cancel has the focus, not Delete). Deleting removes it completely, for our
  side too: the conversation, its messages, their files in it and everyone's notifications
  about it. Nothing starts another one by itself; an admin can start a fresh one.
- They can't rename it, archive it or leave it, and it can't be unpinned.
- Our staff show as a name and a picture on our messages, nothing else. We aren't in their
  member list, their @-picker, their search, their calls or their record sharing.
- A notification when we reply (every message, like a DM), and the unread count.

**Our side**, in our own team chat:

- A **Support** section at the top of the list: one row per customer, by their name, latest
  first, with an unread count.
- Opening one shows the customer's address and workspace name under the title, the whole
  conversation, their files, and a box to reply. Our own messages can be deleted. We can't
  delete a customer's conversation.
- A notification in our inbox for every customer message (in the app; no email), to every
  admin, and a bell in the conversation's header to mute that customer for yourself.

**Not in a support conversation, on either side (for now):** calls, threads, polls, forms,
reactions, record mentions, email shares, the agent, loops, and any link to join it. The database refuses calls,
threads, polls and record grants there, whatever asks. Our side sends words only (no files
yet).

## The privacy rules, and where each is enforced

| Rule | Where |
|---|---|
| Staff read support conversations, their messages and their files, and nothing else of a customer's workspace | Three database policies, each `support_chat_staff_can_read` (a support conversation, and a `support_staff` row for the reader) |
| Staff write only into support conversations, only as themselves, and delete only their own | `support_chat_post`, `support_chat_delete` check the staff row and the kind; no policy lets staff insert or update anything |
| Customers read and write only their own | The two team chat readers (`team_chat_can_read`, `team_chat_member_can_read`) take `support` as a DM's members: only the customer's own member row is in it |
| A customer can't post as us, or change our messages | The insert policy takes members only; the message check refuses our name on anyone else's message; the edit guard holds our columns |
| Nothing of the customer's travels to us through it | The seven record-grant readers stay as they were, so a grant to a support conversation reaches nobody, and a trigger refuses one being made |
| The customer deletes only their own, completely | `support_chat_remove` checks it is theirs; it takes the messages, read marks and notifications, and records that they deleted it so nothing restarts it by itself |
| The customer can't rename, archive or leave it; staff can't delete it | Two triggers refuse it for a signed-in client (the customer's own delete goes through its function); deleting the workspace or the account still takes it |
| Anything the customer posts in it (words, files) is readable by every admin | By design: say so to customers if you like, in the welcome |
| Staff aren't in the customer's member lists, @-picker, search or calls | Staff are never member rows anywhere in the customer's workspace |
| Merge | The conversation moves with the workspace like everything else; the merge's own team chat step only handles DMs and channels |
| Deletion | The account or the workspace going takes the conversation; a staff account going takes its staff row, and its messages keep their name |
| Export | There is no workspace export today; nothing to add |

## The welcome

The default, editable by an admin at **Admin › Support Chat**:

> Hi {name}, welcome to Native Intelligence! This is your own support channel with our team.
> Ask us anything here, and tell us about bugs or ideas any time.

`{name}` becomes "@<their name>", `{first_name}` their first name. The page shows a preview and
lets you pick who it comes from (by default the first admin on the team). A change applies to
new accounts only.

## Existing accounts

Nothing is backfilled. **Admin › Support Chat › Start one for an existing account** starts one
by email address, with the welcome.

## What changed after the reference spec (the clean-room behaviour notes)

You approved a second session reading the reference product's source and writing down only
how it behaves. From those notes:

- **Durable, not fire-and-forget.** Theirs makes the channel in a background task with no
  retry and no duplicate check. Ours is in the database at sign-up, one per account by a
  unique key, and an account that missed it gets it on its first team chat load.
- **No email in the name.** Theirs names it from the address's first part. Ours uses the
  person's name, or no name.
- **The welcome notifies nobody else.** It mentions only the customer; no staff member is
  pinged by a sign-up.
- **No join link or join requests** on a support conversation (theirs lets anyone with the
  link ask to join). Ours has none: only these database functions write its member.
- **Delete is the customer's, complete, after a confirmation with the focus on Cancel**;
  staff can't delete (theirs matches, but focuses the delete button).
- **A per-person mute for our staff** on top of "every admin is notified".
- Kept as it was, and stricter than theirs: staff are not members of the customer's
  workspace at all; they reach this one conversation through database rules for admins.
- Invited people: one per account, in their first workspace, never again per workspace.

## Decisions for you (my defaults in bold)

1. **Who the team is: the admins (`ADMIN_EMAILS`), added when they open team chat.** Until an
   admin has opened team chat once on production, sign-ups get no support conversation (no
   one to send the welcome). Alternative: a separate list, set on the admin page.
2. **The welcome comes from you** (the first admin on the team), not a company account.
3. **A one-time backfill for everyone who signed up before: not done.** If you want it, it's one
   statement on the server once 715 is applied (a loop calling `support_chat_start` for every
   account), and every one of them gets the welcome at once, with an unread badge. Your call.
4. **Customer messages notify every admin, in the app only.** No email to us.
5. **For now, no calls, files from our side, reactions or threads in these conversations.**
   Each can come later; calls need our staff to be in a call without being in the workspace,
   which is its own piece of work.
6. **Our staff see the customer's email address and workspace name** in our list. Leave it out
   if you'd rather we only see their name.
7. **Delete removes everything, for both sides.** Alternative: keep our side's copy, read-only,
   after the customer deletes theirs.
8. **The customer can't rename it.** A rename for their side only means a name of their own on
   the conversation, stored per person; cheap enough later, but team chat's rename is being
   built on another branch right now, so I left it out. Your call.
9. **Staff can't delete a customer's conversation.**

## Production

- **Migration 715** first, then the code. Apply it with `psql -v ON_ERROR_STOP=1 <
  715_support_chat.sql` in the database container ("Apply a database migration" in
  `deploy/README.md`): it is one transaction. Your call, as always.
- **No new setting.** `ADMIN_EMAILS` is already in the server's `.env`.
- After the roll-out, open team chat once as an admin so you're on the team; sign-ups from then
  on get their conversation, and anyone who signed up between the roll-out and that moment
  gets theirs the next time they open team chat. Accounts from before 715 get none unless
  started (decision 3).
- Not yet proven live: all of it. Proven here: migration 715 applied twice on a local Postgres
  with stand-ins for Supabase's auth, roles and storage, and 60 checks passing (both sides,
  every refusal, delete and its mark, the first-load start, mute, names, the merge's
  re-stamp and both deletions).
- **The browser check was not end to end.** 715 isn't on DEV (on purpose: other sessions are
  checking against it). Both sides were checked in a browser on the dev server, signed in,
  with team chat's answers supplied by the test in the shape 715 gives them: the customer's
  pinned conversation and welcome, our Support list and conversation, and the delete
  confirmation. Posting, deleting and notifications against a real database are proven by
  the rehearsal and the tests, not in a browser.

## Checked

- Guard tests: `src/lib/support-chat/__tests__/migration-715.test.ts` (each restated database
  function is its newest text plus exactly the listed changes; the seven grant readers stay
  untouched; the policies, triggers and grants).
- Unit tests: staff, the list, the routes' staff rule, the welcome, notifications, the sub-nav.
