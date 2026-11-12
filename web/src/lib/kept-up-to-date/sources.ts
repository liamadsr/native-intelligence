/**
 * The three sources that keep records up to date (./engine.ts), each made
 * into one KeptSourceItem and handed to the same engine:
 *
 *   - Mail (mailKeptPass): the arrival pass (../email/understand-arrivals.ts)
 *     hands over each thread email.understand read, beside the to-do closer
 *     (../email/action-done-from-mail.ts). Conversations count, not only
 *     automated mail: a deal's signals come from people. Never a newsletter,
 *     a thread with a trust mark, or one outside the inbox and the archive,
 *     and never the person's own message. Its people: the latest message's
 *     sender and recipients (the person's own addresses left out) as CRM
 *     contacts, their companies, and the companies at the senders' work
 *     domains. To-dos only from a known contact's mail that is not a
 *     confirmation (confirmations stay with the to-do closer, measured for
 *     them), and nothing when the closer already closed one from this thread.
 *   - Meetings (keptFromCapture): after the capture's batch extraction, on
 *     its `flow/capture.processed` event (../inngest/kept-up-to-date.ts), the
 *     same event the owner's log line and the knowledge pass read. Its people:
 *     the capture's participants other than the owner. Its words: the
 *     transcript's lines that could state a change (a date, an amount, a
 *     deal word), the summary as context. To-dos too, but never one the
 *     meeting's own pending proposals name (the card decides those).
 *   - Texts (keptFromTexts): after a customer's or a guest's text turn
 *     (../inngest/text-turn.ts), the texts that turn carried. Its people:
 *     their CRM contact. The person's own texts are not a source: their own
 *     agent turn reads them and has the table tools.
 *
 * Never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EmailKind } from '@/lib/ai/decisions/tasks/email-understand'
import { isFreeEmailDomain } from '@/lib/auth/work-email'
import { draftNowLabel } from '@/lib/crm/email-drafts'
import { readMemberTimeZone } from '@/lib/agent-events/member-time-zone'
import { DONE_EVIDENCE_KINDS, EVIDENCE_FOLDERS } from '@/lib/email/action-done-from-mail'
import { senderDomainOf } from '@/lib/email/action-done-part'
import type { EmailMessageForAI } from '@/lib/email/email-read-service'
import { mailboxAddresses } from '@/lib/email/reply-policy'
import { getGuest } from '@/lib/guests/store'
import { findContactByEmailOrPhone } from '@/lib/customers/contacts'
import { keptPass, peopleFor, type KeptPassDeps, type KeptPeople, type KeptScope, type KeptSourceItem } from './engine'
import { amountsIn, datesIn, ownText, sentencesOf } from './values'

/** An earlier message's words, as context. */
const CONTEXT_MAX = 2_000
/** The judged message's words. */
const BODY_MAX = 6_000

// ── Mail ───────────────────────────────────────────────────────────────────

/** What one understood thread brings. */
export interface MailKeptArgs {
  kind: EmailKind | null
  trust: string | null
  folder: string | null
  threadId: string
  messageId: string
  messages: readonly EmailMessageForAI[]
}

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase()

/**
 * The source for one thread, or null when it is not one (see the header).
 * The people are read here. Never throws.
 */
export async function mailKeptItem(supabase: SupabaseClient, scope: KeptScope & { mailbox: string }, args: MailKeptArgs, deps: { people?: typeof peopleFor } = {}): Promise<KeptSourceItem | null> {
  try {
    if (!args.kind || args.kind === 'newsletter_or_promo' || args.trust) return null
    if (!args.folder || !EVIDENCE_FOLDERS.has(args.folder)) return null
    const own = new Set(mailboxAddresses(scope.mailbox))
    if (!own.size) own.add(scope.mailbox.trim().toLowerCase())
    const sent = args.messages.filter((m) => !m.isDraft)
    const latest = sent.at(-1)
    const from = latest ? mailboxAddresses(latest.from)[0] : undefined
    if (!latest || !from || own.has(from)) return null
    const text = ownText(latest.bodyText ?? '').slice(0, BODY_MAX)
    if (!sentencesOf(text).length) return null
    const ownDomains = new Set([...own].map(domainOf))
    const addresses = [...new Set([from, ...mailboxAddresses(latest.to), ...mailboxAddresses(latest.cc || '')])].filter((a) => !own.has(a))
    const domains = [domainOf(from)].filter((d) => !ownDomains.has(d) && !isFreeEmailDomain(`x@${d}`))
    const people = await (deps.people ?? peopleFor)(supabase, scope.workspaceId, { emails: addresses, domains })
    const earlier = sent.at(-2)
    const at = latest.dateISO ?? latest.date
    return {
      source: 'email',
      ref: `${args.threadId}:${args.messageId}`,
      label: senderDomainOf(latest.from),
      atIso: Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : null,
      header: { kind: 'email', from: latest.from.slice(0, 500), date: at.slice(0, 100), subject: (latest.subject ?? '').slice(0, 1000) },
      ...(earlier ? { context: `Earlier message from ${earlier.from.slice(0, 200)}: ${ownText(earlier.bodyText ?? '').replace(/\s+/g, ' ').trim()}`.slice(0, CONTEXT_MAX) } : {}),
      text,
      people,
      // Confirmations close to-dos through the closer; a stranger's conversation closes none.
      tasks: !DONE_EVIDENCE_KINDS.has(args.kind) && people.contactIds.length > 0,
    }
  } catch (err) {
    console.warn('[kept-up-to-date] mail not read:', err instanceof Error ? err.message : String(err))
    return null
  }
}

