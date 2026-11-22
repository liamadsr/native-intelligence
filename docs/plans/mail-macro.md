# Mail: a calmer reader and a composer of its own

The owner (2026-11-21): "update our mail experience to be more like Macro … it's a little
hard to read mail and the UX isn't ideal … we don't even have a way to manually write a
response to an email so we should just match their experience."

Macro's mail client is AGPL. This is a clean-room match of the look and behaviour described
from a screenshot: no code, styles or assets from it, and no new dependency (the composer's
rich text is tiptap, which the app already ships through `novel`).

Branch `claude/mail-macro`. Merged is not live: see "How production works" in `CLAUDE.md`.

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

## Decisions to review

1. **Forward starts a thread of its own** (no `thread_id`): Gmail threads a send only with
   matching References, and Outlook's forward path would need `createForward`. Gmail's own
   UI keeps a forward in the thread; ours shows it in Sent.
2. **A reply quotes nothing.** The thread is the context, as in Macro and as `sendEmail`'s
   Outlook path already does (it strips `createReply`'s quote). A forward quotes in full.
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

## Left out, and why

- Copying anything from Macro: AGPL; clean-room only.
