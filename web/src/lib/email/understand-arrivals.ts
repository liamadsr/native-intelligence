/**
 * Arriving mail reaches the agent (docs/plans/email-through-the-agent.md E2;
 * Liam, 2026-10-20: "it's about feeding the main agent information it needs
 * to know, not always about just drafting up replies… the main agent is my
 * filter").
 *
 * The push's triage (./triage.ts) hands over every thread with a new newest
 * message that drafting doesn't take: a notice, a receipt, an invitation, an
 * alert, a person's message the reply checks passed on. Not a newsletter
 * (decision 2), a draft or the person's own message. Here each is read live
 * (no stored mail), put to Jev's email.understand, and recorded as one
 * `email.arrived` event in the push's workspace (the account's own: one
 * email is never told in four workspaces, decision 3). The router decides how
 * loud it is (./../agent-events/router.ts).
 *
 * The event carries templated facts only: the sender's address, its CRM
 * contact, whether the person knows them, and Jev's answers (what it is,
 * should they know, does it ask them something). Never a subject or a body:
 * the agent reads the thread live when it decides to.
 *
 * A confirmation it understood (a booking, a receipt, a delivery…) is also
 * put beside the person's open to-dos, and the one it clearly settles is
 * marked done, with Undo (./action-done-from-mail.ts).
 *
 * Every thread it understood, conversations too (not a newsletter), is then
 * put beside the records it could change: the table rows linked to its
 * people, and (a known contact's conversation) the open to-dos. The one
 * change it states is applied, with Undo (../kept-up-to-date/sources.ts).
 * Not on a thread the to-do closer just closed one from: one change a source.
 *
 * Gates, as drafting's: the kill switch (failing closed), a dormant workspace,
 * a person over their usage; then at most MAX_UNDERSTOOD_PER_DAY a day and
 * MAX_UNDERSTOOD_PER_PASS a push. Never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { runDecision } from '@/lib/ai/decisions/run-decision'
import type { EmailUnderstandInput, EmailUnderstandValue } from '@/lib/ai/decisions/tasks/email-understand'
import type { DecisionResult } from '@/lib/ai/decisions/contracts'
import { recordAgentEvents, type AgentEventInput, type RecordAgentEventsDeps } from '@/lib/agent-events/record'
import { agentEventKey } from '@/lib/agent-events/types'
import { knownSenders } from '@/lib/agent-events/known-senders'
import { readMemberTimeZone } from '@/lib/agent-events/member-time-zone'
import { draftNowLabel } from '@/lib/crm/email-drafts'
import { readAgentPausedState, type AgentPausedState } from '@/lib/work/agent-paused'
import { draftingBlocked } from './arrival-drafts'
import { mailDonePass, type MailDonePass } from './action-done-from-mail'
import { mailKeptPass, type MailKeptPass } from '@/lib/kept-up-to-date/sources'
import { readEmailThread, type EmailMessageForAI, type EmailThreadForAI } from './email-read-service'
import { mailboxAddresses } from './reply-policy'

/** At most this many threads are understood per push (a flood waits for the next one). */
export const MAX_UNDERSTOOD_PER_PASS = 25
/** At most this many arrivals are understood per person per workspace per UTC day. */
export const MAX_UNDERSTOOD_PER_DAY = 80
/** An arrival is news for this long ("while you were away" and the digest skip it after). */
export const ARRIVED_EVENT_TTL_MS = 3 * 24 * 60 * 60_000
/** The newest messages sent to Jev, each body clipped, within the task's state budget. */
const MESSAGES_SENT = 6
const BODY_MAX = 4_000
const STATE_BUDGET = 26_000

export interface UnderstandArrivalsArgs {
  userId: string
  workspaceId: string
  accountId: string | null
  provider: 'google' | 'microsoft'
  threadIds: readonly string[]
  /** The mailbox's own address: its own messages are never "arrived". */
  mailboxEmail: string | null
}

export interface UnderstandArrivalsDeps {
  readPaused?: (supabase: SupabaseClient, workspaceId: string) => Promise<AgentPausedState>
  blocked?: (supabase: SupabaseClient, userId: string, workspaceId: string) => Promise<'dormant' | 'usage' | null>
  readThread?: (userId: string, threadId: string, workspaceId: string, opts: { accountId: string | null; provider: 'google' | 'microsoft' }) => Promise<EmailThreadForAI | null>
  decide?: (input: EmailUnderstandInput, ctx: { userId: string; workspaceId: string; runId: string }) => Promise<DecisionResult<EmailUnderstandValue>>
  timeZone?: (supabase: SupabaseClient, person: { workspaceId: string; userId: string }) => Promise<string>
  record?: RecordAgentEventsDeps
  /** The pass's to-do closer (default: mailDonePass); null closes nothing. */
  mailDone?: ((supabase: SupabaseClient, scope: Parameters<typeof mailDonePass>[1]) => MailDonePass) | null
  /** The pass's record keeper (default: mailKeptPass); null changes nothing. */
  kept?: ((supabase: SupabaseClient, scope: Parameters<typeof mailKeptPass>[1]) => MailKeptPass) | null
  nowMs?: number
}

