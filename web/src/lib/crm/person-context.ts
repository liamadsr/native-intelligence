import type { SupabaseClient } from '@supabase/supabase-js'
import { wrapUntrusted } from '@/lib/email/untrusted'
import { withLiveHeaders, type HeaderRow } from '@/lib/email/thread-headers'
import {
  applyCaptureVisibility,
  applyEmbeddedCaptureVisibility,
  isCaptureVisible,
  type CaptureRequester,
} from '@/lib/ai/tools/_shared'

/**
 * Person context — the single gate behind both the inline "@-mentioned person"
 * card in the chat system prompt and the `get_contact_details` tool.
 *
 * Every caller may hand us a SERVICE-ROLE client (eve spec/tool routes, MCP,
 * device-token auth), so nothing here relies on RLS. The fences are explicit:
 *   - `contact.workspace_id = workspaceId` on every contact read
 *   - merged contacts are followed to their canonical row (≤3 hops)
 *   - `contact_visible_to(contact, requester)` RPC — NULL requester degrades to
 *     workspace-visible contacts only, never FALSE-for-all
 *   - captures go through applyCaptureVisibility / applyEmbeddedCaptureVisibility
 *     AND a TS `isCaptureVisible` re-check. Both layers also fence out EVAL
 *     captures (`is_eval`, migration 252) — a synthetic mock call must never
 *     surface as a real meeting on a CRM card. The TS re-check only bites when
 *     `is_eval` is in the SELECT, so every capture select here carries it.
 *   - email threads come ONLY from the requester's own mailbox, and only when
 *     there is a requester at all
 *
 * Teammates' work lives in `assignee_id` / `assignee_member_id` /
 * `capture_participant.member_id`, never in the contact columns — so every
 * "their stuff" query bridges through `contact.member_id` when present.
 *
 * Each section is Promise.allSettled-wrapped: a failing section becomes `[]`
 * and the PostgREST error is console.warn'd (silent `.or()` syntax failures
 * are how crm.ts's `created_at` ordering bug hid for months).
 */

const MAX_MERGE_HOPS = 3

export interface PersonContextContact {
  id: string
  workspace_id: string
  full_name: string | null
  email: string | null
  secondary_emails: string[] | null
  job_title: string | null
  member_id: string | null
  visibility: string | null
  relationship_type: string | null
  relationship_strength: string | null
  last_interaction_at: string | null
  interaction_count: number | null
  /**
   * Whether web enrichment has run on this person ('enriched', 'failed',
   * 'skipped', 'pending', or null for never). Enrichment only runs when the
   * person asks, so a reader (the meeting prep, the chat) uses this to OFFER it
   * for someone with none, never to start it.
   */
  enrichment_status: string | null
  company: { id: string; name: string | null; domain: string | null } | null
}

export interface PersonOpenAction {
  id: string
  identifier: string | null
  title: string
  status: string | null
  status_category: string | null
  due_at: string | null
  priority: string | null
  confirmation: string | null
  assigned_via: 'contact' | 'member'
}

export interface PersonPendingCommitment {
  proposed_change_id: string
  display_text: string
  title: string | null
  due_date: string | null
  change_type: string
  capture_id: string
  capture_title: string | null
  capture_date: string | null
}

export interface PersonRecentCapture {
  id: string
  title: string | null
  started_at: string | null
  ai_summary: string | null
}

export interface PersonMyOpenAction {
  id: string
  identifier: string | null
  title: string
  status: string | null
  due_at: string | null
  source_capture_title: string | null
}

export interface PersonEmailThread {
  id: string
  subject: string | null
  last_message_at: string | null
  needs_reply: boolean | null
  from_email: string | null
  message_count: number | null
}

export interface PersonDecision {
  id: string
  content: string
  capture_title: string | null
  created_at: string | null
}

