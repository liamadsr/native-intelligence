# Mentions everywhere: one registry, one search, one @ picker

Status: plan (phase 1 of the work). Nothing here is built yet.

Goal: everything the app has can be found in search and @-mentioned, the same way, in every
place a person types; a mention is a chip that opens the thing; the agent reads what was
mentioned; a mentioned teammate is told.

## 1. What already exists

More than the brief assumed. The "shared entity layer" landed in earlier phases:

| Piece | Where | What it covers |
|---|---|---|
| Kind registry (41 kinds) | `web/src/lib/knowledge/entity-registry.ts` | table, workspace scope, label, realtime, graph flags |
| How each kind opens, links, renames, archives | `web/src/lib/entities/entity-actions-registry.ts` (`Record<EntityType, …>`) | every registered kind |
| What may be mentioned (18 kinds) | `web/src/lib/entity-links/mentionable.ts` | `MENTIONABLE_TYPES`, `LabeledMentionRef {type,id,label}` |
| Mentions as graph edges, fenced per writer | `web/src/lib/entity-links/mentions.ts` (`syncMentions`, `visibleMentionTargets`) | team chat, documents, main-chat turns |
| Fences for private kinds on a service client | `web/src/lib/knowledge/entity-fences.ts` | events, channels, messages, decisions, tables, Studio |
| Search | `GET /api/account/search`, `menu-queries.ts`, `web/src/lib/search/menu-search.ts` | 15 kinds, scored 0–1 across kinds |
| The menu (⌘K, `/`, `@`) | `chat/command-menu.tsx`, `command-menu-model.ts` | tabs appear per kind that found something |
| Opening anything | `web/src/lib/chat-cards/open-card.ts`, `entity-links/open-mention.ts` | `OpenTarget` |
| Agent context for mentions | `web/src/lib/ai/mentioned-records.ts`, `chat-system-prompt.ts` | main chat's attached ids |
| Live chips | `web/src/components/entity-refs/` | action identifiers only |

So the work is not a new system. It is closing the gaps between five overlapping lists and the
surfaces that each use a different one.

## 2. The gaps

**Five lists that should be one.** `MENU_SEARCH_KINDS` (15), `MENTION_PICKER_KINDS` (13),
`MENTION_RECORD_KINDS` (9), `MENTIONABLE_TYPES` (18) and `MENTION_RECORD_KEYS` each name a
different subset, plus per-kind switches in `menuRowTarget`, `menuRowMention`,
`toMentionRecord`, `mentionedRecordIdsOf` and `RECORD_MENTION_TOOL_NAMES`. Adding a kind today
touches eight places.

**Kinds search cannot find today:** mail, agent chats, campaigns, sequences, prospect lists,
tables and their rows (only deals), team-chat channels, teams, teammates as members, knowledge
packages, skills as records, decisions, cycles, milestones, forms, eval suites, AI teammates.

**Kinds the picker cannot mention today:** all of the above, plus team-chat messages and
agents (found, never mentionable). The main chat additionally drops Studio projects, campaigns,
decisions, channels and tables, because it mentions by a fixed id list per kind.

**Three stored formats:**

| Surface | Stored as | Chip when shown |
|---|---|---|
| Documents | `[@label](mention://kind/id)` in the markdown (a TipTap atom) | yes |
| Team chat | plain `@label` in `body`, plus `record_mentions jsonb [{type,id,label}]` and `mentions uuid[]` (members) | yes (records open; members highlight) |
| Main chat | plain `@label` in the text; ids only in that turn's request (`systemContext`), never on the message | no: a sent message keeps no mention |
| Comments | plain `@Name` text only | no |

**Surfaces:**

| Surface | Today | Gap |
|---|---|---|
| Main chat (`chat-panel.tsx`) | people, companies, captures, 9 record kinds | not every kind; nothing stored; no chips after send |
| Team chat (`team-chat-view.tsx`) | members, agent, 13 record kinds | editing a message is a plain textarea; the agent turn gets the text only, not the records |
| Teammate chat, run chat (`conversation-composer.tsx`) | as main chat | same |
| Comments (`components/comments.tsx`, now on `ChatInput`) | teammates' names as text | no records, nothing stored, no chip, no notification; edit is a textarea |
| Inline comments on a doc or capture (`components/inline-comments/`) | textarea | no @ at all |
| Documents (`document-detail-panel.tsx`) | 13 kinds | not every kind; no teammates |
| Descriptions and notes on `NoteEditor` (action, project, initiative, contact notes, capture notes) | none | no @ at all |
| Sub-action and create dialogs, event description, campaign notes | textarea | no @ |

Left out on purpose (text that leaves the app or instructs a machine, where a chip means
nothing to the reader): email bodies, sequence steps, SMS, flow and agent instructions, eval
cases, SEO forms, Studio fields, settings, admin, the public guest chat, titles.

