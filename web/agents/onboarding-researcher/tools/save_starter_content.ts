/**
 * save_starter_content — seed a brand-new workspace with ONE starter project, a
 * handful (1-4) of starter actions linked to it, and an optional workspace
 * rename, so the user lands on a board that already reflects what they told the
 * researcher they're working on (role + focus) instead of an empty shell.
 *
 * Owner-derivation: workspace_id + user_id come ONLY from the verified session
 * principal (requireOwner). The schema carries NO tenant/user fields — the model
 * describes WHAT to seed (project name, actions, optional rename), never WHERE.
 * This mirrors save_company_profile / save_research_claims.
 *
 * Field population mirrors the app's create_action path (src/lib/ai/tools/
 * actions.ts): default team = the workspace's first team by created_at; default
 * workflow state = that team's `is_default` state; the `identifier` (e.g. GEN-3)
 * is left to the `action_generate_identifier` BEFORE-INSERT trigger (migration
 * 022). NOT-NULL columns without a DB default are populated explicitly:
 *   actions  → user_id, title, workspace_id, team_id, status_id
 *   projects → user_id, name, workspace_id
 * (confirmation/priority/status/health/sort_order/auto_accepted/agent_run_status
 * all carry DB defaults and are left alone.)
 *
 * SEEDED MARKER: seeded actions carry `context_data.seeded_by = 'onboarding'`.
 * The `actions` table has no `metadata` column; `context_data` (jsonb) is the
 * table's own tag column and is ALREADY the app's convention for marking
 * onboarding rows — the retired demo capture used the same pattern, tagging its
 * actions `context_data.demo = true`. Reviewers can identify seeded actions by
 * that jsonb key. The `projects` table has no jsonb tag column, so the starter
 * project is identified instead by its DETERMINISTIC id (see lib/seed-id.ts).
 *
 * IDEMPOTENT under replay AND re-run — and SELF-HEALING under partial failure:
 * project and action ids are pure functions of the workspace
 * (see lib/seed-id.ts) and every write is an upsert with ignoreDuplicates, so a
 * replay or re-run lands on the same rows and no-ops, while a re-run after a
 * partial first call (project written, actions failed) fills in the missing
 * rows instead of freezing the workspace at zero actions. Existing row content
 * always wins over a re-run's differing input.
 *
 * CAPS enforced server-side regardless of model input: exactly 1 project, at most
 * 4 actions (extras past 4 are dropped, not errored), and string-length clamps.
 */
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { requireOwner, serviceClient, NoOwnerError } from '../lib/tool-context.js'
import {
  deriveStarterProjectId,
  deriveStarterActionId,
  MAX_STARTER_ACTIONS,
} from '../lib/seed-id.js'

// Server-side length caps. The contract fixes workspaceRename at 80; the rest are
// sane ceilings so a runaway model can't write megabytes into a starter row.
// The action cap lives in seed-id.ts — it bounds the deterministic id space that
// finish_research enumerates to rebuild the seeded summary from the DB.
const MAX_ACTIONS = MAX_STARTER_ACTIONS
const PROJECT_NAME_CAP = 120
const PROJECT_DESC_CAP = 2000
const ACTION_TITLE_CAP = 200
const ACTION_DESC_CAP = 2000
const WORKSPACE_NAME_CAP = 80

const starterActionSchema = z.object({
  title: z.string().min(1).describe('A short, imperative starter task title.'),
  description: z
    .string()
    .optional()
    .describe('Optional one-line detail for the task.'),
})

