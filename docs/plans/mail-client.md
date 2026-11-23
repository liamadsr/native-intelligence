# Mail: a calmer reader and a composer of its own

The owner (2026-11-21): "update our mail experience to be more like [the reference product] …
it's a little hard to read mail and the UX isn't ideal … we don't even have a way to manually
write a response to an email so we should just match their experience."

The reference product's mail client is AGPL. This is a clean-room match of the look and
behaviour described from a screenshot: no code, styles or assets from it, and no new dependency
(the composer's rich text is tiptap, which the app already ships through `novel`).

Built in #225, #227 and #228. Merged is not live: see "How production works" in `CLAUDE.md`.

## What it is now

### Reading (phase 1)

- **The subject** is large and bold (`text-2xl`), with a "…" menu beside it: Reply, Reply
  all, Forward (with their keys), Star, Archive, Delete, Make a task, Share to chat, Copy
  link. The quiet icon row above it (previous/next, star, archive, delete, task, share,
  link) stays, without the header's "Reply All" text button and tag button (tags are the
  "+ Add tags" chip right under the subject).
- **One row of pill chips** under the subject: the automatic labels ("To respond", the
  category), the person's tags and "+ Add tags", the linked contact, the shares, then the
  people with their initials ("Me" for the person). Unchanged in substance
  (`email-thread-tags.tsx`), it now sits under the bigger subject.
- **Each message is its own soft card** (`email-message.tsx`): rounded, generous padding, a
  faint tint instead of a border, so it reads on the app's glass and on both themes. Top
  left: initials, the sender's name, their address muted, and "to Me" (or "to Dana +2"; the
  full list is its title). Top right: Reply and Forward, then a short date ("Sep 9"; the
  time today; the full date is its title).
- **The body in 15px with 1.65 line height** (HTML mail, in its shadow root) and
  `leading-relaxed` for text-only mail.
- **Older messages are one line** (initials, name, the first line of what it says, without
  its quoted history, the date); a click opens it. The last message and any draft are open.
- **Quoted history collapses to a small "•••" pill** (titled "Show quoted text"), and opens
  with a soft rule on its left. Only the label and styling of the existing `<details>`
  changed; the sanitising in `email-sanitize.ts` is untouched.
- **The thread ends in a "Reply…" row** with the person's avatar: clicked, it becomes the
  composer, in place.
- Kept as they were: tags and "To respond", sharing and @mention shares, the invitation and
  RSVP card, Outlook's attachment chips (and every attachment as a chip), read aloud, the
  agents section, focusing a draft opened from a card, multiple accounts.

### Writing (phase 1: reply, reply all, forward, send)

