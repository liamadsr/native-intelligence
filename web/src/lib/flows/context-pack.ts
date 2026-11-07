/**
 * Context pack (Phase 2, Workstream C) — the cheap "world model" a verdict-class
 * loop needs so its judgment is GROUNDED, not isolated.
 *
 * The 2026-07-02 forensics (LOOP-CLOSURE-PHASE2-PLAN.md, F3): triage runs burned
 * 20–100s wandering tool-space and STILL accepted 13/13 proposals, because they
 * never looked at the board holistically — they had no comparator. The fix is to
 * SHOW the model what it needs (its own open work, active projects, recent
 * meetings, the queue shape, the near calendar) up front, so it can dedupe
 * against reality and answer "is this actually new + mine?" without hoping it
 * remembers to search. Tools remain for targeted drill-down.
 *
 * This is DETERMINISTIC: a handful of compact, capped, workspace-fenced reads —
 * no extra model calls, ~2–3k tokens. Built server-side and injected into the
 * user message in assembleSkillRun. Never throws — a failed sub-query degrades
 * to an omitted section (a partial pack beats no run).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

const MAX_ACTIONS = 50
const MAX_PROJECTS = 20
const MAX_CAPTURES = 15
const MAX_CAL_EVENTS = 15
const MAX_PACKAGES = 12
const PACKAGE_NAME_MAX = 80
const PACKAGE_DESC_MAX = 140
/** Non-terminal workflow-state categories = "still open". */
const OPEN_CATEGORIES = ['backlog', 'unstarted', 'started']

export interface ContextPackInput {
  supabase: SupabaseClient
  workspaceId: string
  /** The run-as user (whose open work + calendar we surface). */
  runAsUserId: string
  /** The triggering capture id, when this is a capture_processed run. */
  captureId?: string | null
  /** Now, injectable for tests. */
  now?: Date
}

/**
 * Build the context-pack markdown block. Returns '' when everything is empty or
 * every sub-query failed (the caller simply doesn't inject a block).
 */
export async function buildContextPack(input: ContextPackInput): Promise<string> {
  const { supabase, workspaceId, runAsUserId } = input
  const now = input.now ?? new Date()

  // Resolve the run-as member (whose name + assigned work we surface). The
  // model needs the name to judge is_mine_explicit ("did Liam say HE'd do it?").
  const { data: member } = await supabase
    .from('member')
    .select('id, display_name')
    .eq('workspace_id', workspaceId)
    .eq('user_id', runAsUserId)
    .maybeSingle()
  const memberId = member?.id ?? null
  const memberName = member?.display_name ?? null

  const [actions, projects, cycleName, captures, queue, calendar, autoAccepted, packages] = await Promise.all([
    fetchOpenActions(supabase, workspaceId, memberId),
    fetchActiveProjects(supabase, workspaceId),
    fetchCurrentCycleName(supabase, workspaceId, now),
    fetchRecentCaptureTitles(supabase, workspaceId, now),
    fetchQueueShape(supabase, workspaceId, input.captureId ?? null, now),
    fetchUpcomingCalendar(supabase, workspaceId, runAsUserId, now),
    fetchRecentAutoAccepted(supabase, workspaceId, now),
    fetchKnowledgePackages(supabase, workspaceId, runAsUserId),
  ])

  const sections: string[] = []

  const whoAmI = memberName
    ? `You are running as **${memberName}**. "Mine" / "the user" means ${memberName}. An accept is only "explicitly mine" when ${memberName} is the named owner or spoke in the first person ("I'll…").`
    : `You are running as the workspace owner. Judge "mine" by explicit first-person ownership.`
  sections.push(`### Who this run is for\n${whoAmI}`)

  if (actions.length) {
    sections.push(
      `### ${memberName ?? 'The user'}'s open work (${actions.length}${actions.length >= MAX_ACTIONS ? '+' : ''}) — dedupe proposals against THIS first\n` +
        actions.map((a) => `- ${a.identifier ?? '—'} [${a.status}] ${a.priority !== 'none' ? `(${a.priority}) ` : ''}${a.title}`).join('\n'),
    )
  }

  if (projects.length) {
    sections.push(
      `### Active projects\n${projects.map((p) => `- ${p.name}`).join('\n')}` +
        (cycleName ? `\n\nCurrent cycle: **${cycleName}**` : ''),
    )
  } else if (cycleName) {
    sections.push(`### Current cycle\n**${cycleName}**`)
  }

  if (packages.length) {
    sections.push(
      `### Knowledge packages — curated context you can attach to work proposals\n` +
        `When you emit a work_proposal, cite the RELEVANT packages in ` +
        `payload.resources as {"type":"package","id":"<id>","label":"<name>"} — ` +
        `the executing agent then loads that curated context before working.\n` +
        `Only cite a package whose content genuinely bears on the task.\n` +
        packages.map((p) => `- ${p.name} (id: ${p.id})${p.description ? ` — ${p.description}` : ''}`).join('\n'),
    )
  }

  if (captures.length) {
    sections.push(
      `### Recent meetings (last 7 days) — for cross-meeting continuity\n` +
        captures.map((c) => `- ${c.title}`).join('\n'),
    )
  }

  sections.push(
    `### Proposal queue shape\n` +
      `- Pending across the workspace: **${queue.totalPending}**` +
      (queue.captureePending != null ? `\n- Pending from THIS capture: **${queue.captureePending}**` : '') +
      (queue.stalePending ? `\n- Pending older than 30 days: **${queue.stalePending}** (default-dismiss these)` : ''),
  )

  if (calendar.length) {
    sections.push(
      `### Next 48h on the calendar\n` +
        calendar.map((e) => `- ${e.when} — ${e.title}`).join('\n'),
    )
  }

  if (autoAccepted.length) {
    // Surfacing these makes `revoke` reachable AND useful: the model can spot an
    // auto-accepted item that was a duplicate / not really the user's and revoke
    // it. proposal_id is what the verdict's revoke needs.
    sections.push(
      `### Recently auto-accepted (last 72h) — revoke any that were a mistake\n` +
        `These were applied automatically. If one duplicates existing work or clearly wasn't the user's, dismiss it with verdict \`revoke\` (proposal_id below).\n` +
        autoAccepted.map((a) => `- ${a.title} — proposal_id: ${a.proposalId}`).join('\n'),
    )
  }

  if (sections.length <= 1) return '' // only the who-am-I header → nothing useful

  return (
    `## Workspace context (auto-compiled — your grounding for this run)\n` +
    `Use this to dedupe against existing work and to judge what is genuinely new and the user's own. ` +
    `Do NOT re-list it back; act on it.\n\n` +
    sections.join('\n\n')
  )
}

