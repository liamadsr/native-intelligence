/**
 * The narration reads (bots v2 phase 3): one work item or one attention card,
 * the caller's own, with what its line and "Read it" need, then the templated
 * words from ./narration. (The bubble's GET /api/account/bots/narration read
 * through here too, until the bubble was removed.)
 *
 * The row's member must be one of the caller's own memberships, as the
 * activity route checks before it stamps `opened`, so a cross-workspace row
 * (a bot stands for teammates in every workspace) is found through the row
 * and its member, never the workspace on screen.
 *
 * The main agent's get_bot_item (bots-v4.md Phase A1, bot-work-server.ts)
 * reads through here on a SERVICE client, so every read is fenced
 * explicitly, at least as tightly as RLS and in places more:
 *   - the member check above (as RLS);
 *   - the user on every mail read (as RLS);
 *   - a capture's visibility: the workspace's, or the user's own private one
 *     (as RLS);
 *   - STRICTER than RLS: documents, actions and captures only in the row's
 *     own workspace. RLS would let the session client read them in any of
 *     the caller's workspaces; a run's deliverables are in its own, so the
 *     line and the reading lose nothing real. (bot-work-server.ts checks the
 *     row's member is the caller's IN that workspace before reading.)
 *   - never an eval capture (`is_eval`, a synthetic mock meeting): the
 *     deliverable titles already left them out, and now the meeting a run
 *     came from does too, as every product read of captures must
 *     (applyCaptureVisibility's default-exclude, src/lib/ai/tools/_shared.ts).
 *
 * What is read, and only when the line or the reading needs it:
 *   - an email draft: the draft (its subject, recipients and body; a draft the
 *     email tools made lives at the provider, so its full body comes from the
 *     user's mail store), and on its thread the last message from someone
 *     else: "You got an email from Alex Rivera about Q3 planning." Never an
 *     address: a sender with no name is said as the name in their address.
 *   - a document: its title and text.
 *   - titles for the other deliverables (documents, actions, captures), and
 *     the meeting actions and cards came from.
 * Each read is best-effort: a failed or missing one leaves its words out
 * (the line is said without the sender; there is nothing to read), never a
 * failed answer.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { ownAddresses } from '@/lib/listen-briefs/context'
import { nameFromEmail } from '@/lib/listen-briefs/speech'
import { labelKey, loadDraftRows, type DraftRow } from '@/lib/work/output'
import { WORK_ITEM_SELECT } from '@/lib/work/queries'
import type { WorkDeliverable, WorkItem } from '@/lib/work/types'
import {
  cardReading,
  documentReading,
  draftReading,
  narrateItem,
  questionReading,
  questionsOf,
  readableDeliverable,
  textReading,
  type NarratedCard,
  type NarrationEnrichment,
  type NarrationOptions,
  type NarrationReadKind,
  type NarrationReply,
  type Reading,
} from './narration'

/** The caller, as requireWorkspaceMember resolves them. */
export interface NarrationAuth {
  supabase: SupabaseClient
  user: { id: string; email?: string | null }
  member: { id: string }
}

/** Drafts whose threads are looked up for their senders. */
const DRAFT_CAP = 5
/** A draft body is read up to this many characters before it is converted. */
const BODY_MAX = 20_000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function safe<T>(what: string, fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    console.warn(`[bots] narration ${what} failed:`, err instanceof Error ? err.message : err)
    return fallback
  }
}

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message)
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/**
 * Whether the row's member is one of the caller's own memberships: the
 * active workspace's member answers without a read, any other is read on the
 * session client (`member`'s RLS). A failed read is "not theirs".
 */
async function ownsMember(auth: NarrationAuth, memberId: string | null | undefined): Promise<boolean> {
  if (!memberId) return false
  if (memberId === auth.member.id) return true
  const { data, error } = await auth.supabase
    .from('member')
    .select('id')
    .eq('id', memberId)
    .eq('user_id', auth.user.id)
    .maybeSingle()
  if (error) {
    console.warn('[bots] narration owner check failed:', error.message)
    return false
  }
  return !!data
}