**The agent:** only the main chat hands mentions over, and only for the kinds with an id key.
A capture is handed over only when it is the person's own (`user_id = me`), so a teammate's
workspace capture, mentioned, arrives as nothing. Team chat's agent turn reads the message's
words and not its `record_mentions`.

**Notifications:** only team chat notifies a mentioned teammate (`team_chat_message`,
`web/src/lib/team-chat/notify.ts`). A comment's `@Name` notifies no one. A document's mention
writes an activity row (the Inbox) and no notification.

## 3. Design

### 3.1 One registry of what can be found and mentioned

A third sibling beside the kind registry and the actions registry, client-safe, plain data:
`web/src/lib/entities/findable-registry.ts`.

```ts
export const FINDABLE = {
  document: {
    entity: 'document',          // the EntityType it is stored as (a deal → 'data_row')
    noun: ['Doc', 'Docs'],       // tab and row label; editions may rename
    icon: 'file-text',
    search: true,                // offered in search
    mention: 'everyone',         // 'everyone' | 'own' (only its person sees it) | false
    row: (r) => …,               // row → { id, title, hint, status } for the one row component
    label: (r) => …,             // the words its @ shows (an action: GEN-42)
    open: (ref) => OpenTarget,   // replaces menuRowTarget's switch
    context: 'document',         // which agent-context reader hands it over, or null
    chip: 'live' | 'label',      // live: resolved with status; label: its stored words
  },
  …
} satisfies Record<FindableKind, FindableDescriptor>
```

