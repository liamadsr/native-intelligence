/**
 * The gate and the task messages of the `helpers` tool (A4 slice 3): what its
 * first step (./helpers-prepare.ts) computes from the spec. Reached ONLY
 * through that step: it imports eve/context (via ./expertise.ts), a Node
 * builtin the Workflow VM refuses, and eve strips a step module's imports
 * from the workflow bundle only when nothing but the step uses them.
 */
import type { ChatSpec } from './spec-client.js'
import { renderExpertiseBlock, validPacks, type ChatPack } from './expertise.js'
import { matchSkill } from './skill-match.js'
import { helperAgentsFor, helperTaskMessage, type HelperTaskInput, type PreparedHelpers } from './helpers.js'

const DEFAULT_REFUSAL = 'Helpers are not available in this conversation. Do the work yourself.'
const UNREACHABLE = 'Helpers are unavailable right now (the workspace could not be reached). Do the work yourself.'

/** The pack a requested name means: its area key, its name, or its playbook skill. */
function packFor(name: string, packs: readonly ChatPack[]): ChatPack | null {
  const wanted = name.trim().toLowerCase()
  return (
    packs.find((p) => p.area === wanted || p.name.toLowerCase() === wanted || (p.playbookSkill ?? '').toLowerCase() === wanted) ??
    null
  )
}

/**
 * The playbooks a task asked for, as blocks for its message: an area's whole
 * pack (renderExpertiseBlock, as the main agent gets it), else a workspace
 * skill's body. A name that matches nothing is reported, never guessed.
 */
export function skillBlocksFor(
  names: readonly string[] | undefined,
  spec: Pick<ChatSpec, 'packs' | 'skills'>,
): { blocks: string[]; unknown: string[] } {
  const packs = validPacks(spec.packs)
  const skills = Array.isArray(spec.skills) ? spec.skills : []
  const blocks: string[] = []
  const unknown: string[] = []
  const seen = new Set<string>()
  for (const name of names ?? []) {
    const pack = packFor(name, packs)
    if (pack) {
      if (!seen.has(`pack:${pack.area}`)) blocks.push(renderExpertiseBlock(pack))
      seen.add(`pack:${pack.area}`)
      continue
    }
    const found = matchSkill(skills, name)
    if (found.kind === 'match') {
      if (!seen.has(`skill:${found.skill.name}`)) blocks.push(`<skill name="${found.skill.name.replace(/"/g, '')}">\n${found.skill.markdown}\n</skill>`)
      seen.add(`skill:${found.skill.name}`)
      continue
    }
    unknown.push(name)
  }
  return { blocks, unknown }
}

/** The brief a task's tier is read from (the helper-tier route): its task and context. */
export function helperTierText(task: HelperTaskInput): string {
  return [task.task, task.context ?? ''].join('\n').trim()
}

/**
 * The tasks as messages, or why helpers can't run here (read only from the
 * verified spec). `tiers` is the helper-tier route's answer: each task's
 * roster model (the main agent's choice, after the plan and the cap) picks
 * its declared helper (helperAgentsFor). On the person's ChatGPT plan every
 * task runs on the plain helper (the plan's lighter model).
 */
export function prepareHelperTasks(tasks: readonly HelperTaskInput[], spec: ChatSpec | null, tiers: readonly unknown[] | null = null): PreparedHelpers {
  if (!spec) return { ok: false, reason: UNREACHABLE }
  if (spec.helpersAllowed !== true) {
    const reason = typeof spec.helpersRefusal === 'string' && spec.helpersRefusal.trim() ? spec.helpersRefusal : DEFAULT_REFUSAL
    return { ok: false, reason }
  }
  const unknownSkills: string[] = []
  const agents = helperAgentsFor(tiers, tasks.length, { onPlan: spec.chatgptPlan != null })
  const prepared = tasks.map((task, i) => {
    const { blocks, unknown } = skillBlocksFor(task.skills, spec)
    for (const name of unknown) if (!unknownSkills.includes(name)) unknownSkills.push(name)
    return { label: task.label, message: helperTaskMessage(task, blocks), agent: agents[i] }
  })
  return { ok: true, tasks: prepared, unknownSkills }
}