function reply(line: string, readKind: NarrationReadKind | undefined, r: Reading | null): NarrationReply {
  if (!readKind || !r) return { line }
  return {
    line,
    readKind,
    ...(r.title ? { readTitle: r.title } : {}),
    readText: r.text,
    readSentences: r.sentences,
  }
}

// ── A work item ──────────────────────────────────────────────────────────────

/** Whose rows a reading may touch: the row's workspace, and the user (the explicit fences, see the header). */
interface ReadScope {
  workspaceId: string
  userId: string
}

/** A captures read, as RLS would allow it: the scope's workspace, workspace-visible or the user's own, never an eval capture. */
function visibleCaptures(supabase: SupabaseClient, scope: ReadScope) {
  return supabase
    .from('captures')
    .select('id, title')
    .eq('workspace_id', scope.workspaceId)
    .neq('is_eval', true)
    .or(`visibility.eq.workspace,user_id.eq.${scope.userId}`)
}

/** document_select as a row check (migration 369): workspace, or the user's own private one. Select DOCUMENT_OWNER. */
const DOCUMENT_OWNER = 'visibility, owner:member!created_by(user_id)'
function documentVisible(row: { visibility?: unknown; owner?: unknown }, scope: ReadScope): boolean {
  if (row.visibility !== 'private') return true
  const owner = (Array.isArray(row.owner) ? row.owner[0] : row.owner) as { user_id?: unknown } | null | undefined
  return owner?.user_id === scope.userId
}

/** Current titles for the deliverables, keyed `type:id` (output.ts loadLabels
 *  reads the same, with an action's identifier, which is not said aloud). */
async function loadTitles(supabase: SupabaseClient, open: readonly WorkDeliverable[], scope: ReadScope): Promise<Record<string, string>> {
  const ids = (type: string) => [...new Set(open.filter((d) => d.type === type).map((d) => d.id))]
  const docIds = ids('document')
  const actionIds = ids('action')
  const captureIds = ids('capture')
  const [docs, actions, captures] = await Promise.all([
    docIds.length ? supabase.from('document').select(`id, title, ${DOCUMENT_OWNER}`).in('id', docIds).eq('workspace_id', scope.workspaceId) : null,
    actionIds.length ? supabase.from('actions').select('id, title').in('id', actionIds).eq('workspace_id', scope.workspaceId) : null,
    // The ids are the caller's own row's, but the read is broad by shape, so it
    // carries the eval fence every capture list does.
    captureIds.length ? visibleCaptures(supabase, scope).in('id', captureIds) : null,
  ])
  const labels: Record<string, string> = {}
  const add = (type: string, res: { data: unknown } | null) => {
    for (const r of ((res?.data ?? []) as Array<{ id: string; title: string | null }>)) {
      const t = text(r.title)
      if (t) labels[labelKey({ type, id: r.id })] = t
    }
  }
  add('document', docs ? { data: ((docs.data ?? []) as Array<{ visibility?: unknown; owner?: unknown }>).filter((d) => documentVisible(d, scope)) } : null)
  add('action', actions)
  add('capture', captures)
  return labels
}

async function captureTitle(supabase: SupabaseClient, captureId: string, scope: ReadScope): Promise<string | null> {
  const { data, error } = await visibleCaptures(supabase, scope).eq('id', captureId).maybeSingle()
  fail(error)
  return text((data as { title?: unknown } | null)?.title)
}

async function loadDocument(
  supabase: SupabaseClient,
  id: string,
  scope: ReadScope,
): Promise<{ title: string | null; content: string | null } | null> {
  const { data, error } = await supabase
    .from('document')
    .select(`id, title, content, ${DOCUMENT_OWNER}`)
    .eq('id', id)
    .eq('workspace_id', scope.workspaceId)
    .maybeSingle()
  fail(error)
  const doc = data as { title: string | null; content: string | null; visibility?: unknown; owner?: unknown } | null
  // Someone else's private document is not there for this user (369).
  if (!doc || !documentVisible(doc, scope)) return null
  return { title: doc.title, content: doc.content }
}

