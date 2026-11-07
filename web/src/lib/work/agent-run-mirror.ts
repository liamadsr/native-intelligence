/**
 * agent_run → the work ledger (ACTIVITY-AND-REVIEW-DESIGN §5, the work-run and
 * coding-run rows of the producer table).
 *
 * `agent_run` stays the execution record (log tail, sandbox / session handle,
 * pending input, PR). This module mirrors its lifecycle into ONE ledger row per
 * run so Activity, the header counts and (PR 2) the detail panel read every run
 * kind from the same table:
 *
 *   ensureWorkForAgentRun  — the row exists from dispatch (queued), idempotent on
 *                            run_key = the agent_run id, so a run that predates
 *                            this module or was inserted by a path that forgot
 *                            gets its row on its first beat instead of never;
 *   beatAgentRunWork       — every log-tail append: a `[tool] …` line becomes a
 *                            step phrase, anything else a keep-alive;
 *   mirrorAgentRunStatus   — each settle site adds one call: park, resume,
 *                            complete (with deliverables), PR open, fail, cancel.
 *
 * Every entry point is best-effort and never throws: the execution row is the
 * source of truth, the ledger only reflects it. A process-local handle cache
 * keeps a beat to one UPDATE; it is dropped on a terminal transition.
 *
 * Who a row names (runTeammateId): the run's own teammate, else its persona's
 * teammate, else, for a person's own run with neither (origin 'user'), the bot
 * the work with no teammate comes from (bots-v4.md Phase 5,
 * system-teammates.ts workTeammateId): the Developer for a coding run, else
 * the Assistant; and for any other run that names no one (a loop's run_agent
 * with no assignee, an attempt, a handoff or a chat's run with neither a
 * teammate nor a persona's), the Assistant (Liam, 2026-10-08: work with no
 * bot is the Assistant's). Those last ones are ATTRIBUTION ONLY: they go on
 * the ledger row and never on the agent run, so the run keeps no persona,
 * limits, grants or memory of it, and the row is marked
 * `source.teammate_routed`, so its chat stays the run's own ("Your run's
 * chat", decision 20); the Assistant itself stays propose-only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { attachWork, findWork, inertWork, startWork, type WorkHandle } from './recorder'
import { phraseFromLogLine } from './step-phrases'
import { teammateForPersona } from './persona-teammate'
import { areaTeammateId, loopArea, workTeammateId } from './system-teammates'
import type { AreaKey } from '@/lib/packs/registry'
import { WORK_KINDS, type WorkDeliverable, type WorkDeliverableType, type WorkProvenance } from './types'

/** The agent_run columns the mirror needs; every entry point reads them off the
 *  row its caller already loaded. */
export interface AgentRunLike {
  id: string
  workspace_id: string
  kind?: 'coding' | 'workspace' | string | null
  status?: string | null
  triggered_by?: string | null
  task_prompt?: string | null
  action_id?: string | null
  /** agent_run.origin (migration 280); mirrored onto the ledger row when set. */
  origin?: 'user' | 'loop' | 'attempt' | 'delegation' | 'chat' | null
  /** The teammate doing the work; mirrored onto the ledger row when set. */
  ai_team_member_id?: string | null
  /**
   * The persona a run is done as when it has no teammate (agent_run, migration
   * 163: a run_agent loop action). Its teammate fronts it (bots-v3 Phase 6,
   * persona-teammate.ts) and is mirrored onto the ledger row instead. Only
   * run_agent sets it, and only once RUN_AGENT_DISPATCH_ENABLED is on.
   */
  agent_recipe_id?: string | null
  /** The capture the work came from (an attempted run has no tracked action):
   *  the ledger row's anchor, rendered as the capture link on the item. */
  source_capture_id?: string | null
  /** Where the work came from, for the run's brief (B PR 4): `source.provenance`. */
  provenance?: WorkProvenance | null
  /** The run that handed this work over (delegate_work, Part 3). Its ledger row
   *  becomes this row's parent; the tree's root and depth follow from it. */
  parent_run_id?: string | null
  chat_conversation_id?: string | null
}

