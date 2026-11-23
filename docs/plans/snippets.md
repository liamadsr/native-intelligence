# Snippets: saved text, typed in with `;`

Status: in progress on `claude/snippets`. Merged nowhere, rolled out nowhere.

Goal: a person saves pieces of text they write again and again (a signature, a meeting
follow-up, a "thanks, here's the link"), gives each a short word, and types `;` and a few
letters in any editor to put one in. Snippets are personal or shared with the workspace. The
agent can read them and use them when it drafts.

This matches the behaviour Macro's public docs describe ("Snippets: inserted by typing ;").
It is a clean-room build: nothing was read from Macro's source, and no code, styles, icons or
wording come from it. **No new dependency.**

## 1. What already exists (and is reused)

| Piece | Where | Used for |
|---|---|---|
| The `@` picker's look and keys | `chat/command-menu.tsx` (`InlineFrame`, `MenuRow`) | the `;` menu draws the same popover, rows and footer |
| Trigger reading in text boxes | `chat/command-menu-model.ts` `findTriggerToken` | the `;` reader is a sibling with the same shape (`TriggerToken`-like) |
| Trigger reading in TipTap | `components/editor/record-mention.ts` (`@tiptap/suggestion`, a tiny store, a menu mounted beside the editor) | the `;` extension is a copy of that pattern in its own file |
| Markdown ⇄ TipTap | `views/markdown-conversion.ts` `markdownToJSONContent` | a snippet's body is markdown; it goes into an editor as nodes |
| Settings pages | `app/account/settings/*`, `settings-shell.tsx` | Settings › Snippets |
| The Create menu | `lib/create/create-types.ts`, `create-menu.tsx` | "Snippet", no letter |
| Agent tools, approvals | `lib/ai/tools/*`, `tool-registry.ts`, `lib/safety/approvals.ts` (`createToolApproval`, replay through `approvedCall`) | list/read; shared writes and deletes ask first |

### The editors

| Surface | Editor | `@` today | `;` |
|---|---|---|---|
| Documents | TipTap (`NoteEditor` in `document-detail-panel.tsx`) | `RecordMentionSuggestion` | `SnippetSuggestion` (TipTap) |
| Descriptions and notes (action, project, initiative, contact) | TipTap (`NoteEditor`, `recordMentions`) | same | same |
| Mail composer (reply, forward, new email) | TipTap (`email/compose-editor.tsx`) | none | `SnippetSuggestion`, with the recipient's fill-ins |
| Main chat, teammate and run chats | textarea (`chat/chat-input.tsx`) | `findTriggerToken` + `CommandMenu` | `useSnippetTrigger` (textarea) |
| Comments, team chat | `ChatInput` too | same | same (comes with `ChatInput`) |
| Inline comments, sub-action, event description, campaign notes | `MentionTextarea` | yes | same textarea hook |

So there are three editing primitives (TipTap, `ChatInput`, `MentionTextarea`) and the `;`
work is one TipTap extension and one textarea hook, each in its own file, plus a few lines
in each host to mount the menu.

## 2. Behaviour

- **A snippet** has a name ("Meeting follow-up"), a shortcut word (`followup`: lowercase
  letters, digits, `-` and `_`, up to 32), and a rich-text body (markdown, as documents
  store it: bold, italic, links, lists, headings, quotes, code).
- **Personal or shared.** A personal snippet is its maker's alone. A shared one is read and
  used by every member of the workspace. A shortcut is unique among a person's own snippets
  and among the workspace's shared ones; a personal and a shared one may share a word (the
  menu shows both, the personal one first).
- **Typing `;`** at the start of a word opens the menu: every snippet, then filtered by what
  is typed after it (shortcut prefix first, then name, then body words). ↑ ↓ move, ↵ or Tab
  inserts, Esc closes (the next key typed opens it again), a space closes it. Clicking a row
  inserts too. The `;query` is replaced by the body.
- **Where `;` does not open:** inside a code block or inline code, inside a link (a link
  mark, or a word that is a URL), and in the middle of a word (`a;b`, `x;`). With no
  snippets at all the menu never opens, so `;` stays a plain character for people who don't
  use them. A query longer than 32 characters or holding a space is no query.