// ── Compact, capped, fenced sub-queries (each fail-soft to []) ────────────────

interface OpenAction {
  identifier: string | null
  title: string
  status: string
  priority: string
}

async function fetchOpenActions(
  supabase: SupabaseClient,
  workspaceId: string,
  memberId: string | null,
): Promise<OpenAction[]> {
  try {
    // Resolve the OPEN status ids first (small query), then filter actions by
    // status_id — more predictable than a PostgREST embed filter on the joined
    // resource's category. Fence workflow_state to THIS workspace's teams rather
    // than scanning every tenant's states (adversarial-review LOW finding).
    const { data: teams } = await supabase.from('team').select('id').eq('workspace_id', workspaceId)
    const teamIds = (teams ?? []).map((t: { id: string }) => t.id)
    if (teamIds.length === 0) return []
    const { data: states } = await supabase
      .from('workflow_state')
      .select('id, name, category')
      .in('team_id', teamIds)
      .in('category', OPEN_CATEGORIES)
    const stateRows = (states ?? []) as Array<{ id: string; name: string }>
    const openIds = stateRows.map((s) => s.id)
    const nameById = new Map(stateRows.map((s) => [s.id, s.name]))
    if (openIds.length === 0) return []

    // Confirmed, not-completed, not-dismissed, assigned to the run-as member (or
    // unassigned — still the user's board to reason about).
    let q = supabase
      .from('actions')
      .select('identifier, title, priority, status_id, assignee_id')
      .eq('workspace_id', workspaceId)
      .eq('confirmation', 'confirmed')
      .is('completed_at', null)
      .eq('is_dismissed', false)
      .in('status_id', openIds)
      .order('updated_at', { ascending: false })
      .limit(MAX_ACTIONS)
    if (memberId) q = q.or(`assignee_id.eq.${memberId},assignee_id.is.null`)
    const { data, error } = await q
    if (error || !data) return []
    return (data as Array<Record<string, unknown>>).map((r) => ({
      identifier: (r.identifier as string) ?? null,
      title: String(r.title ?? '').slice(0, 120),
      status: nameById.get(r.status_id as string) ?? 'Open',
      priority: (r.priority as string) ?? 'none',
    }))
  } catch {
    return []
  }
}

async function fetchActiveProjects(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<Array<{ name: string }>> {
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('name, status, is_archived')
      .eq('workspace_id', workspaceId)
      .eq('is_archived', false)
      .order('updated_at', { ascending: false })
      .limit(MAX_PROJECTS)
    if (error || !data) return []
    return (data as Array<{ name: string; status?: string }>)
      .filter((p) => p.status !== 'completed' && p.status !== 'canceled')
      .map((p) => ({ name: String(p.name ?? '').slice(0, 100) }))
  } catch {
    return []
  }
}