/** The deliverable shape agent_run.deliverables carries (agent-run/types.ts). */
export interface AgentRunDeliverable {
  type: string
  id: string
  label: string
  entity_type?: string
}

export type AgentRunTransition =
  | { status: 'running' }
  | { status: 'needs_input'; questions: unknown[] }
  /** Parked on the teammates it handed work to (a delegation park). */
  | { status: 'waiting_on_child'; childWorkItemId: string | null; role: string; label: string; count: number }
  | {
      status: 'completed'
      summary?: string | null
      deliverables?: AgentRunDeliverable[] | null
      /** What the run was asked to hand back and did not (`expects`), in words. */
      expectsUnmet?: string[] | null
    }
  | { status: 'pr_open'; prUrl: string | null; summary?: string | null }
  | { status: 'failed'; error: string; /** Settle with no push (an unattended run's stop, P10). */ quiet?: boolean }
  | { status: 'canceled'; reason?: string | null }

const TITLE_MAX = 120
const HANDLE_CACHE_MAX = 500

const memberCache = new Map<string, string | null>()
const handleCache = new Map<string, WorkHandle>()

function kindFor(run: AgentRunLike): string {
  return run.kind === 'workspace' ? WORK_KINDS.workRun : WORK_KINDS.codingRun
}

function titleFor(run: AgentRunLike, actionTitle?: string | null): string {
  const prompt = (run.task_prompt ?? '').split('\n').map((l) => l.trim()).find(Boolean)
  const candidate = actionTitle?.trim() || prompt || ''
  if (candidate) return candidate.length > TITLE_MAX ? `${candidate.slice(0, TITLE_MAX - 1)}…` : candidate
  return run.kind === 'workspace' ? 'Work run' : 'Coding run'
}

export async function resolveMemberId(
  supabase: SupabaseClient,
  workspaceId: string,
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null
  const key = `${workspaceId}:${userId}`
  if (memberCache.has(key)) return memberCache.get(key) ?? null
  try {
    const { data } = await supabase
      .from('member')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .maybeSingle()
    const id = (data?.id as string | undefined) ?? null
    if (memberCache.size >= HANDLE_CACHE_MAX) memberCache.clear()
    memberCache.set(key, id)
    return id
  } catch {
    return null
  }
}

function remember(agentRunId: string, handle: WorkHandle) {
  if (handle.inert) return
  if (handleCache.size >= HANDLE_CACHE_MAX) handleCache.clear()
  handleCache.set(agentRunId, handle)
}

/**
 * The run's ledger row — created now if missing. `status` defaults from the
 * run: a queued run records queued ("dispatched, not started"), anything else
 * running. Inert when the triggering user has no member row (nobody's feed to
 * appear in).
 */
export async function ensureWorkForAgentRun(
  supabase: SupabaseClient,
  run: AgentRunLike,
  opts: { actionTitle?: string | null } = {},
): Promise<WorkHandle> {
  const cached = handleCache.get(run.id)
  if (cached) return cached
  const kind = kindFor(run)
  try {
    const existing = await findWork(supabase, { agentRunId: run.id })
    if (existing) {
      const handle = attachWork(supabase, existing)
      remember(run.id, handle)
      return handle
    }
    const memberId = await resolveMemberId(supabase, run.workspace_id, run.triggered_by)
    if (!memberId) return inertWork({ kind, workspaceId: run.workspace_id, memberId: '' })
    // A delegated child hangs under its parent's row: the parent, the tree's
    // root (the parent's root, or the parent when it is the root) and a depth
    // one below it.
    const parent = run.parent_run_id ? await findWork(supabase, { agentRunId: run.parent_run_id }) : null
    const area = await runArea(supabase, run)
    const { teammateId, routed } = await runTeammateId(supabase, run, memberId, area)
    const handle = await startWork(supabase, {
      workspaceId: run.workspace_id,
      memberId,
      kind,
      ...(area ? { area } : {}),
      title: titleFor(run, opts.actionTitle),
      actor: 'agent',
      status: run.status === 'queued' || !run.status ? 'queued' : 'running',
      runKey: run.id,
      agentRunId: run.id,
      source: {
        agent_run_id: run.id,
        ...(run.chat_conversation_id ? { chat_conversation_id: run.chat_conversation_id } : {}),
        ...(run.action_id ? { action_id: run.action_id } : {}),
        ...(run.source_capture_id
          ? { capture_id: run.source_capture_id, entity_type: 'capture', entity_id: run.source_capture_id }
          : {}),
        ...(run.provenance ? { provenance: run.provenance } : {}),
        // A bot routed to a person's own run: theirs, not the bot's (its chat stays the run's own).
        ...(routed && teammateId ? { teammate_routed: true } : {}),
      },
      ...(run.origin ? { origin: run.origin } : {}),
      ...(teammateId ? { aiTeamMemberId: teammateId } : {}),
      ...(parent
        ? { parentId: parent.id, rootId: parent.root_id ?? parent.id, depth: (parent.depth ?? 0) + 1 }
        : {}),
    })
    remember(run.id, handle)
    return handle
  } catch (err) {
    console.error('[work] ensureWorkForAgentRun failed:', err instanceof Error ? err.message : err)
    return inertWork({ kind, workspaceId: run.workspace_id, memberId: '' })
  }
}

