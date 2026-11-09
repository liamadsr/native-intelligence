import type { SupabaseClient } from '@supabase/supabase-js'
import { ownedMailbox, type LiveMailbox } from './thread-mailbox'
import { heldThreadsFor } from './held-threads'
import { decodeHtmlEntities } from './html-entities'

/**
 * The inbox's live headers (no stored mail, 2026-10-15). The index keeps ids,
 * flags and addresses; the subject, preview and sender name of the rows on
 * screen come from the provider, batched, ONE round trip per mailbox:
 *   - Gmail: one batch request (multipart/mixed) of messages.get
 *     format=metadata for each row's newest message (5 quota units each);
 *   - Graph: one list call for the folder's page, then single GETs for the
 *     misses from a rolling pool of at most 4 (Graph's per-mailbox concurrency).
 * A held row's subject comes from its hold, with no call. A row the provider
 * can't answer (moved, gone, a 429) gets no header: the list shows it without.
 * Nothing is written; the browser keeps the answers in memory only.
 */

export interface ThreadHeader {
  subject: string | null
  snippet: string | null
  from_name: string | null
}

export interface HeaderRow {
  id: string
  account_id: string | null
  provider: string | null
  provider_thread_id: string
  provider_message_id: string | null
  /** The Mail folder (Graph lists that folder's page in one call). */
  folder?: string | null
}

/** Most rows one call fills (two pages of the list). */
export const HEADERS_MAX_ROWS = 50
const PREVIEW_CHARS = 200

const GMAIL_BATCH_URL = 'https://gmail.googleapis.com/batch/gmail/v1'

function clip(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
}

/** "Name <a@b>" → Name; a bare address → null (the list shows from_email then). */
function displayName(from: string): string | null {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*</)
  return m ? m[1].trim() || null : null
}

/** How long to wait before the one retry a throttled batch gets (Retry-After, capped). */
const RETRY_MAX_MS = 5_000
const RETRY_DEFAULT_MS = 1_000

export interface BatchOptions {
  /** Waits before the retry (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A Retry-After value in milliseconds, within the cap. */
function retryAfterMs(value: string | null | undefined): number {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, RETRY_MAX_MS) : RETRY_DEFAULT_MS
}

/** A Gmail message as a metadata read returns it (the fields Native Intelligence reads). */
export interface GmailMetadata {
  id: string
  threadId?: string
  snippet?: string
  labelIds?: string[]
  internalDate?: string
  payload?: { headers?: Array<{ name: string; value: string }> }
}

/** A header of a metadata read, by name (case-insensitive), or ''. */
export function gmailHeaderValue(msg: GmailMetadata, name: string): string {
  const lower = name.toLowerCase()
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? ''
}

/** A metadata read as a list header. Gmail's snippet is HTML-escaped: decoded here. */
export function gmailThreadHeader(msg: GmailMetadata): ThreadHeader {
  const subject = clip(gmailHeaderValue(msg, 'subject'), 500)
  const snippet = clip(msg.snippet, PREVIEW_CHARS * 2)
  return {
    subject: subject === null ? null : decodeHtmlEntities(subject),
    snippet: snippet === null ? null : clip(decodeHtmlEntities(snippet), PREVIEW_CHARS),
    from_name: displayName(gmailHeaderValue(msg, 'from')),
  }
}

/**
 * Gmail: one batch of metadata reads, by message id (at most
 * HEADERS_MAX_ROWS, 5 quota units each: about 250, Gmail's per-user budget a
 * second). A throttled batch (a 429, whole or for some parts) is retried once
 * for what is missing, after Retry-After. Exported for its tests and for
 * search (email-search-service.ts), which asks for more headers.
 */
export async function gmailMetadata(
  token: string,
  messageIds: readonly string[],
  opts: BatchOptions & { headers?: readonly string[] } = {},
): Promise<Map<string, GmailMetadata>> {
  const out = new Map<string, GmailMetadata>()
  const ids = messageIds.slice(0, HEADERS_MAX_ROWS)
  const sleep = opts.sleep ?? realSleep
  const names = opts.headers ?? ['Subject', 'From']
  for (let attempt = 0; attempt < 2; attempt++) {
    const missing = ids.filter((id) => !out.has(id))
    if (!missing.length) break
    const result = await gmailBatchOnce(token, missing, names, out)
    if (!result.throttled) break
    if (attempt === 0) await sleep(result.retryAfter)
  }
  return out
}

/** Gmail list headers (subject, preview, sender name), keyed by message id. */
export async function gmailHeaders(token: string, messageIds: readonly string[], opts: BatchOptions = {}): Promise<Map<string, ThreadHeader>> {
  const raw = await gmailMetadata(token, messageIds, opts)
  return new Map([...raw.entries()].map(([id, msg]) => [id, gmailThreadHeader(msg)]))
}

