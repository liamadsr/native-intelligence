/**
 * System teammates (docs/plans/agent-orchestration-product.md §1.4, Sequence
 * row 4; since migration 318 the area faces of
 * docs/plans/one-agent-and-chat-pages.md, Part 3 "Faces"): one
 * `ai_team_member` per area that has background work, plus the Assistant, per
 * workspace, `is_system`, keyed by `system_key`. They are ATTRIBUTION — the
 * "who ran it" on a ledger row — not personas: role NULL (never routed), not
 * assignable, and nothing executes their agent recipe (each pipeline still
 * runs its own skill or code). One main agent does everything; a face is how
 * its background work in one area reaches you.
 *
 * Seeding is one SQL function, `seed_system_teammates(workspace_id)`
 * (migration 283, latest 318): the migrations' backfills, the new-workspace
 * trigger, and the self-heal below all call it. Since migration 311 a team
 * delete moves them to another team of the workspace (and is refused on its
 * last team), so the self-heal is a backstop: a workspace that lost them
 * before 311, or a failed seed. The next ledger write re-seeds them on the
 * workspace's oldest team; the light read does the same for a missing
 * Assistant (assistant-heal.ts).
 *
 * Which writer is which face (each row also records its area, work-area.ts):
 *   captures      the extraction pass (extraction-ledger.ts), the seeded
 *                 Triage and Commitment reconciler loops ('seed:triage',
 *                 'seed:reconcile'), the triage-reconciler cron and the
 *                 proposal age-out cron. Triage, Extraction and Reconciler
 *                 folded into it (migration 318, decision 2).
 *   mail          the email-management cron's drafting pass, in a workspace
 *                 with no Correspondent (emailPassTeammateId below), and the
 *                 mail import (import-mirror.ts). Email drafts folded into it.
 *   prospecting   prospecting runs nobody else speaks for (workTeammateId)
 *   evals         eval runs nobody else speaks for
 *   crm           the CRM import, and enrichment nobody else speaks for
 *   assistant     the main agent's face: AI work with no area, or an area
 *                 with no face of its own (workTeammateId), and an agent run
 *                 another path started that names no bot (agent-run-mirror.ts)
 * Every other loop names its own bot (`flow.ai_team_member_id`, migration 302,
 * bots-v3.md Phase 3; flowTeammateId below). A loop whose column is empty (its
 * bot was deleted, or the back-fill hasn't reached it) that runs a
 * verdict-class skill (agent_config.output_contract 'verdict': a triage you
 * built yourself) is Captures', so its cards and its digest still come
 * through the Captures bot (flowTeammateKey). Any other such loop comes from
 * a bot like the rest of the work with no teammate (workTeammateId).
 *
 * Work with no teammate (bots-v4.md Phase 5, decision 2; one-agent plan S3):
 * prospecting, eval, onboarding-research and enrichment runs, a person's own
 * coding and work runs, and a loop run nobody fronts each come from a bot, in
 * this order (workTeammateId): the teammate that holds the run's skill, then
 * the workspace's role teammate for that kind of work (ROUTED_WORK_ROLES: the
 * Researcher for prospecting, enrichment and onboarding research, the
 * Developer for coding runs and evals), then the face of the work's area
 * (ROUTED_WORK_AREAS, or the area the writer knows), then the Assistant.
 * ATTRIBUTION ONLY: the writer stamps the chosen teammate on the LEDGER row
 * (the recorder's `aiTeamMemberId`) and never on the agent run, whose
 * `ai_team_member_id` picks a run's persona, limits, follow-through grants
 * and memory (run-work-spec-rebuild.ts, agent-memory-summary.ts). Imports
 * come from their area's face (CRM, Mail), so their failures land in its
 * Notices. Sequence sends are the one exception: they keep no teammate, stay
 * on the Sequences page, and their failures stay plain notices
 * (lib/work/bot-owner.ts KINDS_WITHOUT_BOT). What write time can't name
 * (older rows, a deleted bot's) is the Assistant's where it's read
 * (bot-owner.ts).
 *
 * Every function here is fail-soft: a lookup that fails returns null and the
 * ledger row is written without a teammate — attribution never blocks a run.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { callerCanReachTeammate } from '@/lib/chat/teammate-access'
import type { AreaKey } from '@/lib/packs/registry'
import { ROLE_ROSTER_LIMIT, roleDefaultTeammateId } from './role-routing'
import type { WorkRole } from './roles'
import { AREA_FACE_KEYS, areaFaceKey, singleArea, type AreaFaceKey } from './work-area'

/** The system keys (migration 318's CHECK): the area faces, then the Assistant. */
export const SYSTEM_TEAMMATE_KEYS = [...AREA_FACE_KEYS, 'assistant'] as const
export type SystemTeammateKey = (typeof SYSTEM_TEAMMATE_KEYS)[number]