/**
 * A work run's area (work-area.ts): its loop's (agent_run.flow_id), as the
 * run's own prompt reads it (packs/background.ts workRunExpertiseSection).
 * Null for a coding run, a run no loop started, or a failed read.
 */
async function runArea(supabase: SupabaseClient, run: AgentRunLike): Promise<AreaKey | null> {
  if (run.kind !== 'workspace') return null
  try {
    const { data, error } = await supabase.from('agent_run').select('flow_id').eq('id', run.id).maybeSingle()
    if (error) return null
    return loopArea(supabase, run.workspace_id, (data as { flow_id?: string | null } | null)?.flow_id ?? null)
  } catch {
    return null
  }
}

/**
 * What the run's own row says of who does it, for a caller that didn't pass it
 * (a log-tail beat, the coding route): its facts, null when there is no such
 * row, or 'failed' when it couldn't be read (then nothing is routed on a
 * guess: runTeammateId).
 */
async function storedRunFacts(
  supabase: SupabaseClient,
  runId: string,
): Promise<{ ai_team_member_id: string | null; agent_recipe_id: string | null; origin: string | null } | null | 'failed'> {
  try {
    const { data, error } = await supabase
      .from('agent_run')
      .select('ai_team_member_id, agent_recipe_id, origin')
      .eq('id', runId)
      .maybeSingle()
    if (error) return 'failed'
    const row = data as { ai_team_member_id?: string | null; agent_recipe_id?: string | null; origin?: string | null } | null
    return row ? { ai_team_member_id: row.ai_team_member_id ?? null, agent_recipe_id: row.agent_recipe_id ?? null, origin: row.origin ?? null } : null
  } catch {
    return 'failed'
  }
}

/**
 * The teammate a run's ledger row names, read once when the row is made:
 *   1. the run's own teammate (`agent_run.ai_team_member_id`: the caller's, or
 *      the stored row's when the caller didn't pass it);
 *   2. the teammate of the persona a run is done as alone (bots-v3 Phase 6),
 *      or nobody when the persona has none;
 *   3. for a person's own run (origin 'user') with neither, the bot the work
 *      with no teammate comes from (workTeammateId: the Developer for a coding
 *      run, else the Assistant), marked `routed` (the row's
 *      `source.teammate_routed`). Never stamped on the agent run.
 *   4. anything else that names no one, the face of the run's area (its
 *      loop's skills, runArea; migration 318), else the Assistant, marked
 *      `routed` too:
 *      a run done as a persona with no teammate (a loop's run_agent with no
 *      assignee), a run another path started (a loop, an attempt, a handoff,
 *      a chat) that names neither a teammate nor a persona, and a work run's
 *      beat whose run row can't be read. Only that face, never a skill
 *      holder or a role teammate: those are picked for a person's own run
 *      alone. When the run row can't be read, a coding run that names no
 *      persona and no origin is a person's own (the start-agent route passes
 *      none): step 3, the Developer, as before.
 * Fail-soft: with no Assistant to read, the row names no one, as before.
 */
