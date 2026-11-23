# Drive files: a viewer, attachments in Drive, search inside files, PDF comments

Owner, 11-23 ("lets build all of it", matching Macro's Drive): files open inside the app;
attachments from mail and team chat show in Drive and can be searched. Branch
`claude/drive-files`. Migrations 709 and 710, and 711 (phase 4), approved by the managing
session on 11-23; each is written, tested, and rehearsed on a local Postgres only. None is
applied anywhere.

Clean room: behaviour comes from Macro's public pages only (macro.com/drive,
docs.macro.com). No Macro source was read, and no code, CSS, icons or wording is copied.

## What is there today (research, 11-23)

- **Drive.** Folders (690, 693) file docs, tables, spreadsheets and canvases
  (`drive_folder_item`). The Files page (`chat-cards/pages/files-card.tsx`,
  `GET /api/account/files`, `lib/attachments/workspace-files.ts`) lists every `attachments`
  row the person may see, fenced twice: the table's RLS, then the record each file hangs
  off. An image opens in the Lightbox. Every other file is downloaded.
- **Uploaded files** (`attachments`, bucket `attachments`). Each hangs off a capture, an
  action, a project or a table's row (`attachments_has_parent`, 663). The read rule is in
  `lib/attachments/visibility.ts`. Text is already extracted
  (`lib/attachments/extract-text.ts`: unpdf, mammoth, jszip), chunked into
  `attachment_chunks` (087) by the `attachment/index` Inngest job, and found by `find` /
  `deep_search` (`hybrid_search_attachments`, `attachment_rag_search`). The palette finds
  files by name (`menu-queries.ts`, `searchAttachments`).
- **Mail attachments are never stored.** 344 dropped `email_attachment` with the rest of the
  stored mail, under the 10-15 rule that the app keeps no copy of anyone's mail.
  `email_thread_index` keeps only `has_attachments`. The bytes are read live from Gmail or
  Graph:
  - `readEmailAttachment` in `lib/email/email-read-service.ts`, 10 MB.
  - The owner's route, `email/threads/[threadId]/attachment`, which checks the caller's own
    linked mailbox.
  - The share routes (`shares/…`, `thread-shares/…`, `shares/links/…`), which are limited
    to the messages each share froze.

  The chip (`components/email/email-attachments.tsx`) only downloads.
- **Team chat files** live in `team_chat_message.attachments` (jsonb, 555) and the private
  bucket `team-chat-files` (558, `<channel>/<user>/<uuid>.<ext>`, 10 MB).
  `team_chat_can_read` decides who reads them, as it does the message. The chip
  (`team-chat-message-parts.tsx`) opens a new tab.
- **Comments.** The generic `comment` table (026) carries text anchors (047). Canvas (682)
  and spreadsheet (675) comments have tables of their own with a position anchor. They
  share `record-comments/mentions.ts` and `notify.ts` for @-mentions and notices.

## Phase 1: the file viewer (no migration)

