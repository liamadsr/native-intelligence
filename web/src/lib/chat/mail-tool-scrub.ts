/**
 * Saved chat turns keep no mail (no stored mail, 2026-10-15). A turn that ran
 * a mail tool carries the tool's output in its parts: read_email returns whole
 * bodies, list_emails subjects and previews, get_email_drafts held chains,
 * show / read_card mail items subjects, get_contact_details /
 * get_company_overview recent_email_threads subjects, and search / find email
 * rows subjects and previews. The model already saw them live; what is kept
 * (chat_messages, and the tab's chat blob in the browser) is a POINTER: the
 * thread and message ids, counts, and success, never the text. Reopening the
 * chat shows the call and its pointer; the agent reads the thread again live
 * when it needs to.
 *
 * Applied on every chat_messages write path (the eve writer, the client
 * autosave's create and append) and before a chat is persisted in the browser
 * (scrubMailToolOutputsForStorage). AI SDK v5+ tool parts (`tool-<name>`,
 * `dynamic-tool`) and v4 `tool-invocation` parts are both handled. Pure;
 * returns the input untouched when there is nothing to scrub.
 */

/** Tools whose whole output is mail text: kept as a pointer. */
const MAIL_TOOLS = ['read_email', 'list_emails', 'get_email_drafts']

/** Fields a mail row carries that a sender wrote (or a subject derives from). */
const MAIL_TEXT_FIELDS = ['subject', 'snippet', 'from_name', 'preview', 'body', 'body_text']

type Part = Record<string, unknown> & { type?: unknown }

function toolNameOf(part: Part): string | null {
  if (typeof part.type === 'string' && part.type.startsWith('tool-') && part.type !== 'tool-invocation') return part.type.slice(5)
  if (part.type === 'dynamic-tool' && typeof part.toolName === 'string') return part.toolName
  if (typeof part.toolName === 'string') return part.toolName
  return null
}

function isMailTool(name: string | null): boolean {
  return !!name && MAIL_TOOLS.some((t) => name === t || name.endsWith(`_${t}`) || name.endsWith(`.${t}`))
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

/** A mail tool's output as its pointer: ids and counts, never text. */
export function mailOutputPointer(output: unknown): Record<string, unknown> {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return { scrubbed: 'mail' }
  const o = output as Record<string, unknown>
  // Already a pointer (a chat reloaded from storage and saved again): keep it
  // as it is. Re-deriving it would drop the id lists it exists to keep.
  if (o.scrubbed === 'mail') return o
  const ids = (list: unknown, key: string) =>
    Array.isArray(list) ? list.map((x) => (x && typeof x === 'object' ? str((x as Record<string, unknown>)[key]) : null)).filter((x): x is string => !!x).slice(0, 50) : undefined
  const pointer: Record<string, unknown> = { scrubbed: 'mail' }
  if (typeof o.success === 'boolean') pointer.success = o.success
  if (str(o.error)) pointer.error = o.error
  if (str(o.thread_id)) pointer.thread_id = o.thread_id
  if (str(o.last_message_id)) pointer.last_message_id = o.last_message_id
  if (typeof o.message_count === 'number') pointer.message_count = o.message_count
  if (typeof o.count === 'number') pointer.count = o.count
  const messageIds = ids(o.messages, 'message_id')
  if (messageIds?.length) pointer.message_ids = messageIds
  const emailIds = ids(o.emails, 'id')
  if (emailIds?.length) pointer.email_ids = emailIds
  const threadIds = ids(o.emails, 'threadId')
  if (threadIds?.length) pointer.thread_ids = threadIds
  const draftIds = ids(o.drafts, 'id')
  if (draftIds?.length) pointer.draft_ids = draftIds
  if (o.message && typeof o.message === 'object') {
    const id = str((o.message as Record<string, unknown>).messageId)
    if (id) pointer.message_id = id
  }
  return pointer
}

/** A mail row with its sender-written text taken out (ids, dates and flags kept). */
function mailRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) if (!MAIL_TEXT_FIELDS.includes(k) && k !== 'metadata') out[k] = v
  return { ...out, scrubbed: 'mail' }
}