export interface PersonContext {
  contact: PersonContextContact
  is_teammate: boolean
  /** Set when the requested id was a merged tombstone — the id the caller asked for. */
  canonical_of?: string
  open_actions: PersonOpenAction[]
  pending_commitments: PersonPendingCommitment[]
  /** Up to 20, newest first. The tool returns 10, the card renders 4. */
  recent_captures: PersonRecentCapture[]
  my_open_actions_from_their_meetings: PersonMyOpenAction[]
  /** Undefined (not empty) when there is no requester — the section is omitted. */
  recent_email_threads?: PersonEmailThread[]
  decisions: PersonDecision[]
}

export interface GatherPersonContextOptions {
  workspaceId: string
  /** Null on unattended runs — skips the "my member" bridge. */
  userId: string | null
  contactId: string
  /** captureRequester(userId, omitPrivateCaptures) — null on unattended runs. */
  requester: CaptureRequester
}

type PgResult<T> = { data: T[] | null; error: { message: string } | null }

/** Unwrap one allSettled slot: rejection or PostgREST error → [] + warn. */
function settled<T>(name: string, r: PromiseSettledResult<unknown> | undefined): T[] {
  if (!r) return []
  if (r.status === 'rejected') {
    console.warn(`[person-context] ${name} threw:`, r.reason)
    return []
  }
  const v = r.value as PgResult<T> | null | undefined
  if (v?.error) {
    console.warn(`[person-context] ${name} failed:`, v.error.message)
    return []
  }
  return v?.data ?? []
}

const CONTACT_SELECT =
  'id, workspace_id, full_name, email, secondary_emails, job_title, member_id, visibility, relationship_type, relationship_strength, last_interaction_at, interaction_count, enrichment_status, merged_into_contact_id, company:company_id(id, name, domain)'

type ContactRow = Omit<PersonContextContact, 'company'> & {
  merged_into_contact_id: string | null
  company: PersonContextContact['company'] | PersonContextContact['company'][] | null
}

/** Fenced contact fetch, following merge tombstones to the canonical row. */
async function fetchCanonicalContact(
  supabase: SupabaseClient,
  workspaceId: string,
  contactId: string,
): Promise<{ contact: ContactRow; canonicalOf?: string } | null> {
  let id = contactId
  for (let hop = 0; hop <= MAX_MERGE_HOPS; hop++) {
    const { data, error } = await supabase
      .from('contact')
      .select(CONTACT_SELECT)
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (error) {
      console.warn('[person-context] contact fetch failed:', error.message)
      return null
    }
    const row = data as unknown as ContactRow | null
    if (!row) return null
    if (!row.merged_into_contact_id) {
      return { contact: row, ...(id !== contactId ? { canonicalOf: contactId } : {}) }
    }
    id = row.merged_into_contact_id
  }
  return null
}