export default defineTool({
  description:
    'Seed the brand-new workspace with a starter project and 1-4 starter ' +
    'actions so the board is not empty. Call this EXACTLY ONCE per run, AFTER ' +
    'your research/decision and BEFORE finish_research. Name the project for ' +
    "what the user told you they're working on (their focus), or a sensible " +
    'default from their company/role when focus is empty. Make the actions the ' +
    'first real steps for this person — reframe the onboarding asks (connect ' +
    'calendar, record first meeting, invite a teammate) in language that fits ' +
    'their role. On a business-email run you may pass workspaceRename with the ' +
    'company name. Never invent a project for a personal-email user with no ' +
    'stated focus — skip seeding entirely instead. Safe to call again: a repeat ' +
    'call upserts into the same deterministic rows (fills in anything a failed ' +
    'earlier call missed, never duplicates).',
  inputSchema: z.object({
    projectName: z
      .string()
      .min(1)
      .describe("Name of the starter project — what the user is working on."),
    projectDescription: z
      .string()
      .optional()
      .describe('Optional short description of the project.'),
    actions: z
      .array(starterActionSchema)
      .min(1)
      .max(MAX_ACTIONS)
      .describe('1-4 starter actions. Personalize by the user\'s role/focus.'),
    workspaceRename: z
      .string()
      .optional()
      .describe(
        "Optional new workspace name (business-email runs only — the company " +
        'name). Omit for personal-email runs.'
      ),
  }),
  async execute(input, ctx) {
    let owner
    try {
      owner = requireOwner(ctx)
    } catch (err) {
      if (err instanceof NoOwnerError) {
        return { success: false, error: err.message }
      }
      throw err
    }
    const { userId, workspaceId } = owner
    const supabase = serviceClient()

    // Defense-in-depth for the workspace rename: the kickoff route already gates
    // the whole run on the caller being the workspace OWNER, but this tool writes
    // service-role (RLS-bypassed), so it independently confirms the derived
    // principal is the OWNER of the workspace before renaming — mirroring the
    // owner-only "Owners can update workspace" RLS policy (migration 013) that a
    // service-role UPDATE would otherwise bypass. A non-owner still gets the
    // project + starter actions (those aren't owner-gated), just never a rename.
    const isOwner = await isWorkspaceOwner(supabase, workspaceId, userId)

    // ── Clamp inputs server-side (the model's caps are advisory; these are law) ──
    const projectName = input.projectName.trim().slice(0, PROJECT_NAME_CAP)
    if (!projectName) return { success: false, error: 'projectName is empty after trimming.' }
    const projectDescription = input.projectDescription?.trim().slice(0, PROJECT_DESC_CAP) || null
    // Hard cap at MAX_ACTIONS regardless of what the model sent, and drop any
    // that are empty after trimming their title.
    const actions = input.actions
      .slice(0, MAX_ACTIONS)
      .map((a) => ({
        title: a.title.trim().slice(0, ACTION_TITLE_CAP),
        description: a.description?.trim().slice(0, ACTION_DESC_CAP) || null,
      }))
      .filter((a) => a.title.length > 0)
    if (actions.length === 0) {
      return { success: false, error: 'No starter actions with a non-empty title.' }
    }

    const projectId = deriveStarterProjectId(workspaceId)

    // No early "already seeded" short-circuit: every write below is replay-safe
    // on its own (deterministic ids + ignoreDuplicates), so falling through
    // SELF-HEALS a partial seed — a first call whose action inserts failed (or
    // a crash between writes) gets its actions on the retry instead of being
    // frozen at zero forever. A true replay upserts into the same ids and
    // no-ops. The first run's row content always wins (ignoreDuplicates).

    // ── Resolve default team + default workflow state (mirrors create_action). ──
    const { data: team, error: teamErr } = await supabase
      .from('team')
      .select('id')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle<{ id: string }>()
    if (teamErr) return { success: false, error: `team lookup failed: ${teamErr.message}` }
    if (!team) {
      // Every workspace is created with a default team by trigger; an empty
      // result means the session is scoped wrong, not that the user must make one.
      return {
        success: false,
        error: `No team resolved for workspace ${workspaceId}; cannot seed starter content.`,
      }
    }

    const { data: state, error: stateErr } = await supabase
      .from('workflow_state')
      .select('id')
      .eq('team_id', team.id)
      .eq('is_default', true)
      .maybeSingle<{ id: string }>()
    if (stateErr) return { success: false, error: `workflow state lookup failed: ${stateErr.message}` }
    if (!state) {
      return { success: false, error: `No default workflow state for team ${team.id}.` }
    }

    // ── Insert the starter project (deterministic id → replay-safe). ──
    // upsert on the primary key with ignoreDuplicates: a step that crashed after
    // this write but before checkpointing re-runs into the same id and no-ops.
    const { error: projErr } = await supabase.from('projects').upsert(
      {
        id: projectId,
        workspace_id: workspaceId,
        user_id: userId,
        name: projectName,
        description: projectDescription,
      },
      { onConflict: 'id', ignoreDuplicates: true }
    )
    if (projErr) return { success: false, error: `project insert failed: ${projErr.message}` }

    // ── Insert the starter actions, each with a deterministic id + seeded tag. ──
    const actionIds: string[] = []
    const errors: string[] = []
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i]
      const actionId = deriveStarterActionId(projectId, i)
      const { error: actErr } = await supabase.from('actions').upsert(
        {
          id: actionId,
          user_id: userId,
          workspace_id: workspaceId,
          team_id: team.id,
          status_id: state.id,
          project_id: projectId,
          title: a.title,
          description: a.description,
          // Identifiable seeded marker — the app's own convention for onboarding
          // rows (context_data.demo=true on the demo capture's actions). No
          // `metadata` column exists on `actions`; context_data IS the tag column.
          // source_type is deliberately OMITTED: its CHECK constraint allows only
          // user/meeting_extraction/chat_suggestion/stt_extraction/
          // insight_suggestion (NULL passes), and the demo capture's seeded
          // actions omit it too.
          context_data: { seeded_by: 'onboarding' },
        },
        { onConflict: 'id', ignoreDuplicates: true }
      )
      if (actErr) {
        errors.push(`action "${a.title.slice(0, 40)}": ${actErr.message}`)
        continue
      }
      actionIds.push(actionId)
    }

    if (actionIds.length === 0) {
      return { success: false, error: `no starter actions saved: ${errors.join('; ')}` }
    }

    const workspaceRenamed = await maybeRenameWorkspace(
      supabase,
      workspaceId,
      input.workspaceRename,
      isOwner,
    )

    // Report the CANONICAL project name, not the input: on a re-run/self-heal,
    // ignoreDuplicates means the first run's name stands even if this call sent
    // a different one — the summary (and the wizard card built from it) must
    // reflect what the user will actually see.
    const { data: savedProject } = await supabase
      .from('projects')
      .select('name')
      .eq('id', projectId)
      .maybeSingle<{ name: string }>()
    const canonicalName = savedProject?.name ?? projectName

    return {
      success: true,
      projectId,
      projectName: canonicalName,
      actionIds,
      actionCount: actionIds.length,
      ...(workspaceRenamed ? { workspaceRenamed } : {}),
      ...(errors.length > 0 ? { warnings: errors } : {}),
      message:
        `Seeded project "${canonicalName}" with ${actionIds.length} starter ` +
        `action${actionIds.length === 1 ? '' : 's'}` +
        (workspaceRenamed ? ` and renamed the workspace to "${workspaceRenamed}".` : '.'),
    }
  },
})