/**
 * Mail rows inside any other output: a search / find email row keeps its id,
 * a mail card item (show / read_card: `thread_id` with a subject) and a
 * contact's or company's recent_email_threads keep ids, dates and flags.
 */
function scrubEmailRows(value: unknown, depth = 0): unknown {
  if (depth > 8 || !value || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((v) => {
      const s = scrubEmailRows(v, depth + 1)
      if (s !== v) changed = true
      return s
    })
    return changed ? next : value
  }
  const o = value as Record<string, unknown>
  if (o.result_type === 'email') {
    return { result_type: 'email', result_id: o.result_id, ...(o.event_at ? { event_at: o.event_at } : {}), title: 'Email', scrubbed: 'mail' }
  }
  if (typeof o.thread_id === 'string' && ('subject' in o || 'snippet' in o) && o.scrubbed !== 'mail') return mailRow(o)
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    let s: unknown
    if (k === 'recent_email_threads' && Array.isArray(v)) {
      s = v.map((t) => (t && typeof t === 'object' && (t as Record<string, unknown>).scrubbed !== 'mail' ? mailRow(t as Record<string, unknown>) : t))
      changed = true
    } else {
      s = scrubEmailRows(v, depth + 1)
      if (s !== v) changed = true
    }
    next[k] = s
  }
  return changed ? next : value
}

/** The output keys a part keeps its result under. */
const OUTPUT_KEYS = ['output', 'result']

function scrubOutputs(holder: Record<string, unknown>, mailTool: boolean): Record<string, unknown> | null {
  let changed = false
  const out: Record<string, unknown> = { ...holder }
  for (const key of OUTPUT_KEYS) {
    if (!(key in out)) continue
    const next = mailTool ? mailOutputPointer(out[key]) : scrubEmailRows(out[key])
    if (next !== out[key]) {
      out[key] = next
      changed = true
    }
  }
  return changed ? out : null
}

/** One part with any mail text replaced by a pointer. */
export function scrubMailPart<T extends Part>(part: T): T {
  if (!part || typeof part !== 'object') return part
  // AI SDK v4: { type: 'tool-invocation', toolInvocation: { toolName, args, result } }.
  if (part.type === 'tool-invocation' && part.toolInvocation && typeof part.toolInvocation === 'object') {
    const inv = part.toolInvocation as Record<string, unknown>
    const scrubbed = scrubOutputs(inv, isMailTool(typeof inv.toolName === 'string' ? inv.toolName : null))
    return (scrubbed ? { ...part, toolInvocation: scrubbed } : part) as T
  }
  const scrubbed = scrubOutputs(part, isMailTool(toolNameOf(part)))
  return (scrubbed ?? part) as T
}

/** A UI message with its mail tool outputs scrubbed (parts only; the rest as it was). */
export function scrubMailFromMessage<T>(message: T): T {
  if (!message || typeof message !== 'object') return message
  const parts = (message as { parts?: unknown }).parts
  if (!Array.isArray(parts)) return message
  let changed = false
  const next = parts.map((p) => {
    const s = scrubMailPart(p as Part)
    if (s !== p) changed = true
    return s
  })
  return changed ? ({ ...(message as object), parts: next } as T) : message
}

/**
 * Messages as they may be persisted anywhere outside the live session (the
 * tab's chat blob in localStorage, a main-chat cache): every mail tool output
 * a pointer. The shared helper for every browser-side chat store. Pure.
 */
export function scrubMailToolOutputsForStorage<T>(messages: readonly T[]): T[] {
  let changed = false
  const next = messages.map((m) => {
    const s = scrubMailFromMessage(m)
    if (s !== m) changed = true
    return s
  })
  return changed ? next : (messages as T[])
}
