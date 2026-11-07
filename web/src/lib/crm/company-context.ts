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
 * Company context — the single gate behind both the inline "@-mentioned
 * company" card in the chat system prompt and the `get_company_overview` tool.
 * Sibling of `person-context.ts`; same fencing discipline.
 *
 * Every caller may hand us a SERVICE-ROLE client (eve spec/tool routes, MCP,
 * device-token auth), so nothing here relies on RLS. The fences are explicit:
 *   - `company.workspace_id = workspaceId` on the company read
 *   - `company_visible_to(company, requester)` RPC — the explicit-user twin of
 *     the 059 company SELECT policy; NULL requester degrades to "has a
 *     workspace-visible contact", never FALSE-for-all
 *   - a visible company does NOT make every contact in it visible: each
 *     contact is re-fenced PER ROW through `contact_visible_to`, and ONLY the
 *     visible contacts' ids / member ids / emails drive every other section
 *   - captures go through applyCaptureVisibility / applyEmbeddedCaptureVisibility
 *     AND a TS `isCaptureVisible` re-check. Both layers also fence out EVAL
 *     captures (`is_eval`, migration 252) — a synthetic mock call must never
 *     surface as a real meeting on a CRM card. The TS re-check only bites when
 *     `is_eval` is in the SELECT, so every capture select here carries it.
 *   - email threads come ONLY from the requester's own mailbox, and only when
 *     there is a requester at all
 *
 * Each section is Promise.allSettled-wrapped: a failing section becomes `[]`
 * and the PostgREST error is console.warn'd.
 */

/** Fetch ceiling for contacts at the company (each is RPC-fenced). */
export const PEOPLE_FETCH_LIMIT = 30
/** How many visible people the context carries / the card renders. */
const PEOPLE_SHOWN = 8

export interface CompanyContextCompany {
  id: string
  workspace_id: string
  name: string
  domain: string | null
  website: string | null
  industry: string | null
  description: string | null
  employee_count_range: string | null
  annual_revenue_range: string | null
  city: string | null
  state: string | null
  country: string | null
  tags: string[] | null
  created_at: string | null
  updated_at: string | null
}

export interface CompanyPerson {
  id: string
  full_name: string | null
  email: string | null
  job_title: string | null
  relationship_strength: string | null
  interaction_count: number | null
  last_interaction_at: string | null
  member_id: string | null
  is_teammate: boolean
}

export interface CompanyOpenAction {
  id: string
  identifier: string | null
  title: string
  status: string | null
  status_category: string | null
  due_at: string | null
  priority: string | null
  confirmation: string | null
  assigned_via: 'contact' | 'member'
  assignee_contact_id: string | null
  assignee_name: string | null
}

export interface CompanyPendingCommitment {
  proposed_change_id: string
  display_text: string
  title: string | null
  due_date: string | null
  change_type: string
  assignee_name: string | null
  capture_id: string
  capture_title: string | null
  capture_date: string | null
}

export interface CompanyRecentCapture {
  id: string
  title: string | null
  started_at: string | null
  ai_summary: string | null
}

export interface CompanyEmailThread {
  id: string
  subject: string | null
  last_message_at: string | null
  needs_reply: boolean | null
  from_email: string | null
  message_count: number | null
}

export interface CompanyDecision {
  id: string
  content: string
  capture_title: string | null
  created_at: string | null
}

export interface CompanyContext {
  company: CompanyContextCompany
  /** Visible contacts at the company, ≤8, most-interacted first. */
  people: CompanyPerson[]
  /** Non-merged contacts on record at the company (capped at the 30 fetched). */
  people_on_record: number
  /** How many of those passed contact_visible_to for this requester. */
  people_visible: number
  /** Most recent last_interaction_at across the visible people. */
  last_interaction_at: string | null
  open_actions: CompanyOpenAction[]
  pending_commitments: CompanyPendingCommitment[]
  /** Up to 20, newest first, deduped by capture id. The card renders 4. */
  recent_captures: CompanyRecentCapture[]
  /** Undefined (not empty) when there is no requester — the section is omitted. */
  recent_email_threads?: CompanyEmailThread[]
  decisions: CompanyDecision[]
}

export interface GatherCompanyContextOptions {
  workspaceId: string
  /** Null on unattended runs — skips the own-mailbox email section. */
  userId: string | null
  companyId: string
  /** captureRequester(userId, omitPrivateCaptures) — null on unattended runs. */
  requester: CaptureRequester
}

