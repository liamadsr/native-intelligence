import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { ownMailAddresses } from '@/lib/email/own-addresses'
import { workspaceHasEventFlows } from './event-triggers'

type Send = (events: Array<{ name: string; id: string; data: Record<string, unknown> }>) => Promise<unknown>

/**
 * New mail for email_received loops. The incremental sync (src/lib/inngest/
 * email-functions.ts) triages the threads a push touched
 * (src/lib/email/triage.ts); the ones whose NEWEST message changed (and that
 * the person hasn't muted) are the candidates here. Of those, a thread is an
 * ARRIVAL when its newest message is:
 *   - from someone else: never one of the person's own addresses (their own
 *     mail, and so everything the app sends from their mailbox);
 *   - not a draft, and not in spam, trash, drafts or sent (Gmail's labels; an
 *     Outlook message in Junk is asked of Graph, as the index keeps no folder);
 *   - recent (ARRIVAL_WINDOW_MS): an old thread touched for the first time
 *     (a label added to mail from before the import) is not new mail.
 * The first import and a full re-index never come through triage, so they
 * never emit. One event per arrived message, keyed on a STABLE id of it, so
 * a re-delivered push fires once: Gmail's message id; for Outlook the
 * message's internetMessageId (its RFC 822 Message-ID), read in the same
 * Graph call as the Junk check, because Graph's own message id changes when
 * the message moves folders (an inbox rule, an archive), which would fire the
 * loop again for the same mail. Only when the mailbox's person has an enabled
 * email_received loop in the workspace (nothing is read otherwise).
 */

/** How recent an arrival's newest message must be. */
export const ARRIVAL_WINDOW_MS = 24 * 60 * 60 * 1000

const EXCLUDED_FOLDERS = new Set(['spam', 'trash', 'drafts', 'sent'])

export interface EmailArrival {
  threadId: string
  /** The provider's message id (Graph's changes when an Outlook message moves). */
  messageId: string
  fromEmail: string | null
  /** The id the event is keyed on when it differs from messageId: an Outlook message's internetMessageId. */
  stableId?: string
}

interface IndexRow {
  provider_thread_id: string
  provider_message_id: string | null
  from_email: string | null
  is_draft: boolean | null
  folder: string | null
  last_message_at: string | null
}

/** Where an arrived Outlook message sits, and its stable id. */
export interface OutlookMessagePlace {
  junk: boolean
  /** The message's internetMessageId (stable across folder moves), or null when Graph gave none. */
  internetMessageId: string | null
}

/** Which arrived Outlook messages sit in Junk. Fails CLOSED: a message Graph won't place counts as junk. */
export async function outlookJunkMessageIds(accessToken: string, messageIds: string[], fetchImpl: typeof fetch = fetch): Promise<Set<string>> {
  const places = await outlookMessagePlaces(accessToken, messageIds, fetchImpl)
  return new Set([...places].filter(([, p]) => p.junk).map(([id]) => id))
}

/**
 * Each arrived Outlook message's folder (Junk or not) and internetMessageId,
 * one Graph read per message. Fails CLOSED on the folder: a message Graph
 * won't place counts as junk.
 */