- **Into rich text** (documents, descriptions, mail) the body goes in as formatting; a
  one-paragraph body goes in inline, at the caret. What an editor can't hold (a heading in
  mail) becomes a plain paragraph. **Into a text box** (chats, comments, team chat) the body
  goes in as its markdown words, which those surfaces already render.
- **Manage** in Settings › Snippets: a list (yours, then shared), search, New, edit in place
  (name, shortcut, personal/shared, body in the rich editor), delete with a confirm.
- **Create menu:** "Snippet" (no letter) opens Settings › Snippets with a new one started.

### Fill-ins (phase 3)

A body may hold a few fill-ins, written in double braces and replaced as it goes in:

| Fill-in | Becomes |
|---|---|
| `{{date}}` | today, written out (`November 23, 2026`) in the person's locale |
| `{{time}}` | the time now (`3:05 PM`) |
| `{{my_name}}`, `{{my_first_name}}` | the person inserting it |
| `{{first_name}}`, `{{name}}` | the first recipient's, in the mail composer only |

A fill-in that has no value where it is used (a recipient in a document, a mail with no
recipient yet) stays as typed, so the writer sees it and fills it by hand. Nothing else is
evaluated: no formulas, no lookups, no conditions.

## 3. Storage and access (migration 699)

One new table, `public.snippet`. No existing table, policy, function or trigger is touched.

```
snippet
  id            uuid pk
  workspace_id  uuid  → workspaces, on delete cascade
  created_by    uuid  → member (current_member_id), on delete set null, as spreadsheets (675)
  name          text  1–80 chars
  shortcut      text  ^[a-z0-9][a-z0-9_-]{0,31}$
  body          text  markdown, ≤ 20 000 chars
  visibility    text  'personal' | 'workspace'
  created_at, updated_at
unique (workspace_id, shortcut) where visibility = 'workspace'
unique (workspace_id, created_by, shortcut) where visibility = 'personal'
```

Row-level security (on, every policy `to authenticated`):

- **select:** a member of the workspace, and the snippet is shared or theirs.
- **insert:** a member, as themself (`created_by = current_member_id`).
- **update:** its maker; a shared one also by the workspace's owner or an admin. The row must
  still be readable by them afterwards.
- **delete:** the same people.

A guard trigger (`snippet_before_write`, the 359/369/675 style) holds a client's token to:
`workspace_id`, `created_by` and `created_at` never change; only the maker changes
`visibility` (an admin editing a shared snippet cannot make it their personal one); and it
keeps `updated_at`. The service role (the agent's tools, which check the person first) is not
held to it.

**A member leaves** (their member row is deleted): `created_by` is set null; an AFTER
trigger (`snippet_drop_orphan`, a definer that deletes only that makerless personal row)
then deletes their personal snippets. Their shared snippets stay, with no maker, and the
workspace's owners and admins manage them (nobody can make one personal again: only a maker
changes who sees it). The referential action's UPDATE runs as the table owner, so the
guard's client rules never refuse it, and the guard never rewrites `created_by`, so removing
a member cannot fail on a snippet.

**Shortcut clashes** (a new snippet, a renamed shortcut, or a flip between personal and
shared into a word that is taken) are the unique indexes' 23505, which the store turns into
"You already have a snippet ;intro." or "The workspace already has a shared snippet ;intro."

No `entity_access` grants: a snippet is not a record people share one by one, and it never
appears in search, mentions or the graph. Nothing widens who can see any existing record.

The file has no `begin`/`commit` of its own: it is applied with `--single-transaction`. It
was applied to local Postgres only, and re-applies cleanly. `supabase/tests/699_snippets.sql`
runs the rules on a database with several people (rolled back); it passed on local Postgres
over a stub of the tables it needs (auth.users, workspace, member, and the 028/359 helpers).
`src/lib/__tests__/migration-699.test.ts` pins the file's text.

## 4. The agent

- `list_snippets` (read): the person's own and the workspace's shared snippets: name,
  shortcut, personal/shared, the first line. Under `omitPrivate` (a run whose output the
  workspace reads), shared only.