type PgResult<T> = { data: T[] | null; error: { message: string } | null }

/** Unwrap one allSettled slot: rejection or PostgREST error → [] + warn. */
function settled<T>(name: string, r: PromiseSettledResult<unknown> | undefined): T[] {
  if (!r) return []
  if (r.status === 'rejected') {
    console.warn(`[company-context] ${name} threw:`, r.reason)
    return []
  }
  const v = r.value as PgResult<T> | null | undefined
  if (v?.error) {
    console.warn(`[company-context] ${name} failed:`, v.error.message)
    return []
  }
  return v?.data ?? []
}

const COMPANY_SELECT =
  'id, workspace_id, name, domain, website, industry, description, employee_count_range, annual_revenue_range, city, state, country, tags, created_at, updated_at'

const PEOPLE_SELECT =
  'id, full_name, email, secondary_emails, job_title, relationship_strength, interaction_count, last_interaction_at, member_id'

type PeopleRow = Omit<CompanyPerson, 'is_teammate'> & { secondary_emails: string[] | null }

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

/** PostgREST `in.(…)` list; emails are quoted so `@`/`.` survive the parser,
 *  with `\` and `"` escaped so a stored junk address cannot end the quote. */
const inList = (vals: string[], quote = false) =>
  `(${vals.map((v) => (quote ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v)).join(',')})`

