/**
 * The mail seam (A6 slice 1): `recordEmailEvent` is the ONE way a mail
 * pipeline tells the agent's inbox what happened. Both drafting paths call it
 * through `recordDraftPassEvents` below:
 *   • the main path, on arrival: `emailDraftReplies`
 *     (src/lib/inngest/email-functions.ts), after a push's triage handed it the
 *     threads that want a reply (src/lib/email/arrival-drafts.ts);
 *   • the safety net, the 05:00 cron (src/app/api/cron/email-management/route.ts),
 *     which drafts only what arrival missed: threads that need a reply, have
 *     no draft and whose newest message is older than SAFETY_NET_MARGIN_MS.
 *
 * What it records, for one (workspace, user):
 *   • email.drafted       one per draft written (dedupe `email:draft:<id>`),
 *                         quiet: "while you were away" and the digest say it;
 *   • email.needs_reply   one per thread that needs a reply and got no draft
 *                         (dedupe `email:<account>:<thread>:<message>`, so a
 *                         new message in the thread is a new event, and the
 *                         two paths reporting one thread land one row).
 *
 * Facts are pointers and an address (no stored mail, 2026-10-15): the sender's
 * address, the linked contact's id, and why no draft; never a subject, a
 * display name, a preview or a body. Renderers name the sender and point at
 * the review pile; the agent reads the thread live if it needs more.
 * Each also says whether the sender is KNOWN to the person (a CRM contact, or
 * an address they have sent mail to: ./known-senders.ts): the router turns a
 * known sender's thread into a home turn within a couple of minutes (Liam's
 * "known people only" rule, 2026-10-15); every other one stays quiet.
 * Never throws.
 *
 * The autonomy, dormancy, usage and cap gates on the drafting itself belong to
 * the mail pipelines (src/lib/email/arrival-drafts.ts), not to this seam: the
 * router gates what the agent says about it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { recordAgentEvents, type AgentEventInput, type RecordAgentEventsDeps } from './record'
import { agentEventKey } from './types'
import { isKnownThreadSender, knownSenders } from './known-senders'

/**
 * A thread's email.trust mark, only while it is about the thread's latest
 * message (the Mail chip's rule, currentTrustMark in email-thread-item.tsx):
 * a newer message is judged on its own, so a stale mark never silences a
 * genuine reply that came after it. Pure.
 */
export function currentThreadTrust(r: { trust?: unknown; trust_message_id?: unknown; provider_message_id?: unknown }): 'suspicious' | 'injection' | null {
  if (r.trust !== 'suspicious' && r.trust !== 'injection') return null
  if (typeof r.trust_message_id !== 'string' || !r.trust_message_id || r.trust_message_id !== r.provider_message_id) return null
  return r.trust
}

export interface EmailDraftedEvent {
  draftId: string
  /** When it was drafted (ISO); defaults to now. */
  at?: string | null
  /** The thread's sender's address (never a display name). */
  from?: string | null
  /** The thread's linked CRM contact (a pointer). */
  contactId?: string | null
  /** The sender is someone the person knows (./known-senders.ts). */
  known?: boolean
  /** email.trust marked the thread at its latest message (an injection thread still drafts). */
  flagged?: boolean
}

export interface EmailNeedsReplyEvent {
  /** connected_account id (or the provider when the index has none). */
  accountId: string
  providerThreadId: string
  /** The newest message's provider id: a later message is a new event. */
  providerMessageId?: string | null
  /** The sender's address (never a display name). */
  from?: string | null
  /** The thread's linked CRM contact (a pointer). */
  contactId?: string | null
  /** Why no draft: 'cap', 'gate', 'not_drafted'… (templated, not free text). */
  reason?: string | null
  at?: string | null
  /** The sender is someone the person knows (./known-senders.ts). */
  known?: boolean
}

export interface RecordEmailEventArgs {
  workspaceId: string
  userId: string
  drafted?: readonly EmailDraftedEvent[]
  needsReply?: readonly EmailNeedsReplyEvent[]
}

/** The events these mail facts are. Pure. */
export function emailEventInputs(args: RecordEmailEventArgs): AgentEventInput[] {
  const out: AgentEventInput[] = []
  for (const d of args.drafted ?? []) {
    if (!d?.draftId) continue
    out.push({
      workspaceId: args.workspaceId,
      userId: args.userId,
      kind: 'email.drafted',
      priority: 1,
      occursAt: d.at ?? null,
      refType: 'email_draft',
      refId: d.draftId,
      facts: {
        ...(d.from ? { from: d.from } : {}),
        ...(d.contactId ? { contactId: d.contactId } : {}),
        ...(d.known ? { known: true } : {}),
        ...(d.flagged ? { flagged: true } : {}),
      },
      dedupeKey: agentEventKey.emailDraft(d.draftId),
    })
  }
  for (const t of args.needsReply ?? []) {
    if (!t?.accountId || !t.providerThreadId) continue
    out.push({
      workspaceId: args.workspaceId,
      userId: args.userId,
      kind: 'email.needs_reply',
      priority: 1,
      occursAt: t.at ?? null,
      refType: 'email_thread',
      refId: t.providerThreadId,
      facts: {
        ...(t.from ? { from: t.from } : {}),
        ...(t.contactId ? { contactId: t.contactId } : {}),
        ...(t.reason ? { reason: t.reason } : {}),
        ...(t.known ? { known: true } : {}),
      },
      dedupeKey: agentEventKey.emailNeedsReply(t.accountId, t.providerThreadId, t.providerMessageId),
    })
  }
  return out
}