interface ThreadSender {
  name: string
  subject: string | null
}

/**
 * Per thread, who last wrote to the user: the thread index row's sender when
 * it is not one of the user's own addresses, as the name in their address
 * (never the address). No subject: Dial8 stores no mail (2026-10-15), so a
 * line names who, never what.
 */
async function loadSenders(auth: NarrationAuth, threadIds: readonly string[]): Promise<Map<string, ThreadSender>> {
  const out = new Map<string, ThreadSender>()
  if (threadIds.length === 0) return out
  const [own, index] = await Promise.all([
    ownAddresses({ supabase: auth.supabase, userId: auth.user.id, userEmail: auth.user.email ?? null }),
    auth.supabase
      .from('email_thread_index')
      .select('provider_thread_id, from_email')
      .eq('user_id', auth.user.id)
      .in('provider_thread_id', threadIds as string[])
      .limit(threadIds.length * 5),
  ])
  fail(index.error)
  const mine = new Set(own)
  for (const m of (index.data ?? []) as Array<{ provider_thread_id: string; from_email: string | null }>) {
    if (out.has(m.provider_thread_id)) continue
    const address = text(m.from_email)?.toLowerCase() ?? null
    if (address && mine.has(address)) continue
    const name = nameFromEmail(address)
    if (name) out.set(m.provider_thread_id, { name, subject: null })
  }
  return out
}

/** HTML mail → plain text with its paragraphs, for a draft with no text
 *  part (email-speech reads HTML through the DOM, which the route lacks).
 *  Quoted history goes. Tags never span a "<" or ">", which keeps these
 *  linear on any input. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(style|script|head)\b[^<>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<blockquote\b[^<>]*>[\s\S]*?<\/blockquote\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|ul|ol)\s*>/gi, '\n\n')
    .replace(/<[^<>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A draft's full body as plain text: its review row's text (or HTML). A
 *  draft the email tools made is found by its provider id
 *  (`provider_draft_id`, src/lib/email/tool-drafts.ts); one with no row has
 *  no body here (no stored mail): the line still names it. */
async function loadDraftBody(supabase: SupabaseClient, row: DraftRow, userId: string): Promise<{ body: string | null; to: string[] }> {
  const to = stringList(row.to_emails)
  if (text(row.body_text)) return { body: row.body_text, to }
  const { data, error } = await supabase
    .from('email_draft')
    .select('id, body_text, body_html, to_emails')
    .eq(UUID_RE.test(row.id) ? 'id' : 'provider_draft_id', row.id)
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle()
  fail(error)
  const draft = data as { body_text?: unknown; body_html?: unknown; to_emails?: unknown } | null
  const html = text(draft?.body_html)
  const body = text(draft?.body_text) ?? (html ? htmlToPlainText(html) : null)
  const rowTo = stringList(draft?.to_emails)
  return { body, to: to.length ? to : rowTo }
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []
}

/** Addresses → names ("dana.reed@acme.com" → "Dana Reed"); a name stays. */
function names(list: readonly string[]): string[] {
  return list.flatMap((r) => {
    const n = r.includes('@') ? nameFromEmail(r) : r.trim()
    return n ? [n] : []
  })
}

/** The line and the reading for one of the caller's work items, or null when
 *  it isn't theirs to see (indistinguishable from not there). `opts`: who
 *  speaks (the bot itself by default; the main agent's get_bot_item says it in
 *  the third person, as the bot's name). */