async function runTeammateId(
  supabase: SupabaseClient,
  run: AgentRunLike,
  memberId: string,
  area: AreaKey | null = null,
): Promise<{ teammateId: string | null; routed: boolean }> {
  const named = (teammateId: string | null) => ({ teammateId, routed: false })
  // Nobody fronts it: its area's face does, else the Assistant, for attribution only (step 4).
  const assistant = async () => {
    const teammateId = await areaTeammateId(supabase, run.workspace_id, area)
    return { teammateId, routed: !!teammateId }
  }
  if (run.ai_team_member_id) return named(run.ai_team_member_id)
  const stored = await storedRunFacts(supabase, run.id)
  if (stored === 'failed') {
    // The run's own row couldn't be read. A run done as a persona: its teammate, else the Assistant.
    if (run.origin !== 'user' && run.agent_recipe_id) {
      const persona = await personaTeammate(supabase, run, run.agent_recipe_id)
      return persona ? named(persona) : assistant()
    }
    // A work run with no word on its origin may be a loop's, an attempt's or a chat's: no role on a
    // guess, the Assistant. A coding run with no persona is a person's own (the start-agent route
    // passes no origin): routed below, to the Developer as before.
    if (run.origin === undefined || run.origin === null) {
      if (run.kind === 'workspace') return assistant()
    }
  } else if (stored?.ai_team_member_id) return named(stored.ai_team_member_id)
  const facts = stored === 'failed' ? null : stored
  // A run done as a persona is its teammate's, else the Assistant's (a loop's run_agent with no assignee).
  const recipeId = run.agent_recipe_id ?? facts?.agent_recipe_id ?? null
  if (recipeId) {
    const persona = await personaTeammate(supabase, run, recipeId)
    return persona ? named(persona) : assistant()
  }
  // A person's own run: the caller's word, else the stored row's. With neither (no row yet), the column default.
  const origin = run.origin ?? facts?.origin ?? 'user'
  if (origin !== 'user') return assistant()
  const teammateId = await workTeammateId(supabase, {
    workspaceId: run.workspace_id,
    kind: run.kind === 'workspace' ? 'work_run' : 'coding_run',
    memberId,
    area,
  })
  return { teammateId, routed: !!teammateId }
}

function personaTeammate(supabase: SupabaseClient, run: AgentRunLike, agentRecipeId: string): Promise<string | null> {
  return teammateForPersona(supabase, { workspaceId: run.workspace_id, agentRecipeId, userId: run.triggered_by })
}

/** A log-tail beat: a `[tool] …` line is a step, anything else a keep-alive. */
export async function beatAgentRunWork(
  supabase: SupabaseClient,
  run: AgentRunLike,
  text: string,
): Promise<void> {
  try {
    const work = await ensureWorkForAgentRun(supabase, run)
    const phrase = phraseFromLogLine(text)
    if (phrase) await work.step(phrase)
    else await work.beat()
  } catch (err) {
    console.error('[work] beatAgentRunWork failed:', err instanceof Error ? err.message : err)
  }
}

const ENTITY_DELIVERABLE_TYPES: ReadonlySet<string> = new Set<WorkDeliverableType>([
  'email_draft',
  'document',
  'action',
  'capture',
  'contact',
  'company',
  'prospect_list',
])

/** agent_run.deliverables → the ledger's typed refs. A generic 'entity' maps
 *  through its entity_type when that is a kind the UI can open; the rest drop. */
export function deliverablesFromAgentRun(list: AgentRunDeliverable[] | null | undefined): WorkDeliverable[] {
  const out: WorkDeliverable[] = []
  for (const d of list ?? []) {
    if (!d || typeof d.id !== 'string' || !d.id) continue
    const label = typeof d.label === 'string' && d.label.trim() ? d.label.trim() : 'Deliverable'
    const type = d.type === 'entity' ? d.entity_type : d.type
    if (type && ENTITY_DELIVERABLE_TYPES.has(type)) {
      out.push({ type: type as WorkDeliverableType, id: d.id, label })
    }
  }
  return out
}

