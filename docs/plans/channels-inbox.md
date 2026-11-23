# Channels that keep the noise out, one inbox, and polls

Owner, via the managing session: "lets build all of it", matching Macro's channels
(macro.com/channels). Branch `claude/channels-inbox`. Reserved migrations: 702, 703.
Merged is not live: see "How production works" in `CLAUDE.md`.

Clean room: the behaviour comes from Macro's public product page only (macro.com/channels:
mark each channel Signal or Noise, Signal reaches the inbox, items wait there and are marked
done, mute or snooze from the channel's menu, polls and other Create items in the composer's
menu, start a call from it). No code, styles, icons or wording come from Macro, and nothing
was read from its source or any mirror of it. No new dependency.

## What exists, and what this builds on

- **How loud a channel is.** Migration 560 already gives each person three levels per channel
  in `team_chat_member.notify_level`: `all` (every message notifies), `mentions` (a channel's
  default: only @-mentions and replies in threads they're in) and `muted` (nothing notifies,
  no unread count; a mention still shows its badge). The fan-out (`src/lib/team-chat/notify.ts`)
  writes one `team_chat_message` notification per message per person it's for. Those rows
  drive the banner, the desktop's native notification and the away email.
- **Notifications.** The `notification` table (031) holds every notice for a person:
  `team_chat_message`, `mentioned`, `action_assigned`, `comment_*`, `record_shared`,
  `work_needs_you`, `reminder` and the rest. It has `is_read` and `is_archived`. Since 401 no
  page lists them: they feed banners, and most also become `agent_event` rows that the agent
  tells in the home thread (and that `get_notifications` / `ni_get_notifications` reads).
- **For you** (`src/lib/bots/for-you-column.ts`): the agent's asks, reviews and drafts in the
  side panel, with their own verbs (accept, dismiss, mark reviewed).
- **Mail.** `email_thread_index.needs_reply` ("To respond") and `auto_classified = 'important'`
  mark the mail that needs the person. Archive (E) is how mail is handled.
- **Hold.** Mail's `email_hold` (`src/lib/email/hold.ts`) is the copy of a thread kept beside
  an agent's draft. It is not a "hold for later". Nothing in the app snoozes or defers an item
  today. The nearest thing is `reminder` (224), which covers records only.
- **Time-offer polls** (`src/lib/time-offers/polls.ts`, 583) pick meeting times with outside
  guests: one host, guests by link, calendars checked, a booking at the end. A channel poll
  shares none of that machinery, only its shape (options, one answer per voter, replace the
  whole answer under a lock, counts shown, close). It gets its own small tables (phase 3).
- **The composer's + menu** (`chat/chat-input.tsx`) offers files (and a folder on the Mac).
  The Create dialog (`openCreateDialog`, `docs/plans/create-everything.md`) already opens a
  task composer from a team-chat message (`openTaskComposer`) and a doc. A call starts from
  the channel's header (`CallButton`, `team-call-parts.tsx`).

## Phase 1: Signal and Noise, mute and snooze

**Signal and Noise are the levels 560 already has, under clearer names.** No second concept
and no second column:

| Menu | Stored `notify_level` | What reaches you |
|---|---|---|
| **Signal** | `all` | every message in the channel (not its threads' replies, unless you're in the thread) |
| **Noise** | `mentions` | only your @-mentions and replies in threads you're in; the rest stays in the channel |
| Muted (until you turn it back on) | `muted` | nothing; no unread count; a mention still shows its badge |

Defaults (see "Decisions to review"): a channel is Noise, a DM (and a note to self) is Signal,
and a meeting's chat follows a channel's default. Your @-mentions, replies in your threads and
your agent's answers to you reach you whether the channel is Signal or Noise, unless it's muted
or snoozed.

**Mute or snooze from the channel's menu.** The channel's bell menu becomes:

- Signal / Noise (radio, with a one-line hint each);
- Mute for 1 hour;
- Mute until tomorrow (8:00 the next morning, the person's own time);
- Mute for a week;
- Mute until I turn it back on (the `muted` level);
- Turn notifications back on (shown while it's muted or snoozed).

A timed mute is a **snooze**, stored as `team_chat_member.muted_until` (migration 702). While
it lasts, nothing about the channel notifies the person (no inbox item, banner, desktop banner
or email, mentions included), exactly as `muted`. The difference is that the unread count keeps
counting, so the channel still shows what's new when they look. It ends by itself. "Turn back
on" clears it. The header's bell shows "Muted until 3:00 PM" while it lasts, and the channel
list shows the muted icon.

Migration 702, part 1 (has its own `begin`/`commit`, additive, idempotent):

- `team_chat_member.muted_until timestamptz` (null: not snoozed).
- `team_chat_snooze(ch uuid, until timestamptz)`: as the caller, for a channel they may read
  (560's `team_chat_set_notify` rules, a first row read up to where it was). `until` must be
  in the future and at most 31 days away; null clears it. Returns the time in effect.
- `team_chat_notify_candidates`: 560's, with `notify_level` reported as `muted` while
  `muted_until > now()`, so the app's existing rule (`teamChatRecipients`: muted, nobody told)
  covers the snooze with no change to the decision code.
- No client update path on `team_chat_member` exists or is added: both columns are written
  only by the two security-definer functions.

App: `src/lib/team-chat/snooze.ts` (pure: the four choices to times, the label),
`POST /api/account/team-chat/channels/[id]/snooze`, `listChannels` reads `muted_until`, and
`TeamChatChannel.muted_until`. The menu changes in `team-chat-view.tsx`.

## Phase 2: One inbox

**One list of what needs you, made of the records that already say so. No new store of items.**
It is a page card (slug `inbox`, kind `inbox`, in `page-menu.ts`, opened like Team chat) with
the list on the left and the open item on the right.

What it lists, newest first, read live on each load:

1. **Your notifications** (`notification`, not archived, not a bot's notice: `plainNotices` in
   `notice-reach.ts`, the same split the shell's route makes). That covers Signal channels'
   messages, DMs, your mentions anywhere, replies in your threads, assignments, comments,
   shares, reminders and "work needs you". Rows that share a `group_key` (a channel's own
   messages, a thread) are **one item** showing the newest and a count. A team-chat item is
   listed only while the person may still read its channel (`team_chat_can_read`, checked in
   the read, so a channel they've left or one archived drops out). Every other notification
   shows what its row already says to its own recipient: the read adds no record the person
   couldn't open before.
2. **Mail that needs you**: the person's own `email_thread_index` rows in the inbox folder with
   `needs_reply` or `auto_classified = 'important'`, subjects read live as Mail reads them (the
   threads route's existing `needs_reply` path, widened to important through one new filter).
3. **For you's cards stay in For you.** The inbox shows one row for them ("3 things from your
   agent") that opens the side panel's For you. That way an agent's ask has one home and one set
   of verbs, and the inbox doesn't become a second For you.

Verbs, on every item:

- **Done (E):**
  - A notification item sets `is_archived` on every row in its group: a new route,
    `POST /api/account/inbox/done`, as the caller, fenced to their own member ids like the
    existing PATCH.
  - A mail item is archived (Mail's own E, `thread-triage.ts`).
  - Undo comes in the toast.
- **Hold for later (H):** an hour, this evening (18:00), tomorrow (8:00), next week (Monday
  8:00). The item leaves the list and comes back at that time, at the top. It also comes back
  sooner if something new arrives in its group (a new message in a held thread). Stored per
  person in `inbox_hold` (702, below), keyed by the item's key (`n:<group_key or id>`,
  `mail:<thread_id>`). A "Held" filter lists what's waiting and when it returns.
- **Open in place (Enter, or a click):** the right pane shows the item:
  - a team-chat item opens the channel or thread on the message (`TeamChatView` with its
    focus), which also reads it (560's mark-read);
  - a mail item opens the thread reader;
  - anything else opens its record the way the rest of the app opens that kind
    (`openEntity`).
  - Opening marks the item's notifications read.
- **J / K** move through the list (and the open item follows while the pane is open). **Esc**
  closes the pane. Registered in `src/lib/shortcuts.ts` under a new `inbox` scope, so the
  conflict test keeps them apart from Mail's own J/K/E.

Filters along the top: All, Messages (team chat), Mentions & assignments, Mail, Held.

Migration 702, part 2:

- `inbox_hold (user_id, workspace_id, item_key text, held_until timestamptz, held_at
  timestamptz)`, primary key `(user_id, workspace_id, item_key)`. RLS: a person reads and
  writes only their own rows, in a workspace they belong to (`is_workspace_member`). A row
  holds a key and two times, never anything a record says, so it widens nothing.
  `held_until` must be in the future at insert, within 90 days. Rows older than 90 days are
  swept by 401's `cleanup_old_notifications`, extended to them.

**Why not a third list.** The inbox reads the notifications people already get, mail's own
flags and For you's count. It owns only "held until", which nothing else has. Done is the
notification's own `is_archived` and mail's own archive, so a thing handled in the inbox is
handled everywhere: the banner comes down, and the mail is archived in Mail too.

The agent: `get_notifications` is unchanged (it reads agent events). Nothing new for agents in
this phase.

## Phase 3: Polls in a channel

- **"New poll"** in the composer's + menu (a channel, DM or thread) opens a small dialog:
  - a question (≤ 300 characters);
  - 2 to 10 options (≤ 120 each);
  - "Let people pick more than one";
  - "Anonymous" (nobody sees who voted for what, the author included: only counts);
  - an optional closing time (in an hour, tomorrow, in a week, or a date and time).
- **The poll is a message**: it goes in the conversation like any other, notifies as any other
  message does (Signal and Noise apply), and its words are "Poll: <question>" so search, the
  thread and the notifications read it. The card draws the options with live counts and
  bars, your choice checked, who voted (as avatars) unless it's anonymous, and how long it has
  left.
- **Voting:**
  - Click an option: one choice replaces your vote, several toggle.
  - Click your choice again to take it back.
  - Anyone who may post in the channel may vote.
  - A closed poll shows its final counts.
- **Live:** every vote rewrites the poll row's tally (`team_chat_poll.tally`), and the channel
  page already listens to the channel's changes. The card follows the row's realtime update,
  and RLS keeps that update to people who may read the channel.
- **Close:** the author (or, for an agent's poll, the person whose agent posted it) may close it
  any time. A closing time closes it by itself: votes are refused once it has passed, and the
  card reads as closed. Deleting the poll's message closes the poll and hides it.

Migration 703 (its own `begin`/`commit`):

- `team_chat_poll`:
  - `id, workspace_id, channel_id, message_id` (unique, the message it is);
  - `question, multiple, anonymous, closes_at, closed_at, created_by` (member), `created_at`;
  - `tally jsonb` (`{ "<option id>": count }`) and `voters integer`.
- `team_chat_poll_option (id, poll_id, position, label)`.
- `team_chat_poll_vote (poll_id, option_id, member_id, workspace_id, created_at)`, primary key
  `(poll_id, option_id, member_id)`.
- `team_chat_message.poll_id` (nullable, unique). A guard trigger in the 646 style (its own,
  so the big 670 guard isn't redefined) means a client never sets or changes it.
- RLS:
  - poll and option rows: readable by whoever may read the channel (`team_chat_can_read`);
  - vote rows: only the voter's own;
  - no client insert, update or delete on any of the three. Every write goes through the
    functions below (the 359/369/675 rule: clients can't edit the guarded columns).
- Functions (security definer, `search_path` pinned):
  - `team_chat_poll_create(...)` as the caller: `team_chat_can_post`, writes the message, the
    poll and its options in one go.
  - `team_chat_poll_create_for_agent(member, ...)`: the service role only, for an agent's poll
    after approval, written as that member's agent.
  - `team_chat_poll_vote(poll, option_ids uuid[])`: may post, poll open, the options are the
    poll's own, one option unless `multiple`. Replaces the caller's whole answer under the
    poll's row lock and rewrites the tally.
  - `team_chat_poll_close(poll)`.
  - `team_chat_poll_read(poll)`: the counts, the caller's own choices, and who chose what only
    when it isn't anonymous.
- `team_chat_poll` joins the realtime publication.

**Agents.**

- `read_team_chat_poll` (read): the question, options and counts, whether it's open, and who
  voted for what unless it's anonymous. Read as the caller, in channels they may read, the
  same rule as `read_team_chat_message`. The question and the options are people's words, so
  they reach the model inside the untrusted fence.
- `post_team_chat_poll` (external-write): it posts to other people, so **it always asks
  first**. The person gets the approval card with the question, options, settings and channel,
  as the tool-policy pattern does for any send. Never on a guest's or a linked agent's turn,
  and attended only.
- Both are in `tool-registry.ts`, `tool-schemas.ts` and the MCP bridge with the usual tests.

## Phase 4: The rest of the composer's + menu

The team chat composer's + menu gets a "Create" group under Add files:

- **New poll** (phase 3).
- **New task from this conversation**: the action composer, its title prefilled from the
  channel's latest message (or the thread's root), linked back to it through the existing
  `about: team_chat_message` (`openTaskComposer`).
- **New doc**: the Create dialog's doc composer (`openCreateDialog({ type: 'document' })`). The
  new doc's link is put in the box, ready to send.
- **New form**: forms belong to a table (`components/tables/forms-panel.tsx`). This makes a
  table from the "form" starter, opens it with its forms panel, and puts the link in the box.
  If a starter that suits doesn't exist, it makes a plain table and opens its forms panel.
- **Start a call**: the same as the header's call button (`CallButton`); hidden where calls
  aren't offered.

`ChatInput` takes an optional `createItems` prop (label, icon, onSelect). The main chat passes
none, so its menu is unchanged.

## Tests and checks

- Unit tests: snooze times and labels; recipient rules with a snooze; inbox grouping, ordering,
  holds and filters; poll input checks; tally and card states; the two agent tools (fenced
  reads, the approval policy); the + menu items.
- Route tests in the existing style for snooze, inbox done and hold, and the poll routes.
- **Migrations 702 and 703 rehearsed on a local Postgres with several users**: a member, a
  member of another team, someone outside the workspace, someone who left. Votes refused when
  closed, past their closing time, or from someone who may not post. Anonymous polls never
  name a voter to anyone. No client write to the guarded columns. `inbox_hold` rows only the
  owner's.
- UI checks in the dev server as the shared test account, test data removed afterwards.
- Before each push, on that tree, with Node 24: `npx fumadocs-mdx`, `npm run typecheck` (0
  errors) and `npx vitest run --maxWorkers=2` (0 failed).

## Decisions to review

1. **Signal = `all`, Noise = `mentions`.** No new column. A Noise channel still brings your
   @-mentions and your threads' replies to the inbox.
2. **Defaults:** channels and meeting chats Noise, DMs Signal, mentions always reach you
   (unless the channel is muted or snoozed).
3. **A snooze silences mentions too**, as `muted` already does. A person who mutes a channel
   for an hour expects quiet.
4. **A snooze keeps the unread count; muting until turned back on hides it** (560's rule,
   unchanged). Turning a `muted` channel back on returns it to its default (Noise for a
   channel), not to whatever it was before.
5. **"Until tomorrow" is 8:00** the next morning in the person's own time zone. A snooze is at
   most 31 days.
6. **The inbox's items are notifications and mail.** For you's cards stay in For you, with one
   row in the inbox that opens it.
7. **Done on a mail item archives the thread** (Mail's E). Done on a chat item archives its
   notifications, not the messages.
8. **A held item comes back early when its conversation gets something new.**
9. **Anonymous means anonymous in the app, the author included.** The database still knows who
   voted (to keep one vote each). The service role and anyone with direct database access
   can see it.
10. **A poll's author closes it. So may the owner of the agent that posted it.** Workspace
    admins get no override.
11. **No result notice when a poll closes** (people see the card). It can be added later.
12. **New form** makes a table with a form, since a form is always a table's.