/** What each one does, in the roster's words (client-safe: no server imports). */
export const SYSTEM_TEAMMATE_BLURBS: Record<SystemTeammateKey, string> = {
  captures: 'Files what was said in each capture and decides what its proposals become',
  mail: 'Drafts replies to the threads that need one, and brings your mail import',
  prospecting: 'Finds the companies and people that fit what you sell',
  evals: 'Runs your evals and tells you how they did',
  crm: 'Imports and enriches your contacts and companies',
  assistant: 'Brings you the AI work that belongs to no area',
}

/** The seeded loops that stand for a system teammate (flow.seed_key → key): both are Captures'. */
const FLOW_SEED_KEYS: Record<string, SystemTeammateKey> = {
  'seed:triage': 'captures',
  'seed:reconcile': 'captures',
}

/** The system teammate a flow's runs are attributed to, or null for a user's own loop. */
export function systemKeyForFlow(flow: { seed_key?: string | null }): SystemTeammateKey | null {
  return (flow.seed_key && FLOW_SEED_KEYS[flow.seed_key]) || null
}

/** The run_skill actions of a flow, as far as the verdict check reads them. */
interface FlowActionForTeammate {
  type: string
  enabled?: boolean
  config?: unknown
}

/** The skills a flow's enabled run_skill actions run, each once. */
export function flowSkillIds(actions: readonly FlowActionForTeammate[] | null | undefined): string[] {
  const ids = new Set<string>()
  for (const action of actions ?? []) {
    if (action?.type !== 'run_skill' || action.enabled === false) continue
    const id = (action.config as { skill_id?: unknown } | null | undefined)?.skill_id
    if (typeof id === 'string' && id) ids.add(id)
  }
  return [...ids]
}

/**
 * Which system teammate a loop's runs are attributed to, or null:
 *   1. a seeded loop's own (systemKeyForFlow: Captures, for Triage and the
 *      Commitment reconciler), else
 *   2. Captures for a loop that runs a verdict-class skill (the Phase 1
 *      stopgap: a triage you built is Captures' until Phase 3's
 *      `flow.ai_team_member_id`), else
 *   3. none (the loop stays its run-as member's).
 * The skill read uses the run_skill executor's visibility rule (the workspace's
 * own skills, or a system one). Fail-soft: a failed read is logged and gives
 * null, never an error, so attribution never blocks a run.
 */
