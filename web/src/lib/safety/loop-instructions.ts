/**
 * A loop's saved instructions, as action.review reads them (A5 slice 2): an
 * unattended loop has no person in the turn, so a risky call is checked
 * against what the person saved when they set the loop up. The only
 * person-authored provenance a loop has.
 *
 * Read lazily, only for a risky call. Never throws: no instructions found is
 * an empty list (the reviewer then blocks: nothing to check the call against).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

const MAX_CHARS = 2_000

function clip(text: string): string {
  return text.length > MAX_CHARS ? text.slice(-MAX_CHARS) : text
}

type FlowRow = { actions?: unknown }

/**
 * One line for the reviewer: the instructions of the loop's run_skill steps
 * for this skill (flow.actions[], each { type, config: { skill_id,
 * instructions } }), the owner's own words. Never the loop's name or
 * description, which any member of the workspace can change (the owner rule
 * covers only the trigger and the steps), and never the skill's name, which
 * is no instruction (S9). A loop with no step instructions has no words.
 */
export function describeLoop(flow: FlowRow | null, skillId: string): string | null {
  const parts: string[] = []
  const actions = Array.isArray(flow?.actions) ? (flow!.actions as unknown[]) : []
  for (const action of actions) {
    const config = action && typeof action === 'object' ? (action as { config?: unknown }).config : undefined
    if (!config || typeof config !== 'object') continue
    const { skill_id: forSkill, instructions } = config as { skill_id?: unknown; instructions?: unknown }
    if (forSkill === skillId && typeof instructions === 'string' && instructions.trim()) parts.push(`Instructions: ${instructions.trim()}`)
  }
  return parts.length ? clip(parts.join(' ')) : null
}

/**
 * One line for the reviewer about a Mac job a loop started (L5,
 * src/lib/local-agent/unattended.ts): the step's SAVED request, the template
 * as the loop's owner saved it, with its mode. Never the rendered text (its
 * trigger values may be outside text), and never the loop's name or
 * description: any member of the workspace can change those, and they must
 * not speak for the owner. The request's head is kept (where the task is
 * stated) and the line fits action.review's 2,000-character window, so the
 * mode is never cut off. Null when the step is gone or has no request: the
 * reviewer then blocks.
 */
export function describeLocalAgentStep(flow: FlowRow | null, actionId: string): string | null {
  const actions = Array.isArray(flow?.actions) ? (flow!.actions as unknown[]) : []
  const step = actions.find((a) => a && typeof a === 'object' && (a as { id?: unknown }).id === actionId) as
    | { type?: unknown; config?: unknown }
    | undefined
  if (!step || step.type !== 'run_local_agent' || !step.config || typeof step.config !== 'object') return null
  const { request, mode } = step.config as { request?: unknown; mode?: unknown }
  if (typeof request !== 'string' || !request.trim()) return null
  const lead = `Loop step: a job on the person's Mac (${mode === 'edit' ? 'may edit files in a git worktree' : 'read only'}): `
  const text = request.trim()
  const room = MAX_CHARS - lead.length
  return text.length <= room ? `${lead}${text}` : `${lead}${text.slice(0, room - 1)}…`
}

/**
 * The Mac-job door's words (L5): the flow and its step, read by id in the
 * session's own workspace, and only while the loop is still the job's own
 * person's (`created_by`): a loop taken over by, or handed to, another member
 * has their words now, and those never speak for the Mac job of the person
 * it ran as. Never throws (no words: the reviewer blocks).
 */
export async function localAgentLoopInstructions(
  supabase: SupabaseClient,
  ids: { workspaceId: string; flowId: string; actionId: string; userId: string },
): Promise<string[]> {
  try {
    const { data } = await supabase
      .from('flow')
      .select('actions, created_by')
      .eq('id', ids.flowId)
      .eq('workspace_id', ids.workspaceId)
      .maybeSingle()
    const flow = data as (FlowRow & { created_by?: unknown }) | null
    if (!flow || flow.created_by !== ids.userId) return []
    const line = describeLocalAgentStep(flow, ids.actionId)
    return line ? [line] : []
  } catch {
    return []
  }
}

/**
 * The skill-run door: the flow the run token's flow step names, else the
 * fire's ledger row (tracked_job.flow_run_id) to its flow run and the flow,
 * and its step instructions for this skill (describeLoop). A run with
 * neither, or a loop with no step instructions, has no words.
 */
export async function skillRunLoopInstructions(
  supabase: SupabaseClient,
  claims: { workspaceId: string; skillId: string; workItemId?: string; flowStep?: { flowId?: string | null } | null },
): Promise<string[]> {
  try {
    let flow: FlowRow | null = null
    // The run token's verified flow step names its flow (every dispatched,
    // manual or resumed run). The ledger row learns its flow run only after
    // the run, so on its own it would leave a live run with no words (and,
    // with the reviewer blocking, every risky call held).
    const flowId = typeof claims.flowStep?.flowId === 'string' && claims.flowStep.flowId ? claims.flowStep.flowId : null
    if (flowId) {
      const { data } = await supabase
        .from('flow')
        .select('actions')
        .eq('id', flowId)
        .eq('workspace_id', claims.workspaceId)
        .maybeSingle()
      flow = data ?? null
    }
    if (!flow && claims.workItemId) {
      const { data: job } = await supabase
        .from('tracked_job')
        .select('flow_run_id')
        .eq('id', claims.workItemId)
        .eq('workspace_id', claims.workspaceId)
        .maybeSingle<{ flow_run_id: string | null }>()
      if (job?.flow_run_id) {
        const { data: run } = await supabase.from('flow_run').select('flow_id').eq('id', job.flow_run_id).maybeSingle<{ flow_id: string }>()
        if (run?.flow_id) {
          const { data } = await supabase
            .from('flow')
            .select('actions')
            .eq('id', run.flow_id)
            .eq('workspace_id', claims.workspaceId)
            .maybeSingle()
          flow = data ?? null
        }
      }
    }
    const line = describeLoop(flow, claims.skillId)
    return line ? [line] : []
  } catch {
    return []
  }
}
