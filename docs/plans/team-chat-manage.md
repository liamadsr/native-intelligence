# Edit a channel, rename a meeting chat, delete a meeting chat

The owner, 2026-11-23: "I just noticed that there's no way to edit a channel in team-chat or
rename a group chat or completely delete a meeting channel".

Branch `claude/team-chat-manage`. Reserved migration: 714. Merged is not live: see "How
production works" in `CLAUDE.md`. 714 has to be applied on the server's database before
the code is rolled out (the Edit and Delete calls need its functions; nothing else does).

## What exists

- **Conversations** are rows of `team_chat_channel` (474, 572), of three kinds:
  - `channel`: the whole workspace's, or one team's. It has a name of 1 to 80 characters,
    unique (ignoring case) among the workspace's live channels, and a topic of up to 250.
  - `dm`: always between two people (`team_chat_open_dm(ws, other_member)`; `dm_key` is the
    pair, a note to self is one person). It has no name: its title is the other person.
  - `meeting`: a meeting link's conversation (572-574, 585 for bookings). Its members are
    whoever is in `team_chat_member` (the host, and each member who opened the link or was
    added). It has a name, the meeting's title, kept separately in `meeting.title`.
- **No way to change one.** The API had list/create (`channels/route.ts`) and
  `channels/[id]/{messages,notify,polls,read,snooze}`: no update, no delete. Nothing in the
  database let a person change a conversation's name or topic, or remove one.
- **"Group chat."** There is no group DM: a DM is always two people. The only private
  conversation with more than two people is a **meeting chat**. So "rename a group chat" is
  built as renaming a meeting chat, and every conversation that has a name (channels and
  meeting chats) can be renamed. Group DMs would be a new kind of conversation: see the
  decisions below.
- **What hangs off a conversation** (every table that names it, checked migration by
  migration): members with their read marks, levels and snoozes; messages, threads and
  their members, reactions, polls, options and votes, the text of files sent (710), email
  shares (646); calls, participants, rings, egress (566), the calls' capture links (587), the
  live agent's rows (655); the meeting, its guests, keys and rates (573); labels (700);
  records shared with the conversation (`entity_access.grantee_channel_id`, 492). All of
  these are `on delete cascade` from the conversation. Not cascaded, because they name it
  by a plain id: notifications (`target`/`context` `team_chat_channel`, or a message of it),
  Inbox holds (702, keyed by a notification), entity links and activity (109, 488), Drive's
  opened-file rows (709, `team_chat:<path>`), each person's agent conversation for it
  (`team_chat_agent_thread` → `chat_conversations`), and the call notes
  (`captures.notes_channel_id`, 566, which has no foreign key on purpose). Files are
  storage objects under `<conversation id>/` in two buckets, `team-chat-files` (558) and
  `team-call-recordings` (566). Recent (713) and search (561) read the messages directly.

## What this builds

### 1. Edit a channel

The conversation's header gets a settings button (a small sliders icon beside
notifications, in the card's header and in the page's own header), and the sub-nav row's
right-click menu gets an item. Both open **Edit channel**: the name (with its `#`) and the
topic. Saving takes effect at once in the list, the header, the sub-nav and Recent; other
screens follow through Realtime. A name another channel has comes back under the field,
in words ("There's already a channel called #design. Pick another name."), and the dialog
stays open.

### 2. Rename a meeting chat

The same menu, on a meeting chat, says **Rename meeting chat**. A Meetings row's own `…`
menu (in the sub-nav and the page's list) also has **Rename…**. The meeting is renamed with
its chat (`meeting.title`), so the Meetings list and the link's page say the same name. A DM
offers nothing: it has no name to change.

### 3. Delete a meeting chat completely

The same menus have **Delete meeting chat…**, which opens a confirmation that names the
chat and counts what goes, read from the database when it opens:

- **Goes:** the messages (with their threads and reactions), the files, the polls, the calls
  and their recordings, the meeting link (it stops working; for a booked meeting, the booked
  guest's too), its notifications, and the chat from everyone's list. And, without being
  listed one by one: members, read marks, snoozes, Inbox holds on its notifications, entity
  links and activity naming it or its messages, the text of its files, email shares, labels,
  records' shares with it, Drive's "opened" rows for its files, and each person's agent
  conversation for it (the agent's private thread that holds the chat's words as context).
- **Stays:** the call notes, each as a private capture of the person who owns it (no one
  else reads it through the chat any more), and anything made from the chat: tasks,
  documents, records.
- **Refused while its call is live:** "End the call before deleting the meeting chat."

The Delete button stays off until the counts are in. After it, the chat leaves the list,
the sub-nav, the Meetings section and Recent on the deleter's screen at once; another
person's screen drops it through Realtime (an unfiltered DELETE listener: Realtime can't
filter a delete, and the event carries only the id).

**Why the notes stay as their owner's.** Without a step for them, deleting the chat would
leave the notes in the database read by no one at all: 566's fence reads a deleted
conversation as nobody's, owner included. The owner's suggestion was that notes and
captures are records of their own, so the delete clears `notes_channel_id` on them: each
becomes an ordinary private capture of its owner (the person who turned notes on).

**Files.** Postgres can't remove storage objects, so the database returns the object names
under the chat's folder and the app removes them with the service role right after the
delete commits. From that moment nobody can read them either way (both buckets' read rule
asks whether the person may read the conversation named by the folder, now gone); a removal
that fails is logged.

### 4. Who may do what, enforced in the database

`team_chat_can_manage(ch)` (714): the person may read the conversation, it is a channel or a
meeting chat that isn't archived, and they made it (a meeting's host), or they are the
workspace's owner or admin. Every change runs as the person through 714's functions, which
ask it again; the UI only uses the list's `can_manage` to decide whether to show the menu.