export async function gatherPersonContext(
  supabase: SupabaseClient,
  { workspaceId, userId, contactId, requester }: GatherPersonContextOptions,
): Promise<PersonContext | null> {
  // 1. Contact (workspace-fenced, tombstone-followed)
  const resolved = await fetchCanonicalContact(supabase, workspaceId, contactId)
  if (!resolved) return null
  const { contact: row, canonicalOf } = resolved

  // 2. Contact visibility — explicit-user twin of can_view_contact, because
  //    auth.uid() is NULL under service role. Anything but `true` is not-found.
  const { data: visible, error: visErr } = await supabase.rpc('contact_visible_to', {
    p_contact_id: row.id,
    p_user_id: requester,
  })
  if (visErr) console.warn('[person-context] contact_visible_to failed:', visErr.message)
  if (visible !== true) return null

  const company = Array.isArray(row.company) ? (row.company[0] ?? null) : row.company
  const contact: PersonContextContact = {
    id: row.id,
    workspace_id: row.workspace_id,
    full_name: row.full_name ?? null,
    email: row.email ?? null,
    secondary_emails: row.secondary_emails ?? null,
    job_title: row.job_title ?? null,
    member_id: row.member_id ?? null,
    visibility: row.visibility ?? null,
    relationship_type: row.relationship_type ?? null,
    relationship_strength: row.relationship_strength ?? null,
    last_interaction_at: row.last_interaction_at ?? null,
    interaction_count: row.interaction_count ?? null,
    enrichment_status: row.enrichment_status ?? null,
    company: company ?? null,
  }
  const theirMemberId = contact.member_id
  const emails = [contact.email, ...(contact.secondary_emails ?? [])]
    .filter((e): e is string => typeof e === 'string' && e.length > 0)
    .map((e) => e.toLowerCase())

  // 3 + 6 + 8. First wave: done-state ids, my member row, their captures, my
  //    email threads with them. Captures come from the CAPTURES side so
  //    started_at ordering is native (capture_participant has no created_at).
  const participantClauses = [`contact_id.eq.${contact.id}`]
  if (theirMemberId) participantClauses.push(`member_id.eq.${theirMemberId}`)
  if (contact.email) {
    // Quoted for `@`/`.`; `\` and `"` escaped so a stored junk address cannot end the quote.
    const quoted = contact.email.toLowerCase().replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    participantClauses.push(`external_email.eq."${quoted}"`)
  }

  const wave1 = await Promise.allSettled([
    supabase
      .from('workflow_state')
      .select('id, team:team!team_id(workspace_id)')
      .in('category', ['completed', 'canceled']),
    userId
      ? supabase
          .from('member')
          .select('id')
          .eq('user_id', userId)
          .eq('workspace_id', workspaceId)
          .maybeSingle()
          .then((r) => ({ data: r.data ? [r.data] : [], error: r.error }))
      : Promise.resolve({ data: [] as Array<{ id: string }>, error: null }),
    applyCaptureVisibility(
      supabase
        .from('captures')
        .select(
          'id, workspace_id, user_id, visibility, is_eval, title, ai_summary, started_at, status, cp:capture_participant!inner(contact_id)',
        )
        .eq('workspace_id', workspaceId)
        .not('started_at', 'is', null)
        .neq('status', 'archived')
        .or(participantClauses.join(','), { referencedTable: 'cp' }),
      requester,
    )
      .order('started_at', { ascending: false })
      .limit(20),
    // Email threads: ONLY the requester's own mailbox, ONLY when attended.
    requester !== null && userId && emails.length
      ? supabase
          .from('email_thread_index')
          // Pointers only; the subject comes live from the mailbox below (no stored mail).
          .select('id, account_id, provider, provider_thread_id, provider_message_id, last_message_at, needs_reply, from_email, message_count')
          .eq('workspace_id', workspaceId)
          .eq('user_id', userId)
          .overlaps('participant_emails', emails)
          .order('last_message_at', { ascending: false })
          .limit(3)
      : Promise.resolve({ data: [] as PersonEmailThread[], error: null }),
  ])

  const doneIds = settled<{ id: string; team: { workspace_id: string } | null }>('workflow_state', wave1[0])
    .filter((s) => (s.team as unknown as { workspace_id: string } | null)?.workspace_id === workspaceId)
    .map((s) => s.id)
  const myMemberId = settled<{ id: string }>('member', wave1[1])[0]?.id ?? null

  type CaptureRow = {
    id: string
    workspace_id: string
    user_id: string | null
    visibility: string | null
    is_eval: boolean | null
    title: string | null
    ai_summary: string | null
    started_at: string | null
  }
  const recentCaptures: PersonRecentCapture[] = settled<CaptureRow>('captures', wave1[2])
    // Defense-in-depth: service-role client → re-check both fences in TS.
    .filter((c) => c && c.workspace_id === workspaceId && isCaptureVisible(c, requester))
    .map((c) => ({ id: c.id, title: c.title, started_at: c.started_at, ai_summary: c.ai_summary }))
  const recentCaptureIds = recentCaptures.map((c) => c.id)

  const emailThreads =
    requester !== null && userId
      ? await withLiveHeaders(supabase, {
          userId,
          workspaceId,
          rows: settled<PersonEmailThread & HeaderRow>('email_thread_index', wave1[3]),
        })
      : undefined

  // 4 + 5 + 7 + 9. Second wave — needs doneIds / myMemberId / capture ids.
  const theirActionClauses = [`assignee_contact_id.eq.${contact.id}`]
  if (theirMemberId) theirActionClauses.push(`assignee_id.eq.${theirMemberId}`)
  const theirProposalClauses = [`assignee_contact_id.eq.${contact.id}`]
  if (theirMemberId) theirProposalClauses.push(`assignee_member_id.eq.${theirMemberId}`)
  const openStateFilter = doneIds.length
    ? `status_id.is.null,status_id.not.in.(${doneIds.join(',')})`
    : null

  const ACTION_SELECT =
    'id, identifier, title, due_at, priority, confirmation, assignee_id, assignee_contact_id, status_id, workflow_state:workflow_state!status_id(name, category)'

  let openActionsQ = supabase
    .from('actions')
    .select(ACTION_SELECT)
    .eq('workspace_id', workspaceId)
    .or(theirActionClauses.join(','))
    .neq('confirmation', 'dismissed')
  if (openStateFilter) openActionsQ = openActionsQ.or(openStateFilter)

  let myActionsQ = myMemberId && recentCaptureIds.length
    ? supabase
        .from('actions')
        .select(`${ACTION_SELECT}, source:captures!source_capture_id(title)`)
        .eq('workspace_id', workspaceId)
        .in('source_capture_id', recentCaptureIds)
        .eq('assignee_id', myMemberId)
        .neq('confirmation', 'dismissed')
    : null
  if (myActionsQ && openStateFilter) myActionsQ = myActionsQ.or(openStateFilter)

  const wave2 = await Promise.allSettled([
    openActionsQ
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('updated_at', { ascending: false })
      .limit(8),
    applyEmbeddedCaptureVisibility(
      supabase
        .from('proposed_change')
        .select(
          'id, display_text, title, due_date, change_type, created_at, capture:captures!capture_id!inner(id, workspace_id, user_id, visibility, is_eval, title, started_at)',
        )
        .eq('workspace_id', workspaceId)
        .eq('status', 'pending')
        .eq('entity_type', 'action')
        .in('change_type', ['create', 'update', 'assign'])
        .or(theirProposalClauses.join(',')),
      requester,
      'capture',
    )
      .order('created_at', { ascending: false })
      .limit(5),
    myActionsQ
      ? myActionsQ
          .order('due_at', { ascending: true, nullsFirst: false })
          .order('updated_at', { ascending: false })
          .limit(5)
      : Promise.resolve({ data: [], error: null }),
    recentCaptureIds.length
      ? supabase
          .from('decision')
          .select('id, content, created_at, capture:captures!capture_id(title)')
          .in('capture_id', recentCaptureIds)
          .eq('confirmation', 'confirmed')
          .order('created_at', { ascending: false })
          .limit(3)
      : Promise.resolve({ data: [], error: null }),
  ])

  type ActionRow = {
    id: string
    identifier: string | null
    title: string
    due_at: string | null
    priority: string | null
    confirmation: string | null
    assignee_id: string | null
    assignee_contact_id: string | null
    status_id: string | null
    workflow_state: { name: string; category: string } | { name: string; category: string }[] | null
    source?: { title: string | null } | { title: string | null }[] | null
  }
  const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))
  const isOpen = (a: ActionRow) => {
    const cat = one(a.workflow_state)?.category
    return cat !== 'completed' && cat !== 'canceled'
  }

  const openActions: PersonOpenAction[] = settled<ActionRow>('actions(open)', wave2[0])
    .filter(isOpen)
    .map((a) => ({
      id: a.id,
      identifier: a.identifier,
      title: a.title,
      status: one(a.workflow_state)?.name ?? null,
      status_category: one(a.workflow_state)?.category ?? null,
      due_at: a.due_at,
      priority: a.priority,
      confirmation: a.confirmation,
      assigned_via: a.assignee_contact_id === contact.id ? 'contact' : 'member',
    }))

  type ProposalRow = {
    id: string
    display_text: string
    title: string | null
    due_date: string | null
    change_type: string
    created_at: string
    capture: CaptureRow | CaptureRow[] | null
  }
  const pendingCommitments: PersonPendingCommitment[] = settled<ProposalRow>('proposed_change', wave2[1])
    .map((p) => {
      const cap = one(p.capture)
      if (!cap || cap.workspace_id !== workspaceId || !isCaptureVisible(cap, requester)) return null
      return {
        proposed_change_id: p.id,
        display_text: p.display_text,
        title: p.title,
        due_date: p.due_date,
        change_type: p.change_type,
        capture_id: cap.id,
        capture_title: cap.title,
        capture_date: cap.started_at,
      }
    })
    .filter((p): p is PersonPendingCommitment => p !== null)

  const myOpenActions: PersonMyOpenAction[] = settled<ActionRow>('actions(mine)', wave2[2])
    .filter(isOpen)
    .map((a) => ({
      id: a.id,
      identifier: a.identifier,
      title: a.title,
      status: one(a.workflow_state)?.name ?? null,
      due_at: a.due_at,
      source_capture_title: one(a.source)?.title ?? null,
    }))

  type DecisionRow = {
    id: string
    content: string
    created_at: string | null
    capture: { title: string | null } | { title: string | null }[] | null
  }
  const decisions: PersonDecision[] = settled<DecisionRow>('decision', wave2[3]).map((d) => ({
    id: d.id,
    content: d.content,
    capture_title: one(d.capture)?.title ?? null,
    created_at: d.created_at,
  }))

  return {
    contact,
    is_teammate: Boolean(theirMemberId),
    ...(canonicalOf ? { canonical_of: canonicalOf } : {}),
    open_actions: openActions,
    pending_commitments: pendingCommitments,
    recent_captures: recentCaptures,
    my_open_actions_from_their_meetings: myOpenActions,
    ...(emailThreads !== undefined ? { recent_email_threads: emailThreads } : {}),
    decisions,
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

const TRUNCATION_MARK = '…[truncated]'
const CARD_CAPTURES_SHOWN = 4

function ymd(iso: string | null | undefined): string | null {
  if (!iso) return null
  return iso.slice(0, 10)
}

function clip(s: string | null | undefined, n: number): string {
  if (!s) return ''
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/**
 * Render one person card in the exact shape the §6d "Mentioned people" layer
 * expects. Two sections always render ("none on record" when empty); the rest
 * are omitted when empty. Hard cap `maxChars`: optional sections are dropped
 * from the tail first, then the text itself is cut.
 */
export function renderPersonContextBlock(
  ctx: PersonContext,
  { maxChars = 3000 }: { maxChars?: number } = {},
): string {
  const c = ctx.contact
  const name = c.full_name || c.email || 'Unknown'
  const role = [c.job_title, c.company?.name].filter(Boolean).join(' @ ')
  const headerParts = [
    role ? `${name} — ${role}` : name,
    ctx.is_teammate ? 'teammate' : 'external contact',
    ...(c.email ? [c.email] : []),
    `contact_id: ${c.id}`,
  ]
  const header = `### ${headerParts.join(' · ')}`
  const relParts = [
    c.relationship_strength ? `relationship: ${c.relationship_strength}` : null,
    `${c.interaction_count ?? 0} interactions`,
    c.last_interaction_at ? `last interaction ${ymd(c.last_interaction_at)}` : 'no interactions on record',
  ].filter(Boolean)
  const head = `${header}\n${relParts.join(' · ')}`

  // Always-on sections.
  const openLines = ctx.open_actions.map((a) => {
    const bits = [a.identifier, a.title, a.status || 'no status', a.due_at ? `due ${ymd(a.due_at)}` : 'no due date']
    if (a.confirmation === 'suggested') bits.push('(suggested, unconfirmed)')
    return `- ${bits.filter(Boolean).join(' · ')}`
  })
  const openSection = [
    `Open actions they own — what you are waiting on from them (${ctx.open_actions.length}):`,
    ...(openLines.length ? openLines : ['- none on record']),
  ].join('\n')

  const pendingLines = ctx.pending_commitments.map((p) => {
    const bits = [
      `"${clip(p.display_text, 160)}"`,
      p.capture_title ? `from ${p.capture_title}${p.capture_date ? ` (${ymd(p.capture_date)})` : ''}` : null,
      p.due_date ? `due ${ymd(p.due_date)}` : null,
    ]
    return `- ${bits.filter(Boolean).join(' · ')}`
  })
  const pendingSection = [
    `Suggested commitments not yet accepted (AI-extracted, pending your review) (${ctx.pending_commitments.length}):`,
    ...(pendingLines.length ? pendingLines : ['- none on record']),
  ].join('\n')

  // Optional sections, in priority order (tail is dropped first).
  const optional: string[] = []
  if (ctx.my_open_actions_from_their_meetings.length) {
    optional.push(
      [
        `Your open actions from meetings with them (${ctx.my_open_actions_from_their_meetings.length}):`,
        ...ctx.my_open_actions_from_their_meetings.map((a) =>
          `- ${[a.identifier, a.title, a.status || 'no status', a.due_at ? `due ${ymd(a.due_at)}` : 'no due date'].filter(Boolean).join(' · ')}`,
        ),
      ].join('\n'),
    )
  }
  if (ctx.recent_captures.length) {
    const shown = ctx.recent_captures.slice(0, CARD_CAPTURES_SHOWN)
    optional.push(
      [
        `Recent meetings with them (${shown.length} of ${ctx.recent_captures.length}):`,
        ...shown.map((m) => {
          const summary = clip(m.ai_summary, 160)
          return `- ${[m.title || 'Untitled', ymd(m.started_at), `capture_id: ${m.id}`].filter(Boolean).join(' · ')}${summary ? ` — ${summary}` : ''}`
        }),
      ].join('\n'),
    )
  }
  if (ctx.recent_email_threads && ctx.recent_email_threads.length) {
    optional.push(
      [
        `Recent email threads with them (your mailbox) (${ctx.recent_email_threads.length}):`,
        ...ctx.recent_email_threads.map((t) =>
          // The subject is read live and a sender wrote it: marked as data. No subject, no quote.
          `- ${[clip(t.subject, 120) ? wrapUntrusted(clip(t.subject, 120)) : 'Email', t.from_email ? `from ${t.from_email}` : null, ymd(t.last_message_at), t.needs_reply ? 'needs reply' : null, `thread_id: ${t.id}`].filter(Boolean).join(' · ')}`,
        ),
      ].join('\n'),
    )
  }
  if (ctx.decisions.length) {
    optional.push(
      [
        `Decisions from meetings with them (${ctx.decisions.length}):`,
        ...ctx.decisions.map((d) => `- "${clip(d.content, 120)}"${d.capture_title ? ` — ${d.capture_title}` : ''}`),
      ].join('\n'),
    )
  }

  const assemble = (opt: string[]) => [head, openSection, pendingSection, ...opt].join('\n')

  let out = assemble(optional)
  if (out.length <= maxChars) return out

  // Drop optional sections from the tail until it fits.
  const kept = [...optional]
  while (kept.length && out.length > maxChars) {
    kept.pop()
    out = `${assemble(kept)}\n${TRUNCATION_MARK}`
  }
  if (out.length <= maxChars) return out

  // Still over with only the always-on sections: cut the text itself.
  return `${out.slice(0, Math.max(0, maxChars - TRUNCATION_MARK.length))}${TRUNCATION_MARK}`
}