- `get_snippet` (read): one by id or shortcut, with its whole body and the fill-ins it holds.
- `save_snippet` (internal-write): create or change one. A **personal** snippet of the
  person's own is saved at once. Creating or changing a **shared** snippet raises an approval
  card first (it changes words the whole team inserts); the person's Accept replays the exact
  call (`createToolApproval`, `approvedCall`).
- `delete_snippet` (delete): always an approval card first.
- Unattended runs (work runs, skill runs) never write snippets, as with the vocabulary.
- **Drafting:** the drafting tools' guidance (email drafts, replies, documents) says to look
  for a snippet that fits (a signature, a standard answer) with `list_snippets` and use its
  words, filling its fill-ins from what the agent knows.

No new model call: tools only, on the existing chat agent.

## 5. Phases

1. **Snippets and their picker in documents:** migration 699, routes
   (`/api/account/snippets`, `/[id]`), the store, Settings › Snippets, the Create menu entry,
   the `;` reader for TipTap and for text boxes (pure, tested), the menu, in documents.
2. **Every editor:** descriptions and notes, the mail composer, `ChatInput` (main chat,
   teammate and run chats, comments, team chat), `MentionTextarea`.
3. **Fill-ins:** the table above, resolved at insert.
4. **Agents:** the four tools, their registry entries, the approval cards, the drafting
   guidance.

Each phase ends typechecked, with the full suite green, and is pushed only then.

## Decisions to review

1. **Who edits a shared snippet:** its maker, and the workspace's owner or admins. Other
   members use it but don't change it (a shared snippet is words the whole team sends). The
   alternative, any member edits, is a policy change only.
2. **No usage counts.** Ranking is by match (shortcut, then name, then body), personal first.
   Counting uses would need every member to write a shared row; left out to keep the table's
   writes to the people who own it.
3. **Fill-ins are a fixed list of six, in double braces,** and an unknown or empty one stays as
   typed. No custom fields, no prompts for a value at insert time. Double braces so ordinary
   text with single braces (code, JSON) is never touched.
4. **Body stored as markdown**, the format documents already store, so the TipTap editors take
   it through the existing conversion and text boxes take its words as they are.
5. **`;` opens on an empty query** (the whole list), but only when the person has at least one
   snippet; with none, `;` is an ordinary character everywhere.
6. **Text boxes get the markdown words**, not plain text with the formatting stripped: the
   chats, comments and team chat all render markdown.
7. **Snippets are not findable in search or `@`-mentionable.** They are text to insert, not
   records to point at.
8. **The Create menu's "Snippet" opens Settings › Snippets** with a new one started, rather
   than a quick form in the dialog: the body is rich text and wants the full editor.
9. **A member who leaves takes their personal snippets with them; their shared ones stay**
   for the workspace's owners and admins to keep, change or delete (the managing session's
   suggestion, 11-23). The alternative, keeping personal ones orphaned and unreadable, keeps
   words nobody can see; cascading everything would delete words the team uses.
10. **The agent's shared-snippet card carries the snippet's `updated_at`**: an Accept after
    someone changed it saves nothing and says so, rather than overwriting the newer words.

## New dependencies

None. TipTap (`@tiptap/core`, `@tiptap/suggestion`), already in the app, MIT.

## Progress

Built on `claude/snippets` (merged nowhere, rolled out nowhere). Needs migration 699 applied
before the code that reads it is rolled out.

- **Phase 1–4 in one push:** the table and its rules (699), the store
  (`web/src/lib/snippets/`), the routes, Settings › Snippets, the Create menu's "Snippet",
  the `;` reader for TipTap (`web/src/components/editor/snippet-suggestion.ts`) and for text
  boxes (`web/src/components/snippets/use-textarea-snippets.ts`), the menu
  (`web/src/components/snippets/snippet-menu.tsx`), fill-ins, and the four agent tools
  (`web/src/lib/ai/tools/snippets.ts`).
- **Where `;` works:** documents and every `NoteEditor` (descriptions, notes), the mail
  composer (with the recipient's fill-ins), `ChatInput` (main chat, teammate and run chats,
  comments, team chat) and `MentionTextarea` (inline comments, sub-action and event
  descriptions, campaign notes, canvas and spreadsheet comments).
- Not done: the iOS app's composers and the desktop app's own fields.