export async function gatherCompanyContext(
  supabase: SupabaseClient,
  { workspaceId, userId, companyId, requester }: GatherCompanyContextOptions,
): Promise<CompanyContext | null> {
  // 1. Company (workspace-fenced)
  const { data: companyRow, error: companyErr } = await supabase
    .from('company')
    .select(COMPANY_SELECT)
    .eq('id', companyId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (companyErr) {
    console.warn('[company-context] company fetch failed:', companyErr.message)
    return null
  }
  if (!companyRow) return null
  const c = companyRow as unknown as CompanyContextCompany

  // 2. Company visibility — explicit-user twin of the 059 SELECT policy,
  //    because auth.uid() is NULL under service role. Anything but `true` is
  //    not-found (deliberately indistinguishable from a missing row).
  const { data: visible, error: visErr } = await supabase.rpc('company_visible_to', {
    p_company_id: c.id,
    p_user_id: requester,
  })
  if (visErr) console.warn('[company-context] company_visible_to failed:', visErr.message)
  if (visible !== true) return null

  const company: CompanyContextCompany = {
    id: c.id,
    workspace_id: c.workspace_id,
    name: c.name,
    domain: c.domain ?? null,
    website: c.website ?? null,
    industry: c.industry ?? null,
    description: c.description ?? null,
    employee_count_range: c.employee_count_range ?? null,
    annual_revenue_range: c.annual_revenue_range ?? null,
    city: c.city ?? null,
    state: c.state ?? null,
    country: c.country ?? null,
    tags: c.tags ?? null,
    created_at: c.created_at ?? null,
    updated_at: c.updated_at ?? null,
  }

  // 3. First wave: contacts on record (fenced per-row below) + done-state ids.
  const wave1 = await Promise.allSettled([
    supabase
      .from('contact')
      .select(PEOPLE_SELECT)
      .eq('workspace_id', workspaceId)
      .eq('company_id', company.id)
      .is('merged_into_contact_id', null)
      .order('interaction_count', { ascending: false, nullsFirst: false })
      .order('last_interaction_at', { ascending: false, nullsFirst: false })
      .limit(PEOPLE_FETCH_LIMIT),
    // Scoped to this workspace's teams IN the query: unscoped, it read every
    // tenant's done states and lost this workspace's past the 1000-row cap.
    supabase
      .from('workflow_state')
      .select('id, team:team!team_id!inner(workspace_id)')
      .in('category', ['completed', 'canceled'])
      .eq('team.workspace_id', workspaceId),
  ])

  const onRecord = settled<PeopleRow>('contact', wave1[0])
  const doneIds = settled<{ id: string; team: { workspace_id: string } | null }>('workflow_state', wave1[1])
    .filter((s) => (s.team as unknown as { workspace_id: string } | null)?.workspace_id === workspaceId)
    .map((s) => s.id)

  // 4. Per-contact visibility. A visible company only guarantees ≥1 visible
  //    contact — every row is re-fenced; an RPC error counts as NOT visible.
  const visibility = await Promise.all(
    onRecord.map(async (p) => {
      try {
        const { data, error } = await supabase.rpc('contact_visible_to', {
          p_contact_id: p.id,
          p_user_id: requester,
        })
        if (error) {
          console.warn('[company-context] contact_visible_to failed:', error.message)
          return false
        }
        return data === true
      } catch (e) {
        console.warn('[company-context] contact_visible_to threw:', e)
        return false
      }
    }),
  )
  const visiblePeople = onRecord.filter((_, i) => visibility[i])

  const people: CompanyPerson[] = visiblePeople.slice(0, PEOPLE_SHOWN).map((p) => ({
    id: p.id,
    full_name: p.full_name ?? null,
    email: p.email ?? null,
    job_title: p.job_title ?? null,
    relationship_strength: p.relationship_strength ?? null,
    interaction_count: p.interaction_count ?? null,
    last_interaction_at: p.last_interaction_at ?? null,
    member_id: p.member_id ?? null,
    is_teammate: Boolean(p.member_id),
  }))
  const lastInteractionAt =
    visiblePeople
      .map((p) => p.last_interaction_at)
      .filter((d): d is string => typeof d === 'string' && d.length > 0)
      .sort()
      .at(-1) ?? null

  // Everything below is driven ONLY by the visible contacts.
  const contactIds = visiblePeople.map((p) => p.id)
  const memberIds = Array.from(
    new Set(visiblePeople.map((p) => p.member_id).filter((m): m is string => typeof m === 'string' && m.length > 0)),
  )
  const emails = Array.from(
    new Set(
      visiblePeople
        .flatMap((p) => [p.email, ...(p.secondary_emails ?? [])])
        .filter((e): e is string => typeof e === 'string' && e.length > 0)
        .map((e) => e.toLowerCase()),
    ),
  )
  const nameByContactId = new Map(visiblePeople.map((p) => [p.id, p.full_name || p.email || null]))
  const nameByMemberId = new Map(
    visiblePeople.filter((p) => p.member_id).map((p) => [p.member_id as string, p.full_name || p.email || null]),
  )

  const empty = Promise.resolve({ data: [] as never[], error: null })

  if (!contactIds.length) {
    return {
      company,
      people,
      people_on_record: onRecord.length,
      people_visible: 0,
      last_interaction_at: null,
      open_actions: [],
      pending_commitments: [],
      recent_captures: [],
      ...(requester !== null ? { recent_email_threads: [] } : {}),
      decisions: [],
    }
  }

  // 5. Second wave: open actions, pending proposals, captures, my email threads.
  const actionClauses = [`assignee_contact_id.in.${inList(contactIds)}`]
  if (memberIds.length) actionClauses.push(`assignee_id.in.${inList(memberIds)}`)
  const proposalClauses = [`assignee_contact_id.in.${inList(contactIds)}`]
  if (memberIds.length) proposalClauses.push(`assignee_member_id.in.${inList(memberIds)}`)
  const participantClauses = [`contact_id.in.${inList(contactIds)}`]
  if (memberIds.length) participantClauses.push(`member_id.in.${inList(memberIds)}`)
  if (emails.length) participantClauses.push(`external_email.in.${inList(emails, true)}`)
  const openStateFilter = doneIds.length
    ? `status_id.is.null,status_id.not.in.(${doneIds.join(',')})`
    : null

  const ACTION_SELECT =
    'id, identifier, title, due_at, priority, confirmation, assignee_id, assignee_contact_id, status_id, workflow_state:workflow_state!status_id(name, category)'

  let openActionsQ = supabase
    .from('actions')
    .select(ACTION_SELECT)
    .eq('workspace_id', workspaceId)
    .or(actionClauses.join(','))
    .neq('confirmation', 'dismissed')
  if (openStateFilter) openActionsQ = openActionsQ.or(openStateFilter)

  const wave2 = await Promise.allSettled([
    openActionsQ
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('updated_at', { ascending: false })
      .limit(8),
    applyEmbeddedCaptureVisibility(
      supabase
        .from('proposed_change')
        .select(
          'id, display_text, title, due_date, change_type, created_at, assignee_contact_id, assignee_member_id, capture:captures!capture_id!inner(id, workspace_id, user_id, visibility, is_eval, title, started_at)',
        )
        .eq('workspace_id', workspaceId)
        .eq('status', 'pending')
        .eq('entity_type', 'action')
        .in('change_type', ['create', 'update', 'assign'])
        .or(proposalClauses.join(',')),
      requester,
      'capture',
    )
      .order('created_at', { ascending: false })
      .limit(5),
    // Captures from the CAPTURES side (capture_participant has no created_at).
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
          .limit(5)
      : empty,
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
  }
  const isOpen = (a: ActionRow) => {
    const cat = one(a.workflow_state)?.category
    return cat !== 'completed' && cat !== 'canceled'
  }
  const openActions: CompanyOpenAction[] = settled<ActionRow>('actions(open)', wave2[0])
    .filter(isOpen)
    .map((a) => {
      const viaContact = a.assignee_contact_id && nameByContactId.has(a.assignee_contact_id)
      return {
        id: a.id,
        identifier: a.identifier,
        title: a.title,
        status: one(a.workflow_state)?.name ?? null,
        status_category: one(a.workflow_state)?.category ?? null,
        due_at: a.due_at,
        priority: a.priority,
        confirmation: a.confirmation,
        assigned_via: viaContact ? 'contact' : 'member',
        assignee_contact_id: a.assignee_contact_id,
        assignee_name: viaContact
          ? (nameByContactId.get(a.assignee_contact_id as string) ?? null)
          : (a.assignee_id ? (nameByMemberId.get(a.assignee_id) ?? null) : null),
      }
    })

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
  type ProposalRow = {
    id: string
    display_text: string
    title: string | null
    due_date: string | null
    change_type: string
    created_at: string
    assignee_contact_id: string | null
    assignee_member_id: string | null
    capture: CaptureRow | CaptureRow[] | null
  }
  const pendingCommitments: CompanyPendingCommitment[] = settled<ProposalRow>('proposed_change', wave2[1])
    .map((p) => {
      const cap = one(p.capture)
      if (!cap || cap.workspace_id !== workspaceId || !isCaptureVisible(cap, requester)) return null
      return {
        proposed_change_id: p.id,
        display_text: p.display_text,
        title: p.title,
        due_date: p.due_date,
        change_type: p.change_type,
        assignee_name:
          (p.assignee_contact_id ? nameByContactId.get(p.assignee_contact_id) : null) ??
          (p.assignee_member_id ? nameByMemberId.get(p.assignee_member_id) : null) ??
          null,
        capture_id: cap.id,
        capture_title: cap.title,
        capture_date: cap.started_at,
      }
    })
    .filter((p): p is CompanyPendingCommitment => p !== null)

  // Defense-in-depth: service-role client → re-check both fences in TS, and
  // dedupe (several people from one company on one call → one row).
  const seenCaptures = new Set<string>()
  const recentCaptures: CompanyRecentCapture[] = []
  for (const cap of settled<CaptureRow>('captures', wave2[2])) {
    if (!cap || cap.workspace_id !== workspaceId || !isCaptureVisible(cap, requester)) continue
    if (seenCaptures.has(cap.id)) continue
    seenCaptures.add(cap.id)
    recentCaptures.push({ id: cap.id, title: cap.title, started_at: cap.started_at, ai_summary: cap.ai_summary })
  }
  const recentCaptureIds = recentCaptures.map((c) => c.id)

  const emailThreads =
    requester !== null && userId
      ? await withLiveHeaders(supabase, {
          userId,
          workspaceId,
          rows: settled<CompanyEmailThread & HeaderRow>('email_thread_index', wave2[3]),
        })
      : undefined

  // 6. Third wave: decisions from the fenced captures.
  type DecisionRow = {
    id: string
    content: string
    created_at: string | null
    capture: { title: string | null } | { title: string | null }[] | null
  }
  const wave3 = await Promise.allSettled([
    recentCaptureIds.length
      ? supabase
          .from('decision')
          .select('id, content, created_at, capture:captures!capture_id(title)')
          .in('capture_id', recentCaptureIds)
          .eq('confirmation', 'confirmed')
          .order('created_at', { ascending: false })
          .limit(3)
      : empty,
  ])
  const decisions: CompanyDecision[] = settled<DecisionRow>('decision', wave3[0]).map((d) => ({
    id: d.id,
    content: d.content,
    capture_title: one(d.capture)?.title ?? null,
    created_at: d.created_at,
  }))

  return {
    company,
    people,
    people_on_record: onRecord.length,
    people_visible: visiblePeople.length,
    last_interaction_at: lastInteractionAt,
    open_actions: openActions,
    pending_commitments: pendingCommitments,
    recent_captures: recentCaptures,
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
 * Render one company card in the shape the "Mentioned companies" prompt layer
 * expects. Two sections always render ("none on record" when empty); the rest
 * are omitted when empty. Hard cap `maxChars`: optional sections are dropped
 * from the tail first, then the text itself is cut.
 */
export function renderCompanyContextBlock(
  ctx: CompanyContext,
  { maxChars = 3000 }: { maxChars?: number } = {},
): string {
  const c = ctx.company
  const headerParts = [
    c.industry ? `${c.name} — ${c.industry}` : c.name,
    ...(c.domain ? [c.domain] : []),
    `company_id: ${c.id}`,
  ]
  const header = `### ${headerParts.join(' · ')}`
  const statParts = [
    `${ctx.people_on_record} ${ctx.people_on_record === 1 ? 'person' : 'people'} on record`,
    `${ctx.people_visible} visible to you`,
    c.employee_count_range ? `${c.employee_count_range} employees` : null,
    [c.city, c.country].filter(Boolean).join(', ') || null,
    ctx.last_interaction_at ? `last interaction ${ymd(ctx.last_interaction_at)}` : 'no interactions on record',
  ].filter(Boolean)
  const head = `${header}\n${statParts.join(' · ')}`

  // Always-on sections.
  const peopleLines = ctx.people.map((p) => {
    const bits = [
      p.full_name || p.email || 'Unknown',
      p.job_title,
      p.is_teammate ? 'teammate' : null,
      p.email && p.full_name ? p.email : null,
      `${p.interaction_count ?? 0} interactions`,
      p.last_interaction_at ? `last ${ymd(p.last_interaction_at)}` : null,
      `contact_id: ${p.id}`,
    ]
    return `- ${bits.filter(Boolean).join(' · ')}`
  })
  const peopleSection = [
    `People (${ctx.people.length}${ctx.people_visible > ctx.people.length ? ` of ${ctx.people_visible}` : ''}):`,
    ...(peopleLines.length ? peopleLines : ['- none on record']),
  ].join('\n')

  const openLines = ctx.open_actions.map((a) => {
    const bits = [
      a.identifier,
      a.title,
      a.assignee_name ? `owner: ${a.assignee_name}` : null,
      a.status || 'no status',
      a.due_at ? `due ${ymd(a.due_at)}` : 'no due date',
    ]
    if (a.confirmation === 'suggested') bits.push('(suggested, unconfirmed)')
    return `- ${bits.filter(Boolean).join(' · ')}`
  })
  const openSection = [
    `Open actions across this account (${ctx.open_actions.length}):`,
    ...(openLines.length ? openLines : ['- none on record']),
  ].join('\n')

  // Optional sections, in priority order (tail is dropped first).
  const optional: string[] = []
  if (ctx.pending_commitments.length) {
    optional.push(
      [
        `Suggested commitments not yet accepted (AI-extracted, pending your review) (${ctx.pending_commitments.length}):`,
        ...ctx.pending_commitments.map((p) => {
          const bits = [
            `"${clip(p.display_text, 160)}"`,
            p.assignee_name ? `owner: ${p.assignee_name}` : null,
            p.capture_title ? `from ${p.capture_title}${p.capture_date ? ` (${ymd(p.capture_date)})` : ''}` : null,
            p.due_date ? `due ${ymd(p.due_date)}` : null,
          ]
          return `- ${bits.filter(Boolean).join(' · ')}`
        }),
      ].join('\n'),
    )
  }
  if (ctx.recent_captures.length) {
    const shown = ctx.recent_captures.slice(0, CARD_CAPTURES_SHOWN)
    optional.push(
      [
        `Recent meetings with this account (${shown.length} of ${ctx.recent_captures.length}):`,
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
        `Recent email threads with this account (your mailbox) (${ctx.recent_email_threads.length}):`,
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
        `Decisions from meetings with this account (${ctx.decisions.length}):`,
        ...ctx.decisions.map((d) => `- "${clip(d.content, 120)}"${d.capture_title ? ` — ${d.capture_title}` : ''}`),
      ].join('\n'),
    )
  }

  const assemble = (opt: string[]) => [head, peopleSection, openSection, ...opt].join('\n')

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