export async function flowTeammateKey(
  supabase: SupabaseClient,
  workspaceId: string,
  flow: { seed_key?: string | null; actions?: readonly FlowActionForTeammate[] | null },
): Promise<SystemTeammateKey | null> {
  const seeded = systemKeyForFlow(flow)
  if (seeded) return seeded
  const skillIds = flowSkillIds(flow.actions)
  if (skillIds.length === 0) return null
  try {
    const { data, error } = await supabase
      .from('recipe')
      .select('agent_config')
      .in('id', skillIds)
      .eq('category', 'skill')
      .or(`workspace_id.eq.${workspaceId},is_system.eq.true`)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as Array<{ agent_config?: { output_contract?: unknown } | null }>
    return rows.some((r) => r.agent_config?.output_contract === 'verdict') ? 'captures' : null
  } catch (err) {
    console.warn(
      `[work] loop teammate lookup failed (${workspaceId}):`,
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

/** A loop's attribution: the teammate its runs come from, and the area they belong to. */
export interface FlowAttribution {
  teammateId: string | null
  area: AreaKey | null
}

/**
 * The teammate a loop's runs are attributed to (the one place a loop run gets
 * its teammate: startFlowWork), in the plan's order:
 *   1. a seeded loop's own system teammate (Captures, for Triage and the
 *      Commitment reconciler); else
 *   2. the loop's bot, `flow.ai_team_member_id`, while it is still in the
 *      workspace and the run-as member can reach it (the person its notices go
 *      to; a private team they left falls through); else
 *   3. Captures, for a loop running a verdict-class skill (flowTeammateKey); else
 *   4. the work with no teammate's order (workTeammateId): the teammate that
 *      holds one of its skills, else the face of its skills' area, else the
 *      Assistant.
 * And its area (work-area.ts): a seeded loop's or a verdict loop's is
 * Captures'; any other loop's is its skills' area when they agree on one.
 * Needs the SERVICE client (the system-teammate self-heal, and private teams).
 * Fail-soft at every step: attribution never blocks a run.
 */
export async function flowAttribution(
  supabase: SupabaseClient,
  workspaceId: string,
  flow: {
    seed_key?: string | null
    ai_team_member_id?: string | null
    actions?: readonly FlowActionForTeammate[] | null
  },
  runAsMemberId: string | null,
): Promise<FlowAttribution> {
  const seeded = systemKeyForFlow(flow)
  if (seeded) return { teammateId: await systemTeammateId(supabase, workspaceId, seeded), area: areaOfKey(seeded) }
  const key = await flowTeammateKey(supabase, workspaceId, { seed_key: null, actions: flow.actions })
  const skillIds = flowSkillIds(flow.actions)
  const area = key ? areaOfKey(key) : await skillsArea(supabase, workspaceId, skillIds)
  const named = flow.ai_team_member_id
  if (named) {
    try {
      const { data, error } = await supabase
        .from('ai_team_member')
        .select('id, team_id, is_system')
        .eq('id', named)
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      if (error) throw new Error(error.message)
      const mate = data as { id: string; team_id: string | null; is_system: boolean | null } | null
      if (mate && runAsMemberId) {
        const reachable = await callerCanReachTeammate(supabase, {
          userId: '',
          workspaceId,
          teammate: { isSystem: mate.is_system === true, teamId: mate.team_id ?? null },
          memberId: runAsMemberId,
        })
        if (reachable) return { teammateId: mate.id, area }
      }
      console.warn(`[work] loop bot ${named} is gone or out of the run-as member's reach (${workspaceId}); falling back`)
    } catch (err) {
      console.warn(
        `[work] loop bot lookup failed (${workspaceId}):`,
        err instanceof Error ? err.message : err,
      )
    }
  }
  if (key) return { teammateId: await systemTeammateId(supabase, workspaceId, key), area }
  // Nobody fronts it: the work with no teammate's order (a person's own loop run).
  const teammateId = await workTeammateId(supabase, {
    workspaceId,
    kind: 'flow_run',
    memberId: runAsMemberId,
    skillIds,
    area,
  })
  return { teammateId, area }
}

/**
 * The area of a loop's runs, read from the loop (a work run its loop
 * started): a seeded loop's is Captures', any other's its skills' area when
 * they agree on one. Null for none, or a failed read (logged).
 */
export async function loopArea(supabase: SupabaseClient, workspaceId: string, flowId: string | null | undefined): Promise<AreaKey | null> {
  if (!flowId) return null
  try {
    const { data, error } = await supabase
      .from('flow')
      .select('seed_key, actions')
      .eq('id', flowId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    const flow = data as { seed_key?: string | null; actions?: FlowActionForTeammate[] | null } | null
    if (!flow) return null
    const seeded = systemKeyForFlow(flow)
    if (seeded) return areaOfKey(seeded)
    return skillsArea(supabase, workspaceId, flowSkillIds(flow.actions))
  } catch (err) {
    console.warn(`[work] loop area read failed (${workspaceId}):`, err instanceof Error ? err.message : err)
    return null
  }
}

/** The teammate a loop's runs are attributed to (flowAttribution's teammate). */
export async function flowTeammateId(
  supabase: SupabaseClient,
  workspaceId: string,
  flow: {
    seed_key?: string | null
    ai_team_member_id?: string | null
    actions?: readonly FlowActionForTeammate[] | null
  },
  runAsMemberId: string | null,
): Promise<string | null> {
  return (await flowAttribution(supabase, workspaceId, flow, runAsMemberId)).teammateId
}

/** The area a system key stands for: an area face's own, none for the Assistant. */
export function areaOfKey(key: SystemTeammateKey): AreaKey | null {
  return areaFaceKey(key)
}

/**
 * The one area some skills agree on (recipe.area, migration 316), read with
 * the run_skill executor's visibility rule; null for none, several, or a
 * failed read (logged).
 */
async function skillsArea(supabase: SupabaseClient, workspaceId: string, skillIds: readonly string[]): Promise<AreaKey | null> {
  if (skillIds.length === 0) return null
  try {
    const { data, error } = await supabase
      .from('recipe')
      .select('area')
      .in('id', [...skillIds])
      .eq('category', 'skill')
      .or(`workspace_id.eq.${workspaceId},is_system.eq.true`)
    if (error) throw new Error(error.message)
    return singleArea(((data ?? []) as Array<{ area?: string | null }>).map((r) => r.area))
  } catch (err) {
    console.warn(`[work] loop area lookup failed (${workspaceId}):`, err instanceof Error ? err.message : err)
    return null
  }
}

async function readTeammateId(
  supabase: SupabaseClient,
  workspaceId: string,
  key: SystemTeammateKey,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('ai_team_member')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('system_key', key)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as { id?: string } | null)?.id ?? null
}

/**
 * The workspace's system teammate for `key`, seeding the set once if it is
 * missing. Needs the SERVICE client (the seed RPC is service-role only; every
 * ledger writer already holds one). Never throws.
 */
export async function systemTeammateId(
  supabase: SupabaseClient,
  workspaceId: string,
  key: SystemTeammateKey,
): Promise<string | null> {
  try {
    const id = await readTeammateId(supabase, workspaceId, key)
    if (id) return id
    const { error } = await supabase.rpc('seed_system_teammates', { p_workspace_id: workspaceId })
    if (error) throw new Error(error.message)
    return await readTeammateId(supabase, workspaceId, key)
  } catch (err) {
    console.warn(
      `[work] system teammate lookup failed (${workspaceId}, ${key}):`,
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

/**
 * Who the email-management cron's drafting pass is attributed to. Email has one
 * face (owner decision): the workspace's Correspondent (the role's default, its
 * oldest holder; role-routing.ts) when one exists, else the Mail area face
 * (Email drafts until migration 318). Only a workspace switched to attempt
 * holds role teammates, so every other workspace has Mail.
 *
 * ATTRIBUTION ONLY. The pass still runs its own code, not the Correspondent's
 * persona, and neither its autonomy nor its ceiling gates the pass (followups
 * issue 27, for later). So the lookup does not filter on autonomy: a
 * Correspondent that is switched off is still the face.
 *
 * A failed Correspondent read is logged and falls back to Mail; with
 * neither, null (the row is written without a teammate). Needs the SERVICE
 * client, as systemTeammateId does. Never throws.
 */
export async function emailPassTeammateId(supabase: SupabaseClient, workspaceId: string): Promise<string | null> {
  try {
    const correspondent = await roleDefaultTeammateId(supabase, workspaceId, 'correspondent')
    if (correspondent) return correspondent
  } catch (err) {
    console.warn(
      `[work] correspondent lookup failed (${workspaceId}), attributing the email pass to Mail:`,
      err instanceof Error ? err.message : err,
    )
  }
  return systemTeammateId(supabase, workspaceId, 'mail')
}

/**
 * The face of an area's background work: its area face (Captures, Mail,
 * Prospecting, Evals, CRM), else the Assistant (an area with no face of its
 * own, or no area). For writers whose work is the area's outright, with no
 * skill holder or role to ask first (the imports). Needs the SERVICE client;
 * never throws (null only when even the Assistant can't be read).
 */
export async function areaTeammateId(
  supabase: SupabaseClient,
  workspaceId: string,
  area: AreaKey | null | undefined,
): Promise<string | null> {
  const face = areaFaceKey(area)
  if (face) {
    const id = await systemTeammateId(supabase, workspaceId, face)
    if (id) return id
  }
  return systemTeammateId(supabase, workspaceId, 'assistant')
}

// ── Work with no teammate (bots-v4.md Phase 5) ───────────────────────────────

/**
 * The kinds of work that run with no teammate of their own and come from a bot,
 * each with the role whose teammate speaks for it when no skill holder does
 * (decision 2): the Researcher for prospecting, enrichment and onboarding
 * research; the Developer for a person's own coding runs and for evals; none
 * for a person's own work run or a loop run nobody fronts (the Assistant).
 * Sequence sends are not here: they keep no teammate. Nor are the CRM and
 * email imports: they come straight from their area's face (import-mirror.ts,
 * areaTeammateId).
 */
export const ROUTED_WORK_ROLES = {
  prospecting: 'researcher',
  crm_enrichment: 'researcher',
  onboarding_research: 'researcher',
  eval: 'developer',
  coding_run: 'developer',
  work_run: null,
  flow_run: null,
} as const satisfies Record<string, WorkRole | null>

export type RoutedWorkKind = keyof typeof ROUTED_WORK_ROLES

/**
 * The area each kind of work belongs to when nobody holds its skill and no
 * role teammate speaks for it: its face takes it before the Assistant does
 * (one-agent plan S3: the Assistant's catch-all work moves to its area).
 * Null: the area comes from the run (a loop's skills, `args.area`), or there
 * is none and the Assistant keeps it.
 */
export const ROUTED_WORK_AREAS = {
  prospecting: 'prospecting',
  crm_enrichment: 'crm',
  onboarding_research: null,
  eval: 'evals',
  coding_run: null,
  work_run: null,
  flow_run: null,
} as const satisfies Record<RoutedWorkKind, AreaFaceKey | null>

/** The teammate facts the reach rule reads. */
interface Candidate {
  id: string
  team_id: string | null
}

/** The first of `mates` (already in order) the owner can reach; null with no owner. */
async function firstReachable(
  supabase: SupabaseClient,
  workspaceId: string,
  memberId: string | null,
  mates: readonly Candidate[],
): Promise<string | null> {
  if (!memberId) return null
  for (const mate of mates) {
    const reachable = await callerCanReachTeammate(supabase, {
      userId: '',
      workspaceId,
      teammate: { isSystem: false, teamId: mate.team_id ?? null },
      memberId,
    })
    if (reachable) return mate.id
  }
  return null
}

/** How many skill holders one lookup reads (a skill is held by a handful of bots in a workspace). */
const SKILL_HOLDERS_LIMIT = 50

/**
 * The teammate that holds one of `skillIds` (`ai_team_member_skill`), oldest
 * first, in this workspace, that the owner can reach. Never a system
 * teammate: each speaks for its own job. One read, fenced to the workspace in
 * the join (a system skill is held across every workspace), so it never
 * collects other workspaces' holders. Throws on a failed read.
 */
async function skillHolderId(
  supabase: SupabaseClient,
  workspaceId: string,
  memberId: string | null,
  skillIds: readonly string[],
): Promise<string | null> {
  if (skillIds.length === 0 || !memberId) return null
  const { data, error } = await supabase
    .from('ai_team_member_skill')
    .select('ai_team_member!inner(id, team_id, created_at, workspace_id, is_system)')
    .in('skill_recipe_id', [...skillIds])
    .eq('ai_team_member.workspace_id', workspaceId)
    .eq('ai_team_member.is_system', false)
    .limit(SKILL_HOLDERS_LIMIT)
  if (error) throw new Error(`skill holder read failed: ${error.message}`)
  type Holder = Candidate & { created_at: string }
  const byId = new Map<string, Holder>()
  // A to-one embed comes back as one row (an array only in the generated types).
  for (const hold of (data ?? []) as unknown as Array<{ ai_team_member: Holder | Holder[] | null }>) {
    for (const mate of [hold.ai_team_member].flat()) if (mate?.id) byId.set(mate.id, mate)
  }
  // Oldest first, id breaking a tie (role-routing.ts's order).
  const mates = [...byId.values()].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id.localeCompare(b.id))
  return firstReachable(supabase, workspaceId, memberId, mates)
}

/**
 * The workspace's teammate for `role` that the owner can reach: its holders
 * oldest first (role-routing.ts's order), whatever their autonomy, as the
 * email pass's face is (emailPassTeammateId): a face for work already
 * running, not a teammate to hand work to. System teammates and work bots
 * hold no role (their CHECKs). Throws on a failed read.
 */
async function roleTeammateId(
  supabase: SupabaseClient,
  workspaceId: string,
  memberId: string | null,
  role: WorkRole,
): Promise<string | null> {
  if (!memberId) return null
  const { data, error } = await supabase
    .from('ai_team_member')
    .select('id, team_id, created_at')
    .eq('workspace_id', workspaceId)
    .eq('role', role)
    .eq('is_system', false)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(ROLE_ROSTER_LIMIT)
  if (error) throw new Error(`role teammate read failed: ${error.message}`)
  return firstReachable(supabase, workspaceId, memberId, (data ?? []) as Candidate[])
}

/**
 * Who a run with no teammate comes from (bots-v4.md Phase 5, decision 2), in
 * order:
 *   1. the teammate that holds the run's skill (`skillIds`: an eval's target
 *      skill, a loop's run_skill skills), as v3's loops pick;
 *   2. the workspace's role teammate for this kind of work
 *      (ROUTED_WORK_ROLES), where it has one;
 *   3. the face of the work's area (`area` when the writer knows it, else
 *      ROUTED_WORK_AREAS): Prospecting, Evals, CRM and the rest (migration
 *      318);
 *   4. the Assistant (system teammate, migration 310), for everything left.
 * Steps 1 and 2 only pick a teammate the run's owner (`memberId`, the person
 * whose ledger row it is) can reach: a bot on a private team they aren't on
 * would bring them work they could never open. The area faces and the
 * Assistant, system teammates, everyone reaches.
 *
 * ATTRIBUTION ONLY: the caller stamps the answer on the ledger row (the
 * recorder's `aiTeamMemberId`), never on `agent_run.ai_team_member_id`.
 * Needs the SERVICE client (private teams, and the Assistant's self-heal
 * seed). Fail-soft at every step: a failed read is logged and falls through to
 * the next; the answer is null only when even the Assistant can't be read, and
 * the row is then written with no teammate, as before.
 */
export async function workTeammateId(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    kind: RoutedWorkKind
    memberId: string | null
    skillIds?: readonly string[]
    /** The run's area, when the writer knows it (a loop's skills); else the kind's. */
    area?: AreaKey | null
  },
): Promise<string | null> {
  const { workspaceId, kind, memberId } = args
  try {
    const holder = await skillHolderId(supabase, workspaceId, memberId, args.skillIds ?? [])
    if (holder) return holder
  } catch (err) {
    console.warn(`[work] ${kind} skill holder lookup failed (${workspaceId}):`, err instanceof Error ? err.message : err)
  }
  const role = ROUTED_WORK_ROLES[kind]
  if (role) {
    try {
      const mate = await roleTeammateId(supabase, workspaceId, memberId, role)
      if (mate) return mate
    } catch (err) {
      console.warn(`[work] ${kind} ${role} lookup failed (${workspaceId}):`, err instanceof Error ? err.message : err)
    }
  }
  return areaTeammateId(supabase, workspaceId, args.area ?? ROUTED_WORK_AREAS[kind])
}