/**
 * Record what a mail pass did for one person in one workspace. Returns how
 * many rows newly landed. Never throws.
 */
export async function recordEmailEvent(
  args: RecordEmailEventArgs,
  supabase?: SupabaseClient,
  deps: RecordAgentEventsDeps = {},
): Promise<number> {
  try {
    if (!args.workspaceId || !args.userId) return 0
    const inputs = emailEventInputs(args)
    if (!inputs.length) return 0
    return await recordAgentEvents(inputs, supabase, deps)
  } catch (err) {
    console.warn('[agent-event] email skipped:', err instanceof Error ? err.message : err)
    return 0
  }
}

/** How far back the cron path looks for threads still waiting on a reply. */
export const NEEDS_REPLY_LOOKBACK_MS = 24 * 60 * 60_000
/** At most this many not-drafted threads per pass. */
export const NEEDS_REPLY_MAX = 10

/**
 * The threads that need a reply and have no draft: the drafting pass's own
 * candidate set (needs_reply, personal or important) with a message in the
 * lookback window, minus the threads drafted this pass and those with a
 * pending or approved draft already. Read from email_thread_index and
 * email_draft only. Never throws: a failed read is an empty list.
 */
export async function threadsAwaitingReply(
  supabase: SupabaseClient,
  args: {
    userId: string
    workspaceId: string
    draftedThreadIds?: readonly string[]
    /** Only these threads (provider ids): the arrival path reports the ones it was handed. */
    providerThreadIds?: readonly string[]
    /** Why they got no draft (templated): 'not_drafted' by default, or 'cap', 'paused', 'dormant', 'usage'. */
    reason?: string
    /** A thread's own reason, by provider thread id, over `reason` ('unsure': the gate asks the person first, E3). */
    reasons?: Readonly<Record<string, string>>
    /** Only threads whose newest message is at or before this (ISO): the safety net leaves fresh mail to arrival. */
    lastMessageBefore?: string
    nowMs?: number
  },
): Promise<EmailNeedsReplyEvent[]> {
  try {
    if (args.providerThreadIds && args.providerThreadIds.length === 0) return []
    const since = new Date((args.nowMs ?? Date.now()) - NEEDS_REPLY_LOOKBACK_MS).toISOString()
    let query = supabase
      .from('email_thread_index')
      .select('id, account_id, provider, provider_thread_id, provider_message_id, from_email, last_message_at, linked_contact_id, trust, trust_message_id')
      .eq('user_id', args.userId)
      .eq('workspace_id', args.workspaceId)
      .eq('needs_reply', true)
      .in('auto_classified', ['personal', 'important'])
    if (args.providerThreadIds) query = query.in('provider_thread_id', [...args.providerThreadIds])
    if (args.lastMessageBefore) query = query.lte('last_message_at', args.lastMessageBefore)
    const { data, error } = await query
      .gte('last_message_at', since)
      .order('last_message_at', { ascending: false })
      .limit(NEEDS_REPLY_MAX * 3)
    if (error || !Array.isArray(data) || data.length === 0) return []
    const rows = data as Array<Record<string, unknown>>
    const drafted = new Set(args.draftedThreadIds ?? [])
    // A thread email.trust marked (suspicious, injection) at its latest message never asks for a reply here (§6b).
    let candidates = rows.filter((r) => typeof r.id === 'string' && !drafted.has(r.id as string) && currentThreadTrust(r) === null)
    if (!candidates.length) return []
    const { data: drafts, error: draftsError } = await supabase
      .from('email_draft')
      .select('email_thread_id')
      .in('email_thread_id', candidates.map((r) => r.id as string))
      .in('status', ['pending_review', 'approved', 'edited'])
    if (draftsError) return []
    const hasDraft = new Set(((drafts as Array<{ email_thread_id?: unknown }> | null) ?? []).map((d) => d.email_thread_id))
    candidates = candidates.filter((r) => !hasDraft.has(r.id)).slice(0, NEEDS_REPLY_MAX)
    const known = await knownSenders(supabase, { workspaceId: args.workspaceId, userId: args.userId, addresses: candidates.map((r) => r.from_email as string | null) })
    return candidates.flatMap((r) => {
      const threadId = typeof r.provider_thread_id === 'string' ? r.provider_thread_id : null
      const accountId = typeof r.account_id === 'string' && r.account_id ? r.account_id : typeof r.provider === 'string' ? r.provider : null
      if (!threadId || !accountId) return []
      return [
        {
          accountId,
          providerThreadId: threadId,
          providerMessageId: typeof r.provider_message_id === 'string' ? r.provider_message_id : null,
          from: typeof r.from_email === 'string' && r.from_email ? r.from_email : null,
          contactId: typeof r.linked_contact_id === 'string' && r.linked_contact_id ? r.linked_contact_id : null,
          reason: args.reasons?.[threadId] ?? args.reason ?? 'not_drafted',
          at: typeof r.last_message_at === 'string' ? r.last_message_at : null,
          ...(isKnownThreadSender(r, known) ? { known: true } : {}),
        },
      ]
    })
  } catch {
    return []
  }
}

