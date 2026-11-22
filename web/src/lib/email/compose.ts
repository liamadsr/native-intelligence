/**
 * Mail's own composer (components/email/email-composer.tsx): what Reply,
 * Reply all and Forward start from, and what Send posts. Pure, so the
 * recipients, the subject and the threading are tested apart from the editor.
 *
 *  - Reply goes to the message's Reply-To when it names one, else its sender;
 *    replying to a message the person sent themselves goes to whoever it was
 *    sent to (as Gmail does).
 *  - Reply all adds everyone else on the message: its To with the sender,
 *    its Cc as Cc. Never the person's own addresses.
 *  - Forward starts with no one, and the message below the person's words.
 *  - Re: / Fwd: once: a subject that already has one keeps it.
 *
 * Nothing here blocks an address the person typed. A no-reply sender is not
 * dropped as the automatic drafts drop it (src/lib/email/reply-policy.ts):
 * the person decides, and the composer says it doesn't take replies.
 */
import { isDraftAddress, MAX_DRAFT_BODY, MAX_DRAFT_RECIPIENTS, MAX_DRAFT_SUBJECT } from './draft-edits'
import { escapeHtml, htmlToPlainText } from './plain-text-to-html'
import { isNoReplyAddress } from './reply-policy'
import type { ComposeAttachmentWire } from './compose-attachments'

export type ComposeMode = 'reply' | 'replyAll' | 'forward' | 'new'

export interface ComposeAddress {
  name: string | null
  email: string
}

/** The message a reply or a forward is about, as the thread view has it. */
export interface ComposeSource {
  id: string
  from: ComposeAddress
  to: readonly ComposeAddress[]
  cc: readonly ComposeAddress[]
  replyTo?: readonly ComposeAddress[]
  subject: string
  date: string
  bodyHtml: string | null
  bodyText: string | null
}

export interface ComposeStart {
  mode: ComposeMode
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  /** The message replied to (a reply's threading), else null. */
  inReplyTo: string | null
}

const RE = /^\s*re\s*:/i
const FWD = /^\s*(fwd?|fw)\s*:/i

/** "Re: <subject>", once. */
export function replySubject(subject: string): string {
  const s = subject.trim()
  if (!s) return 'Re:'
  return RE.test(s) ? s : `Re: ${s}`
}

/** "Fwd: <subject>", once. */
export function forwardSubject(subject: string): string {
  const s = subject.trim()
  if (!s) return 'Fwd:'
  return FWD.test(s) ? s : `Fwd: ${s}`
}

function clean(list: readonly (ComposeAddress | string)[]): string[] {
  return list
    .map((a) => (typeof a === 'string' ? a : a.email))
    .map((e) => e?.trim().toLowerCase() ?? '')
    .filter((e) => isDraftAddress(e))
}

/** Each address once, in order, leaving out `drop`. */
function unique(list: readonly string[], drop: ReadonlySet<string> = new Set()): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const e of list) {
    if (drop.has(e) || seen.has(e)) continue
    seen.add(e)
    out.push(e)
  }
  return out
}

/** Who a reply (or a reply all) to `source` is addressed to. `own`: the person's addresses, lowercase. */
export function composeRecipients(
  mode: Exclude<ComposeMode, 'forward' | 'new'>,
  source: Pick<ComposeSource, 'from' | 'to' | 'cc' | 'replyTo'>,
  own: ReadonlySet<string>,
): { to: string[]; cc: string[] } {
  const from = clean([source.from])
  const fromMe = from.length > 0 && own.has(from[0])
  const replyTo = clean(source.replyTo ?? [])
  const sourceTo = clean(source.to)
  const sourceCc = clean(source.cc)

  // To the person's own message: on to whoever it went to.
  const primary = fromMe ? unique(sourceTo, own) : unique(replyTo.length ? replyTo : from, own)
  if (mode === 'reply') {
    // Their own message to themselves only: back to themselves.
    return { to: primary.length ? primary : fromMe ? from : [], cc: [] }
  }
  const to = unique([...primary, ...(fromMe ? [] : sourceTo)], own)
  const cc = unique(sourceCc, new Set([...own, ...to]))
  return { to: to.length ? to : fromMe ? from : [], cc }
}