/**
 * Whether the run is a meeting prep (a helper the server starts on its own,
 * `agent_run.server_helper`, migration 337; agent-events/meeting-prep.ts).
 * One read, at a run's completion only. Fails to false: a failed read (or a
 * database without the column) leaves the ordinary review.
 */
export async function isMeetingPrepRun(supabase: SupabaseClient, ref: { agentRunId: string; workspaceId: string }): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('agent_run')
      .select('server_helper')
      .eq('id', ref.agentRunId)
      .eq('workspace_id', ref.workspaceId)
      .maybeSingle()
    if (error || !data) return false
    return (data as { server_helper?: unknown }).server_helper === 'meeting_prep'
  } catch {
    return false
  }
}

/**
 * Mirror one agent_run transition onto its ledger row. A run with no row (one
 * that predates the ledger, or whose owner has no member row) is skipped — the
 * execution row already carries the truth.
 */
export async function mirrorAgentRunStatus(
  supabase: SupabaseClient,
  ref: { agentRunId: string; workspaceId: string },
  transition: AgentRunTransition,
): Promise<void> {
  try {
    let work = handleCache.get(ref.agentRunId)
    if (!work) {
      const row = await findWork(supabase, { agentRunId: ref.agentRunId })
      if (!row) return
      work = attachWork(supabase, row)
      remember(ref.agentRunId, work)
    }
    switch (transition.status) {
      case 'running':
        await work.resume()
        break
      case 'needs_input':
        await work.needInput(transition.questions)
        break
      case 'waiting_on_child':
        await work.waitOnChild({
          workItemId: transition.childWorkItemId,
          role: transition.role,
          label: transition.label,
          count: transition.count,
        })
        break
      case 'completed': {
        const deliverables = deliverablesFromAgentRun(transition.deliverables)
        // A work run's result is what the user asked for — it always waits on
        // their review (the summary is the deliverable when nothing else is). A
        // coding run that finished without a PR just ends.
        // Except a meeting prep (docs/plans/chat-ui-polish.md Phase 5): nobody
        // asked for it, and it is delivered where it belongs, the report in the
        // chat with its document and goal box. It waits on nobody, so it never
        // sits in For you, a bot's count or the digest's pile; its `done` still
        // reports to the chat (reportDone).
        const prep = await isMeetingPrepRun(supabase, ref)
        const review = !prep && (deliverables.length > 0 || work.kind === WORK_KINDS.workRun)
        await work.finish({
          summary: transition.summary ?? null,
          deliverables,
          review: review ? { kind: 'review', verb: 'review' } : null,
          ...(prep ? { reportDone: true } : {}),
          ...(transition.expectsUnmet && transition.expectsUnmet.length > 0
            ? { progress: { expects_unmet: transition.expectsUnmet } }
            : {}),
        })
        handleCache.delete(ref.agentRunId)
        break
      }
      case 'pr_open': {
        const deliverables: WorkDeliverable[] = transition.prUrl
          ? [{ type: 'pr', id: transition.prUrl, label: 'Pull request' }]
          : []
        await work.finish({
          summary: transition.summary ?? null,
          deliverables,
          review: deliverables.length > 0 ? { kind: 'review', verb: 'approve' } : null,
        })
        handleCache.delete(ref.agentRunId)
        break
      }
      case 'failed':
        if (transition.quiet) await work.mute()
        await work.fail(transition.error)
        handleCache.delete(ref.agentRunId)
        break
      case 'canceled':
        await work.cancel(transition.reason ?? 'Canceled by user')
        handleCache.delete(ref.agentRunId)
        break
    }
  } catch (err) {
    console.error('[work] mirrorAgentRunStatus failed:', err instanceof Error ? err.message : err)
  }
}

/** Test seam: forget cached handles / members between cases. */
export function resetAgentRunMirrorCaches(): void {
  memberCache.clear()
  handleCache.clear()
}