async function gmailBatchOnce(
  token: string,
  ids: readonly string[],
  headerNames: readonly string[],
  out: Map<string, GmailMetadata>,
): Promise<{ throttled: boolean; retryAfter: number }> {
  const boundary = `batch_dial8_${ids.length}_${Date.now()}`
  const query = ['format=metadata', ...headerNames.map((h) => `metadataHeaders=${encodeURIComponent(h)}`)].join('&')
  const body =
    ids
      .map(
        (id, i) =>
          `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item${i}>\r\n\r\nGET /gmail/v1/users/me/messages/${encodeURIComponent(id)}?${query}\r\n\r\n`,
      )
      .join('') + `--${boundary}--`
  const res = await fetch(GMAIL_BATCH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/mixed; boundary=${boundary}` },
    body,
  })
  if (res.status === 429) return { throttled: true, retryAfter: retryAfterMs(res.headers?.get?.('Retry-After')) }
  if (!res.ok) return { throttled: false, retryAfter: 0 }
  const text = await res.text()
  let throttled = false
  for (const chunk of text.split(/--batch_[\w-]+/)) {
    if (/HTTP\/1\.1 429/.test(chunk)) throttled = true
    const json = chunk.match(/\{[\s\S]*\}/)
    if (!json) continue
    try {
      const msg = JSON.parse(json[0]) as GmailMetadata
      if (!msg.id) continue
      out.set(msg.id, msg)
    } catch {
      // A part that isn't a message (an error) gets no header.
    }
  }
  return { throttled, retryAfter: RETRY_DEFAULT_MS }
}

/** Graph allows about 4 concurrent requests per mailbox: the pool never runs more. */
const GRAPH_CONCURRENCY = 4
const GRAPH_LIST_TOP = 50
const GRAPH_SELECT = 'id,conversationId,subject,bodyPreview,from'

/** A Mail folder as Graph names it (its well-known folder), or null for one Graph has no name for. */
export function graphFolderOf(folder: string | null | undefined): string | null {
  switch (folder) {
    case 'inbox': return 'inbox'
    case 'sent': return 'sentitems'
    case 'drafts': return 'drafts'
    case 'trash': return 'deleteditems'
    case 'spam': return 'junkemail'
    case 'archive': return 'archive'
    default: return null
  }
}

function graphHeader(body: Record<string, unknown>): ThreadHeader {
  const from = (body.from as { emailAddress?: { name?: string } } | undefined)?.emailAddress
  return {
    subject: clip(body.subject, 500),
    snippet: clip(body.bodyPreview, PREVIEW_CHARS),
    from_name: clip(from?.name, 200),
  }
}

/** One row as the Graph path needs it: its newest message, its conversation, its folder. */
export interface GraphHeaderRow {
  messageId: string
  conversationId: string
  folder?: string | null
}

/**
 * Graph headers for these rows, in their order (the visible rows first):
 *   1. ONE list call for the page: the folder's newest 50 messages with
 *      subject, preview and sender, matched by message id or, failing that,
 *      by conversation (the newest message of each, as the list is newest first);
 *   2. the misses only, as single GETs from a rolling pool of at most 4 at
 *      once (Graph's per-mailbox concurrency), in row order, no waves; a
 *      throttled GET (429) waits its Retry-After and is retried once.
 * Keyed by message id. Exported for its tests.
 */
export async function graphHeaders(token: string, rows: readonly GraphHeaderRow[], opts: BatchOptions = {}): Promise<Map<string, ThreadHeader>> {
  const out = new Map<string, ThreadHeader>()
  if (!rows.length) return out
  const sleep = opts.sleep ?? realSleep
  const auth = { Authorization: `Bearer ${token}` }

  // 1. The page in one call, from the folder most of these rows are in.
  const counts = new Map<string, number>()
  for (const r of rows) {
    const f = graphFolderOf(r.folder)
    if (f) counts.set(f, (counts.get(f) ?? 0) + 1)
  }
  const folder = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0]
  if (folder) {
    try {
      const params = new URLSearchParams({ $select: GRAPH_SELECT, $orderby: 'receivedDateTime desc', $top: String(GRAPH_LIST_TOP) })
      const res = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?${params}`, { headers: auth })
      if (res.ok) {
        const data = (await res.json()) as { value?: Array<Record<string, unknown>> }
        const byConversation = new Map<string, ThreadHeader>()
        for (const m of data.value ?? []) {
          const h = graphHeader(m)
          if (typeof m.id === 'string') out.set(m.id, h)
          if (typeof m.conversationId === 'string' && !byConversation.has(m.conversationId)) byConversation.set(m.conversationId, h)
        }
        for (const r of rows) {
          if (!out.has(r.messageId) && byConversation.has(r.conversationId)) out.set(r.messageId, byConversation.get(r.conversationId)!)
        }
      }
    } catch {
      // The pool below asks for every row then.
    }
  }

  // 2. The misses, a rolling pool of at most GRAPH_CONCURRENCY single GETs.
  const misses = [...new Set(rows.map((r) => r.messageId))].filter((id) => !out.has(id))
  let next = 0
  const one = async (id: string, retried = false): Promise<void> => {
    try {
      const res = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}?$select=${GRAPH_SELECT}`, { headers: auth })
      if (res.status === 429 && !retried) {
        await sleep(retryAfterMs(res.headers?.get?.('Retry-After')))
        return one(id, true)
      }
      if (!res.ok) return
      out.set(id, graphHeader((await res.json()) as Record<string, unknown>))
    } catch {
      // No header for this row.
    }
  }
  const worker = async () => {
    while (next < misses.length) {
      const id = misses[next++]
      await one(id)
    }
  }
  await Promise.all(Array.from({ length: Math.min(GRAPH_CONCURRENCY, misses.length) }, worker))
  return out
}

export interface ThreadHeadersDeps {
  mailbox?: (userId: string, accountId: string) => Promise<LiveMailbox | null>
  gmail?: typeof gmailHeaders
  graph?: typeof graphHeaders
}

/**
 * Headers for these index rows (the person's own, at most HEADERS_MAX_ROWS),
 * keyed by row id. Held rows answer from their hold; the rest, one batched
 * call per mailbox, all mailboxes in parallel. Never throws.
 */
export async function fetchThreadHeaders(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; rows: readonly HeaderRow[] },
  deps: ThreadHeadersDeps = {},
): Promise<Record<string, ThreadHeader>> {
  const rows = args.rows.slice(0, HEADERS_MAX_ROWS)
  const out: Record<string, ThreadHeader> = {}
  if (!rows.length) return out

  const held = await heldThreadsFor(supabase, { userId: args.userId, providerThreadIds: rows.map((r) => r.provider_thread_id) })
  const heldBy = new Map(held.map((h) => [`${h.account_id ?? ''}:${h.provider_thread_id}`, h]))
  const live: HeaderRow[] = []
  for (const row of rows) {
    const hold = heldBy.get(`${row.account_id ?? ''}:${row.provider_thread_id}`)
    if (hold) out[row.id] = { subject: hold.subject, snippet: null, from_name: null }
    else if (row.account_id && row.provider_message_id) live.push(row)
  }

  const byAccount = new Map<string, HeaderRow[]>()
  for (const row of live) byAccount.set(row.account_id!, [...(byAccount.get(row.account_id!) ?? []), row])
  const resolveMailbox = deps.mailbox ?? ownedMailbox
  await Promise.all(
    [...byAccount.entries()].map(async ([accountId, accountRows]) => {
      try {
        const mailbox = await resolveMailbox(args.userId, accountId)
        if (!mailbox) return
        const ids = [...new Set(accountRows.map((r) => r.provider_message_id!))]
        const found = mailbox.provider === 'google'
          ? await (deps.gmail ?? gmailHeaders)(mailbox.token, ids)
          : await (deps.graph ?? graphHeaders)(mailbox.token, accountRows.map((r) => ({ messageId: r.provider_message_id!, conversationId: r.provider_thread_id, folder: r.folder ?? null })))
        for (const row of accountRows) {
          const h = found.get(row.provider_message_id!)
          if (h) out[row.id] = h
        }
      } catch (err) {
        console.warn('[email-headers] a mailbox did not answer:', err instanceof Error ? err.message : 'unknown error')
      }
    }),
  )
  return out
}

/** The index columns a live-headers caller selects: pointers only. */
export const HEADER_ROW_COLUMNS = 'id, account_id, provider, provider_thread_id, provider_message_id, folder'

/**
 * Index rows with their live headers merged in (subject, snippet, sender
 * name), for a server reader that shows a short list (a contact's or a
 * company's mail). One batched call per mailbox; a row with no answer keeps
 * null. Nothing is stored. Never throws.
 */
export async function withLiveHeaders<T extends HeaderRow>(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; rows: readonly T[] },
  deps: ThreadHeadersDeps = {},
): Promise<Array<T & ThreadHeader>> {
  const headers = await fetchThreadHeaders(supabase, args, deps)
  return args.rows.map((row) => {
    const header = headers[row.id] as ThreadHeader | undefined
    return { ...row, subject: header?.subject ?? null, snippet: header?.snippet ?? null, from_name: header?.from_name ?? null }
  })
}