/**
 * Whether `userId` is the OWNER of `workspaceId`. Read service-role (the eve
 * runtime has no per-request JWT) but pinned to the single verified
 * (user_id, workspace_id) row, so the bypass never widens scope. Fails CLOSED:
 * a query error or a missing/non-owner row returns false, so a rename is only
 * ever applied when ownership is positively proven.
 */
async function isWorkspaceOwner(
  supabase: ReturnType<typeof serviceClient>,
  workspaceId: string,
  userId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('member')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle<{ role: string | null }>()
  if (error) return false
  return data?.role === 'owner'
}

/**
 * Apply an optional workspace rename (trimmed, capped 80 chars). Returns the
 * name actually written, or null when nothing was applied (absent/blank input,
 * OR the caller is not the workspace owner). Writes only the `name` column —
 * never the tenant, which is fixed by the caller.
 *
 * `isOwner` gates the write: renaming a workspace is owner-only under the
 * "Owners can update workspace" RLS policy (migration 013), which this
 * service-role write would otherwise bypass. A non-owner run silently skips the
 * rename (returns null) rather than mutating a workspace it doesn't own.
 */
async function maybeRenameWorkspace(
  supabase: ReturnType<typeof serviceClient>,
  workspaceId: string,
  rename: string | undefined,
  isOwner: boolean
): Promise<string | null> {
  if (rename == null) return null
  if (!isOwner) return null
  const name = rename.trim().slice(0, WORKSPACE_NAME_CAP)
  if (!name) return null
  const { error } = await supabase
    .from('workspace')
    .update({ name, updated_at: new Date().toISOString() })
    .eq('id', workspaceId)
  if (error) return null
  return name
}