| | Edit name/topic | Delete |
|---|---|---|
| Channel | its creator; an owner or admin | not built (decision below) |
| Meeting chat | its host; an owner or admin who is in it | the same, never during a live call |
| DM | nobody (no name) | not built |

An owner or admin who isn't in a meeting chat can't see it, so can't manage it either.

### 5. Everything that shows the conversation follows

- **Rename:** the sub-nav and the page's list, the open card's header, the Meetings section
  (the meeting is renamed too), Recent and mentions (both read the name live, by id), and
  the Inbox: a channel's notifications say "… in #name" in their stored title, so the rename
  rewrites that ending and their `place`. Meeting chats' and DMs' notifications don't name
  the conversation. An `entity-updated` event tells other open cards.
- **Delete:** the same places drop it; its notifications and their holds go, so the Inbox
  drops it; links to it resolve to nothing and the graph's edges to it are deleted.

## Migration 714

New functions only, no table, column or policy change, nothing restated:
`team_chat_can_manage(uuid)`, `team_chat_update_channel(uuid, text, text)`,
`team_chat_meeting_chat_contents(uuid)`, `team_chat_delete_meeting_chat(uuid)`. Each is
`security definer` with `search_path = public, pg_temp`, revoked from public and anon,
granted to authenticated and service_role.

**Apply:** the file has its own `begin;`/`commit;`, so apply it WITHOUT
`--single-transaction`, with `ON_ERROR_STOP=1`, on the owner's word, before rolling out the
code. It reloads the data API's schema itself. Re-runnable.

**Rehearsed** on a local Postgres 16 (stand-ins for the tables with their real keys and
cascades, 566's guard, 568's triggers, 572's read functions): applied twice; every rule
above held, as written in `web/src/lib/team-chat/__tests__/migration-714.test.ts`.

## Decisions for the owner

1. **Channels: archive or delete?** Not built, as asked. A channel already has an
   `archived_at` (474): archiving would hide it from lists, keep its history readable, free
   its name, and stop new messages; deleting would work as a meeting chat's delete does.
   Suggestion: archive for channels (with an Archived list and Restore), delete for meeting
   chats only.
2. **Group DMs.** There is no conversation with more than two people besides a meeting chat.
   If "group chat" meant a private chat with several teammates, that is a new kind
   (`dm` with more than two members, or a private channel with chosen members), not part of
   this change.
3. **Who renames a channel.** Built as: its creator, or an owner or admin. The alternative
   is any member who can read it (Slack's default for public channels).
4. **Deleting during a call** is refused. The alternative is to end the call and delete.
5. **The agent.** Its tools (`lib/ai/tools/team-chat.ts`) can't rename or delete a
   conversation. A rename tool would be small; a delete by the agent should ask the person
   first.
6. **Calendar events** made for a scheduled meeting keep their title and link after a rename
   or a delete; the link then opens nothing. Updating them would mean writing to the
   person's calendar.

## Files

- `web/supabase/migrations/714_team_chat_manage.sql`
- `web/src/lib/team-chat/manage.ts`; `store.ts` (`can_manage`, `canManageChannel`, the new
  error codes); `types.ts`; `route-errors.ts`
- `web/src/app/api/account/team-chat/channels/[id]/route.ts` (PATCH, DELETE),
  `channels/[id]/contents/route.ts` (GET), `channels/route.ts` (the role, for `can_manage`)
- `web/src/app/account/(dashboard)/views/team-chat-manage.tsx` (the menu and both dialogs),
  `team-chat-view.tsx`, `page-panel/team-chat-panel.tsx`,
  `components/meeting-links/meetings-section.tsx`,
  `components/chat-cards/team-chat-card-controls.ts`
- Tests: `web/src/lib/team-chat/__tests__/manage.test.ts`, `migration-714.test.ts`
