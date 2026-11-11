import { tool } from 'ai'
import { PROPOSAL_PERSON_ONLY_NOTE, proposalNeedsPerson } from '@/lib/safety/person-only-proposals'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveSince,
  resolveUntil,
  timeWindowParams,
  resolveEntityWorkspace,
  resolveCreateWorkspace,
  workspaceEcho,
  getUserWorkspaces,
  displayName,
  FUZZY_MATCH_LIMIT,
  listMatches,
  soleMatch,
  applyEmbeddedCaptureVisibility,
  captureRequester,
} from './_shared'
import type { CreateWorkspacePolicy } from './_shared'
import { claimAndApplyChange } from '@/lib/proposed-changes/claim-apply'
import type { ProposedChange } from '@/lib/proposed-changes/types'
import { emitStatusChange } from '@/lib/flows/emit-status-change'
import type { StatusChangeOrigin } from '@/lib/flows/types'
import { resolveMemberIdByName } from '@/lib/people/name-match'
import { loadQuoteSpeakers } from '@/lib/transcript/quote-speakers'
import { orderByUrgency } from '@/lib/actions/urgency'
import { customFieldDefsOrNone, withCustomFields } from '@/lib/crm/custom-fields'
import { OPEN_STATE_CATEGORIES } from '@/lib/actions/open-work'
import { memberIdForUser, resolveDelegate } from '@/lib/actions/delegate'
import { moveActionToReview } from '@/lib/actions/agent-finish'
import { dueAtFromDate } from '@/lib/actions/due-at'

const PRIORITY_VALUES = ['none', 'low', 'medium', 'high', 'urgent'] as const

// `list_actions` confirmation choices. Omitted means confirmed + suggested: a
// dismissed proposal is nobody's work.
const LIST_CONFIRMATIONS = ['confirmed', 'suggested', 'any'] as const

// Time columns available for `time_field` filtering on actions.
// Note: there is no `completed_at` column — completion is modeled via workflow_state
// transitions and shows up as a bump on `updated_at`.
const ACTION_TIME_FIELDS = ['due_at', 'created_at', 'updated_at'] as const

// A model-supplied member id spliced into a PostgREST `.or(...)` string must be
// exactly a UUID — anything else could add filter clauses.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Workspace roles that may delete an action (RLS `actions_delete`, migration 028). */
const ACTION_DELETE_ROLES = new Set(['owner', 'admin'])

/**
 * Resolves a free-text name to a workspace member ID using the shared tiered
 * fuzzy matcher (exact → first-name → nickname/sound-alike → substring →
 * trigram) — same resolution the live agent's staging tools use.
 */
async function resolveMemberByName(
  supabase: SupabaseClient,
  workspaceId: string,
  name: string,
): Promise<string | null> {
  return resolveMemberIdByName(supabase, workspaceId, name)
}

// `workspace_id` is selected on every read so each row can say which workspace
// it came from. An id-based tool resolves cross-workspace (see
// resolveEntityWorkspace), so "the active workspace" is NOT a safe inference for
// an agent holding a row — the row has to carry its own tenant.
const ACTION_SELECT = `
  id, workspace_id, identifier, title, description, status_id, team_id, confirmation, priority, due_at, all_day, assignee_id, assignee_ai_member_id, parent_id, estimate, project_id, milestone_id, cycle_id, created_at,
  workflow_state:workflow_state!status_id(id, name, category, color),
  delegate_agent:ai_team_member!assignee_ai_member_id(id, name),
  project:projects!project_id(id, name),
  milestone:milestone!milestone_id(id, name),
  cycle:cycle!cycle_id(id, name, number),
  labels:action_label(label:label(id, name, color))
`

/** The delegate agent on a read row, `{ id, name }` or null (the embed, else the bare id). */
function delegateOf(a: Record<string, unknown>): { id: string; name: string | null } | null {
  const embed = a.delegate_agent as { id?: string; name?: string | null } | Array<{ id?: string; name?: string | null }> | null | undefined
  const row = Array.isArray(embed) ? embed[0] : embed
  const id = (row?.id as string | undefined) ?? (typeof a.assignee_ai_member_id === 'string' ? a.assignee_ai_member_id : undefined)
  return id ? { id, name: row?.name ?? null } : null
}

function flattenAction(a: Record<string, unknown>) {
  const ws = a.workflow_state as { id: string; name: string; category: string; color: string } | null
  const projectData = a.project as { id: string; name: string } | null
  const milestoneData = a.milestone as { id: string; name: string } | null
  const cycleData = a.cycle as { id: string; name: string; number: number } | null
  const labelsData = a.labels as Array<{ label: { id: string; name: string; color: string } | null }> | null
  return {
    id: a.id,
    workspace_id: a.workspace_id,
    identifier: a.identifier,
    title: a.title,
    description: a.description,
    status: ws?.name || '',
    status_category: ws?.category || '',
    priority: a.priority,
    due_at: a.due_at,
    all_day: a.all_day,
    assignee_id: a.assignee_id,
    // The agent working it as the delegate (decision 9), beside the person.
    assignee_ai_member_id: a.assignee_ai_member_id ?? null,
    delegate: delegateOf(a),
    parent_id: a.parent_id,
    estimate: a.estimate,
    project_id: a.project_id,
    project_name: projectData?.name || null,
    milestone_id: a.milestone_id,
    milestone_name: milestoneData?.name || null,
    cycle_id: a.cycle_id ?? null,
    cycle_name: cycleData?.name || null,
    cycle_number: cycleData?.number || null,
    labels: (labelsData || []).map((row) => row.label).filter(Boolean),
  }
}

/** Resolve the default team for the workspace */
async function getDefaultTeamId(supabase: SupabaseClient, workspaceId: string) {
  const { data } = await supabase
    .from('team')
    .select('id')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true })
    .limit(1)
    .single()
  return data?.id as string | undefined
}

/**
 * Error returned when no team resolves for the workspace a create is aimed at.
 * Every workspace gets a default "General" team via a DB trigger on insert, so
 * an empty result almost always means the create is pointed at the WRONG
 * workspace (or one this principal can't see under RLS) — not that the user
 * needs to create a team. Naming the workspace makes that diagnosable instead of
 * sending the user on a wild goose chase to "set up a team".
 *
 * The remedy it names is the CREATE's own `workspace_id`, never a session
 * switch: under create-time routing the workspace is an argument, and telling an
 * agent to call set_workspace would silently re-scope every later call in the
 * turn to fix one of them. Keeps `success: false` so callers/tests that only
 * check the flag are unaffected.
 */
function noTeamError(workspaceId: string): string {
  return (
    `No team resolved for workspace ${workspaceId} — that is the workspace this ` +
    `create looked in. Every workspace is created with a default team ` +
    `automatically, so an empty result almost always means the create was aimed ` +
    `at the wrong one. Retry with workspace_id pointing at the intended ` +
    `workspace, copied from the workspace_id on the rows you read or from ` +
    `active_workspace. Do not ask the user to create a team.`
  )
}

/**
 * The `workspace_id` param every ROOT create carries (one with no parent entity
 * to route by: create_action, create_actions_batch, create_label).
 *
 * Shared instance rather than three copies of the same `.describe()`: the
 * wording is the protocol's only interface to the agent, and it has one job —
 * tell it where the id comes from (a row it already read, or the envelope's
 * `active_workspace`), so routing costs no extra tool call. See the
 * CREATE-TIME WORKSPACE ROUTING block in ./_shared.ts.
 */
const createWorkspaceParam = z
  .string()
  .optional()
  .describe(
    'Workspace to create in. Defaults to the active workspace. Copy it from the workspace_id on rows you read, or from active_workspace.',
  )

/**
 * Verify the foreign keys a create carries all live in `targetWs`.
 *
 * Called ONLY when a create is routed OUT of the session workspace. The ids in
 * a routed create were, by construction, copied from somewhere else in the
 * turn — attaching a session-workspace project (or label, or parent action) to
 * a row written into another tenant is precisely the cross-tenant foreign key
 * this protocol exists to prevent, and nothing in Postgres stops it: every one
 * of these FKs is workspace-blind.
 *
 * In-workspace creates deliberately skip the whole probe, so the session path
 * is byte-identical to before (and no faster path pays for a check it has
 * always gone without). Closing the equivalent hole for an unrouted create is a
 * separate change — this protocol must not OPEN a path, which is what routing
 * without these checks would do.
 *
 * `milestone` and `cycle` carry no workspace_id of their own (they inherit it
 * from their project / team), so those two are checked through the embed that
 * names it. Errors name the FIELD, never the workspace — same posture as
 * `resolveCreateWorkspace`'s flat 'Workspace not found'.
 */
async function refsOutsideWorkspace(
  supabase: SupabaseClient,
  targetWs: string,
  refs: {
    project_id?: string
    milestone_id?: string
    cycle_id?: string
    parent_id?: string
    label_ids?: string[]
  },
): Promise<string | null> {
  if (refs.project_id) {
    const { data } = await supabase
      .from('projects')
      .select('id')
      .eq('id', refs.project_id)
      .eq('workspace_id', targetWs)
      .maybeSingle()
    if (!data) return 'project_id does not belong to the workspace this action is being created in'
  }

  if (refs.parent_id) {
    const { data } = await supabase
      .from('actions')
      .select('id')
      .eq('id', refs.parent_id)
      .eq('workspace_id', targetWs)
      .maybeSingle()
    if (!data) return 'parent_id does not belong to the workspace this action is being created in'
  }

  if (refs.milestone_id) {
    const { data } = await supabase
      .from('milestone')
      .select('id, project:projects!project_id(workspace_id)')
      .eq('id', refs.milestone_id)
      .maybeSingle()
    const project = (data as { project?: { workspace_id?: string } | null } | null)?.project
    if (project?.workspace_id !== targetWs) {
      return 'milestone_id does not belong to the workspace this action is being created in'
    }
  }

  if (refs.cycle_id) {
    const { data } = await supabase
      .from('cycle')
      .select('id, team:team!team_id(workspace_id)')
      .eq('id', refs.cycle_id)
      .maybeSingle()
    const team = (data as { team?: { workspace_id?: string } | null } | null)?.team
    if (team?.workspace_id !== targetWs) {
      return 'cycle_id does not belong to the workspace this action is being created in'
    }
  }

  if (refs.label_ids?.length) {
    const { data } = await supabase
      .from('label')
      .select('id')
      .in('id', refs.label_ids)
      .eq('workspace_id', targetWs)
    if ((data || []).length !== new Set(refs.label_ids).size) {
      return 'label_ids do not all belong to the workspace this action is being created in'
    }
  }

  return null
}

/** Get the default workflow state for a team */
async function getDefaultStateId(supabase: SupabaseClient, teamId: string) {
  const { data } = await supabase
    .from('workflow_state')
    .select('id')
    .eq('team_id', teamId)
    .eq('is_default', true)
    .single()
  return data?.id as string | undefined
}

/** Get the completed workflow state for a team */
async function getCompletedStateId(supabase: SupabaseClient, teamId: string) {
  const { data } = await supabase
    .from('workflow_state')
    .select('id')
    .eq('team_id', teamId)
    .eq('category', 'completed')
    .order('sort_order', { ascending: true })
    .limit(1)
    .single()
  return data?.id as string | undefined
}

/**
 * Resolve a status reference (either `status_id` or `status_name`) to a workflow_state.id
 * scoped to a given team. Returns either { ok: true, id } on success or { ok: false, error }
 * with a friendly message listing available state names.
 *
 * Matching for `status_name`: case-insensitive exact match → unique case-insensitive substring.
 * Ambiguous substring matches are rejected (caller must disambiguate).
 */
async function resolveStatusForTeam(
  supabase: SupabaseClient,
  teamId: string,
  ref: { status_id?: string; status_name?: string },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const { data: states } = await supabase
    .from('workflow_state')
    .select('id, name, category, sort_order')
    .eq('team_id', teamId)
    .order('sort_order', { ascending: true })

  const list = states || []
  const availableNames = list.map((s) => s.name).join(', ')

  if (ref.status_id) {
    const match = list.find((s) => s.id === ref.status_id)
    if (!match) {
      return {
        ok: false,
        error: `status_id "${ref.status_id}" does not belong to this action's team. Available states: ${availableNames}`,
      }
    }
    return { ok: true, id: match.id }
  }

  if (ref.status_name) {
    const needle = ref.status_name.toLowerCase().trim()
    const exact = list.find((s) => s.name.toLowerCase() === needle)
    if (exact) return { ok: true, id: exact.id }

    const substringMatches = list.filter((s) => s.name.toLowerCase().includes(needle))
    if (substringMatches.length === 1) return { ok: true, id: substringMatches[0].id }
    if (substringMatches.length > 1) {
      return {
        ok: false,
        error: `status_name "${ref.status_name}" is ambiguous — matches: ${substringMatches.map((s) => s.name).join(', ')}. Use the exact name or pass status_id.`,
      }
    }
    return {
      ok: false,
      error: `status_name "${ref.status_name}" not found. Available states: ${availableNames}`,
    }
  }

  return { ok: false, error: 'Must supply status_id or status_name' }
}