export async function narrateWorkItemById(
  auth: NarrationAuth,
  id: string,
  opts: NarrationOptions = {},
): Promise<NarrationReply | null> {
  const { supabase } = auth
  const { data, error } = await supabase.from('tracked_job').select(WORK_ITEM_SELECT).eq('id', id).maybeSingle()
  fail(error)
  const item = (data as WorkItem | null) ?? null
  if (!item || !(await ownsMember(auth, item.member_id))) return null

  const open = (item.deliverables ?? []).filter((d) => !d.resolved_at)
  const readable = readableDeliverable(item)
  const draftRefs = open.filter((d) => d.type === 'email_draft').slice(0, DRAFT_CAP)
  const captureId = text(item.source?.capture_id)
  const wantsSource = item.kind === 'extraction' || open.some((d) => d.type === 'action' || d.type === 'attention_cards')

  const scope: ReadScope = { workspaceId: item.workspace_id, userId: auth.user.id }
  const [labels, drafts, sourceTitle, doc] = await Promise.all([
    safe('titles', {} as Record<string, string>, () => loadTitles(supabase, open, scope)),
    draftRefs.length
      ? safe('drafts', [] as DraftRow[], () =>
          loadDraftRows(supabase, { deliverables: draftRefs, workspace_id: item.workspace_id }, { userId: auth.user.id }),
        )
      : ([] as DraftRow[]),
    wantsSource && captureId ? safe('source', null, () => captureTitle(supabase, captureId, scope)) : null,
    readable?.type === 'document' ? safe('document', null, () => loadDocument(supabase, readable.id, scope)) : null,
  ])

  const threadIds = [...new Set(drafts.map((d) => d.provider_thread_id).filter((t): t is string => !!t))]
  const readDraft = readable?.type === 'email_draft' ? (drafts.find((d) => d.id === readable.id) ?? null) : null
  const [senders, draftBody] = await Promise.all([
    safe('senders', new Map<string, ThreadSender>(), () => loadSenders(auth, threadIds)),
    readDraft ? safe('draft body', null, () => loadDraftBody(supabase, readDraft, auth.user.id)) : null,
  ])

  // One name per thread the drafts reply to, in the drafts' order.
  const said = new Set<string>()
  const senderNames: string[] = []
  for (const d of drafts) {
    const s = d.provider_thread_id ? senders.get(d.provider_thread_id) : undefined
    if (s && !said.has(s.name)) {
      said.add(s.name)
      senderNames.push(s.name)
    }
  }
  const firstDraft = drafts[0]
  const firstSender = firstDraft?.provider_thread_id ? senders.get(firstDraft.provider_thread_id) : undefined
  const enrichment: NarrationEnrichment = {
    labels,
    sourceTitle,
    senders: senderNames,
    subject: firstSender?.subject ?? text(firstDraft?.subject),
    recipients: names(drafts.flatMap((d) => stringList(d.to_emails))),
  }
  const narration = narrateItem({ item, enrichment, ...opts })

  let r: Reading | null = null
  if (narration.readKind === 'email_draft' && readDraft && draftBody) {
    r = draftReading({
      subject: readDraft.subject,
      recipients: names(draftBody.to),
      bodyText: draftBody.body?.slice(0, BODY_MAX) ?? null,
    })
  } else if (narration.readKind === 'document' && doc) {
    r = documentReading(doc)
  } else if (narration.readKind === 'text') {
    r =
      item.status === 'needs_input'
        ? questionReading(item.title, questionsOf(item.needs))
        : textReading(item.title, [item.result_summary])
  }
  return reply(narration.line, narration.readKind, r)
}

// ── A card ───────────────────────────────────────────────────────────────────

const CARD_SELECT = 'id, workspace_id, member_id, kind, title, why, payload, status'

/** The line and the reading for one of the caller's attention cards, or null
 *  when it isn't theirs to see. `opts` as narrateWorkItemById's. */
export async function narrateCardById(auth: NarrationAuth, id: string, opts: NarrationOptions = {}): Promise<NarrationReply | null> {
  const { data, error } = await auth.supabase.from('attention_item').select(CARD_SELECT).eq('id', id).maybeSingle()
  fail(error)
  const row = (data as (NarratedCard & { member_id: string | null }) | null) ?? null
  if (!row || !(await ownsMember(auth, row.member_id))) return null
  const card: NarratedCard = {
    kind: row.kind,
    title: row.title,
    why: row.why ?? null,
    payload: row.payload && typeof row.payload === 'object' ? row.payload : null,
  }
  const narration = narrateItem({ card, ...opts })
  return reply(narration.line, narration.readKind, narration.canRead ? cardReading(card) : null)
}