export interface MailKeptPass {
  consider(args: MailKeptArgs & { runId: string }): Promise<'changed' | 'none' | 'skipped'>
  changed(): number
}

/** One arrival pass's keeper over its threads. */
export function mailKeptPass(
  supabase: SupabaseClient,
  scope: KeptScope & { mailbox: string; now: string },
  deps: KeptPassDeps & { people?: typeof peopleFor } = {},
): MailKeptPass {
  const pass = keptPass(supabase, scope, deps)
  return {
    changed: () => pass.changed(),
    async consider(args) {
      const item = await mailKeptItem(supabase, scope, args, deps)
      return item ? pass.consider(item, args.runId) : 'skipped'
    },
  }
}

// ── Meetings ───────────────────────────────────────────────────────────────

/** Lines of a transcript that could state a change. */
const DEAL_WORDS = /\b(sign|signed|signing|signature|contract|countersign|close|closed|closing|won|lost|went with|go ahead|going ahead|moving forward|move forward|push|pushed|postpone|delay|reschedule|budget|price|pricing|quote|approved|approve|decided|decision|cancel|cancelled|canceled|paid|invoice|renew|renewal|deadline|start date|deposit|purchase order|PO|done|finished|sent)\b/i
const TRANSCRIPT_LINES = 40

/** The transcript's lines a change could be in, in order, at most TRANSCRIPT_LINES. Pure. */
export function meetingLines(transcript: string, atIso: string | null): string[] {
  const lines = transcript.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
  if (lines.length <= TRANSCRIPT_LINES) return lines
  return lines.filter((l) => DEAL_WORDS.test(l) || amountsIn([l]).length > 0 || datesIn([l], atIso, 1).length > 0).slice(0, TRANSCRIPT_LINES)
}

export interface CaptureKeptDeps extends KeptPassDeps {
  people?: typeof peopleFor
  now?: (supabase: SupabaseClient, scope: KeptScope) => Promise<string>
}

async function nowLabel(supabase: SupabaseClient, scope: KeptScope, nowMs: number): Promise<string> {
  const zone = await readMemberTimeZone(supabase, scope).then((z) => z.timeZone).catch(() => 'UTC')
  return draftNowLabel({ nowMs, timeZone: zone })
}

/**
 * A finished meeting keeps the owner's records up to date (see the header).
 * 'skipped' when it isn't a source (no capture, a demo or an eval one, no
 * words). Never throws.
 */