/** Where the composer starts for `mode` on `source` (none: a new email). */
export function composeStart(
  mode: ComposeMode,
  source: ComposeSource | null,
  own: ReadonlySet<string>,
): ComposeStart {
  if (mode === 'new' || !source) return { mode: 'new', to: [], cc: [], bcc: [], subject: '', inReplyTo: null }
  if (mode === 'forward') {
    return { mode, to: [], cc: [], bcc: [], subject: forwardSubject(source.subject), inReplyTo: null }
  }
  const { to, cc } = composeRecipients(mode, source, own)
  return { mode, to, cc, bcc: [], subject: replySubject(source.subject), inReplyTo: source.id }
}

/** The reply's recipients that don't take replies (a no-reply sender): the composer says so. */
export function noReplyRecipients(to: readonly string[]): string[] {
  return to.filter((a) => isNoReplyAddress(a))
}

function person(a: ComposeAddress): string {
  const name = a.name?.trim()
  return name && name.toLowerCase() !== a.email.toLowerCase() ? `${name} <${a.email}>` : a.email
}

function forwardDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * The forwarded message under the person's words, as mail clients write it:
 * a "Forwarded message" header (From, Date, Subject, To, Cc), then the
 * message. Its HTML goes through `sanitize` (the reader's own sanitizer, the
 * one that draws mail on the page); a text-only message is escaped.
 */
export function forwardQuoteHtml(source: ComposeSource, sanitize: (html: string) => string): string {
  const lines = [
    '---------- Forwarded message ---------',
    `From: ${person(source.from)}`,
    `Date: ${forwardDate(source.date)}`,
    `Subject: ${source.subject}`,
    source.to.length ? `To: ${source.to.map(person).join(', ')}` : '',
    source.cc.length ? `Cc: ${source.cc.map(person).join(', ')}` : '',
  ].filter(Boolean)
  const header = lines.map(escapeHtml).join('<br>')
  const body = source.bodyHtml
    ? sanitize(source.bodyHtml)
    : escapeHtml(source.bodyText ?? '').replace(/\r\n|\r|\n/g, '<br>')
  return `<div class="ni_forward">${header}<br><br>${body}</div>`
}

/**
 * The editor's HTML as mail clients write a typed message: a `<div>` per
 * paragraph, `<div><br></div>` for an empty one (clients give a `<p>` a
 * margin), in the same styled container plain text gets (plain-text-to-html.ts).
 */
export function editorHtmlToEmail(html: string): string {
  const body = html
    .replace(/<p(\s[^>]*)?>\s*<\/p>/gi, '<div><br></div>')
    .replace(/<p(\s[^>]*)?>/gi, '<div>')
    .replace(/<\/p>/gi, '</div>')
  return `<div style="font-family: sans-serif; line-height: 1.5;">${body}</div>`
}

/** Whether the editor holds anything but empty paragraphs. */
export function editorIsEmpty(html: string): boolean {
  return htmlToPlainText(html).trim() === '' && !/<(img|li)\b/i.test(html)
}

export interface ComposeFields {
  to: readonly string[]
  cc: readonly string[]
  bcc: readonly string[]
  subject: string
}

/** What stops Send, said as the composer says it; null: it can go. */
export function composeProblem(fields: ComposeFields, bodyLength: number, mode: ComposeMode): string | null {
  const all = [...fields.to, ...fields.cc, ...fields.bcc]
  if (fields.to.length + fields.cc.length + fields.bcc.length === 0) return 'Add a recipient'
  const bad = all.find((a) => !isDraftAddress(a))
  if (bad) return `“${bad}” isn’t an email address`
  if (all.length > MAX_DRAFT_RECIPIENTS) return `At most ${MAX_DRAFT_RECIPIENTS} recipients`
  if (fields.subject.length > MAX_DRAFT_SUBJECT) return 'The subject is too long'
  if (mode === 'new' && !fields.subject.trim()) return 'Add a subject'
  if (bodyLength > MAX_DRAFT_BODY * 4) return 'The message is too long'
  return null
}