/**
 * A drafting pass's events in the person's agent inbox: one per draft written,
 * one per thread that needs a reply and has none (`reason` says why). Both
 * paths call this, so the router, the away section and the digest read one
 * shape whichever path drafted. Never throws: a lost event is a gap, never a
 * failed pass.
 */
export async function recordDraftPassEvents(
  supabase: SupabaseClient,
  args: {
    userId: string
    workspaceId: string
    drafts: ReadonlyArray<Record<string, unknown>>
    providerThreadIds?: readonly string[]
    reason?: string
    /** Per-thread reasons over `reason` (threadsAwaitingReply). */
    reasons?: Readonly<Record<string, string>>
    lastMessageBefore?: string
    nowMs?: number
  },
  deps: RecordAgentEventsDeps = {},
): Promise<number> {
  try {
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
    const draftedThreadIds = args.drafts.map((d) => str(d.email_thread_id)).filter((id): id is string => id !== null)
    const senders = await draftedThreadSenders(supabase, args, draftedThreadIds)
    const drafted = args.drafts.flatMap((d) => {
      const draftId = str(d.id)
      if (!draftId) return []
      const sender = senders.get(str(d.email_thread_id) ?? '')
      return [{
        draftId,
        at: str(d.created_at),
        ...(sender?.from ? { from: sender.from } : {}),
        ...(sender?.contactId ? { contactId: sender.contactId } : {}),
        ...(sender?.known ? { known: true } : {}),
        ...(sender?.flagged ? { flagged: true } : {}),
      }]
    })
    const needsReply = await threadsAwaitingReply(supabase, {
      userId: args.userId,
      workspaceId: args.workspaceId,
      draftedThreadIds,
      ...(args.providerThreadIds ? { providerThreadIds: args.providerThreadIds } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
      ...(args.reasons ? { reasons: args.reasons } : {}),
      ...(args.lastMessageBefore ? { lastMessageBefore: args.lastMessageBefore } : {}),
      ...(args.nowMs !== undefined ? { nowMs: args.nowMs } : {}),
    })
    return await recordEmailEvent({ workspaceId: args.workspaceId, userId: args.userId, drafted, needsReply }, supabase, deps)
  } catch (err) {
    console.warn('[agent-event] draft pass events skipped:', err instanceof Error ? err.message : err)
    return 0
  }
}

/**
 * The sender of each drafted thread (email_thread_index, never a message
 * body) and whether the person knows them. A failed read is an empty map: the
 * drafts still land, quiet.
 */
async function draftedThreadSenders(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string },
  threadIds: readonly string[],
): Promise<Map<string, { from: string | null; contactId: string | null; known: boolean; flagged: boolean }>> {
  const out = new Map<string, { from: string | null; contactId: string | null; known: boolean; flagged: boolean }>()
  if (!threadIds.length) return out
  try {
    const { data, error } = await supabase
      .from('email_thread_index')
      .select('id, from_email, linked_contact_id, provider_message_id, trust, trust_message_id')
      .eq('user_id', args.userId)
      .eq('workspace_id', args.workspaceId)
      .in('id', [...threadIds])
    if (error || !Array.isArray(data)) return out
    const rows = data as Array<Record<string, unknown>>
    const known = await knownSenders(supabase, { workspaceId: args.workspaceId, userId: args.userId, addresses: rows.map((r) => r.from_email as string | null) })
    for (const r of rows) {
      if (typeof r.id !== 'string') continue
      const from = typeof r.from_email === 'string' && r.from_email ? r.from_email : null
      const contactId = typeof r.linked_contact_id === 'string' && r.linked_contact_id ? r.linked_contact_id : null
      // A thread email.trust marked at its latest message is never a known
      // sender's (no turn for it, §6b), and Jev never raises it (`flagged`).
      const flagged = currentThreadTrust(r) !== null
      out.set(r.id, { from, contactId, known: !flagged && isKnownThreadSender(r, known), flagged })
    }
  } catch {
    // Unknown senders: the drafts stay quiet.
  }
  return out
}