One viewer, `components/files/file-viewer.tsx`, opened from:
- the Files page (Drive);
- a mail attachment chip (the owner's thread, and both shared views);
- a team chat attachment;
- a file found by search (the palette's Files group).

The viewer is chosen by name and MIME type (`lib/files/viewer-kind.ts`), so every entry
point picks the same one. Every viewer renders in the browser from the file's own bytes.
A file is never sent to an outside service.

| Kind | How |
|---|---|
| PDF | pdf.js. It is the build already in `unpdf` (MIT wrapper, pdf.js Apache-2.0), so there is no new dependency. It has pages, zoom (in, out, fit width), page thumbnails, find text (every match listed, next and previous) and download. Scripting and eval are off. |
| Image | `<img>` from a blob URL. SVG is shown as text, so its script can never run. |
| Video, audio | `<video>` and `<audio>` |
| Text, code | Text, up to 2 MB |
| Word .docx | mammoth (BSD-2, already a dependency) to HTML, sanitized with DOMPurify (already a dependency) |
| .xlsx, .csv | Read only, through the spreadsheet import readers (`crm/import/sources/spreadsheet.ts`: `readXlsx`, `parseCsv`) |
| .pptx | Basic: each slide's text in order, its pictures and its notes (`lib/files/pptx-slides.ts`). Otherwise, download. |
| Figma link | Figma's own embed (`embed.figma.com`), for a Figma link only |
| Anything else, or too big | Download |

## Phase 2: attachments in Drive (migration 709)

- **Mail attachments in Drive come from the person's own mailboxes, live.** They are never
  copied (see decision 1).
  - `lib/drive/mail-files.ts` and `GET /api/account/drive/mail-files` list them by asking
    the provider for messages with files: Gmail's `has:attachment -in:spam -in:trash`,
    Graph's `hasAttachments eq true`. They read a page at a time, only from the mailboxes
    the person linked to this workspace (`readableWorkspaceEmailAccounts`).
  - A picture placed inline in the body (a signature's logo) is left out.
  - They open through the owner's attachment route. They are hidden by default, behind an
    "Email attachments" filter.
- **Team chat files in Drive.** `lib/drive/chat-files.ts` and
  `GET /api/account/drive/chat-files` read `team_chat_message` under the person's own RLS,
  so a channel's file shows only to its readers. Paging is keyset on (created_at, id).
- **Tabs:**
  - **My files:** files I uploaded or sent.
  - **Recent:** files I opened, from `drive_file_open`.
  - **Shared with me:** files others put where I can read them.
- **Sort** by created (a file never changes once it arrives, so created is also modified),
  opened, name or size. **Filter** by type, creator and source.
- **Upload by dragging files onto a folder.** The file becomes a Drive upload filed in that
  folder. **M** moves the selected item to a folder.

### 709: the rules

- **`attachments.drive_upload`.** A file uploaded to Drive itself, on no record.
  - It is set when the file is made and never changed (a guard trigger).
  - A Drive upload has no other parent, is never a form's, and always has its uploader.
  - `attachments_has_parent` is restated, so an ordinary file still needs a parent exactly
    as 663 left it.
- **Who reads a Drive upload** (`drive_upload_visible_to`, one definer function that every
  path asks):
  - its uploader, always;
  - while it is filed in a folder, every non-guest member: exactly the folder's readers,
    since folders are the workspace's and guests have none (690);
  - an unfiled upload: its uploader only;
  - no person (an unattended run): no one.

  It is never readable by more people than its folder.
- **Where that rule is applied:**
  - four restrictive policies on `attachments`: read, add (as oneself, by a non-guest
    member), and change or delete (its uploader only);
  - the attachments bucket's read rule (663), which reads `attachments` as the caller, so
    the bytes follow the same rule;
  - both `entity_visible_to` overloads, restated from 664;
  - `attachment_readable_by`, restated from 708 with one AND. 708 (the file-search fence,
    released before this) makes `hybrid_search_attachments` and `attachment_rag_search` ask
    it, so `find` and `deep_search` follow the Drive rule without 709 restating either one.

  A test holds each restated body equal to its source with only the Drive lines added.
- **Filing shares it, so only its uploader files, moves or unfiles it.** This is three
  restrictive policies on `drive_folder_item`, next to 693's grant fence. A grant never
  reaches an attachment: no grant names one, so `entity_grant_only` answers false.
  Deleting a folder unfiles the upload, which makes it the uploader's again: narrower,
  never wider.
- **`drive_file_open`:** one row per person, workspace and file.
  - A file is named `upload:<id>` or `team_chat:<object path>`. A mail attachment is
    never recorded: that would keep something of the mail.
  - Each person reads and writes only their own rows.
- A partial index on team chat messages that carry files.

**Rehearsal, local Postgres 16.** Stand-ins stood in for the app's tables, with `auth.uid()`
read from a setting and 690, 693 and 708 applied first. The installed pgvector is 0.6, which
has no `halfvec`, so the rehearsal copy reads `halfvec(3072)` as `vector(3)`. Applied twice,
then 40 checks, all passing:

| Who, doing what | Result |
|---|---|
| Another member reads the uploader's unfiled upload, its bytes, its search text, its graph node | none |
| The same, once it is filed | all |
| A guest, filed or not | none |
| Someone from another workspace | none |
| Another member files, moves, unfiles, renames or deletes someone's upload | refused, or 0 rows |
| Upload as someone else; a guest uploads; a Drive upload on a project; an ordinary file with no parent | refused |
| The uploader turns a Drive upload into an ordinary file | refused |
| The uploader files it, then unfiles it; then deletes its folder | readers widen, then narrow; narrow |
| `hybrid_search_attachments` / `attachment_rag_search` for another member, or with no person | the unfiled upload never comes back |
| An open recorded for someone else, in another workspace, or for a mail attachment | refused |

## Phase 3: search inside files (migration 710)

- **Uploaded files** are already extracted and indexed (`attachment_chunks`). Drive uploads
  join them: the same job indexes them, and 709's arms fence the searches.
- **Team chat files:** 710 adds `team_chat_file_chunk`, the passages of a file on a message.
  - **Reading:** a passage is read exactly as its message is. The policy asks for the
    message under the reader's own RLS, so a reader taken off a channel stops finding its
    files' text at once.
  - **Writing:** only the service role writes passages, through the job
    `team-chat-file-index` (`lib/drive/chat-file-text.ts`), when a message is posted with
    files.
  - **Never stale:**
    - passages cascade with their message and channel;
    - a message deleted in the app (555 clears its files) loses them;
    - a message that drops a file loses that file's passages;
    - editing a message's words changes nothing, since only files are indexed.
  - **The search:** `team_chat_file_search(ws, q, lim, p_requesting_user_id)` searches the
    channels the person may read (556's `team_chat_member_can_read`). It works for the
    caller, or for the person an agent's service-role call names (275's rule: a signed-in
    caller may not name someone else). With no person, it returns no rows.
  - Full text only, as 561's message search.
- **Mail attachments are not indexed** (decision 1). Drive's search box, with the Email
  filter on, passes the words to the provider's own search.

**Rehearsal:** 710 was applied twice after 709, with 474's `team_chat_can_read` and 556's
`team_chat_member_can_read` as written. 17 checks, all passing:
- a member on the channel's team finds the files by their words, and so does an agent
  naming them;
- a member off the team finds nothing, and neither does an agent naming them;
- **a reader taken off the team stops finding the text at once**, through the search and
  the table both;
- a client can't write or delete a passage, and can't search as someone else;
- with no person, nothing comes back;
- a deleted message, a dropped file and a removed message leave no passage, and an edit of
  the words keeps them.

## Phase 4: comments on a PDF (migration 711)

`file_comment`: a comment pinned to a place on a page (page from 1; x and y as fractions of
the page, 0 to 1), with threads, mentions, `via_agent` (692) and resolve.
- **The file** is an uploaded one (`attachment_id`) or one sent in team chat (the message
  and the file's path). It is never a mail attachment.
- **Who:** whoever reads the file at that moment reads, starts, answers and resolves. The
  file is read under the caller's own RLS, so 709's rule and team chat's rule decide.
  Nothing is restated.
- **Words:** a comment is written and deleted as its author.
- **The guard** (682's and 681's rule): a comment keeps its file, author, thread, place and
  time. Only its author changes its words, and a resolver is recorded as themself. 692's
  `record_comment_agent_mark_guard` keeps `via_agent` as it was made.
- **Notices** go through `record-comments/notify.ts`, only to a member who can open the
  file then (`entity_visible_to`, which 709 made Drive-aware). The notification target list
  is 688's with `attachment` added.
- **The agent tool** `comment_on_file` follows `comment_on_canvas`'s policy.

**Rehearsal:** 711 was applied twice after 709 and 710. 25 checks, all passing:
- comments on an upload and on a chat file;
- a comment signed as someone else, on a file one can't read, marked as the assistant's by a
  client, off the page, or on a path the message doesn't carry: refused;
- a reply on another file's thread: refused;
- rewriting another's words, moving their pin or changing their assistant mark: refused;
- resolving as oneself is allowed, as someone else refused;
- deleting another's comment: 0 rows;
- a guest, and a member off the channel, read nothing;
- unfiling an upload hides its comments from the others;
- a deleted file leaves no comment.

## Status (11-23)

| Phase | Built | Checked |
|---|---|---|
| 1. The viewer | All of it. | Pushed at `057ebcd2`. In a browser as the test account: every kind, find, thumbnails, search opens it. |
| 2. Attachments in Drive | The Files card's tabs, sources, type, creator and sort. Mail attachments live behind their filter. Team chat files. Drive uploads (drop on the card or a folder, or Upload). M moves a focused row. Folders hold files. Opens recorded. | Unit and route tests. 709 rehearsed with 40 checks. In a browser: the card, the tabs, the filters, the email filter (no mailbox linked: says so), the viewer. |
| 3. Search inside files | `find` and `search` (ni_search) and the palette find uploads (their extracted text, fenced) and team chat files (710) by their words. Posting a message with files queues its text job. | Unit tests. 710 rehearsed with 17 checks. |
| 4. PDF comments | The viewer's Comments panel: pins on a page, threads on the whole file, replies, resolve, @-mentions. Notices to those who can open the file; a notice opens the file. The `comment_on_file` agent tool. | Unit tests. 711 rehearsed with 25 checks. |

**Before 709, 710 and 711 are applied, the code reads as it would without them:**
- Files list as before.
- No Drive uploads: an upload fails and says why.
- Recent is empty and opens are not recorded.
- Comments are hidden: their route answers 503 and the button does not show.
- Chat file text search finds nothing.

The dev project has none of the three migrations, so the Drive upload, Recent, comments and chat file search paths were not seen in a browser. They were checked by the tests and the local rehearsals. Apply each migration before the code that uses it, as usual.

## New dependencies

None new. Already present and used: `unpdf` (MIT, bundling pdf.js, Apache-2.0; the managing
session confirmed it, 11-23). The existing `unpdf` (MIT, bundling pdf.js, Apache-2.0), `mammoth` (BSD-2), `jszip`
(MIT or GPL-3.0, used under MIT) and `dompurify` (Apache-2.0 or MPL-2.0) do the work.
`pdfjs-dist` 6.5.438 (Apache-2.0) was the first choice, for its worker. Installing it was
refused in this session, so pdf.js runs on the page's thread (see decision 6).

## Decisions to review

1. **Mail attachments are fetched from the provider when needed, never copied.** This
   keeps the 10-15 rule behind 344 (no copy of anyone's mail). As a result:
   - their text is not indexed, so `ni_search` and the palette don't find a mail
     attachment by its words;
   - Drive's email filter searches through Gmail's or Outlook's own search instead;
   - they can't be filed in a folder or commented on.

   The alternative is to copy each one into storage on arrival and index it. That would
   undo 344's rule. The managing session agreed (11-23).
2. **Mail visibility is the person's own mailbox only.** Not even a thread shared with them
   lists its files in Drive. They still open from the shared thread, in the viewer. This is
   narrower than "who can see the thread", never wider.
3. **A Drive upload is its uploader's until it is filed.** Filed, every non-guest member
   reads it: exactly the folder's readers, since folders are the workspace's (690). The
   upload says so. Only its uploader files, moves or unfiles it. The managing session set
   this rule on 11-23 (709).
4. **Team chat and mail files are not filed in folders.** They live in their channel or
   mailbox. M and drag-to-folder apply to uploaded files and Drive records.
5. **No outside viewer services.** Nothing is sent to Google Docs Viewer, Office Online or
   the like. The one outside frame is Figma's own embed, shown only for a Figma link
   someone pasted, and it loads from Figma as the link's own page would.
6. **pdf.js runs without a worker** (the `unpdf` build). It is fine for ordinary PDFs; a
   500-page PDF is slow to search. Adding `pdfjs-dist` with its worker is the fix, if the
   owner approves the dependency.
7. **`.pptx` is basic:** text, pictures and notes, not the slide's layout. Otherwise the
   file downloads.
8. **`.xls` (old binary Excel), `.doc` and `.ppt` download.** No permissive reader is in the
   tree.
9. **Found while restating 275's and 223's searches:** neither fenced a table row's file
   (663) by its table. 708 (a separate session, released first) fixes it with
   `attachment_readable_by`. 709 now extends that helper instead of restating the searches.
10. **Migration numbers.** First reserved as 696, 697 and 706; renumbered 709, 710 and 711
    by the managing session (696, 697 and 706 released unused), so they come after 708, the
    700s batch and GitHub Reviews' 694/695 in both number and apply order, and the repo's
    "newest definition" tests agree with the order they are applied in.
11. **Chat file text is full text only**, no vectors, as 561's message search.