export interface UnderstandArrivalsResult {
  understood: number
  recorded: number
  /** Open to-dos a confirmation marked done. */
  closed?: number
  /** Records kept up to date. */
  kept?: number
  skipped?: 'paused' | 'dormant' | 'usage' | 'cap'
}

/**
 * The email.understand input for a thread as the live read returns it: the
 * newest messages (drafts left out), oldest first, each body clipped, the
 * oldest dropped until the state fits. Null when there is no message to judge
 * or the newest is the person's own. Pure.
 */
export function understandInput(args: {
  mailbox: string
  threadId: string
  revision: string
  now: string
  known: boolean
  messages: readonly EmailMessageForAI[]
}): EmailUnderstandInput | null {
  const own = mailboxAddresses(args.mailbox)[0] ?? args.mailbox.trim().toLowerCase()
  const sent = args.messages.filter((m) => !m.isDraft)
  const latest = sent.at(-1)
  if (!latest || mailboxAddresses(latest.from)[0] === own) return null
  const shaped = sent.slice(-MESSAGES_SENT).map((m) => {
    const from = mailboxAddresses(m.from)[0] ?? null
    return {
      from: m.from.slice(0, 500),
      to: mailboxAddresses(m.to).slice(0, 100),
      cc: mailboxAddresses(m.cc || '').slice(0, 100),
      ...(m.replyTo ? { replyTo: m.replyTo.slice(0, 1000) } : {}),
      direction: from === null ? ('unknown' as const) : from === own ? ('outbound' as const) : ('inbound' as const),
      date: (m.dateISO ?? m.date).slice(0, 100),
      subject: (m.subject ?? '').slice(0, 1000),
      body: (m.bodyText ?? '').slice(0, BODY_MAX),
    }
  })
  const input: EmailUnderstandInput = {
    mailbox: own,
    threadId: args.threadId.slice(0, 500),
    revision: args.revision.slice(0, 200),
    now: args.now.slice(0, 100),
    ...(args.known ? { knownSender: true } : {}),
    ...(sent.some((m) => m.hasAttachments) ? { attachmentsUnseen: true } : {}),
    messages: shaped,
  }
  // Keep the newest message; drop the oldest until the state fits.
  while (input.messages.length > 1 && JSON.stringify(input).length > STATE_BUDGET) input.messages = input.messages.slice(1)
  return JSON.stringify(input).length > STATE_BUDGET ? { ...input, messages: input.messages.map((m) => ({ ...m, body: m.body.slice(0, 2_000) })) } : input
}

/** The `email.arrived` event for one understood message. Pure. */
export function arrivedEvent(args: {
  workspaceId: string
  userId: string
  accountId: string | null
  threadId: string
  messageId: string | null
  atIso: string | null
  from: string | null
  contactId: string | null
  known: boolean
  value: EmailUnderstandValue
}, nowMs: number): AgentEventInput {
  const at = args.atIso && Number.isFinite(Date.parse(args.atIso)) ? Date.parse(args.atIso) : nowMs
  const v = args.value
  return {
    workspaceId: args.workspaceId,
    userId: args.userId,
    kind: 'email.arrived',
    priority: v.shouldKnow ? 2 : 1,
    occursAt: new Date(at).toISOString(),
    expiresAt: new Date(Math.max(at, nowMs) + ARRIVED_EVENT_TTL_MS).toISOString(),
    refType: 'email_thread',
    refId: args.threadId,
    facts: {
      ...(args.from ? { from: args.from } : {}),
      ...(args.contactId ? { contactId: args.contactId } : {}),
      ...(args.known ? { known: true } : {}),
      ...(v.kind ? { emailKind: v.kind } : {}),
      ...(v.shouldKnow !== null ? { shouldKnow: v.shouldKnow } : {}),
      ...(v.needsInput !== null ? { needsInput: v.needsInput } : {}),
    },
    dedupeKey: agentEventKey.emailArrived(args.accountId ?? 'mailbox', args.threadId, args.messageId),
  }
}

/** How many arrivals were already understood today (UTC) for the person here. Fails closed (the cap). */
async function understoodToday(supabase: SupabaseClient, args: Pick<UnderstandArrivalsArgs, 'userId' | 'workspaceId'>, nowMs: number): Promise<number> {
  const midnight = new Date(nowMs)
  midnight.setUTCHours(0, 0, 0, 0)
  const { count, error } = await supabase
    .from('agent_event')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', args.workspaceId)
    .eq('user_id', args.userId)
    .eq('kind', 'email.arrived')
    .gte('created_at', midnight.toISOString())
  return error ? MAX_UNDERSTOOD_PER_DAY : count ?? 0
}