`FindableKind` = the registered kinds people work with, plus the four that are not rows of
their own: `deal` (a pipeline's `data_row`), `agent` and `skill` (a `recipe`), `page`.
Every list in section 2 becomes a derivation of it, and `MENTIONABLE_TYPES` stays the
storage-side truth it derives from. A kind in `ENTITY_REGISTRY` that is neither in `FINDABLE`
nor in an explicit `NOT_FINDABLE` list with a reason is a type error, as `ENTITY_ACTIONS`
already forces for opening.

The server half, `web/src/app/api/account/search/findable-queries.ts`, is a
`Record<FindableKind, query>` (today's `MENU_QUERIES`, completed), and
`web/src/lib/ai/mentioned-records.ts` becomes a `Record<context, reader>`. Adding a kind is
then: one registry entry, one query, one context reader (or `null`).

### 3.2 One search

Same route and response shape (`GET /api/account/search`), so nothing that calls it breaks.

- **New kinds:** campaign, sequence, prospect list, table, table row, team-chat channel, team,
  member, package, skill, decision, form, agent chat (own), mail (own; see 4.1).
  Cycles, milestones, eval suites and AI teammates: found, low in the order.
- **Ranking:** keep `scoreText` and the cross-kind 0–1 scale. Add a small recency lift and a
  small lift for the kinds of the surface's context (a comment on a project lifts that
  project's tasks and docs). Body matches stay under title matches.
- **Tabs:** as now, one per kind that found something. With 25+ kinds the strip groups them:
  All, People, Work (tasks, projects, initiatives), Docs, Meetings, Mail, Chats, CRM
  (companies, deals, tables), Outreach (campaigns, sequences, lists), Agents and skills, Pages.
- **Cost:** one request still fans out to every kind in parallel. Title `ilike` needs no new
  index at today's sizes; a trigram index per new kind is a later migration if it shows.

### 3.3 Access

The rule everywhere: a person finds and mentions only what they may read; nothing is found
through a mention that its reader could not open.

- Search runs on the caller's client, so row-level security holds, and each query also states
  its rule (as `menu-queries.ts` does) because the same readers run on the service client for
  the agent. Service-only tables (Studio, forms, companies' RPC) keep their explicit checks.
- Written mentions are fenced for the writer by `visibleMentionTargets` before anything is
  stored (already so for team chat and documents; comments and chat messages join it).
- A reader's chip resolves through one endpoint that answers only what that reader may see.
  What they may not see renders as a locked chip with the stored words dimmed, or, for the
  kinds marked `own`, as a neutral "an email" with no words at all (see 4.1).
- Per-kind rules as the tables state them: private captures and docs (owner or a grant),
  team-call notes (who can read the call's conversation), contacts (`can_view_contact`),
  calendar events, mail and agent chats (their person's alone), DMs and private channels
  (their members), private tables, Studio (members, not guests).

### 3.4 One mention format

The triple `{type, id, label}` (`LabeledMentionRef`) is already the format in two of three
places. It stays the one format, in two carriers:

- **Rich text** (documents, descriptions, notes): the existing inline node, saved as
  `[@label](mention://type/id)`.
- **Plain-text messages** (team chat, comments, chat messages): the text keeps `@label`, and
  the row carries the triples beside it: `record_mentions jsonb` and `mentions uuid[]`
  (members), exactly team chat's columns. Comments get the same two columns (migration 671);
  a chat message keeps them in its existing `metadata`.

Why not put the link form inside message text too: older desktop builds and the iOS app print
a team-chat body as it is, and would show the raw `[@…](mention://…)`.

A teammate is one more mention: `type: 'member'` in the picker and the chip, written to
`mentions uuid[]` where the row has it, so team chat's stored data does not change.

**Existing data:** no rewrite. Documents and team chat already hold the format. Old comments
and old chat messages hold no ids, so they stay plain text. `kind` values from before a
rename keep reading through `canonicalEntityType`.

### 3.5 One picker

`CommandMenu` stays the one menu; `ChatInput` and the TipTap suggestion already both draw it.
What changes: every host offers the same kinds (the registry's `mention` kinds) and passes
only a `context` (what it is on) for ranking, instead of its own kind list and its own
`mentionList`. Teammates and the person's agent come from the search like everything else, so
team chat's and comments' hand-made option lists go away. A host that cannot take a kind is
no longer possible: a pick is always a `LabeledMentionRef`.

For the textareas, one small component, `MentionTextarea`, wraps the same trigger detection
(`findTriggerToken`) and menu, for the edit boxes of comments and team chat, inline comments,
sub-action and create dialogs, the event description and campaign notes.

### 3.6 Rendering

One chip, `EntityChip`, grown from `entity-ref-chip.tsx`: icon and label for every kind, the
status dot and quick edit where the kind has a status (actions today; projects and deals
next). `GET /api/account/entities/resolve` takes `refs=type:id,…` beside today's identifiers
and answers per kind through the registry, fenced for the reader, batched as now.

It is drawn by: the markdown renderer (`mention://` links), a `MentionText` component for
plain-text bodies with their side-car triples (team chat's `mentionSegments`, generalised and
used by comments and chat messages), and the TipTap node. Bare identifiers (`GEN-42`) keep
working as they do.

### 3.7 The agent reads mentions

- The main, teammate and run chats send `mentions: LabeledMentionRef[]` in the turn's context.
  The old per-kind id keys (`attachedNoteIds`, `attachedActionIds`…) keep being read, for
  desktop builds in the field.
- `buildMentionedRecordsBlock` reads every kind through the registry's context readers,
  fenced for the person the turn runs as, capped, wrapped as untrusted. New readers: a
  capture the person may read though it is not theirs (summary and notes; the transcript
  through its tool), an email thread (live from the provider, the person's own), a calendar
  event with attendees, a team-chat message with its thread, a table row's fields, a
  campaign, a sequence, a prospect list.
- Each mentioned kind also puts its read tools on the turn, as now.
- Team chat's agent turn and a comment that mentions the agent hand over the message's
  `record_mentions` the same way, fenced for the person who wrote it.
- No new model call anywhere: this only adds context to turns that already run on the
  chat agent (eve), so the "every model call on eve" rule holds.

### 3.8 Telling a mentioned teammate

Team chat keeps its own path. A comment that mentions a teammate creates one in-app
notification for them, through `createNotification`, and stops them getting the weaker
`comment_added` for the same comment. Documents and descriptions: see 4.4. No new channel.

## 4. Decisions needed before building on them

1. **Mail and agent chats.** Both are their person's alone, and migration 341 decided mail is
   shown to no one. Subjects and bodies are not stored (read live from the provider).
   Proposed: a person finds and mentions their own; to anyone else the chip says only
   "an email" or "a chat" and opens nothing; only the writer's own agent turn reads it.
   Showing it to others stays the existing explicit share (`email_share`).
2. **Mentioning something private where others will read it.** Team chat already shares a
   mentioned private doc or capture with the channel (a view grant, source `mention`).
   Proposed: the same everywhere a mention has an audience (a comment's record, a document's
   readers), for the kinds grants cover; never for events, mail or agent chats.
3. **Stored format and old data.** Proposed in 3.4: side-car triples for messages, the link
   form for rich text, no rewrite of old rows.
4. **Notifications.** Proposed: a comment's @ notifies (in-app, as replies do). Whether a
   mention in a document or a description should notify too, or stay an Inbox row only.

## 5. Phases

Each ends working, tested and committed.

1. Registry and search: `findable-registry.ts`, the five lists derived from it, the new
   kinds' queries, grouped tabs. Tests: registry completeness, each query's fence.
2. The picker in the main chat: every kind, `mentions` in the turn, stored on the message,
   chips in sent messages.
3. Team chat: the unified list, members through the registry, the edit box.
4. Comments: records, storage (migration 671), chips, notification; inline comments.
5. Documents and the `NoteEditor` descriptions and notes; `MentionTextarea` for the rest.
6. `EntityChip` and the resolve route for every kind.
7. Agent context for every kind; team chat's and comments' agent turns.

Migration 671 (comments' two columns, and a notification type if decision 4 wants one) is
written here and applied to production only by the owner, before the code that needs it is
rolled out.

Not in this plan: the iOS app's composer, and semantic (embedding) search in the menu.