interface KnowledgePackage {
  id: string
  name: string
  description: string | null
}

/**
 * The workspace's visible knowledge packages, so the proposer can cite curated
 * context on a work_proposal (`{type:'package', id, label}`) instead of only
 * label-only guesses. Fencing MIRRORS packages.ts `canSee` MINUS shares (the
 * grant path is deliberately not expanded here — a rare miss from grounding is a
 * soft omission, never a leak):
 *   - visibility 'workspace' → always include.
 *   - visibility 'personal'  → include only when created_by === runAsUserId
 *     (created_by is an auth.users id, mig 124 — NOT a member id).
 *   - visibility 'team'      → include only when the run-as user's member is in
 *     the package's team_id (team ids resolved via member → team_member, the way
 *     packages.ts myAccess does). If that lookup fails, fail-soft to EXCLUDING
 *     team packages — never the whole section.
 * Fail-soft to [] like every sibling fetch.
 */
async function fetchKnowledgePackages(
  supabase: SupabaseClient,
  workspaceId: string,
  runAsUserId: string,
): Promise<KnowledgePackage[]> {
  try {
    // Resolve the run-as user's team ids UP FRONT (the way packages.ts myAccess
    // does — member row by user_id + workspace_id, then team_member) so the
    // visibility fence can live in the QUERY itself. Fencing client-side over an
    // updated_at-ordered over-fetch window let other users' recent personal
    // packages crowd every visible one out of the window (adversarial-review
    // finding). Lookup failure fails soft to no team ids → team packages
    // excluded, never the whole section.
    let teamIds: string[] = []
    try {
      const { data: member } = await supabase
        .from('member')
        .select('id')
        .eq('user_id', runAsUserId)
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      const mid = (member as { id?: string } | null)?.id
      if (mid) {
        const { data: tm } = await supabase
          .from('team_member')
          .select('team_id')
          .eq('member_id', mid)
        teamIds = (tm ?? []).map((t: { team_id: string }) => t.team_id)
      }
    } catch {
      teamIds = []
    }

    // Visibility fence in SQL: workspace-visible, OR the run-as user's own
    // personal packages, OR their teams' packages. Values interpolated here are
    // our own DB reads / the caller's uuid, never model or user text.
    const arms = [
      `visibility.eq.workspace`,
      `and(visibility.eq.personal,created_by.eq.${runAsUserId})`,
    ]
    if (teamIds.length > 0) {
      arms.push(`and(visibility.eq.team,team_id.in.(${teamIds.join(',')}))`)
    }
    const { data, error } = await supabase
      .from('knowledge_package')
      .select('id, name, description, visibility, team_id, created_by, updated_at')
      .eq('workspace_id', workspaceId)
      .or(arms.join(','))
      .order('updated_at', { ascending: false })
      .limit(MAX_PACKAGES)
    if (error || !data) return []
    const rows = data as Array<{
      id: string
      name: string
      description: string | null
      visibility: string
      team_id: string | null
      created_by: string | null
    }>

    // Belt: re-apply the same fence client-side (defense in depth over the
    // service-role client — a malformed .or() must degrade to fewer rows shown,
    // never more).
    const teamIdSet = new Set(teamIds)
    const visible: KnowledgePackage[] = []
    for (const p of rows) {
      if (visible.length >= MAX_PACKAGES) break
      let show = false
      if (p.visibility === 'workspace') show = true
      else if (p.visibility === 'personal') show = p.created_by === runAsUserId
      else if (p.visibility === 'team' && p.team_id) show = teamIdSet.has(p.team_id)
      if (!show) continue
      visible.push({
        id: p.id,
        name: String(p.name ?? '').slice(0, PACKAGE_NAME_MAX),
        description: p.description ? String(p.description).slice(0, PACKAGE_DESC_MAX) : null,
      })
    }
    return visible
  } catch {
    return []
  }
}

async function fetchCurrentCycleName(
  supabase: SupabaseClient,
  workspaceId: string,
  now: Date,
): Promise<string | null> {
  try {
    // Cycles are team-scoped; find one whose window contains now for any team in
    // the workspace. One name is enough for orientation.
    const { data: teams } = await supabase.from('team').select('id').eq('workspace_id', workspaceId)
    const teamIds = (teams ?? []).map((t: { id: string }) => t.id)
    if (!teamIds.length) return null
    const iso = now.toISOString()
    const { data } = await supabase
      .from('cycle')
      .select('name, start_date, end_date')
      .in('team_id', teamIds)
      .lte('start_date', iso)
      .gte('end_date', iso)
      .limit(1)
      .maybeSingle()
    return (data as { name?: string } | null)?.name ?? null
  } catch {
    return null
  }
}

