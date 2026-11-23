# Drive files: a viewer, attachments in Drive, search inside files, PDF comments

Owner, 11-23 ("lets build all of it", matching Macro's Drive): files open inside the app;
attachments from mail and team chat show in Drive and can be searched. Branch
`claude/drive-files`. Reserved migrations 696 and 697, plus 698 asked for (phase 4).

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

## Phase 2: attachments in Drive (migration 696)

- **Mail attachments in Drive come from the person's own mailboxes, live.** They are never
  copied (see decision 1).
  - Listed by asking the provider for messages with attachments: Gmail's `has:attachment`,
    Graph's `hasAttachments eq true`, a page at a time, only from the mailboxes the person
    linked to this workspace (`readableWorkspaceEmailAccounts`).
  - They are opened through the owner's attachment route.
  - Hidden by default, behind an "Email attachments" filter.
- **Team chat files in Drive** are read from `team_chat_message` under the person's own RLS
  (`team_chat_can_read`), so a channel's file shows only to its readers. 696 adds a partial
  index on messages that carry files.
- **Tabs:**
  - **My files:** files I uploaded or sent.
  - **Recent:** the files I opened last.
  - **Shared with me:** files others put where I can read them: a channel I'm in, a record
    shared with me, a thread shared with me.
- **Sort** by modified, created or opened. **Filter** by type, creator and source (upload,
  team chat, email).
- **Upload by dragging files onto a folder.** The file becomes an `attachments` row filed
  in that folder.
- **M moves the selected item** to a folder (the folder picker).

696 holds, all of it new except where named:
- `attachments.drive_upload` (boolean). `attachments_has_parent` is restated to allow a
  Drive upload with no other parent.
- `drive_folder_item` takes `attachment`. Its type check is widened, and
  `drive_folder_item_readable` is restated with one arm, under the reader's own RLS, as
  today.
- `drive_file_open`, which records when a person last opened a file (for Recent and "sort
  by opened"). Each person reads and writes only their own rows.
- The partial index above.

## Phase 3: search inside files (migration 697)

- **Uploaded files** are already extracted and indexed. Phase 3 also indexes Drive uploads,
  and shows a content hit in the palette's Files group (`hybrid_search_attachments`, already
  fenced by the attachments rule).
- **Team chat files:** 697 adds `team_chat_file_chunk`, a file's extracted text chunks, by
  channel and message.
  - RLS uses `team_chat_can_read`. The service role writes the rows.
  - An Inngest job indexes a message's files when it is posted, and drops them when the
    message is deleted or its files cleared.
  - `find` and `ni_search` get one arm for it, fenced by the channel. Agents in a channel
    turn read only what the person can.
- **Mail attachments are not indexed** (decision 1). Drive's search box, with the Email
  filter on, passes the words to the provider's own search.

## Phase 4: comments on a PDF (migration 698, to be asked for)

- A comment pinned to a place on a page: page, x and y as fractions of the page.
- It uses the record-comment pattern (canvas and spreadsheet):
  - `file_comment`, whose RLS follows the file's own read rule (an uploaded file's,
    `filterVisibleAttachments`'s rule; a chat file's, `team_chat_can_read`);
  - `@-mentions` through `record-comments/mentions.ts`, and notices through
    `record-comments/notify.ts`, only to someone who can open the file;
  - an agent tool, `comment_on_file`, which asks first as the other comment writers do.
- Mail attachments get no comments: a comment would keep a copy of something about the mail.

## New dependencies

None. The existing `unpdf` (MIT, bundling pdf.js, Apache-2.0), `mammoth` (BSD-2), `jszip`
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
   undo 344's rule.
2. **Mail visibility is the person's own mailbox only.** Not even a thread shared with them
   lists its files in Drive. They still open from the shared thread, in the viewer. This is
   narrower than "who can see the thread", never wider.
3. **A file dropped on a Drive folder is seen by every member** of the workspace (not
   guests). This is what a project's or a task's file already is, and folders are already
   shared by the whole workspace (690). The upload says so. The alternative, a private
   upload, needs a new rule on `attachments`.
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