- `email-composer.tsx`, used for Reply, Reply all and Forward in the thread (from the
  "Reply…" row, each card's Reply and Forward, the "…" menu, and R, A, F), and for New
  email (phase 3).
- **Recipients** (`src/lib/email/compose.ts`, tested on its own):
  - Reply: the message's Reply-To when it names one, else its sender. To a message the
    person sent themselves: whoever it went to.
  - Reply all: that, plus the message's To; its Cc as Cc; the person's own addresses never.
  - Forward: no one.
  - To, Cc and Bcc are editable chips with contact search (the existing
    `email-recipient-input.tsx`).
- **Subject:** "Re:" / "Fwd:" once (a subject that has one keeps it). A reply's subject is
  shown muted and becomes editable on a click; a forward's and a new email's are an input.
- **Threading:** a reply posts `thread_id` and `in_reply_to_message_id` (the message it
  answers), so `sendEmail` sets In-Reply-To and References at Gmail and uses `createReply` at
  Outlook. It goes out from the thread's own mailbox: the thread response now carries
  `accountId` (its index row's account) and `mailboxEmail`, and the composer posts
  `account_id`. Before, a reply without `account_id` went out from the person's first
  mailbox.
- **Rich text:** bold, italic, links (http, https and mailto only), bulleted and numbered
  lists. Sent as HTML in the same container plain text gets, a `<div>` per paragraph (as mail
  clients write it), with a plain-text part made from it.
- **Forward** puts the original below the note, as clients do ("---------- Forwarded message
  ---------", From, Date, Subject, To, Cc, then the message, its HTML through the reader's own
  sanitizer). The composer shows it as a collapsed "Forwarded message from …".
- **Keys:** R reply, A reply all, F forward (new: `mail-forward` in `src/lib/shortcuts.ts`),
  ⌘/Ctrl+Enter sends, Esc closes the composer only (never the thread behind it) and keeps
  what was written.
- **Kept when closed:** what is written stays for this person in this browser (memory, then
  `localStorage`, a week at most; `src/lib/email/compose-drafts.ts`), and comes back when the
  same kind of composer opens on the same message.
- A reply to an address that takes no replies (`noreply@…`, the same test as
  `reply-policy.ts`) says so under the recipients; it is not removed (the person decides).
- Reply's no-reply and automatic-reply rules (`reply-policy.ts`, `email-reply-gate.ts`)
  govern the automatic drafts only; nothing in them is loosened, and the composer reuses the
  no-reply test to warn.

### Writing (phase 2: files, drafts, send later, undo, AI)

- **Files:** a paperclip (or a drop onto the composer) attaches files, shown as chips with
  their size and an ×. 3 MB a file, 10 files, 6 MB in all
  (`src/lib/email/compose-attachments.ts`, checked in the composer and again by each route):
  Outlook takes a file of up to 3 MB in one request, and `/api/account/*` passes the app's
  proxy, which reads at most 10 MB of a body (base64 adds a third). `sendEmail` and
  `saveDraftToProvider` carry them: Gmail as `multipart/mixed` parts (RFC 2231 names for
  non-ASCII), Outlook as a `fileAttachment` each on the draft before `/send`; a refused file
  stops the send.
- **Save draft** puts it in the mailbox (`save-draft`), threaded for a reply: Gmail gets
  In-Reply-To/References from the answered message's Message-ID; Outlook makes it with
  `createReply`. Before, a reply draft saved there was not threaded at Outlook and had no
  In-Reply-To at Gmail. The thread then shows the draft as a card, with its own Send, Send
  later, Edit and Discard (unchanged).
- **Send later** beside Send (the existing picker): the scheduled route's new-message form now
  takes `reply_thread_id` + `in_reply_to_message_id` (and files), so a scheduled reply waits
  as a threaded draft.
- **Undo send:** Send closes the composer at once and shows "Sending… Undo" for 5 seconds
  (`src/lib/email/undo-send.ts`); Undo opens the composer again as it was, and nothing is
  sent. The wait lives outside the composer, so closing the thread doesn't drop it; while a
  send waits, leaving the page asks first. A failed send says why, with "Open" to bring the
  composer back; what was written is kept until the send has gone.
- **Draft with AI** (inside the composer, not on forwards): with an AI draft on the thread
  (an `email_draft` row an agent or the chat wrote), "Use AI draft" fills the composer
  (recipients, subject, words) and says so; the person reads it over and sends it, and the send
  replaces that draft (`provider_draft_id`, deleted and released as the chat card's send
  does). With none, it asks the chat (`requestEmailReply`, as Reply did) and shows "Drafting in
  chat…"; when the draft lands on the thread it fills in, or, if the person has started
  writing, offers "Use it". Nothing is sent without the person pressing Send.

### New email (phase 3)

- **One composer for everything.** The Create dialog's Email type (opened from Mail's pencil
  and `c`, and from Create anywhere) is now the same `EmailComposer`, in `new` mode: To/Cc/Bcc,
  subject, rich text, files, Save draft, Send later, Undo. The dialog keeps its header (the
  type, and the From mailbox picker); its old plain-text form, footer and handlers are gone.
- What is written is kept when the dialog closes (Esc, the ×, clicking outside), and is there
  the next time New email opens; the composer's trash discards it. Undo on a send opens the
  dialog again on it.
- Send later needs a mailbox to send from: with none connected it is off.

## Screenshots

`/dev/mail-thread` (DEV ONLY, like `/dev/inbox-tidy`): the real thread pane and composer on a
made-up thread, every mail request answered in the browser, nothing sent. `?compose=reply`,
`replyAll` or `forward` opens the composer; `?theme=dark` draws it dark.

## Decisions to review

**Accepted by the owner as written, 2026-11-22.**

1. **Forward starts a thread of its own** (no `thread_id`): Gmail threads a send only with
   matching References, and Outlook's forward path would need `createForward`. Gmail's own
   UI keeps a forward in the thread; ours shows it in Sent.
2. **A reply quotes nothing.** The thread is the context, as in the reference product and as
   `sendEmail`'s Outlook path already does (it strips `createReply`'s quote). A forward quotes
   in full.
3. **The original's attachments are not forwarded.** Re-attaching them needs the server to
   fetch each file from the mailbox; left for later (the composer's own files go, phase 2).
4. **Older messages collapse to one line** even when unread; the last message and drafts are
   open. Gmail opens every unread message.
5. **The header's "Reply All" (chat) button is gone:** writing it yourself is the default;
   "Draft with AI" lives inside the composer (phase 2).
6. **The header's tag button is gone**: "+ Add tags" under the subject opens the same picker.
7. **A no-reply recipient is warned about, not removed.**
8. **The composer's local copy lives in `localStorage`** (per person, per browser, a week):
   it is a convenience. Save draft (phase 2) is what puts a draft in the mailbox.
9. **Undo is a client-side wait of 5 seconds** before the request is made (the same for
   Gmail and Outlook). A tab closed in those seconds asks first; if the person leaves anyway,
   the email is not sent (it is still in the composer's local copy).
10. **Files: 3 MB each, 6 MB in all.** Bigger needs Outlook's upload sessions and a larger
    proxy body limit (a deploy setting): left out.
11. **"Use AI draft" only offers drafts an agent wrote** (the thread's `email_draft` rows),
    not a draft the person saved themselves (that one is its own card with Edit).
12. **Save draft after filling from the AI draft** saves the new one and discards the AI one,
    so the thread keeps one draft.

## Left out, and why

- Copying anything from the reference product: AGPL; clean-room only.