async function fetchRecentCaptureTitles(
  supabase: SupabaseClient,
  workspaceId: string,
  now: Date,
): Promise<Array<{ title: string }>> {
  try {
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString()
    const { data, error } = await supabase
      .from('captures')
      .select('title, started_at, created_at, status')
      .eq('workspace_id', workspaceId)
      // Unattended prompt: an "Only me" capture's title never goes in, the
      // run-as person's own included.
      .eq('visibility', 'workspace')
      .neq('status', 'archived')
      .gte('created_at', weekAgo)
      .order('created_at', { ascending: false })
      .limit(MAX_CAPTURES)
    if (error || !data) return []
    return (data as Array<{ title?: string }>)
      .map((c) => ({ title: String(c.title ?? 'Untitled').slice(0, 120) }))
      .filter((c) => c.title.trim())
  } catch {
    return []
  }
}

interface QueueShape {
  totalPending: number
  captureePending: number | null
  stalePending: number
}

async function fetchQueueShape(
  supabase: SupabaseClient,
  workspaceId: string,
  captureId: string | null,
  now: Date,
): Promise<QueueShape> {
  const count = async (build: (q: ReturnType<SupabaseClient['from']>) => unknown): Promise<number> => {
    try {
      const base = supabase.from('proposed_change').select('id', { count: 'exact', head: true })
      const { count: c } = (await build(base as never)) as { count: number | null }
      return c ?? 0
    } catch {
      return 0
    }
  }
  const thirtyAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString()
  const [totalPending, stalePending, captureePending] = await Promise.all([
    count((q) => (q as any).eq('workspace_id', workspaceId).eq('status', 'pending')),
    count((q) => (q as any).eq('workspace_id', workspaceId).eq('status', 'pending').lt('created_at', thirtyAgo)),
    captureId
      ? count((q) => (q as any).eq('workspace_id', workspaceId).eq('status', 'pending').eq('capture_id', captureId))
      : Promise.resolve(null as unknown as number),
  ])
  return {
    totalPending,
    stalePending,
    captureePending: captureId ? captureePending : null,
  }
}

async function fetchRecentAutoAccepted(
  supabase: SupabaseClient,
  workspaceId: string,
  now: Date,
): Promise<Array<{ proposalId: string; title: string }>> {
  try {
    // Applied create:action proposals auto-accepted in the last 72h — the exact
    // window + shape the verdict `revoke` guardrails accept. This is what gives
    // the model a read path to a revocable proposal_id (adversarial-review
    // MEDIUM: revoke was unreachable through the skill's tools).
    const cutoff = new Date(now.getTime() - 72 * 3600 * 1000).toISOString()
    const { data, error } = await supabase
      .from('proposed_change')
      .select('id, display_text, title, applied_at')
      .eq('workspace_id', workspaceId)
      .eq('status', 'applied')
      .eq('auto_accepted', true)
      .eq('change_type', 'create')
      .eq('entity_type', 'action')
      .gte('applied_at', cutoff)
      .order('applied_at', { ascending: false })
      .limit(20)
    if (error || !data) return []
    return (data as Array<{ id: string; display_text?: string; title?: string }>).map((r) => ({
      proposalId: r.id,
      title: String(r.title || r.display_text || 'Untitled').slice(0, 120),
    }))
  } catch {
    return []
  }
}

async function fetchUpcomingCalendar(
  supabase: SupabaseClient,
  workspaceId: string,
  runAsUserId: string,
  now: Date,
): Promise<Array<{ when: string; title: string }>> {
  try {
    const soon = new Date(now.getTime() + 48 * 3600 * 1000).toISOString()
    // FENCE ON BOTH workspace_id AND user_id. local_calendar_event carries both;
    // fencing on user_id alone leaks the run-as user's OTHER workspaces' meeting
    // titles into this run's grounding (adversarial-review HIGH finding).
    const { data, error } = await supabase
      .from('local_calendar_event')
      .select('title, start_at')
      .eq('workspace_id', workspaceId)
      .eq('user_id', runAsUserId)
      .gte('start_at', now.toISOString())
      .lte('start_at', soon)
      .order('start_at', { ascending: true })
      .limit(MAX_CAL_EVENTS)
    if (error || !data) return []
    return (data as Array<{ title?: string; start_at?: string }>).map((e) => ({
      when: e.start_at ? new Date(e.start_at).toISOString().slice(5, 16).replace('T', ' ') : '',
      title: String(e.title ?? 'Untitled').slice(0, 100),
    }))
  } catch {
    return []
  }
}