/** See the header. Never throws. */
export async function understandArrivals(
  supabase: SupabaseClient,
  args: UnderstandArrivalsArgs,
  deps: UnderstandArrivalsDeps = {},
): Promise<UnderstandArrivalsResult> {
  const result: UnderstandArrivalsResult = { understood: 0, recorded: 0 }
  const nowMs = deps.nowMs ?? Date.now()
  try {
    if (!args.threadIds.length || !args.mailboxEmail) return result
    // Fails closed: an unreadable switch is off.
    if ((await (deps.readPaused ?? readAgentPausedState)(supabase, args.workspaceId).catch(() => 'unknown' as const)) !== 'active') {
      return { ...result, skipped: 'paused' }
    }
    const gated = await (deps.blocked ?? draftingBlocked)(supabase, args.userId, args.workspaceId)
    if (gated) return { ...result, skipped: gated }
    const room = MAX_UNDERSTOOD_PER_DAY - (await understoodToday(supabase, args, nowMs))
    if (room <= 0) return { ...result, skipped: 'cap' }
    const threadIds = [...new Set(args.threadIds)].slice(0, Math.min(MAX_UNDERSTOOD_PER_PASS, room))

    const { data, error } = await supabase
      .from('email_thread_index')
      .select('id, provider_thread_id, provider_message_id, from_email, linked_contact_id, trust, folder')
      .eq('user_id', args.userId)
      .eq('workspace_id', args.workspaceId)
      .in('provider_thread_id', threadIds)
    if (error) return result
    const rows = new Map(((data ?? []) as Array<Record<string, unknown>>).map((r) => [String(r.provider_thread_id), r]))
    const known = await knownSenders(supabase, { workspaceId: args.workspaceId, userId: args.userId, addresses: [...rows.values()].map((r) => r.from_email as string | null) })
    const zone = await (deps.timeZone ?? (async (db, person) => (await readMemberTimeZone(db, person)).timeZone))(supabase, args).catch(() => 'UTC')
    const now = draftNowLabel({ nowMs, timeZone: zone })
    const readThread = deps.readThread ?? ((userId, threadId, workspaceId, opts) => readEmailThread(userId, threadId, workspaceId, opts))
    const decide = deps.decide ?? ((input, ctx) => runDecision('email.understand', input, { ...ctx, mode: 'shadow' }))
    const done = deps.mailDone === null ? null : (deps.mailDone ?? mailDonePass)(supabase, {
      workspaceId: args.workspaceId, userId: args.userId, accountId: args.accountId, mailbox: args.mailboxEmail, now,
    })
    const kept = deps.kept === null ? null : (deps.kept ?? mailKeptPass)(supabase, {
      workspaceId: args.workspaceId, userId: args.userId, mailbox: args.mailboxEmail, now, timeZone: zone,
    })

    const events: AgentEventInput[] = []
    for (const threadId of threadIds) {
      const row = rows.get(threadId)
      if (!row) continue
      try {
        const thread = await readThread(args.userId, threadId, args.workspaceId, { accountId: args.accountId, provider: args.provider })
        const latest = thread?.messages.filter((m) => !m.isDraft).at(-1)
        // The index may name a newer message the provider hasn't served yet: the next push brings it.
        if (!thread || !latest?.messageId || (row.provider_message_id && latest.messageId !== row.provider_message_id)) continue
        const from = mailboxAddresses(latest.from)[0] ?? null
        const isKnown = (typeof row.linked_contact_id === 'string' && !!row.linked_contact_id) || (!!from && known.has(from))
        const input = understandInput({ mailbox: args.mailboxEmail, threadId, revision: latest.messageId, now, known: isKnown, messages: thread.messages })
        if (!input) continue
        const decided = await decide(input, { userId: args.userId, workspaceId: args.workspaceId, runId: String(row.id) })
        result.understood += 1
        if (decided.status !== 'accepted') continue
        events.push(arrivedEvent({
          workspaceId: args.workspaceId,
          userId: args.userId,
          accountId: args.accountId,
          threadId,
          messageId: latest.messageId,
          atIso: latest.dateISO ?? null,
          from,
          contactId: typeof row.linked_contact_id === 'string' ? row.linked_contact_id : null,
          known: isKnown,
          value: decided.value,
        }, nowMs))
        const evidence = {
          kind: decided.value.kind,
          trust: typeof row.trust === 'string' && row.trust ? row.trust : null,
          folder: typeof row.folder === 'string' ? row.folder : null,
          threadId,
          messageId: latest.messageId,
          messages: thread.messages,
          runId: String(row.id),
        }
        const closed = done ? await done.consider(evidence) : 'skipped'
        if (kept && closed !== 'closed') await kept.consider(evidence)
      } catch (err) {
        console.warn('[understand-arrivals] thread skipped:', err instanceof Error ? err.message : err)
      }
    }
    if (events.length) result.recorded = await recordAgentEvents(events, supabase, deps.record ?? {})
    if (done?.closed()) result.closed = done.closed()
    if (kept?.changed()) result.kept = kept.changed()
  } catch (err) {
    console.warn('[understand-arrivals] skipped:', err instanceof Error ? err.message : err)
  }
  return result
}