export async function keptFromCapture(supabase: SupabaseClient, args: { workspaceId: string; captureId: string }, deps: CaptureKeptDeps = {}): Promise<'changed' | 'none' | 'skipped'> {
  try {
    const { data, error } = await supabase
      .from('captures')
      .select('id, user_id, title, visibility, started_at, created_at, transcript, ai_summary, is_eval, metadata')
      .eq('id', args.captureId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle()
    const capture = data as {
      id: string; user_id: string | null; title: string | null; visibility: string | null; started_at: string | null; created_at: string | null
      transcript: string | null; ai_summary: string | null; is_eval?: boolean | null; metadata: { demo?: unknown } | null
    } | null
    if (error || !capture?.user_id || capture.is_eval === true || capture.metadata?.demo === true) return 'skipped'
    const atIso = capture.started_at ?? capture.created_at
    const text = meetingLines(capture.transcript ?? '', atIso).join('\n')
    if (!text) return 'skipped'
    const scope = { workspaceId: args.workspaceId, userId: capture.user_id }

    const [{ data: participants }, { data: pending }] = await Promise.all([
      supabase.from('capture_participant').select('contact_id, external_email, is_self, member_id').eq('capture_id', capture.id),
      supabase.from('proposed_change').select('entity_id').eq('capture_id', capture.id).eq('status', 'pending').eq('entity_type', 'action'),
    ])
    const others = ((participants ?? []) as Array<{ contact_id: string | null; external_email: string | null; is_self: boolean | null; member_id: string | null }>).filter((p) => !p.is_self && !p.member_id)
    const people: KeptPeople = await (deps.people ?? peopleFor)(supabase, args.workspaceId, {
      contactIds: others.map((p) => p.contact_id).filter((id): id is string => !!id),
      emails: others.map((p) => p.external_email).filter((e): e is string => !!e),
    })
    const item: KeptSourceItem = {
      source: 'capture',
      ref: capture.id,
      label: null,
      atIso,
      header: { kind: 'meeting', ...(capture.title ? { subject: capture.title.slice(0, 1000) } : {}), ...(atIso ? { date: atIso.slice(0, 100) } : {}) },
      ...(capture.ai_summary ? { context: `The meeting's summary: ${capture.ai_summary.replace(/\s+/g, ' ').trim()}`.slice(0, 3_000) } : {}),
      text,
      people,
      tasks: true,
      skipActionIds: ((pending ?? []) as Array<{ entity_id: string | null }>).map((p) => p.entity_id).filter((id): id is string => !!id),
      private: capture.visibility === 'private',
    }
    const now = await (deps.now ?? ((db, s) => nowLabel(db, s, deps.nowMs ?? Date.now())))(supabase, scope)
    return await keptPass(supabase, { ...scope, now }, deps).consider(item, capture.id)
  } catch (err) {
    console.warn('[kept-up-to-date] meeting skipped:', err instanceof Error ? err.message : String(err))
    return 'skipped'
  }
}

// ── Texts ──────────────────────────────────────────────────────────────────

export interface TextKeptDeps extends CaptureKeptDeps {
  guest?: typeof getGuest
  contactByPhone?: (supabase: SupabaseClient, workspaceId: string, phone: string) => Promise<string | null>
}

/**
 * A customer's or a guest's texts keep the owner's records up to date (see
 * the header): `messageIds`, the texts their turn carried, read back from
 * their thread here (their words never ride a step's output). Never throws.
 */
export async function keptFromTexts(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; conversationId: string; guestId: string; messageIds: readonly string[] },
  deps: TextKeptDeps = {},
): Promise<'changed' | 'none' | 'skipped'> {
  try {
    const ids = [...new Set(args.messageIds)].slice(0, 20)
    if (!ids.length) return 'skipped'
    const guest = await (deps.guest ?? getGuest)(supabase, args.userId, args.guestId)
    if (!guest || guest.workspaceId !== args.workspaceId) return 'skipped'
    const { data, error } = await supabase
      .from('chat_messages')
      .select('ui_message, created_at')
      .eq('conversation_id', args.conversationId)
      .eq('user_id', args.userId)
      .in('ui_message->>id', ids)
    if (error) return 'skipped'
    const rows = ((data ?? []) as Array<{ ui_message: { id?: unknown; role?: unknown; parts?: unknown } | null; created_at: string | null }>)
      .filter((r) => r.ui_message?.role === 'user')
      .sort((a, b) => Date.parse(a.created_at ?? '') - Date.parse(b.created_at ?? ''))
    const texts = rows
      .map((r) => (Array.isArray(r.ui_message?.parts) ? (r.ui_message!.parts as Array<{ type?: unknown; text?: unknown }>) : []).filter((p) => p.type === 'text' && typeof p.text === 'string').map((p) => p.text as string).join(' '))
      .filter((t) => t.trim())
    const last = rows.at(-1)
    if (!texts.length || !last) return 'skipped'

    let contactId = guest.contactId
    if (!contactId && guest.phone) {
      contactId = await (deps.contactByPhone ?? (async (db, ws, phone) => (await findContactByEmailOrPhone(db, ws, { email: null, phone }))?.id ?? null))(supabase, args.workspaceId, guest.phone).catch(() => null)
    }
    const people = contactId ? await (deps.people ?? peopleFor)(supabase, args.workspaceId, { contactIds: [contactId] }) : { contactIds: [], companyIds: [], names: new Map<string, string>() }
    if (!people.contactIds.length) return 'skipped'
    const atIso = last.created_at
    const item: KeptSourceItem = {
      source: 'sms',
      ref: String(last.ui_message!.id),
      label: null,
      atIso,
      header: { kind: 'text', from: guest.displayName.slice(0, 500), ...(atIso ? { date: atIso.slice(0, 100) } : {}) },
      text: texts.join('\n'),
      people,
      tasks: true,
    }
    const scope = { workspaceId: args.workspaceId, userId: args.userId }
    const now = await (deps.now ?? ((db, s) => nowLabel(db, s, deps.nowMs ?? Date.now())))(supabase, scope)
    return await keptPass(supabase, { ...scope, now }, deps).consider(item, item.ref.slice(0, 200))
  } catch (err) {
    console.warn('[kept-up-to-date] texts skipped:', err instanceof Error ? err.message : String(err))
    return 'skipped'
  }
}