/**
 * Rules an unattended surface sets on the action tools (CreateToolsOptions).
 * Each is derived server-side from the run's verified token, never from model
 * input; absent everywhere a person is at the keyboard.
 */
export interface ActionToolRules {
  /**
   * The run has nobody watching (a work run's own turns, an unattended skill
   * run). Nothing it does promotes a suggestion: confirm_action and
   * confirm_decision are refused, and accept_proposal / confirm_all_decisions
   * refuse the suggestions it filed itself (`filedByRun`). "Leave it for the
   * person to confirm."
   */
  unattended?: boolean
  /**
   * Which of these entity ids (actions, decisions, proposals) the run filed
   * itself: its ledger's created / proposed touches (touch.ts
   * entitiesFiledByWork), bound by the route to the run's own work item.
   * FAILS CLOSED: absent, a run with no ledger row, or a lookup that fails
   * answers every id (filedByThisRun), so the confirm is left for the person.
   */
  filedByRun?: (ids: readonly string[]) => Promise<ReadonlySet<string>>
  /**
   * The promotion guard (docs/plans/always-on-agent.md §4b, A4 slice 8): an
   * unattended run files every action as SUGGESTED, whatever `confirmation`
   * the model passed, so a step it promotes waits for a person to confirm it.
   * create_action and create_actions_batch.
   */
  fileActionsAsSuggested?: boolean
  /**
   * The actions this run works (agent_run.action_id): an agent finishing one
   * moves it to REVIEW, never Done (decision 9, src/lib/actions/agent-finish.ts).
   * complete_action, and update_action into a completed state or with
   * toggle_complete, go through moveActionToReview for these ids.
   */
  reviewActionIds?: readonly string[]
}

/** Why an unattended run may not promote a suggestion. */
export const LEAVE_FOR_PERSON =
  'Leave it for the person to confirm: work running with nobody watching never confirms a suggestion it made.'

/**
 * The ids an unattended run filed itself, among `ids` (ActionToolRules). Empty
 * when the run is attended or nothing is known. Lower-cased.
 */
export async function filedByThisRun(rules: ActionToolRules, ids: readonly string[]): Promise<ReadonlySet<string>> {
  if (!rules.unattended || ids.length === 0) return new Set()
  // Fail closed: an unattended run that can't say what it filed is treated as
  // having filed everything (the person confirms it).
  const every = new Set(ids.map((id) => id.toLowerCase()))
  if (!rules.filedByRun) return every
  try {
    return await rules.filedByRun(ids)
  } catch {
    return every
  }
}

/** The `delegate` parameter's wording, shared by the three tools that take it. */
const DELEGATE_PARAM_HELP =
  'An agent (AI teammate) to work this action as its delegate: its id or name, from list_bot_work. ' +
  'The person stays responsible (the assignee; with none named, the person you act for). ' +
  'Starting the agent is the person\'s Start on the action; when it finishes, the action goes to review and the person marks it Done.'

/**
 * @param createWorkspacePolicy what a CREATE with no `workspace_id` does — see
 *   {@link CreateWorkspacePolicy}. Default 'session' keeps chat / live-agent /
 *   work-run behaviour byte-identical; the MCP bridge passes 'explicit'.
 */