export interface ComposeSendInput extends ComposeFields {
  mode: ComposeMode
  /** The editor's HTML (editorHtmlToEmail is applied here). */
  editorHtml: string
  /** A forward's quoted message (forwardQuoteHtml), appended below. */
  quoteHtml?: string | null
  threadId?: string | null
  inReplyTo?: string | null
  accountId?: string | null
  /** The thread's draft this send replaces (an AI draft the composer was filled from): deleted after the send. */
  replacesDraftId?: string | null
  /** Files attached in the composer. */
  attachments?: readonly ComposeAttachmentWire[]
}

/** The body POST /api/account/email/send takes. */
export interface ComposeSendBody {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body_html: string
  body_text: string
  thread_id?: string
  in_reply_to_message_id?: string
  account_id?: string
  provider_draft_id?: string
  attachments?: ComposeAttachmentWire[]
}

/**
 * The send request for what the composer holds. A reply threads on its thread
 * and the message it answers (sendEmail resolves that message's Message-ID for
 * In-Reply-To and References). A forward and a new email start a thread of
 * their own.
 */
export function composeSendBody(input: ComposeSendInput): ComposeSendBody {
  const quote = input.quoteHtml ? `<br>${input.quoteHtml}` : ''
  const html = editorHtmlToEmail(input.editorHtml) + quote
  const reply = input.mode === 'reply' || input.mode === 'replyAll'
  const subject =
    input.mode === 'reply' || input.mode === 'replyAll'
      ? input.subject.trim() || 'Re:'
      : input.subject.trim()
  return {
    to: [...input.to],
    ...(input.cc.length ? { cc: [...input.cc] } : {}),
    ...(input.bcc.length ? { bcc: [...input.bcc] } : {}),
    subject,
    body_html: html,
    body_text: htmlToPlainText(html),
    ...(reply && input.threadId ? { thread_id: input.threadId } : {}),
    ...(reply && input.inReplyTo ? { in_reply_to_message_id: input.inReplyTo } : {}),
    ...(input.accountId ? { account_id: input.accountId } : {}),
    ...(input.replacesDraftId ? { provider_draft_id: input.replacesDraftId } : {}),
    ...(input.attachments?.length ? { attachments: [...input.attachments] } : {}),
  }
}

/** The body POST /api/account/email/save-draft takes, for what the composer holds. */
export function composeDraftBody(input: ComposeSendInput): Record<string, unknown> {
  const send = composeSendBody({ ...input, replacesDraftId: null })
  return {
    to: send.to,
    ...(send.cc ? { cc: send.cc } : {}),
    ...(send.bcc ? { bcc: send.bcc } : {}),
    subject: send.subject,
    body_html: send.body_html,
    ...(send.thread_id ? { thread_id: send.thread_id } : {}),
    ...(send.in_reply_to_message_id ? { in_reply_to_message_id: send.in_reply_to_message_id } : {}),
    ...(send.account_id ? { account_id: send.account_id } : {}),
    ...(send.attachments ? { attachments: send.attachments } : {}),
  }
}

/**
 * The body POST /api/account/email/scheduled takes for a message written in
 * the composer (its "new message" form; a reply names its thread and message
 * as reply_thread_id / in_reply_to_message_id). Null without a mailbox to
 * send from: scheduling needs one named.
 */
export function composeScheduleBody(input: ComposeSendInput): Record<string, unknown> | null {
  const send = composeSendBody({ ...input, replacesDraftId: null })
  if (!send.account_id) return null
  return {
    account_id: send.account_id,
    to: send.to,
    ...(send.cc ? { cc: send.cc } : {}),
    ...(send.bcc ? { bcc: send.bcc } : {}),
    subject: send.subject,
    body_html: send.body_html,
    ...(send.thread_id && send.in_reply_to_message_id
      ? { reply_thread_id: send.thread_id, in_reply_to_message_id: send.in_reply_to_message_id }
      : {}),
    ...(send.attachments ? { attachments: send.attachments } : {}),
  }
}
