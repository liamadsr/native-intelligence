/**
 * Background runs get the same know-how as the main chat (plan Part 3,
 * "Background work"). A skill-runner run whose skill has an area, or a
 * work-agent run whose loop runs such a skill, gains that area's playbook
 * (and S2's memory) in its system prompt. A run with no area of its own gets
 * the areas of the tools it works through, but only when they narrow to one
 * or two: a skill that may use every tool has no area, and loading all
 * sixteen playbooks would bury its own instructions.
 *
 * Same gate as the chat: only areas whose edition feature is on.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveWorkspaceEdition } from '@/lib/editions'
import { enabledAreaGate } from './chat-packs'
import { loadPackMemory } from './memory'
import { areasForToolGroups, areasForToolNames, isAreaKey, playbookSlug, type AreaKey } from './registry'
import { renderBackgroundExpertise } from './render'
import { areaGuide } from './area-guides'
import { flowSkillIds } from '@/lib/work/system-teammates'

/** At most this many areas come from a run's tools; an explicit area always counts. */
export const MAX_TOOL_DERIVED_AREAS = 2

/** The explicit areas first, then the tool-derived ones when they narrow to a couple. */
function mergeAreas(explicit: readonly unknown[], derived: readonly AreaKey[]): AreaKey[] {
  const out: AreaKey[] = []
  for (const a of explicit) if (isAreaKey(a) && !out.includes(a)) out.push(a)
  if (out.length === 0 && derived.length > 0 && derived.length <= MAX_TOOL_DERIVED_AREAS) out.push(...derived)
  return out
}

/**
 * A skill run's areas: the skill's own `area`, else the areas of the tool
 * groups it enables (agent_config.enabled_tools) when they narrow to one or two.
 */
export function areasForSkillRun(skill: { area?: string | null; enabledTools?: readonly string[] | null }): AreaKey[] {
  return mergeAreas([skill.area], areasForToolGroups(skill.enabledTools ?? []))
}

/**
 * A work run's areas: the areas a helper was given (agent_run.helper_areas,
 * always-on-agent §4: the main chat's thread areas), then the areas of the
 * skills its loop runs, else the areas of the tools its teammate is limited to
 * (tool_allowlist) when they narrow.
 */
export function areasForWorkRun(run: {
  explicitAreas?: readonly (string | null | undefined)[] | null
  loopSkillAreas: readonly (string | null | undefined)[]
  toolAllowlist?: readonly string[] | null
}): AreaKey[] {
  return mergeAreas([...(run.explicitAreas ?? []), ...run.loopSkillAreas], run.toolAllowlist ? areasForToolNames(run.toolAllowlist) : [])
}

/**
 * The expertise section for a background run's system prompt, or '' when its
 * areas have nothing (or are off). Reads each area's playbook (the system skill
 * `<area>-playbook`) and its memory, beside how its tools work (area-guides.ts). Never throws: the run goes on without it.
 */
export async function backgroundExpertiseSection(
  supabase: SupabaseClient,
  scope: { workspaceId: string; userId: string; areas: readonly AreaKey[]; workspaceSettings?: unknown },
): Promise<string> {
  if (scope.areas.length === 0) return ''
  try {
    const enabled = enabledAreaGate(await resolveWorkspaceEdition(supabase, scope.workspaceId, scope.workspaceSettings))
    const areas = scope.areas.filter(enabled)
    if (areas.length === 0) return ''
    const [{ data, error }, memory] = await Promise.all([
      supabase
        .from('recipe')
        .select('slug, area, system_prompt')
        .eq('category', 'skill')
        .eq('is_system', true)
        .in('slug', areas.map(playbookSlug)),
      loadPackMemory(supabase, { workspaceId: scope.workspaceId, userId: scope.userId, areas }),
    ])
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as Array<{ slug: string | null; area: string | null; system_prompt: string | null }>
    return renderBackgroundExpertise(
      areas.map((area) => ({
        area,
        playbook: rows.find((r) => r.slug === playbookSlug(area) && r.area === area)?.system_prompt ?? '',
        memory: memory.get(area) ?? '',
        guide: areaGuide(area),
      })),
    )
  } catch (err) {
    console.error(`[packs] background expertise skipped: ${err instanceof Error ? err.message : String(err)}`)
    return ''
  }
}

/** The areas of the skills a loop runs, read in one query (system or this workspace's). */
export async function loopSkillAreas(
  supabase: SupabaseClient,
  workspaceId: string,
  skillIds: readonly string[],
): Promise<string[]> {
  if (skillIds.length === 0) return []
  const { data, error } = await supabase
    .from('recipe')
    .select('id, area')
    .in('id', [...skillIds])
    .eq('category', 'skill')
    .or(`workspace_id.eq.${workspaceId},is_system.eq.true`)
  if (error || !data) return []
  return (data as Array<{ area: string | null }>).map((r) => r.area).filter((a): a is string => isAreaKey(a))
}

/**
 * The expertise section for a work run: a helper's own areas
 * (agent_run.helper_areas) first, then the areas of the skills its loop runs
 * (agent_run.flow_id → the flow's run_skill actions), else of the tools its
 * teammate is limited to. '' when none gives an area. Never throws.
 */
export async function workRunExpertiseSection(
  supabase: SupabaseClient,
  scope: {
    workspaceId: string
    userId: string
    flowId?: string | null
    toolAllowlist?: readonly string[] | null
    helperAreas?: readonly string[] | null
  },
): Promise<string> {
  try {
    let skillAreas: string[] = []
    if (scope.flowId) {
      const { data } = await supabase
        .from('flow')
        .select('actions')
        .eq('id', scope.flowId)
        .eq('workspace_id', scope.workspaceId)
        .maybeSingle()
      const actions = (data as { actions?: unknown } | null)?.actions
      skillAreas = await loopSkillAreas(supabase, scope.workspaceId, flowSkillIds(Array.isArray(actions) ? actions : []))
    }
    const areas = areasForWorkRun({ explicitAreas: scope.helperAreas ?? null, loopSkillAreas: skillAreas, toolAllowlist: scope.toolAllowlist ?? null })
    return await backgroundExpertiseSection(supabase, { workspaceId: scope.workspaceId, userId: scope.userId, areas })
  } catch (err) {
    console.error(`[packs] work-run expertise skipped: ${err instanceof Error ? err.message : String(err)}`)
    return ''
  }
}