export function createActionTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
  omitPrivateCaptures = false,
  createWorkspacePolicy: CreateWorkspacePolicy = 'session',
  /** Who this tool set's status writes are (loop guard) — see CreateToolsOptions.origin. */
  origin?: StatusChangeOrigin,
  /** Unattended-run rules for actions — see {@link ActionToolRules}. */
  rules: ActionToolRules = {},
) {
  const reviewActionIds = new Set((rules.reviewActionIds ?? []).filter(Boolean))
  /** What an agent finishing a run's own action does instead of completing it. */
  const routeToReview = async (actionId: string, actionWorkspaceId: string) =>
    moveActionToReview(supabase, {
      actionId,
      workspaceId: actionWorkspaceId,
      actor: { userId, origin: origin ?? { actor: 'agent', depth: 1 } },
    })
  const captureVisibilityRequester = captureRequester(userId, omitPrivateCaptures)

  /**
   * One action matched by a non-id reference, plus the workspace it lives in.
   * `crossWorkspace` carries the same meaning it does on the `action_id` path
   * (see {@link resolveEntityWorkspace}): the row is NOT in the active workspace.
   */
  type ActionRefMatch = { id: string; workspaceId: string; crossWorkspace: boolean }

  /** One row of the disambiguation refusal — enough for the agent to re-call with an id. */
  type ActionRefCandidate = {
    action_id: string
    workspace_id: string
    workspace_name: string
    title: string
  }

  /**
   * Resolve an `identifier` (ENG-42) or `title_match` to exactly ONE action,
   * searching the user's OTHER workspaces when the active one has no match.
   *
   * Why: identifiers are unique per (workspace_id, identifier) — migration
   * 022:51 — so the SAME identifier can legitimately exist in two workspaces the
   * user belongs to. The old lookups pinned `.eq('workspace_id', workspaceId)`,
   * so an ENG-42 copied out of another workspace's UI came back "Action not
   * found" even though the user could see it in the product. The active
   * workspace still wins outright (fast path, byte-identical query, zero extra
   * round-trips); the fan-out runs ONLY when that comes back empty.
   *
   * Returns:
   *   `{ match }`                 – exactly one workspace holds it; act there
   *   `{ error, candidates }`     – 2+ workspaces hold it; refuse with the list
   *                                 rather than guess which tenant to write to
   *   `null`                      – nothing reachable; callers keep their
   *                                 existing 'Action not found'
   *
   * `strictWorkspace` short-circuits BEFORE the fan-out: an unattended run is
   * fenced to one workspace, so no cross-workspace probe may be issued at all —
   * otherwise the timing/shape of the refusal is an existence oracle for
   * identifiers in workspaces the run must not reach.
   *
   * `pinnedWorkspaceId` is the caller ANSWERING the ambiguity question up front
   * (the `workspace_id` param the three write tools take): the lookup runs in
   * that workspace and only there — no active-first fast path, no fan-out, and
   * therefore no candidates refusal, because there is nothing left to
   * disambiguate. Membership on it is checked by {@link resolveActionTarget}
   * BEFORE this function is called.
   */
  const findActionByRef = async ({
    identifier,
    title_match,
    pinnedWorkspaceId,
  }: {
    identifier?: string
    title_match?: string
    pinnedWorkspaceId?: string
  }): Promise<{ match: ActionRefMatch } | { error: string; candidates: ActionRefCandidate[] } | null> => {
    if (!identifier && !title_match) return null

    // ── Fast path: the active workspace (or the pinned one), as before ───────
    // Every lookup here is workspace-wide, not creator-scoped: an action is a
    // shared row (RLS gives every member SELECT and UPDATE), so a teammate's
    // ENG-42 must resolve exactly as the caller's own does.
    const searchWs = pinnedWorkspaceId ?? workspaceId
    const found = (id: string): { match: ActionRefMatch } => ({
      match: { id, workspaceId: searchWs, crossWorkspace: searchWs !== workspaceId },
    })

    if (identifier) {
      const { data } = await supabase
        .from('actions')
        .select('id')
        .eq('identifier', identifier)
        .eq('workspace_id', searchWs)
        .single()
      if (data?.id) return found(data.id as string)
    } else {
      // A title is fuzzy and the search is everyone's actions: act only on the
      // sole match (or the sole exact one), else refuse with the matches.
      const { data } = await supabase
        .from('actions')
        .select('id, title, identifier')
        .eq('workspace_id', searchWs)
        .ilike('title', `%${title_match}%`)
        .limit(FUZZY_MATCH_LIMIT)
      const rows = (data || []) as Array<{ id: string; title: string; identifier: string | null }>
      const pick = soleMatch(rows, (r) => r.title, title_match!)
      if (pick) return found(pick.id)
      if (rows.length > 1) {
        return {
          error:
            `Title match "${title_match}" matches several actions: ` +
            `${listMatches(rows.map((r) => `${r.identifier ?? r.id} "${r.title}"`))}. ` +
            'Pass the identifier or action_id.',
          candidates: rows.map((r) => ({
            action_id: r.id,
            workspace_id: searchWs,
            workspace_name: displayName(null, searchWs),
            title: r.title,
          })),
        }
      }
    }

    // A pinned workspace is a FENCE, not a preference: the caller already said
    // which tenant they meant, so a miss there is a miss, full stop. Fanning out
    // would search workspaces they explicitly did not name.
    if (pinnedWorkspaceId || strictWorkspace) return null

    // ── Slow path: the user's other workspaces ──────────────────────────────
    // `getUserWorkspaces` is the membership fence — these tools run on a
    // service-role client, so the `.in(...)` list, not RLS, is what keeps the
    // search inside workspaces the user actually belongs to.
    const others = (await getUserWorkspaces(supabase, userId)).filter((w) => w.id !== workspaceId)
    if (others.length === 0) return null

    let q = supabase
      .from('actions')
      .select('id, title, workspace_id')
      .in('workspace_id', others.map((w) => w.id))
    q = identifier ? q.eq('identifier', identifier) : q.ilike('title', `%${title_match}%`)
    // Bounded: an identifier yields at most one row per workspace, and a
    // title_match only needs enough rows to tell "one workspace" from "several".
    const { data: rows } = await q.limit(25)

    const matches = (rows || []) as Array<{ id: string; title: string; workspace_id: string }>
    if (matches.length === 0) return null

    const nameById = new Map(others.map((w) => [w.id, w.name]))
    const workspaceIds = [...new Set(matches.map((m) => m.workspace_id))]

    // Exactly one foreign workspace holds it → proceed there, on the same rule
    // as the active workspace: an identifier is unique there, a title must be
    // the sole match (or the sole exact one).
    if (workspaceIds.length === 1) {
      const pick = identifier ? matches[0] : soleMatch(matches, (m) => m.title, title_match!)
      if (pick) {
        return {
          match: {
            id: pick.id,
            workspaceId: pick.workspace_id,
            crossWorkspace: true,
          },
        }
      }
    }

    // Two or more tenants match. Refuse with a STRUCTURED, actionable error —
    // silently picking one would write to the wrong workspace, and a bare
    // "ambiguous" would leave the agent with nowhere to go.
    const label = identifier ? `Identifier ${identifier}` : `Title match "${title_match}"`
    const listed = workspaceIds
      .map((id) => `${displayName(nameById.get(id), id)} (${id})`)
      .join(', ')
    return {
      error:
        workspaceIds.length === 1
          ? `${label} matches several actions in ${listed}: ` +
            `${listMatches(matches.map((m) => `"${m.title}" (${m.id})`))}. Pass action_id to disambiguate.`
          : `${label} matches actions in ${workspaceIds.length} workspaces: ${listed}. ` +
            'Pass action_id or workspace_id to disambiguate.',
      candidates: matches.map((m) => ({
        action_id: m.id,
        workspace_id: m.workspace_id,
        workspace_name: displayName(nameById.get(m.workspace_id), m.workspace_id),
        title: m.title,
      })),
    }
  }

  /**
   * Shared front door for the three ref-addressable write tools
   * (complete / update / delete). Resolves `action_id` through
   * {@link resolveEntityWorkspace} and `identifier` / `title_match` through
   * {@link findActionByRef}, so all three route to the same workspace for the
   * same input. Returns the tool's own refusal payload on failure.
   *
   * `workspace_id` is the answer to the ambiguity refusal those tools can
   * return ("Pass action_id or workspace_id to disambiguate") — until now the
   * message named a param that did not exist. It NARROWS a name-based lookup:
   * membership is checked here (via {@link resolveCreateWorkspace}, which under
   * `strictWorkspace` refuses a foreign id without probing at all, and gives a
   * non-member the same flat 'Workspace not found' the creates do), then
   * findActionByRef searches that workspace alone.
   *
   * With `action_id` it is IGNORED, deliberately: the id already carries its own
   * workspace, so honouring a contradicting hint could only turn a resolvable
   * write into a refusal — or, worse, be read as permission to look elsewhere.
   */
  const resolveActionTarget = async (ref: {
    action_id?: string
    identifier?: string
    title_match?: string
    workspace_id?: string
  }): Promise<
    | { ok: true; id: string; workspaceId: string; crossWorkspace: boolean }
    | { ok: false; failure: { success: false; error: string; candidates?: ActionRefCandidate[] } }
  > => {
    const notFound = { ok: false as const, failure: { success: false as const, error: 'Action not found' } }

    if (ref.action_id) {
      const resolved = await resolveEntityWorkspace(
        supabase,
        userId,
        'actions',
        ref.action_id,
        workspaceId,
        strictWorkspace,
      )
      if (!resolved) return notFound
      return { ok: true, id: ref.action_id, ...resolved }
    }

    // A named workspace is membership-checked before it is searched, so a
    // non-member learns nothing about what lives there.
    let pinnedWorkspaceId: string | undefined
    if (ref.workspace_id) {
      const ws = await resolveCreateWorkspace(supabase, userId, workspaceId, ref.workspace_id, {
        strictWorkspace,
        // The policy governs the FALLBACK only, and there is no fallback here:
        // this branch runs exactly when an explicit id was supplied.
        policy: 'session',
      })
      if (!ws.ok) return { ok: false, failure: { success: false, error: ws.error.error } }
      pinnedWorkspaceId = ws.workspaceId
    }

    const found = await findActionByRef({ ...ref, pinnedWorkspaceId })
    if (!found) return notFound
    if ('error' in found) {
      return {
        ok: false,
        failure: { success: false, error: found.error, candidates: found.candidates },
      }
    }
    return { ok: true, ...found.match }
  }

  return {
    create_action: tool({
      description:
        'Create a new action/task for the user. Use this when the user asks to add a task, reminder, or action item. ' +
        'Pass workspace_id to file it in a specific workspace — copy it from the workspace_id on rows you read.',
      inputSchema: z.object({
        workspace_id: createWorkspaceParam,
        title: z.string().describe('Title of the action'),
        description: z.string().optional().describe('Additional description or notes'),
        due_date: z.string().optional().describe('Due date in ISO 8601 format'),
        all_day: z.boolean().optional().describe('Whether this is an all-day task (no specific time)'),
        priority: z.enum(PRIORITY_VALUES).optional().describe('Priority level. Default none.'),
        assignee_id: z.string().optional().describe('UUID of the member to assign to. Prefer this if you know the UUID.'),
        assignee_name: z.string().optional().describe('Name of the person to assign to. Will be resolved to a workspace member. Use this when you know the name but not the UUID.'),
        delegate: z.string().optional().describe(DELEGATE_PARAM_HELP),
        parent_id: z.string().optional().describe('UUID of parent action (creates a sub-action)'),
        estimate: z.number().optional().describe('Estimate in points'),
        project_id: z.string().optional().describe('UUID of the project to link to'),
        milestone_id: z.string().optional().describe('UUID of the milestone to link to'),
        cycle_id: z.string().optional().describe('UUID of the cycle/sprint to assign to'),
        confirmation: z
          .enum(['confirmed', 'suggested'])
          .optional()
          .default('confirmed')
          .describe("'confirmed' for user-requested, 'suggested' for AI-identified. Work running with nobody watching always files 'suggested'."),
        source_type: z.string().optional().describe('Source: chat_suggestion, meeting_extraction, etc.'),
        links: z
          .array(z.object({ url: z.string(), name: z.string().optional() }))
          .optional()
          .describe('Related links'),
        label_ids: z
          .array(z.string())
          .optional()
          .describe('Label IDs to attach. Use list_labels to find available labels.'),
        status_id: z
          .string()
          .optional()
          .describe(
            'UUID of the workflow state to start this action in. Must belong to the default team. ' +
              'Defaults to the team\'s default state (usually "Todo"). Get IDs from ni_get_workspace.',
          ),
        status_name: z
          .string()
          .optional()
          .describe(
            'Name of the workflow state to start this action in (e.g. "In Progress"). ' +
              'Resolved within the default team. Defaults to the team\'s default state if omitted.',
          ),
      }),
      execute: async ({ workspace_id, title, description, due_date, all_day, priority, assignee_id, assignee_name, delegate, parent_id, estimate, project_id, milestone_id, cycle_id, confirmation, source_type, links, label_ids, status_id, status_name }) => {
        // WHERE does this land? An explicit workspace_id wins (membership-checked);
        // otherwise the policy decides whether the session workspace is an answer
        // we trust. See CREATE-TIME WORKSPACE ROUTING in ./_shared.ts.
        const ws = await resolveCreateWorkspace(supabase, userId, workspaceId, workspace_id, {
          strictWorkspace,
          policy: createWorkspacePolicy,
        })
        if (!ws.ok) return ws.error
        const targetWs = ws.workspaceId

        // EVERY lookup below resolves in `targetWs`, never in the session
        // workspace: each one becomes a column on the inserted row, so a member
        // or team or state resolved in the wrong tenant is a cross-tenant
        // foreign key rather than a cosmetic mismatch.
        if (!assignee_id && assignee_name) {
          assignee_id = await resolveMemberByName(supabase, targetWs, assignee_name) ?? undefined
        }
        // The delegate (decision 9): an agent the caller can see in this
        // workspace works it; the person stays responsible — the named
        // assignee, else the person this tool acts for.
        let delegateAgent: { id: string; name: string } | null = null
        if (delegate !== undefined && delegate.trim()) {
          const found = await resolveDelegate(supabase, { userId, workspaceId: targetWs, ref: delegate })
          if (!found.ok) return { success: false, error: found.error }
          delegateAgent = { id: found.id, name: found.name }
          if (!assignee_id) assignee_id = (await memberIdForUser(supabase, userId, targetWs)) ?? undefined
        }
        const delegateEcho = delegateAgent ? { delegate: delegateAgent } : {}
        const createdNote = (identifier: unknown, actionTitle: unknown) =>
          `Created action ${identifier}: "${actionTitle}"` +
          (delegateAgent ? `, delegated to ${delegateAgent.name} (the person stays responsible; Start it from the action)` : '') +
          (rules.fileActionsAsSuggested ? ' as a suggestion for the person to confirm' : '')
        const teamId = await getDefaultTeamId(supabase, targetWs)
        if (!teamId) return { success: false, error: noTeamError(targetWs) }

        // Ids the caller supplied ready-made get the same treatment — but only
        // on a routed create, so the in-workspace path is unchanged. See
        // {@link refsOutsideWorkspace}.
        if (ws.crossWorkspace) {
          const refError = await refsOutsideWorkspace(supabase, targetWs, {
            project_id,
            milestone_id,
            cycle_id,
            parent_id,
            label_ids,
          })
          if (refError) return { success: false, error: refError }
        }

        let statusId: string | undefined
        if (status_id !== undefined || status_name !== undefined) {
          const resolved = await resolveStatusForTeam(supabase, teamId, { status_id, status_name })
          if (!resolved.ok) return { success: false, error: resolved.error }
          statusId = resolved.id
        } else {
          statusId = await getDefaultStateId(supabase, teamId)
        }
        if (!statusId) return { success: false, error: 'No default workflow state for team' }

        const insertData: Record<string, unknown> = {
          user_id: userId,
          workspace_id: targetWs,
          team_id: teamId,
          title,
          description: description || null,
          due_at: dueAtFromDate(due_date) || null,
          all_day: all_day ?? (due_date ? false : true),
          priority: priority || 'none',
          status_id: statusId,
          // The promotion guard: nobody watching → a suggestion a person confirms.
          confirmation: rules.fileActionsAsSuggested ? 'suggested' : confirmation || 'confirmed',
          source_type: source_type || null,
          links: links || [],
        }
        if (assignee_id) insertData.assignee_id = assignee_id
        if (delegateAgent) insertData.assignee_ai_member_id = delegateAgent.id
        if (parent_id) insertData.parent_id = parent_id
        if (estimate !== undefined) insertData.estimate = estimate
        if (project_id) insertData.project_id = project_id
        if (milestone_id) insertData.milestone_id = milestone_id
        if (cycle_id) insertData.cycle_id = cycle_id

        const { data, error } = await supabase
          .from('actions')
          .insert(insertData)
          .select(ACTION_SELECT)
          .single()

        if (error) return { success: false, error: error.message }

        // Sync action_assignee join table
        if (assignee_id) {
          await supabase.from('action_assignee').insert({ action_id: data.id, member_id: assignee_id })
        }

        // Attach labels
        if (label_ids && label_ids.length > 0) {
          await supabase.from('action_label').insert(
            label_ids.map((lid) => ({ action_id: data.id, label_id: lid })),
          )
          // Re-fetch to include labels in response
          const { data: refreshed } = await supabase
            .from('actions')
            .select(ACTION_SELECT)
            .eq('id', data.id)
            .eq('workspace_id', targetWs)
            .single()
          if (refreshed) {
            const action = flattenAction(refreshed as Record<string, unknown>)
            return {
              success: true,
              action,
              ...delegateEcho,
              message: createdNote(action.identifier, action.title),
              ...workspaceEcho(targetWs, ws.workspaceName),
            }
          }
        }

        const action = flattenAction(data as Record<string, unknown>)
        return {
          success: true,
          action,
          ...delegateEcho,
          message: createdNote(action.identifier, action.title),
          // The echo is what makes a mis-route visible in the SAME turn: compare
          // it against `active_workspace` on the envelope. See workspaceEcho.
          ...workspaceEcho(targetWs, ws.workspaceName),
        }
      },
    }),

    list_actions: tool({
      description:
        'List actions/tasks with optional filtering. Default returns a compact summary (id, identifier, title, status, due_at, assignee, delegate agent, project) — set verbose=true to include description, labels, milestone, cycle, and estimate. ' +
        "By default it lists the whole workspace's actions, everyone's, not just the user's. To check what the user needs to do, pass `assignee: 'me'`; pass a member UUID for a teammate's list. " +
        "`project_id` narrows to one project's actions, `team_id` to one team's board; they combine with every other filter. " +
        'For arbitrary time ranges, use `since`/`until` with a preset (e.g. last_week, past_30_days) or ISO date, plus `time_field` to pick which column to filter on (due_at default, or created_at / updated_at). ' +
        '`since`/`until` override any time window implied by `filter`. ' +
        'Rows come urgent first, then by earliest due date (no due date last); each carries its `confirmation`. ' +
        "Dismissed actions are left out unless `confirmation: 'any'`; pass `confirmation: 'confirmed'` for accepted work only, without meeting suggestions nobody accepted.",
      inputSchema: z.object({
        ...timeWindowParams,
        time_field: z
          .enum(ACTION_TIME_FIELDS)
          .optional()
          .default('due_at')
          .describe(
            'Which date column `since`/`until` apply to. Defaults to `due_at`. ' +
              'Use `created_at` for "actions created in the past week" or `updated_at` for "recently changed".',
          ),
        filter: z
          .enum(['all', 'today', 'tomorrow', 'this_week', 'overdue', 'completed'])
          .optional()
          .default('all')
          .describe(
            'Convenience preset combining a time window with status semantics. ' +
              'Prefer `since`/`until` for arbitrary ranges. `overdue` and `completed` apply status logic on top of the time filter ' +
              "(`filter: 'completed'` overrides the `status` param, which defaults to 'active'). " +
              "Cannot combine `filter: 'overdue'` with `status: 'completed'` — overdue items are by definition not completed.",
          ),
        status: z
          .enum(['all', 'active', 'completed'])
          .optional()
          .default('active')
          .describe("Status filter. 'active' = not completed/canceled"),
        search: z.string().optional().describe('Full-text search query'),
        assignee: z
          .string()
          .optional()
          .describe(
            "Only actions assigned to this person: 'me' for the user's own, or a member UUID (from list_workspace_members). Omit to list everyone's.",
          ),
        confirmation: z
          .enum(LIST_CONFIRMATIONS)
          .optional()
          .describe(
            "Which actions by confirmation. Omit for confirmed and suggested (dismissed left out). 'confirmed' = accepted work only; 'suggested' = proposals from meetings nobody accepted yet; 'any' also includes dismissed.",
          ),
        project_id: z
          .string()
          .optional()
          .describe("Only this project's actions: a project UUID (from list_projects). Omit for every project."),
        team_id: z
          .string()
          .optional()
          .describe("Only this team's actions: a team UUID (`team_id` on list_workflow_states rows). Omit for every team."),
        limit: z.number().int().min(1).max(200).optional().default(50).describe('Max results (default 50, max 200)'),
        offset: z.number().int().min(0).optional().default(0).describe('Pagination offset (default 0)'),
        verbose: z
          .boolean()
          .optional()
          .default(false)
          .describe('Include description, labels, milestone, cycle, estimate. Off by default to keep responses small.'),
      }),
      execute: async ({ filter, status, search, assignee, confirmation, project_id, team_id, since, until, time_field, limit, offset, verbose }) => {
        // `filter='overdue'` constrains status_id to active categories
        // (backlog/unstarted/started). Passing `status='completed'` at the same
        // time would also constrain status_id to the completed category — the
        // two IN(...) filters are mutually exclusive and would silently return
        // an empty result set. Fail loudly so the agent picks one.
        if (filter === 'overdue' && status === 'completed') {
          return {
            success: false,
            error:
              "`filter: 'overdue'` is incompatible with `status: 'completed'` — overdue actions are by definition not completed. Use `filter: 'completed'` (or `status: 'completed'` with `until: 'today'`) to find past-due completed items.",
          }
        }

        // A project or team id must be a UUID: anything else is a name the
        // model should have resolved first, and Postgres would refuse it.
        if (project_id !== undefined && !UUID_RE.test(project_id)) {
          return { success: false, error: '`project_id` must be a project UUID (use list_projects with `search` to find one).' }
        }
        if (team_id !== undefined && !UUID_RE.test(team_id)) {
          return { success: false, error: '`team_id` must be a team UUID (list_workflow_states rows carry `team_id` and `team_name`).' }
        }

        const cappedLimit = Math.min(limit ?? 50, 200)
        const startOffset = Math.max(0, offset ?? 0)

        // `assignee` narrows to one person: 'me' is the caller's member row in
        // this workspace. A member id is checked as a UUID because it is spliced
        // into the `.or(...)` filter string below.
        let assigneeMemberId: string | null = null
        if (assignee) {
          if (assignee === 'me') {
            const { data: me } = await supabase
              .from('member')
              .select('id')
              .eq('user_id', userId)
              .eq('workspace_id', workspaceId)
              .maybeSingle()
            if (!me?.id) return { success: false, error: 'You are not a member of this workspace' }
            assigneeMemberId = me.id as string
          } else if (UUID_RE.test(assignee)) {
            assigneeMemberId = assignee
          } else {
            return {
              success: false,
              error: "`assignee` must be 'me' or a member UUID (use list_workspace_members to find one).",
            }
          }
        }

        // Always select the full join graph; size savings come from the response
        // shape, not the query (per-row payload is small either way and Supabase's
        // type parser doesn't handle a ternary over two select strings).
        //
        // Workspace-wide, not creator-scoped: actions are shared rows every
        // member may read (RLS), so the default is everyone's list.
        //
        // `assignee` filters through the `action_assignee` join table, in the
        // database: an inner embed keeps only actions with a row for that
        // member. The table is the record (whoever writes `assignee_id` writes
        // a row too; PROD had no action assigned by the column alone,
        // 2026-10-09), and a list of ids in the URL would outgrow it for a
        // busy person (329 assignments on PROD).
        // Typed as ACTION_SELECT: the embed only filters, and the rows are read
        // through flattenAction, which never looks at `assigned`.
        // custom_fields: the workspace's own fields on tasks (migration 496), the set ones by name.
        const columns = (assigneeMemberId
          ? `${ACTION_SELECT}, custom_fields, assigned:action_assignee!inner(member_id)`
          : `${ACTION_SELECT}, custom_fields`) as typeof ACTION_SELECT
        let query = supabase
          .from('actions')
          .select(columns, { count: 'exact' })
          .eq('workspace_id', workspaceId)
          .is('parent_id', null) // top-level only
        if (assigneeMemberId) query = query.eq('assigned.member_id', assigneeMemberId)
        // Every action sits on exactly one team (actions.team_id NOT NULL,
        // migration 019) and at most one project.
        if (project_id) query = query.eq('project_id', project_id)
        if (team_id) query = query.eq('team_id', team_id)

        // Confirmation: a meeting's proposal is a row too, `suggested` until
        // someone accepts it and `dismissed` once they reject it. Dismissed rows
        // are never anyone's work, so they stay out unless asked for.
        if (confirmation === 'confirmed' || confirmation === 'suggested') {
          query = query.eq('confirmation', confirmation)
        } else if (confirmation !== 'any') {
          query = query.neq('confirmation', 'dismissed')
        }

        // Status filter via workflow state categories — scope to workspace teams.
        //
        // `filter` presets carry their own status semantics ('completed' ⇒
        // completed-only, 'overdue' ⇒ active-only), so fold them into the
        // status before building the IN(...) clause. `status` defaults to
        // 'active', so without this `filter: 'completed'` would AND the active
        // IN(...) from the defaulted status with the completed IN(...) from the
        // preset — two disjoint status_id sets that silently return zero rows
        // (the mirror image of the overdue+completed guard above).
        const effectiveStatus =
          filter === 'completed' ? 'completed' : filter === 'overdue' ? 'active' : status

        const { data: wsTeams } = await supabase
          .from('team')
          .select('id')
          .eq('workspace_id', workspaceId)
        const wsTeamIds = (wsTeams || []).map((t) => t.id)

        if (effectiveStatus === 'active' && wsTeamIds.length > 0) {
          const { data: states } = await supabase
            .from('workflow_state')
            .select('id')
            .in('team_id', wsTeamIds)
            .in('category', [...OPEN_STATE_CATEGORIES])
          const ids = (states || []).map((s) => s.id)
          if (ids.length) query = query.in('status_id', ids)
        } else if (effectiveStatus === 'completed' && wsTeamIds.length > 0) {
          const { data: states } = await supabase
            .from('workflow_state')
            .select('id')
            .in('team_id', wsTeamIds)
            .eq('category', 'completed')
          const ids = (states || []).map((s) => s.id)
          if (ids.length) query = query.in('status_id', ids)
        }

        // Full-text search
        if (search) {
          const tsQuery = search.trim().split(/\s+/).join(' & ')
          query = query.textSearch('fts', tsQuery)
        }

        // Time filters
        //
        // Two ways an agent can specify time:
        //   1. `since` / `until` on a chosen `time_field` — the standard shape
        //      shared across all list_* tools. Wins when set.
        //   2. The legacy `filter` enum — convenience presets that combine a
        //      time window with status semantics (overdue, completed). Time
        //      windows from `filter` are ignored when `since`/`until` is set,
        //      but the status logic of `overdue` / `completed` still applies.
        const now = new Date()
        const sinceISO = resolveSince(since)
        const untilISO = resolveUntil(until)
        const timeField = time_field ?? 'due_at'
        const hasExplicitWindow = sinceISO !== null || untilISO !== null

        if (hasExplicitWindow) {
          if (sinceISO) query = query.gte(timeField, sinceISO)
          if (untilISO) query = query.lte(timeField, untilISO)
        } else {
          // Legacy filter-driven time windows. All apply to `due_at`.
          const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
          const endOfDay = new Date(startOfDay.getTime() + 86400000)
          if (filter === 'today') {
            query = query.gte('due_at', startOfDay.toISOString()).lt('due_at', endOfDay.toISOString())
          } else if (filter === 'tomorrow') {
            const tomorrow = new Date(startOfDay.getTime() + 86400000)
            const dayAfter = new Date(startOfDay.getTime() + 172800000)
            query = query.gte('due_at', tomorrow.toISOString()).lt('due_at', dayAfter.toISOString())
          } else if (filter === 'this_week') {
            const endOfWeek = new Date(startOfDay.getTime() + 7 * 86400000)
            query = query.gte('due_at', startOfDay.toISOString()).lt('due_at', endOfWeek.toISOString())
          }
        }

        // Status semantics from `filter` are applied once above via
        // `effectiveStatus` — never as a second IN(...) here, which would AND
        // with the first and could zero out the result set. The only extra
        // constraint a preset adds is overdue ⇒ past-due. Only skip the "due
        // before now" cap when the caller already supplied an upper bound via
        // `until` — otherwise we'd double-constrain. A `since` alone still
        // needs this cap.
        if (filter === 'overdue' && !untilISO) {
          query = query.lt('due_at', now.toISOString())
        }

        query = orderByUrgency(query).range(startOffset, startOffset + cappedLimit - 1)

        const [{ data, error, count }, fieldDefs] = await Promise.all([query, customFieldDefsOrNone(supabase, workspaceId, 'action')])
        if (error) return { success: false, error: error.message }

        const actions = (data || []).map((a) => {
          const fields = withCustomFields(fieldDefs, (a as { custom_fields?: unknown }).custom_fields)
          if (verbose) {
            const flat = flattenAction(a as unknown as Record<string, unknown>)
            return {
              ...flat,
              confirmation: a.confirmation,
              is_overdue: a.due_at && new Date(a.due_at) < now && flat.status_category !== 'completed',
              ...fields,
            }
          }
          // Compact shape — only essentials. ~10x smaller than verbose.
          const ws = (a as { workflow_state?: { name?: string; category?: string } }).workflow_state
          const project = (a as { project?: { name?: string } }).project
          return {
            id: a.id,
            workspace_id: a.workspace_id,
            identifier: a.identifier,
            title: a.title,
            status: ws?.name || '',
            status_category: ws?.category || '',
            priority: a.priority,
            due_at: a.due_at,
            confirmation: a.confirmation,
            assignee_id: a.assignee_id,
            delegate: delegateOf(a as unknown as Record<string, unknown>),
            project_id: a.project_id,
            project_name: project?.name || null,
            is_overdue: a.due_at && new Date(a.due_at) < now && ws?.category !== 'completed',
            ...fields,
          }
        })

        const total = count ?? actions.length
        return {
          success: true,
          actions,
          count: actions.length,
          total,
          offset: startOffset,
          has_more: startOffset + actions.length < total,
          verbose: !!verbose,
          ...(hasExplicitWindow
            ? { time_field: timeField, since: sinceISO, until: untilISO }
            : {}),
        }
      },
    }),

    complete_action: tool({
      description: "Mark an action as completed. Can find by ID, identifier, or title match.",
      inputSchema: z.object({
        action_id: z.string().optional().describe('UUID of the action'),
        identifier: z.string().optional().describe('Action identifier like ENG-42'),
        title_match: z.string().optional().describe('Partial title to match (case-insensitive)'),
        workspace_id: z
          .string()
          .optional()
          .describe(
            'Narrows an identifier or title_match lookup to this workspace. Copy it from the workspace_id on rows you read.',
          ),
      }),
      execute: async ({ action_id, identifier, title_match, workspace_id }) => {
        // Resolve id AND workspace together — an id, an identifier or a title
        // may all point at an action in another workspace the user belongs to.
        const target = await resolveActionTarget({ action_id, identifier, title_match, workspace_id })
        if (!target.ok) return target.failure
        const id = target.id
        const resolved = { workspaceId: target.workspaceId, crossWorkspace: target.crossWorkspace }

        // Look up the action's team (for the completed state) and current
        // status (for the Flow trigger's from→to).
        const { data: action } = await supabase
          .from('actions')
          .select('team_id, status_id')
          .eq('id', id)
          .single()

        if (!action) return { success: false, error: 'Action not found' }

        // The run's own action: an agent's finish is review, never Done
        // (decision 9). The person marks it Done.
        if (reviewActionIds.has(id)) {
          await routeToReview(id, resolved.workspaceId)
          return {
            success: true,
            review: true,
            message: 'Moved this action to review: the person who owns it marks it Done. Finish your run as usual.',
          }
        }

        const completedStateId = await getCompletedStateId(supabase, action.team_id)
        if (!completedStateId) return { success: false, error: 'No completed workflow state found' }

        const { data, error } = await supabase
          .from('actions')
          .update({ status_id: completedStateId })
          .eq('id', id)
          .eq('workspace_id', resolved.workspaceId)
          .select(ACTION_SELECT)
          .single()

        if (error) return { success: false, error: error.message }
        const flat = flattenAction(data as Record<string, unknown>)

        // Fire the status-change Flow trigger (GEN-112) — completing via the
        // agent/MCP must behave like completing in the UI.
        emitStatusChange({
          entityType: 'action',
          entityId: id!,
          workspaceId: resolved.workspaceId,
          teamId: (action.team_id as string | null) ?? null,
          fromStatusId: (action.status_id as string | null) ?? null,
          toStatusId: completedStateId,
          actorUserId: userId,
        origin,
        })

        return { success: true, message: `Completed ${flat.identifier}: "${flat.title}"` }
      },
    }),

    update_action: tool({
      description:
        'Update an existing action. Can find by ID, identifier, or title match. ' +
        'To move the action to a different workflow state (e.g. Todo → In Progress, In Progress → Done, → Canceled, → Blocked), ' +
        'pass `status_name` (e.g. "In Progress") or `status_id` (UUID from ni_get_workspace). ' +
        'Workflow states are per-team and customizable — call ni_get_workspace first to see the available states for the relevant team.',
      inputSchema: z.object({
        action_id: z.string().optional().describe('UUID of the action'),
        identifier: z.string().optional().describe('Action identifier like ENG-42'),
        title_match: z.string().optional().describe('Partial title to match (case-insensitive)'),
        workspace_id: z
          .string()
          .optional()
          .describe(
            'Narrows an identifier or title_match lookup to this workspace. Copy it from the workspace_id on rows you read.',
          ),
        title: z.string().optional().describe('New title'),
        description: z.string().optional().describe('New description'),
        due_date: z.string().optional().describe('New due date (ISO 8601)'),
        priority: z.enum(PRIORITY_VALUES).optional().describe('New priority'),
        assignee_id: z.string().optional().describe('UUID of member to assign (or empty string to unassign)'),
        delegate: z
          .string()
          .optional()
          .describe(`${DELEGATE_PARAM_HELP} An empty string removes the delegate; the person stays.`),
        estimate: z.number().optional().describe('New estimate in points'),
        project_id: z.string().optional().describe('UUID of project to link (empty string to unlink)'),
        milestone_id: z.string().optional().describe('UUID of milestone to link (empty string to unlink)'),
        cycle_id: z.string().optional().describe('UUID of cycle to assign (empty string to unassign)'),
        status_id: z
          .string()
          .optional()
          .describe(
            'UUID of the workflow state to move this action into. Must belong to the action\'s team. ' +
              'Prefer this if you have the ID from ni_get_workspace. Mutually exclusive with status_name (status_id wins).',
          ),
        status_name: z
          .string()
          .optional()
          .describe(
            'Name of the workflow state to move this action into (e.g. "In Progress", "In Review", "Done", "Canceled", "Blocked"). ' +
              'Resolved within the action\'s team. Case-insensitive exact match, falling back to a unique substring match.',
          ),
        toggle_complete: z
          .boolean()
          .optional()
          .describe(
            'Toggle completion status. Ignored if status_id or status_name is also supplied — those take precedence.',
          ),
        label_ids: z
          .array(z.string())
          .optional()
          .describe('Replace all labels with these IDs. Use list_labels to find available labels.'),
      }),
      execute: async ({ action_id, identifier, title_match, workspace_id, title, description, due_date, priority, assignee_id, delegate, estimate, project_id, milestone_id, cycle_id, status_id, status_name, toggle_complete, label_ids }) => {
        // Resolve id AND workspace together — an id, an identifier or a title
        // may all point at an action in another workspace the user belongs to.
        const target = await resolveActionTarget({ action_id, identifier, title_match, workspace_id })
        if (!target.ok) return target.failure
        const id = target.id
        const wsResolved = { workspaceId: target.workspaceId, crossWorkspace: target.crossWorkspace }

        // The delegate (decision 9), resolved before anything is written: an
        // agent the caller can see in the ACTION's workspace. '' removes it.
        let delegateAgent: { id: string; name: string } | null = null
        if (delegate !== undefined && delegate.trim()) {
          const found = await resolveDelegate(supabase, { userId, workspaceId: wsResolved.workspaceId, ref: delegate })
          if (!found.ok) return { success: false, error: found.error }
          delegateAgent = { id: found.id, name: found.name }
        }

        const updates: Record<string, unknown> = {}
        if (delegate !== undefined) updates.assignee_ai_member_id = delegateAgent?.id ?? null
        // Delegating an action nobody holds makes the delegator responsible.
        if (delegateAgent && assignee_id === undefined) {
          const { data: held } = await supabase.from('action_assignee').select('member_id').eq('action_id', id)
          if (!held || held.length === 0) {
            const delegator = await memberIdForUser(supabase, userId, wsResolved.workspaceId)
            if (delegator) assignee_id = delegator
          }
        }
        if (title !== undefined) updates.title = title
        if (description !== undefined) updates.description = description
        if (due_date !== undefined) updates.due_at = dueAtFromDate(due_date)
        if (priority !== undefined) updates.priority = priority
        if (assignee_id !== undefined) {
          updates.assignee_id = assignee_id || null
          // Sync join table
          await supabase.from('action_assignee').delete().eq('action_id', id!)
          if (assignee_id) {
            await supabase.from('action_assignee').insert({ action_id: id!, member_id: assignee_id })
          }
        }
        if (estimate !== undefined) updates.estimate = estimate
        if (project_id !== undefined) updates.project_id = project_id || null
        if (milestone_id !== undefined) updates.milestone_id = milestone_id || null
        if (cycle_id !== undefined) updates.cycle_id = cycle_id || null

        // Status transition: explicit status_id/status_name takes precedence over toggle_complete.
        // Workflow states are per-team, so we always resolve against the action's team.
        // Capture the team + previous status so we can fire the status-change
        // Flow trigger after the update (GEN-112: MCP/agent writes must emit
        // the same trigger the UI PATCH path does).
        const statusRequested = status_id !== undefined || status_name !== undefined
        let flowTeamId: string | null = null
        let previousStatusId: string | null = null
        if (statusRequested || toggle_complete !== undefined) {
          const { data: actionData } = await supabase
            .from('actions')
            .select('team_id, status_id')
            .eq('id', id)
            .single()

          if (actionData) {
            flowTeamId = (actionData.team_id as string | null) ?? null
            previousStatusId = (actionData.status_id as string | null) ?? null
            if (statusRequested) {
              const resolved = await resolveStatusForTeam(supabase, actionData.team_id, {
                status_id,
                status_name,
              })
              if (!resolved.ok) return { success: false, error: resolved.error }
              updates.status_id = resolved.id
            } else if (toggle_complete) {
              const completedId = await getCompletedStateId(supabase, actionData.team_id)
              if (!completedId) return { success: false, error: 'No completed workflow state found' }
              updates.status_id = completedId
            } else {
              const defaultId = await getDefaultStateId(supabase, actionData.team_id)
              if (!defaultId) return { success: false, error: 'No default workflow state found' }
              updates.status_id = defaultId
            }
          }
        }

        // The run's own action into a completed state: review instead, never
        // Done (decision 9). The other fields still write.
        let toReview = false
        if (reviewActionIds.has(id) && typeof updates.status_id === 'string') {
          const { data: state } = await supabase
            .from('workflow_state')
            .select('category')
            .eq('id', updates.status_id)
            .maybeSingle()
          if ((state as { category?: string } | null)?.category === 'completed') {
            delete updates.status_id
            toReview = true
          }
        }

        // PostgREST answers a PATCH with an empty body by skipping the UPDATE and
        // returning no rows, so `.single()` below would fail with the opaque
        // "Cannot coerce the result to a single JSON object" (GEN-102). Labels live
        // in action_label, so a labels-only call legitimately has no row columns
        // and is read back instead. Any other empty call passed no recognised
        // field — typically a misnamed one (`status` for `status_name`), which the
        // schema drops silently — so refuse it before writing anything.
        const hasRowChanges = Object.keys(updates).length > 0
        if (!hasRowChanges && label_ids === undefined && !toReview) {
          return {
            success: false,
            error:
              'Nothing to update: no recognised fields were provided (unknown arguments are ignored). ' +
              'To move the action to another workflow state, pass status_name (e.g. "Canceled") or status_id. ' +
              'Other updatable fields: title, description, due_date, priority, assignee_id, delegate, estimate, ' +
              'project_id, milestone_id, cycle_id, toggle_complete, label_ids.',
          }
        }

        // Update labels if provided
        if (label_ids) {
          await supabase.from('action_label').delete().eq('action_id', id)
          if (label_ids.length > 0) {
            await supabase.from('action_label').insert(
              label_ids.map((lid) => ({ action_id: id!, label_id: lid })),
            )
          }
        }

        // Labels-only: read the row back rather than issuing an empty UPDATE.
        const { data, error } = hasRowChanges
          ? await supabase
              .from('actions')
              .update(updates)
              .eq('id', id)
              .eq('workspace_id', wsResolved.workspaceId)
              .select(ACTION_SELECT)
              .single()
          : await supabase
              .from('actions')
              .select(ACTION_SELECT)
              .eq('id', id)
              .eq('workspace_id', wsResolved.workspaceId)
              .single()

        if (error) return { success: false, error: error.message }
        const action = flattenAction(data as Record<string, unknown>)

        // Fire the status-change Flow trigger when this update moved the action
        // into a new status — same emit the UI PATCH path uses, so Flows behave
        // consistently regardless of writer (GEN-112). No-op if status didn't
        // change or the team is unknown.
        if (updates.status_id !== undefined) {
          emitStatusChange({
            entityType: 'action',
            entityId: id!,
            workspaceId: wsResolved.workspaceId,
            teamId: flowTeamId,
            fromStatusId: previousStatusId,
            toStatusId: updates.status_id as string,
            actorUserId: userId,
          origin,
          })
        }

        if (toReview) {
          await routeToReview(id, wsResolved.workspaceId)
          return {
            success: true,
            action,
            review: true,
            message: `Updated ${action.identifier}: "${action.title}". It went to review, not Done: the person who owns it marks it Done.`,
          }
        }
        return {
          success: true,
          action,
          ...(delegateAgent ? { delegate: delegateAgent } : {}),
          message:
            `Updated ${action.identifier}: "${action.title}"` +
            (delegateAgent ? `, delegated to ${delegateAgent.name} (the person stays responsible; Start it from the action)` : ''),
        }
      },
    }),

    delete_action: tool({
      description: 'Delete an action permanently. Only a workspace owner or admin can delete an action.',
      inputSchema: z.object({
        action_id: z.string().optional().describe('UUID of the action'),
        identifier: z.string().optional().describe('Action identifier like ENG-42'),
        title_match: z.string().optional().describe('Partial title to match'),
        workspace_id: z
          .string()
          .optional()
          .describe(
            'Narrows an identifier or title_match lookup to this workspace. Copy it from the workspace_id on rows you read.',
          ),
      }),
      execute: async ({ action_id, identifier, title_match, workspace_id }) => {
        // Resolve id AND workspace together — an id, an identifier or a title
        // may all point at an action in another workspace the user belongs to.
        const target = await resolveActionTarget({ action_id, identifier, title_match, workspace_id })
        if (!target.ok) return target.failure
        const id = target.id
        const wsResolved = { workspaceId: target.workspaceId }

        // Only a workspace owner or admin may delete an action, exactly as the
        // `actions_delete` RLS policy says. Checked here too because MCP and
        // unattended runs use a service-role client, where RLS never runs. The
        // role is read in the ACTION'S workspace: member rows are per workspace.
        const { data: member } = await supabase
          .from('member')
          .select('role')
          .eq('user_id', userId)
          .eq('workspace_id', wsResolved.workspaceId)
          .maybeSingle()
        if (!member || !ACTION_DELETE_ROLES.has(member.role as string)) {
          return { success: false, error: 'Only a workspace owner or admin can delete an action' }
        }

        const { data: deleted, error } = await supabase
          .from('actions')
          .delete()
          .eq('id', id)
          .eq('workspace_id', wsResolved.workspaceId)
          .select('id')

        if (error) return { success: false, error: error.message }
        // A delete that matched nothing (RLS on the session client filters
        // silently) must not read as a success.
        if (!deleted || deleted.length === 0) return { success: false, error: 'Action not deleted' }
        return { success: true, message: 'Action deleted' }
      },
    }),

    confirm_action: tool({
      description: "Confirm a suggested action (change confirmation from 'suggested' to 'confirmed').",
      inputSchema: z.object({
        action_id: z.string().describe('UUID of the suggested action'),
      }),
      execute: async ({ action_id }) => {
        // The promotion guard: nobody watching → the person confirms.
        if (rules.unattended) return { success: false, code: 'LEAVE_FOR_PERSON', error: LEAVE_FOR_PERSON }
        const wsResolved = await resolveEntityWorkspace(supabase, userId, 'actions', action_id, workspaceId, strictWorkspace)
        if (!wsResolved) return { success: false, error: 'Action not found' }

        const { data, error } = await supabase
          .from('actions')
          .update({ confirmation: 'confirmed' })
          .eq('id', action_id)
          .eq('workspace_id', wsResolved.workspaceId)
          .eq('confirmation', 'suggested')
          .select('id, identifier, title')
          .single()

        if (error) return { success: false, error: error.message }
        return { success: true, message: `Confirmed ${data.identifier}: "${data.title}"` }
      },
    }),

    dismiss_action: tool({
      description: 'Dismiss a suggested action.',
      inputSchema: z.object({
        action_id: z.string().describe('UUID of the action to dismiss'),
        reason: z.string().optional().describe('Reason for dismissing'),
      }),
      execute: async ({ action_id, reason }) => {
        const wsResolved = await resolveEntityWorkspace(supabase, userId, 'actions', action_id, workspaceId, strictWorkspace)
        if (!wsResolved) return { success: false, error: 'Action not found' }

        const { data, error } = await supabase
          .from('actions')
          .update({
            confirmation: 'dismissed',
            dismiss_reason: reason || null,
          })
          .eq('id', action_id)
          .eq('workspace_id', wsResolved.workspaceId)
          .select('id, identifier, title')
          .single()

        if (error) return { success: false, error: error.message }
        return { success: true, message: `Dismissed ${data.identifier}: "${data.title}"` }
      },
    }),

    get_action_suggestions: tool({
      description:
        'Get pending AI-proposed changes from recent meeting captures that need review. ' +
        'These are staged by the live meeting agent and appear as <!-- proposal:UUID --> markers ' +
        'in capture summaries. Includes all entity types (actions, project updates, decisions, etc.). ' +
        'Default returns a compact page (display_text + key fields) plus pending_by_capture counts for the whole queue — ' +
        'set verbose=true for full detail (description, reasoning, trigger_quote, open_questions), ideally scoped to one capture_id. ' +
        'Verbose rows also carry spoken_by: the transcript voice(s) that said the trigger_quote — each label, its channel ' +
        '(microphone = the recorder\'s own mic, meeting_audio = the call) and who it was identified as (null = nobody) — and ' +
        'possibly_you, true when an unidentified voice on your own microphone said it on a capture where your voice was not identified. ' +
        'Page through large queues with offset. Use dismiss_proposal to discard a suggestion that is no longer relevant.',
      inputSchema: z.object({
        capture_id: z
          .string()
          .optional()
          .describe('Scope to a specific capture. Omit to return pending proposals across all recent captures.'),
        limit: z
          .number()
          .optional()
          .default(20)
          .describe('Max results per page (default 20; max 100 compact, 25 verbose)'),
        offset: z.number().optional().default(0).describe('Pagination offset (default 0)'),
        verbose: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'Include description, reasoning, trigger_quote, stakes, open_questions. ' +
              'Off by default to keep responses small — prefer scoping to a capture_id when enabling.',
          ),
      }),
      execute: async ({ capture_id, limit, offset, verbose }) => {
        // Verbose rows carry full provenance prose (~10x a compact row), so they
        // get a tighter page cap. A 50-row full dump reached ~90KB in production
        // (GEN-74) and blew client token limits.
        const cappedLimit = Math.max(1, Math.min(limit ?? 20, verbose ? 25 : 100))
        const startOffset = Math.max(0, offset ?? 0)

        let query = supabase
          .from('proposed_change')
          .select(
            'id, capture_id, change_type, entity_type, entity_id, display_text, title, description, ' +
            'priority, due_date, assignee_name, assignee_member_id, project_id, ' +
            'reasoning, trigger_quote, stakes, open_questions, confidence, created_at, ' +
            'capture:captures!capture_id!inner(id, title)',
            { count: 'exact' },
          )
          .eq('workspace_id', workspaceId)
          .eq('status', 'pending')

        // Proposals inherit their source capture's visibility. The embed is
        // !inner so the capture predicate actually drops the parent row (a
        // non-inner embed would keep the proposal with a null capture), which
        // also fails closed on a dangling capture_id.
        query = applyEmbeddedCaptureVisibility(query, captureVisibilityRequester, 'capture')

        if (capture_id) {
          query = query.eq('capture_id', capture_id)
        }

        query = query
          .order('created_at', { ascending: false })
          .range(startOffset, startOffset + cappedLimit - 1)

        const { data, error, count } = await query

        if (error) return { success: false, error: error.message }

        // proposed_change may not be in the auto-generated Supabase types yet,
        // so we cast to a local shape rather than rely on the inferred type.
        type ProposedChangeRow = {
          id: string
          capture_id: string
          change_type: string
          entity_type: string
          entity_id: string | null
          display_text: string
          title: string | null
          description: string | null
          priority: string | null
          due_date: string | null
          assignee_name: string | null
          assignee_member_id: string | null
          project_id: string | null
          reasoning: string | null
          trigger_quote: string | null
          stakes: string | null
          open_questions: string[] | null
          confidence: number
          created_at: string
          capture: { id: string; title: string } | null
        }

        const rows = (data as unknown as ProposedChangeRow[]) || []

        // Who said each trigger quote (issue 11): read only for a verbose page.
        const spokenBy = verbose ? await loadQuoteSpeakers(supabase, rows, userId, captureVisibilityRequester) : null

        const suggestions = rows.map((row) => {
          const compact = {
            id: row.id,
            capture_id: row.capture_id,
            capture_title: row.capture?.title || null,
            change_type: row.change_type,
            entity_type: row.entity_type,
            display_text: row.display_text,
            priority: row.priority,
            due_date: row.due_date,
            assignee_name: row.assignee_name,
            confidence: row.confidence,
            created_at: row.created_at,
          }
          if (!verbose) return compact
          return {
            ...compact,
            entity_id: row.entity_id,
            title: row.title,
            description: row.description,
            assignee_member_id: row.assignee_member_id,
            project_id: row.project_id,
            reasoning: row.reasoning,
            trigger_quote: row.trigger_quote,
            spoken_by: spokenBy?.get(row.id) ?? null,
            stakes: row.stakes,
            open_questions: row.open_questions,
          }
        })

        const total = count ?? suggestions.length

        // Whole-queue roll-up so the agent can see the shape of a large queue
        // (which captures, how many each) without paging through every row.
        // Slim projection keeps the second query cheap; skipped when already
        // scoped to one capture. Degrades gracefully: on error we just omit it.
        let pendingByCapture: Array<{ capture_id: string; capture_title: string | null; pending_count: number }> | null =
          null
        if (!capture_id) {
          const { data: slimData } = await applyEmbeddedCaptureVisibility(
            supabase
              .from('proposed_change')
              .select('capture_id, capture:captures!capture_id!inner(title)')
              .eq('workspace_id', workspaceId)
              .eq('status', 'pending')
              .limit(500),
            captureVisibilityRequester,
            'capture',
          )

          type SlimRow = { capture_id: string; capture: { title: string } | null }
          const slimRows = (slimData as unknown as SlimRow[]) || []
          const byCapture = new Map<string, { capture_id: string; capture_title: string | null; pending_count: number }>()
          for (const row of slimRows) {
            const entry = byCapture.get(row.capture_id) ?? {
              capture_id: row.capture_id,
              capture_title: row.capture?.title || null,
              pending_count: 0,
            }
            entry.pending_count++
            byCapture.set(row.capture_id, entry)
          }
          if (byCapture.size > 0) {
            pendingByCapture = [...byCapture.values()].sort((a, b) => b.pending_count - a.pending_count)
          }
        }

        return {
          success: true,
          suggestions,
          count: suggestions.length,
          total,
          offset: startOffset,
          has_more: startOffset + suggestions.length < total,
          verbose: !!verbose,
          ...(pendingByCapture ? { pending_by_capture: pendingByCapture } : {}),
        }
      },
    }),

    dismiss_proposal: tool({
      description:
        'Dismiss pending AI-proposed changes that are no longer relevant (cancelled task, changed scope, misunderstanding, etc.). ' +
        'Use the ids returned by get_action_suggestions — pass one as proposal_id or several as proposal_ids. ' +
        'Include a reason so the triage rationale is preserved with each dismissed proposal.',
      inputSchema: z.object({
        proposal_id: z.string().optional().describe('UUID of the proposed change to dismiss'),
        proposal_ids: z
          .array(z.string())
          .min(1)
          .max(100)
          .optional()
          .describe('Batch variant: UUIDs of several proposals to dismiss in one call'),
        reason: z
          .string()
          .optional()
          .describe('Why the suggestion is being discarded — persisted on each proposal for later review'),
      }),
      execute: async ({ proposal_id, proposal_ids, reason }) => {
        const ids = [...new Set(proposal_ids?.length ? proposal_ids : proposal_id ? [proposal_id] : [])]
        if (ids.length === 0) return { success: false, error: 'Provide proposal_id or proposal_ids' }

        // Proposals hang off captures the agent may well have read from another
        // workspace, so route by the FIRST id and scope the whole batch there.
        // One resolution, not N: a dismissal batch is one triage pass over one
        // capture's queue, and ids from elsewhere simply fall out as not_found —
        // the shape this tool already returns for an id it cannot see. An id
        // that resolves nowhere leaves the session workspace in place, so the
        // existing not-found path runs unchanged.
        const routed = await resolveEntityWorkspace(supabase, userId, 'proposed_change', ids[0], workspaceId, strictWorkspace)
        const targetWs = routed?.workspaceId ?? workspaceId

        const { data, error } = await supabase
          .from('proposed_change')
          .select('id, display_text, extra')
          .in('id', ids)
          .eq('workspace_id', targetWs)
          .eq('status', 'pending')

        if (error) return { success: false, error: error.message }
        type PendingRow = { id: string; display_text: string; extra: Record<string, unknown> | null }
        const raw = data as unknown as PendingRow[] | PendingRow | null
        const rows: PendingRow[] = Array.isArray(raw) ? raw : raw ? [raw] : []
        if (rows.length === 0) {
          return { success: false, error: 'Proposal not found or already resolved' }
        }

        const failures: Array<{ proposal_id: string; error: string }> = []
        for (const row of rows) {
          // The dismissal reason lives in extra.dismiss_reason — NOT the
          // `reasoning` column, which records why the AI proposed the item in
          // the first place and must survive dismissal for review.
          const { error: updateError } = await supabase
            .from('proposed_change')
            .update({
              status: 'dismissed',
              ...(reason ? { extra: { ...(row.extra ?? {}), dismiss_reason: reason } } : {}),
            })
            .eq('id', row.id)
            .eq('workspace_id', targetWs)
            .eq('status', 'pending')
          if (updateError) failures.push({ proposal_id: row.id, error: updateError.message })
        }

        if (ids.length === 1) {
          if (failures.length > 0) return { success: false, error: failures[0].error }
          return { success: true, message: `Dismissed proposal: "${rows[0].display_text}"` }
        }

        const notFound = ids.filter((id) => !rows.some((r) => r.id === id))
        const dismissedCount = rows.length - failures.length
        return {
          success: failures.length === 0,
          dismissed_count: dismissedCount,
          ...(notFound.length ? { not_found: notFound } : {}),
          ...(failures.length ? { failures } : {}),
          message: `Dismissed ${dismissedCount} of ${ids.length} proposals${
            notFound.length ? ` (${notFound.length} not found or already resolved)` : ''
          }`,
        }
      },
    }),

    accept_proposal: tool({
      description:
        'Accept pending AI-proposed changes and promote them to real actions, decisions, milestones, or ' +
        'project updates — in a single call. Use the `id`s returned by `get_action_suggestions`: pass one as ' +
        '`proposal_id` or several as `proposal_ids`. All stored fields (title, description, assignee, priority, ' +
        'project, due date, provenance, etc.) are applied server-side; you do not need to re-marshal them. ' +
        "Created actions land in the team's Backlog state by default — pass `status` to place them elsewhere. " +
        'This replaces the two-step `create_action` + `dismiss_proposal` workaround — it preserves ' +
        'the link back to the source capture and works for all entity types.',
      inputSchema: z.object({
        proposal_id: z
          .string()
          .optional()
          .describe('UUID of the pending proposed change (from get_action_suggestions)'),
        proposal_ids: z
          .array(z.string())
          .min(1)
          .max(50)
          .optional()
          .describe('Batch variant: UUIDs of several pending proposals to accept in one call'),
        status: z
          .string()
          .optional()
          .describe(
            'Workflow state NAME to place a created action in (e.g. "Todo", "In Progress"), matched ' +
              "case-insensitively within the action's team. Defaults to the team's Backlog state. " +
              'For an update proposal this is the status the action moves to.',
          ),
        target_action_id: z
          .string()
          .optional()
          .describe(
            'For an update:action proposal whose target could not be resolved: UUID of the action the ' +
              'update should apply to. Only valid with a single proposal.',
          ),
      }),
      execute: async ({ proposal_id, proposal_ids, status, target_action_id }) => {
        const ids = [...new Set(proposal_ids?.length ? proposal_ids : proposal_id ? [proposal_id] : [])]
        if (ids.length === 0) return { success: false, error: 'Provide proposal_id or proposal_ids' }
        if (target_action_id && ids.length > 1) {
          return { success: false, error: 'target_action_id can only be used with a single proposal' }
        }
        // An approval card (A5: a held tool call) is the person's alone. It
        // never carries a proposal (migration 335's check), so none of these
        // ids can reach one; an id that IS an approval card is refused by name.
        {
          const { data: approvals } = await supabase
            .from('attention_item')
            .select('id')
            .eq('kind', 'approval')
            .in('id', ids)
            .limit(1)
          if (approvals?.length) {
            return { success: false, code: 'APPROVAL_PERSON_ONLY', error: "That is an approval card: only the person can approve or decline it, on the card itself. Tell them it is waiting." }
          }
        }

        const acceptOne = async (id: string) => {
          // 0. WHICH workspace does this proposal live in? Accepting WRITES —
          //    it creates the action / decision / milestone — so every id below
          //    (the member row, the apply engine's workspace) has to come from
          //    the proposal's own workspace, not the session's. Resolved per id
          //    because each accept is its own independent write. A resolution
          //    that comes back empty (absent, not a member, fenced run, or a
          //    transient read error) leaves the session workspace in place so
          //    the fetch below still reports what actually went wrong.
          const routed = await resolveEntityWorkspace(supabase, userId, 'proposed_change', id, workspaceId, strictWorkspace)
          const targetWs = routed?.workspaceId ?? workspaceId

          // 1. Fetch and validate the proposal — scoped to its own workspace
          const { data: rawChange, error: fetchError } = await supabase
            .from('proposed_change')
            .select('*')
            .eq('id', id)
            .eq('workspace_id', targetWs)
            .single()

          // PGRST116 is `.single()` finding no row — that is this tool's
          // not-found, not a database failure, and it falls through to the
          // message below. Anything else is a real error and says so.
          if (fetchError && fetchError.code !== 'PGRST116') {
            return { success: false, error: fetchError.message }
          }
          if (!rawChange) {
            return {
              success: false,
              error: 'Proposal not found. Use get_action_suggestions to list pending proposals.',
            }
          }

          const change = rawChange as unknown as ProposedChange

          if (change.status !== 'pending') {
            return {
              success: false,
              error: `Proposal is already ${change.status}. Only pending proposals can be accepted.`,
            }
          }

          // A proposal that runs a connected app's tool (mcp_call) is the
          // person's alone to apply (src/lib/safety/person-only-proposals.ts):
          // never from here, in a chat, a loop or a flow run.
          if (proposalNeedsPerson(change)) {
            return { success: false, code: 'PROPOSAL_PERSON_ONLY', error: PROPOSAL_PERSON_ONLY_NOTE }
          }

          // 2. Resolve the caller's member record IN THE PROPOSAL'S WORKSPACE
          //    (required by the apply engine). `member.id` is workspace-scoped:
          //    the session workspace's row would be a cross-tenant applied_by
          //    and assignee on everything the engine writes.
          const { data: member, error: memberError } = await supabase
            .from('member')
            .select('id')
            .eq('user_id', userId)
            .eq('workspace_id', targetWs)
            .single()

          if (memberError || !member) {
            return { success: false, error: 'Not a member of this workspace' }
          }

          // 3. Apply the proposal server-side (same engine the UI "Apply" button
          //    uses), with the caller's overrides threaded through the change:
          //    `status` → status_to (workflow state for created/updated actions),
          //    `target_action_id` → entity_id (the update's unresolved target).
          const effective: ProposedChange = {
            ...change,
            ...(status ? { status_to: status } : {}),
            ...(target_action_id ? { entity_id: target_action_id } : {}),
          }
          // Claim, then apply (claim-apply.ts): a concurrent accept of the same
          // proposal (a click, another run) can't apply it a second time. An
          // unattended caller (a skill/work run) passes its origin so the apply
          // engine's status emit carries it (loop guard, A3).
          const outcome = await claimAndApplyChange(supabase, effective, {
            workspaceId: targetWs,
            memberId: member.id,
            userId,
            ...(origin ? { origin } : {}),
          })

          if (!outcome.ok && outcome.reason === 'not_pending') {
            return {
              success: false,
              error: 'Proposal was accepted or dismissed by someone else just now.',
              code: 'not_pending',
            }
          }
          if (!outcome.ok) {
            // The claim was handed back with the error on the row, so it's
            // visible in the Native Intelligence UI.
            return {
              success: false,
              error: outcome.error,
              ...(outcome.code ? { code: outcome.code } : {}),
            }
          }
          const result = { entity_id: outcome.entity_id ?? undefined }

          // 5. For actions, look up the human-readable identifier (e.g. GEN-34)
          //    so the agent can reference it in follow-up messages.
          let identifier: string | null = null
          let entityTitle: string | null = null
          if (result.entity_id && change.entity_type === 'action') {
            const { data: actionRow } = await supabase
              .from('actions')
              .select('id, identifier, title')
              .eq('id', result.entity_id)
              .eq('workspace_id', targetWs)
              .single()
            if (actionRow) {
              const row = actionRow as unknown as { id: string; identifier: string; title: string }
              identifier = row.identifier
              entityTitle = row.title
            }
          }

          const verb = change.change_type === 'create' ? 'created' : 'applied to'
          const message = identifier
            ? `Accepted proposal: ${verb} ${identifier} "${entityTitle}"`
            : `Accepted proposal: created ${change.entity_type}${result.entity_id ? ` (${result.entity_id})` : ''}`

          return {
            success: true,
            entity_id: result.entity_id,
            entity_type: change.entity_type,
            ...(identifier ? { identifier } : {}),
            ...(entityTitle ? { title: entityTitle } : {}),
            message,
            // An accept CREATES a row, so it echoes where it landed for the same
            // reason the create tools do (workspaceEcho in ./_shared.ts).
            ...workspaceEcho(targetWs),
          }
        }

        // The promotion guard: an unattended run never accepts a proposal it
        // filed itself; the person does.
        const own = await filedByThisRun(rules, ids)
        const refusedOwn = (id: string) => own.has(id.toLowerCase())
        const leave = { success: false as const, code: 'LEAVE_FOR_PERSON', error: LEAVE_FOR_PERSON }

        // Single id keeps the flat result shape; a batch returns per-proposal results.
        if (ids.length === 1) return refusedOwn(ids[0]) ? leave : acceptOne(ids[0])

        const results: Array<{ proposal_id: string; success: boolean } & Record<string, unknown>> = []
        for (const id of ids) {
          results.push({ proposal_id: id, ...(refusedOwn(id) ? leave : await acceptOne(id)) })
        }
        const accepted = results.filter((r) => r.success).length
        return {
          success: accepted === results.length,
          accepted_count: accepted,
          failed_count: results.length - accepted,
          results,
          message: `Accepted ${accepted} of ${results.length} proposals`,
        }
      },
    }),

    get_action: tool({
      description:
        'Get a single action by id, identifier (e.g. ENG-42), or title match. Returns the full action ' +
        'including description, labels, status, project, milestone, cycle, and timestamps. ' +
        'Title match is case-insensitive substring; if it matches more than one action, returns the candidates ' +
        'so the caller can disambiguate. Resolves cross-workspace when the user is a member of the action\'s ' +
        'workspace — every result carries `workspace_id`. Use this when you need details about a specific action before updating it.',
      inputSchema: z.object({
        action_id: z.string().optional().describe('UUID of the action'),
        identifier: z.string().optional().describe('Action identifier like ENG-42'),
        title_match: z
          .string()
          .optional()
          .describe('Case-insensitive substring of the title. Returns candidates if ambiguous.'),
      }),
      execute: async ({ action_id, identifier, title_match }) => {
        if (!action_id && !identifier && !title_match) {
          return {
            success: false,
            error: 'Must supply action_id, identifier, or title_match',
          }
        }

        // An id copied out of another workspace's UI has to READ as easily as it
        // WRITES (update_action already resolves it), so route the id path through
        // resolveEntityWorkspace and scope the query to whatever it returns. The
        // identifier / title_match paths stay on the active workspace here — the
        // write tools own the cross-workspace identifier fan-out.
        let scopedWorkspaceId = workspaceId
        let crossWorkspace = false
        if (action_id) {
          const resolved = await resolveEntityWorkspace(
            supabase,
            userId,
            'actions',
            action_id,
            workspaceId,
            strictWorkspace,
          )
          if (!resolved) return { success: false, error: 'Action not found' }
          scopedWorkspaceId = resolved.workspaceId
          crossWorkspace = resolved.crossWorkspace
        }

        // Build the base query with the workspace scope already applied. Not
        // creator-scoped: any member may read any action in the workspace.
        let q = supabase
          .from('actions')
          .select(`${ACTION_SELECT}, description, updated_at, source_capture_id, source_type, custom_fields`)
          .eq('workspace_id', scopedWorkspaceId)

        if (action_id) q = q.eq('id', action_id)
        else if (identifier) q = q.eq('identifier', identifier)
        else if (title_match) q = q.ilike('title', `%${title_match}%`)

        // For id / identifier we expect a single row; for title_match we want
        // up to a few candidates so we can return them on ambiguity.
        if (title_match) q = q.limit(5)

        const { data, error } = await q
        if (error) return { success: false, error: error.message }
        if (!data || data.length === 0) {
          return { success: false, error: 'Action not found' }
        }

        if (data.length > 1) {
          // Ambiguous title match — return the candidate set so the caller can
          // pick one rather than silently choosing the first.
          return {
            success: false,
            error: `Ambiguous title_match — matched ${data.length} actions. Pass action_id or identifier to disambiguate.`,
            candidates: data.map((a) => {
              const flat = flattenAction(a as unknown as Record<string, unknown>)
              return {
                id: flat.id,
                identifier: flat.identifier,
                title: flat.title,
                status: flat.status,
                project_name: flat.project_name,
              }
            }),
          }
        }

        const row = data[0] as Record<string, unknown>
        const flat = flattenAction(row)
        // The workspace's own fields on tasks (migration 496), the set ones, by name.
        const fieldDefs = await customFieldDefsOrNone(supabase, scopedWorkspaceId, 'action')
        return {
          success: true,
          action: {
            ...flat,
            description: row.description ?? null,
            updated_at: row.updated_at ?? null,
            source_capture_id: row.source_capture_id ?? null,
            source_type: row.source_type ?? null,
            confirmation: row.confirmation ?? null,
            created_at: row.created_at ?? null,
            ...withCustomFields(fieldDefs, row.custom_fields),
          },
          // Deliberately NOT get_document's "call ni_set_workspace" advice: an
          // agent that switches the session here would silently re-scope every
          // later call. The action's workspace travels on the row instead.
          ...(crossWorkspace
            ? {
                workspace_hint: `This action lives in workspace ${scopedWorkspaceId}, not the currently active one. Pass this workspace_id explicitly if you act on it.`,
              }
            : {}),
        }
      },
    }),

    list_workflow_states: tool({
      description:
        'List workflow states (the columns of a team\'s board, e.g. Backlog → Todo → In Progress → Done) ' +
        'for the current workspace. Workflow states are per-team and customizable. Use this before ' +
        'create_action / update_action / create_actions_batch when you need to know the valid `status_id` / ' +
        '`status_name` values for a team. If you pass `team_id`, results are filtered to that team only.',
      inputSchema: z.object({
        team_id: z
          .string()
          .optional()
          .describe('UUID of a specific team to filter to. If omitted, returns states for all teams in the workspace.'),
      }),
      execute: async ({ team_id }) => {
        // Resolve the set of team IDs to query. We scope to teams in the
        // current workspace even when a team_id is passed — RLS would catch a
        // cross-workspace team but explicit scoping makes the failure mode a
        // friendly "team not in workspace" rather than an empty result.
        const { data: teams, error: teamErr } = await supabase
          .from('team')
          .select('id, name, issue_prefix')
          .eq('workspace_id', workspaceId)
        if (teamErr) return { success: false, error: teamErr.message }

        const allTeams = teams || []
        const scoped = team_id ? allTeams.filter((t) => t.id === team_id) : allTeams
        if (team_id && !scoped.length) {
          return { success: false, error: 'team_id is not part of the current workspace' }
        }

        const teamIds = scoped.map((t) => t.id)
        if (!teamIds.length) {
          return { success: true, states: [], count: 0 }
        }

        const { data, error } = await supabase
          .from('workflow_state')
          .select('id, name, category, color, sort_order, is_default, team_id')
          .in('team_id', teamIds)
          .order('team_id', { ascending: true })
          .order('sort_order', { ascending: true })

        if (error) return { success: false, error: error.message }

        const teamById = new Map(scoped.map((t) => [t.id, t]))
        const states = (data || []).map((s) => {
          const team = teamById.get(s.team_id)
          return {
            id: s.id,
            name: s.name,
            category: s.category,
            color: s.color,
            sort_order: s.sort_order,
            is_default: s.is_default,
            team_id: s.team_id,
            team_name: team?.name ?? null,
            team_issue_prefix: team?.issue_prefix ?? null,
          }
        })

        return { success: true, states, count: states.length }
      },
    }),

    list_labels: tool({
      description:
        'List available labels in the workspace. Use this to find label IDs before attaching labels to actions. Optionally filter by scope. Labels with null scopes are universal (appear on all entity types); labels with a scopes array are restricted to those entity types only.',
      inputSchema: z.object({
        scope: z
          .enum(['action', 'email_thread', 'project', 'initiative', 'capture'])
          .optional()
          .describe('Filter labels by scope. Default returns all labels.'),
      }),
      execute: async ({ scope }) => {
        let query = supabase
          .from('label')
          .select('id, name, color, group_name, scopes')
          .eq('workspace_id', workspaceId)

        // Filter by scope: return labels that are universal (scopes IS NULL) or include the requested scope
        if (scope) {
          query = query.or(`scopes.is.null,scopes.cs.{${scope}}`)
        }

        const { data, error } = await query
          .order('group_name', { ascending: true, nullsFirst: false })
          .order('name', { ascending: true })

        if (error) return { success: false, error: error.message }
        return { success: true, labels: data || [], count: (data || []).length }
      },
    }),

    create_label: tool({
      description:
        'Create a new workspace label. Labels are scoped to entity types (action, email_thread, project, initiative, capture) — a label with scopes: ["action"] cannot be attached to a project and vice versa. Omit scopes to create a universal label visible on all entity types. Use group_name to organise related labels (e.g. "Team", "Status"). Call list_labels first to avoid creating duplicates.',
      inputSchema: z.object({
        workspace_id: createWorkspaceParam,
        name: z.string().describe('Label name (must be unique within the workspace)'),
        color: z
          .string()
          .optional()
          .describe('Hex color code, e.g. "#ef4444". Defaults to grey (#6b7280) if omitted.'),
        scopes: z
          .array(z.enum(['action', 'email_thread', 'project', 'initiative', 'capture']))
          .optional()
          .describe(
            'Entity types this label may be attached to. Omit or pass an empty array for a universal label. A label created with only ["action"] scope cannot be attached to a project.',
          ),
        group_name: z
          .string()
          .optional()
          .describe('Label group for organisation (e.g. "Team", "Status"). Omit to leave ungrouped.'),
      }),
      execute: async ({ workspace_id, name, color, scopes, group_name }) => {
        // A label is a ROOT create — nothing about it names a workspace — so it
        // routes exactly like create_action. Labels are also uniquely easy to
        // mis-file: the name collides only WITHIN a workspace, so a duplicate
        // lands silently in the wrong tenant instead of erroring.
        const ws = await resolveCreateWorkspace(supabase, userId, workspaceId, workspace_id, {
          strictWorkspace,
          policy: createWorkspacePolicy,
        })
        if (!ws.ok) return ws.error
        const targetWs = ws.workspaceId

        const { data, error } = await supabase
          .from('label')
          .insert({
            workspace_id: targetWs,
            name: name.trim(),
            color: color || '#6b7280',
            group_name: group_name || null,
            scopes: scopes && scopes.length > 0 ? scopes : null,
          })
          .select('id, name, color, group_name, scopes')
          .single()

        if (error) {
          if (error.code === '23505')
            return { success: false, error: 'A label with that name already exists in this workspace' }
          return { success: false, error: error.message }
        }
        return { success: true, label: data, ...workspaceEcho(targetWs, ws.workspaceName) }
      },
    }),

    update_label: tool({
      description:
        'Update an existing label — rename, recolor, change scopes, or move to a different group. Use list_labels to get the label_id. Only the fields you pass will be changed. To clear scopes (make the label universal), pass scopes: []. To remove a label from its group, pass group_name: null.',
      inputSchema: z.object({
        label_id: z.string().describe('UUID of the label to update (from list_labels)'),
        name: z.string().optional().describe('New label name'),
        color: z.string().optional().describe('New hex color code, e.g. "#3b82f6"'),
        scopes: z
          .array(z.enum(['action', 'email_thread', 'project', 'initiative', 'capture']))
          .optional()
          .describe(
            'New set of entity-type scopes. Pass an empty array [] to make the label universal. Omit to leave scopes unchanged.',
          ),
        group_name: z
          .string()
          .nullable()
          .optional()
          .describe('New group name, or null to remove from any group'),
      }),
      execute: async ({ label_id, name, color, scopes, group_name }) => {
        // Follow the label to whichever workspace holds it, exactly as the
        // id-based action tools follow an action. An id that resolves nowhere
        // reachable falls back to the session workspace so the update below
        // matches no row and returns the tool's own not-found message —
        // identical to today, and it never says WHERE the id lives.
        const resolved = await resolveEntityWorkspace(supabase, userId, 'label', label_id, workspaceId, strictWorkspace)
        const targetWs = resolved?.workspaceId ?? workspaceId

        const updates: Record<string, unknown> = {}
        if (name !== undefined) updates.name = name.trim()
        if (color !== undefined) updates.color = color
        if (group_name !== undefined) updates.group_name = group_name
        if (scopes !== undefined) updates.scopes = scopes.length > 0 ? scopes : null

        if (Object.keys(updates).length === 0)
          return { success: false, error: 'No fields to update — pass at least one of: name, color, scopes, group_name' }

        const { data, error } = await supabase
          .from('label')
          .update(updates)
          .eq('id', label_id)
          .eq('workspace_id', targetWs)
          .select('id, name, color, group_name, scopes')
          .single()

        if (error) {
          if (error.code === '23505')
            return { success: false, error: 'A label with that name already exists in this workspace' }
          if (error.code === 'PGRST116')
            return { success: false, error: 'Label not found or does not belong to this workspace' }
          return { success: false, error: error.message }
        }
        if (!data) return { success: false, error: 'Label not found or does not belong to this workspace' }
        return { success: true, label: data }
      },
    }),

    delete_label: tool({
      description:
        'Delete a label from the workspace. This permanently removes the label and detaches it from all entities (actions, projects, captures, etc.). Use list_labels to find the label_id. This action is irreversible.',
      inputSchema: z.object({
        label_id: z.string().describe('UUID of the label to delete (from list_labels)'),
      }),
      execute: async ({ label_id }) => {
        // Same resolve-then-scope as update_label. The fallback matters more
        // here: an unreachable id has always produced a no-op delete reported as
        // success, and turning that into an error now would tell a caller that
        // the id exists somewhere it cannot reach.
        const resolved = await resolveEntityWorkspace(supabase, userId, 'label', label_id, workspaceId, strictWorkspace)
        const targetWs = resolved?.workspaceId ?? workspaceId

        const { error } = await supabase
          .from('label')
          .delete()
          .eq('id', label_id)
          .eq('workspace_id', targetWs)

        if (error) return { success: false, error: error.message }
        return { success: true, message: `Label deleted` }
      },
    }),

    list_workspace_members: tool({
      description: 'List all workspace members with their IDs and display names. Use this to resolve a person\'s name to their member UUID before assigning actions.',
      inputSchema: z.object({}),
      execute: async () => {
        const { data, error } = await supabase
          .from('member')
          .select('id, user_id, display_name, role')
          .eq('workspace_id', workspaceId)

        if (error) return { success: false, error: error.message }
        // Surface `display_label` alongside the raw `display_name` so an
        // agent that hits a member with an empty name has something usable
        // in its output. Falls back to user_id → member id → "(unnamed)".
        const members = (data || []).map((m) => ({
          ...m,
          display_label: displayName(m.display_name, m.user_id, m.id),
        }))
        return { success: true, members, count: members.length }
      },
    }),

    reorder_actions: tool({
      description: 'Reorder actions. Pass ALL action IDs in the desired new order.',
      inputSchema: z.object({
        action_ids: z
          .array(z.string())
          .describe('Ordered array of action IDs in the desired new order'),
      }),
      execute: async ({ action_ids }) => {
        // A reorder is ONE ordering over ONE board, so it routes by the first id
        // and then insists the rest agree. Resolving each id independently would
        // let a mixed list half-succeed: sort_order is meaningless across
        // workspaces, and the half that moved would be silently wrong.
        const routed = action_ids.length
          ? await resolveEntityWorkspace(supabase, userId, 'actions', action_ids[0], workspaceId, strictWorkspace)
          : null
        const targetWs = routed?.workspaceId ?? workspaceId

        // The disagreement probe is skipped under strictWorkspace: for a fenced
        // run an action in another workspace must read as ABSENT (the same
        // zero-row failure below a nonexistent id gets), and a 'different workspaces' error would confirm it
        // exists. Skipped for a single id too — resolveEntityWorkspace above
        // already membership-checked it, and one id cannot disagree with itself.
        if (!strictWorkspace && action_ids.length > 1) {
          const { data: spread } = await supabase
            .from('actions')
            .select('id, workspace_id')
            .in('id', action_ids)
          if ((spread || []).some((r) => (r as { workspace_id?: string }).workspace_id !== targetWs)) {
            // Names neither the id nor the other workspace — the caller has to
            // re-issue one list per board, which is the only coherent request.
            return { success: false, error: 'Actions are in different workspaces' }
          }
        }

        const updates = action_ids.map((id, index) =>
          supabase
            .from('actions')
            .update({ sort_order: index })
            .eq('id', id)
            .eq('workspace_id', targetWs)
            .select('id'),
        )

        const results = await Promise.all(updates)
        // An update that matched no row (an id not in this workspace, or one
        // RLS filtered out) is a failure too, not a silent skip.
        const errors = results.filter((r) => r.error || !r.data || r.data.length === 0)

        if (errors.length > 0)
          return { success: false, error: `Failed to reorder ${errors.length} actions` }

        return { success: true, message: `Reordered ${action_ids.length} actions` }
      },
    }),

    create_actions_batch: tool({
      description:
        'Create multiple actions at once. Use this when extracting several action items from a meeting, conversation, or planning session. ' +
        'The whole batch lands in one workspace — pass workspace_id to choose it, copied from the workspace_id on rows you read.',
      inputSchema: z.object({
        workspace_id: createWorkspaceParam,
        actions: z
          .array(
            z.object({
              title: z.string().describe('Title of the action'),
              description: z.string().optional().describe('Additional notes'),
              due_date: z.string().optional().describe('Due date in ISO 8601 format'),
              priority: z.enum(PRIORITY_VALUES).optional().describe('Priority level'),
              assignee_id: z.string().optional().describe('UUID of the member to assign to'),
              assignee_name: z.string().optional().describe('Name of assignee — resolved to member UUID'),
              delegate: z.string().optional().describe(DELEGATE_PARAM_HELP),
              confirmation: z
                .enum(['confirmed', 'suggested'])
                .optional()
                .describe("Confirmation status. Work running with nobody watching always files 'suggested'."),
              source_type: z.string().optional().describe('Source type'),
              label_ids: z.array(z.string()).optional().describe('Label IDs to attach'),
              status_id: z
                .string()
                .optional()
                .describe('UUID of the workflow state to start this action in. Defaults to the team\'s default.'),
              status_name: z
                .string()
                .optional()
                .describe('Name of the workflow state (e.g. "In Progress"). Defaults to the team\'s default.'),
            }),
          )
          .describe('Array of actions to create'),
      }),
      execute: async ({ workspace_id, actions }) => {
        if (!actions.length) return { success: false, error: 'No actions provided' }

        // One resolution for the whole batch — a batch is one intent, and
        // splitting it across tenants row-by-row is never what was meant.
        const ws = await resolveCreateWorkspace(supabase, userId, workspaceId, workspace_id, {
          strictWorkspace,
          policy: createWorkspacePolicy,
        })
        if (!ws.ok) return ws.error
        const targetWs = ws.workspaceId

        const teamId = await getDefaultTeamId(supabase, targetWs)
        if (!teamId) return { success: false, error: noTeamError(targetWs) }

        const defaultStatusId = await getDefaultStateId(supabase, teamId)
        if (!defaultStatusId) return { success: false, error: 'No default workflow state for team' }

        const created: Array<{ id: string; identifier: string; title: string }> = []
        const failed: Array<{ title: string; error: string }> = []
        // The caller's member row in targetWs, read once for the first delegated row with no person.
        let delegatorMemberId: string | null | undefined

        for (const action of actions) {
          // Resolve assignee_name to assignee_id if name provided but no ID —
          // in `targetWs`, the workspace whose member table this row's
          // assignee_id has to come from.
          let resolvedAssigneeId = action.assignee_id || null
          if (!resolvedAssigneeId && action.assignee_name) {
            resolvedAssigneeId = await resolveMemberByName(supabase, targetWs, action.assignee_name)
          }

          // The delegate (decision 9): checked like create_action's; a bad
          // one fails this row only. The person stays responsible.
          let delegateId: string | null = null
          if (action.delegate !== undefined && action.delegate.trim()) {
            const found = await resolveDelegate(supabase, { userId, workspaceId: targetWs, ref: action.delegate })
            if (!found.ok) {
              failed.push({ title: action.title, error: found.error })
              continue
            }
            delegateId = found.id
            if (!resolvedAssigneeId) {
              delegatorMemberId ??= await memberIdForUser(supabase, userId, targetWs)
              resolvedAssigneeId = delegatorMemberId
            }
          }

          // Same routed-create rule as create_action: label ids supplied on a
          // batch routed out of the session workspace are re-checked there.
          if (ws.crossWorkspace && action.label_ids?.length) {
            const refError = await refsOutsideWorkspace(supabase, targetWs, {
              label_ids: action.label_ids,
            })
            if (refError) {
              failed.push({ title: action.title, error: refError })
              continue
            }
          }

          // Resolve per-action status if provided, else use team default
          let resolvedStatusId: string = defaultStatusId
          if (action.status_id !== undefined || action.status_name !== undefined) {
            const resolved = await resolveStatusForTeam(supabase, teamId, {
              status_id: action.status_id,
              status_name: action.status_name,
            })
            if (!resolved.ok) {
              failed.push({ title: action.title, error: resolved.error })
              continue
            }
            resolvedStatusId = resolved.id
          }

          const insertData: Record<string, unknown> = {
            user_id: userId,
            workspace_id: targetWs,
            team_id: teamId,
            title: action.title,
            description: action.description || null,
            due_at: dueAtFromDate(action.due_date) || null,
            all_day: action.due_date ? false : true,
            priority: action.priority || 'none',
            status_id: resolvedStatusId,
            // The promotion guard: nobody watching → a suggestion a person confirms.
            confirmation: rules.fileActionsAsSuggested ? 'suggested' : action.confirmation || 'confirmed',
            source_type: action.source_type || null,
          }
          if (resolvedAssigneeId) insertData.assignee_id = resolvedAssigneeId
          if (delegateId) insertData.assignee_ai_member_id = delegateId

          const { data, error } = await supabase
            .from('actions')
            .insert(insertData)
            .select('id, identifier, title')
            .single()

          if (error) {
            failed.push({ title: action.title, error: error.message })
          } else {
            // Sync action_assignee join table
            if (resolvedAssigneeId) {
              await supabase.from('action_assignee').insert({ action_id: data.id, member_id: resolvedAssigneeId })
            }
            // Attach labels if provided
            if (action.label_ids && action.label_ids.length > 0) {
              await supabase.from('action_label').insert(
                action.label_ids.map((lid) => ({ action_id: data.id, label_id: lid })),
              )
            }
            created.push({ id: data.id, identifier: data.identifier, title: data.title })

            // GEN-112 (creation case): fire the status-change Flow trigger ONLY
            // when the action was explicitly placed into a non-default state
            // (e.g. created straight into "Todo"). Treat creation as a null →
            // state transition. We deliberately do NOT fire for actions that
            // land in the team default — every create would otherwise trip
            // automations, which is noisy and surprising. The reference flow
            // ("from_status_id=null, to_status_id=Todo") is exactly this case.
            if (resolvedStatusId !== defaultStatusId) {
              emitStatusChange({
                entityType: 'action',
                entityId: data.id,
                workspaceId: targetWs,
                teamId,
                fromStatusId: null,
                toStatusId: resolvedStatusId,
                actorUserId: userId,
              origin,
              })
            }
          }
        }

        return {
          success: failed.length === 0,
          created,
          failed: failed.length > 0 ? failed : undefined,
          message:
            `Created ${created.length}/${actions.length} actions` +
            (rules.fileActionsAsSuggested && created.length > 0 ? ' as suggestions for the person to confirm' : ''),
          ...workspaceEcho(targetWs, ws.workspaceName),
        }
      },
    }),
  }
}