export async function outlookMessagePlaces(
  accessToken: string,
  messageIds: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, OutlookMessagePlace>> {
  const places = new Map<string, OutlookMessagePlace>()
  if (messageIds.length === 0) return places
  const junkPlace: OutlookMessagePlace = { junk: true, internetMessageId: null }
  const headers = { Authorization: `Bearer ${accessToken}` }
  let junkFolder: string | null = null
  try {
    const res = await fetchImpl('https://graph.microsoft.com/v1.0/me/mailFolders/junkemail?$select=id', { headers })
    if (res.ok) {
      const id = ((await res.json()) as { id?: unknown }).id
      junkFolder = typeof id === 'string' && id ? id : null
    }
  } catch {
    junkFolder = null
  }
  for (const id of messageIds) {
    if (!junkFolder) {
      places.set(id, junkPlace)
      continue
    }
    try {
      const res = await fetchImpl(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}?$select=parentFolderId,internetMessageId`, { headers })
      const body = res.ok ? ((await res.json()) as { parentFolderId?: unknown; internetMessageId?: unknown }) : null
      const folder = body?.parentFolderId
      const internetMessageId = typeof body?.internetMessageId === 'string' && body.internetMessageId.trim() ? body.internetMessageId.trim() : null
      places.set(id, { junk: typeof folder !== 'string' || folder === junkFolder, internetMessageId })
    } catch {
      places.set(id, junkPlace)
    }
  }
  return places
}

/**
 * The arrivals among the changed threads (the rules above). Never throws: a
 * failed read emits nothing (a missed loop fire, logged, never a wrong one).
 */
export async function emailArrivals(
  supabase: SupabaseClient,
  input: {
    userId: string
    workspaceId: string
    provider: 'google' | 'microsoft'
    accountId: string | null
    threadIds: readonly string[]
    mailboxEmail: string | null
    /** The mailbox's token, asked only for an Outlook mailbox with an arrival (the Junk check). */
    getAccessToken?: () => Promise<string | null>
    now?: number
  },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<EmailArrival[]> {
  if (input.threadIds.length === 0) return []
  try {
    if (!(await workspaceHasEventFlows(supabase, { workspaceId: input.workspaceId, triggerType: 'email_received', ownerUserId: input.userId }))) return []
    let q = supabase
      .from('email_thread_index')
      .select('provider_thread_id, provider_message_id, from_email, is_draft, folder, last_message_at')
      .eq('user_id', input.userId)
      .eq('workspace_id', input.workspaceId)
      .eq('provider', input.provider)
      .in('provider_thread_id', [...new Set(input.threadIds)])
    q = input.accountId ? q.eq('account_id', input.accountId) : q.is('account_id', null)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    const own = await ownMailAddresses(supabase, input.userId)
    const mailbox = input.mailboxEmail?.trim().toLowerCase()
    if (mailbox) own.add(mailbox)
    const since = (input.now ?? Date.now()) - ARRIVAL_WINDOW_MS
    const seen = new Set<string>()
    const arrivals: EmailArrival[] = []
    for (const row of (data ?? []) as IndexRow[]) {
      if (!row.provider_message_id || seen.has(row.provider_message_id)) continue
      if (row.is_draft) continue
      if (row.folder && EXCLUDED_FOLDERS.has(row.folder)) continue
      const from = (row.from_email ?? '').trim().toLowerCase()
      if (!from || own.has(from)) continue
      const at = Date.parse(row.last_message_at ?? '')
      if (!Number.isFinite(at) || at < since) continue
      seen.add(row.provider_message_id)
      arrivals.push({ threadId: row.provider_thread_id, messageId: row.provider_message_id, fromEmail: from })
    }
    if (input.provider === 'microsoft' && arrivals.length) {
      const token = input.getAccessToken ? await input.getAccessToken() : null
      if (!token) return []
      const places = await outlookMessagePlaces(token, arrivals.map((a) => a.messageId), deps.fetchImpl)
      const stable = new Set<string>()
      const out: EmailArrival[] = []
      for (const a of arrivals) {
        const place = places.get(a.messageId)
        if (!place || place.junk) continue
        // Keyed on the internetMessageId when Graph gave one (a moved message keeps it).
        const key = place.internetMessageId ? `imid:${place.internetMessageId}` : null
        if (key && stable.has(key)) continue
        if (key) stable.add(key)
        out.push(key ? { ...a, stableId: key } : a)
      }
      return out
    }
    return arrivals
  } catch (err) {
    console.warn('[flows] email arrivals not read:', err instanceof Error ? err.message : 'unknown')
    return []
  }
}

/** The event for one arrived message (its id is the message's stable id: a re-delivered push, or a moved Outlook message, fires once). */
export function emailReceivedEvent(
  args: { workspaceId: string; userId: string; provider: 'google' | 'microsoft'; accountId: string | null; arrival: EmailArrival; firedAt: string },
) {
  return {
    name: 'flow/email.received',
    id: `email-received:${args.userId}:${args.arrival.stableId ?? args.arrival.messageId}`,
    data: {
      workspace_id: args.workspaceId,
      user_id: args.userId,
      provider: args.provider,
      account_id: args.accountId,
      thread_id: args.arrival.threadId,
      message_id: args.arrival.messageId,
      from_email: args.arrival.fromEmail,
      fired_at: args.firedAt,
    },
  }
}

/** Send one event per arrival. Never throws; returns how many were sent. */
export async function emitEmailReceived(
  args: { workspaceId: string; userId: string; provider: 'google' | 'microsoft'; accountId: string | null; arrivals: EmailArrival[]; firedAt?: string },
  deps: { send?: Send } = {},
): Promise<number> {
  if (args.arrivals.length === 0) return 0
  const firedAt = args.firedAt ?? new Date().toISOString()
  const events = args.arrivals.map((arrival) => emailReceivedEvent({ ...args, arrival, firedAt }))
  try {
    await (deps.send ?? ((e) => inngest.send(e as never)))(events)
    return events.length
  } catch (err) {
    console.error('[flows] email received inngest.send failed', err instanceof Error ? err.message : 'unknown')
    return 0
  }
}
