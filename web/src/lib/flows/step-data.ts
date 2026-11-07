/**
 * Data passing between a flow's steps (F4, docs/plans/flows-connectors.md
 * §2.2). Each step that runs leaves an OUTPUT on the run, which later steps
 * read through the template context (`{{steps.<step id>.output}}`,
 * template.ts). That is what makes "summarise this call, draft a post, put it
 * in my Typefully queue" one flow.
 *
 * What a step's output is:
 *   - run_skill: what the skill wrote (its prose, or its delivery's line);
 *   - call_tool: the connected app's text result, as the app returned it;
 *   - http_post: the response body preview;
 *   - archive_capture, run_agent, run_local_agent: nothing a later step can use.
 *
 * Every output is stored REDACTED of anything secret-shaped (a bearer token,
 * an API key, a password field) and size-capped, per step and per run, before
 * it is kept or passed on. Outputs are OUTSIDE text for a model: a skill step
 * that reads one gets it inside the untrusted fence (wrapUntrusted, as the
 * run's own tools fence it), while a call_tool step sends it to the app as
 * plain text (the fence would land in someone's Notion page).
 *
 * The outputs live in flow_run_state (migration 383), a server-only table:
 * flow_run is readable by every member of the workspace, and an output can
 * hold the owner's own data from their connected apps.
 *
 * Pure: no I/O.
 */
import type { FlowAction } from './types'
import { stepReferences } from './template'

export { capStepOutput, redactSecrets, REDACTED, STEP_OUTPUT_MAX_CHARS, STEP_OUTPUT_TRUNCATED, type StepOutput } from './redact'
import { capStepOutput, STEP_OUTPUT_MAX_CHARS, type StepOutput } from './redact'

/** The most of every step's output together, per run. */
export const RUN_OUTPUTS_MAX_CHARS = 32_000

/** A run's outputs, by step (action) id. */
export type StepOutputs = Record<string, StepOutput>

/** How many characters the run's outputs hold now. */
export function outputsSize(outputs: StepOutputs): number {
  let n = 0
  for (const v of Object.values(outputs)) n += v.output.length
  return n
}

/**
 * The outputs with one more step's added, within the run's cap: a step that
 * would overflow it keeps only what is left (and is marked truncated). Pure.
 */
export function withStepOutput(outputs: StepOutputs, actionId: string, raw: string | null | undefined): StepOutputs {
  const room = Math.max(0, RUN_OUTPUTS_MAX_CHARS - outputsSize(outputs))
  return { ...outputs, [actionId]: capStepOutput(raw, Math.min(STEP_OUTPUT_MAX_CHARS, room)) }
}

/** The outputs as the template context reads them. */
export function stepsContext(outputs: StepOutputs): Record<string, { output: string }> {
  const out: Record<string, { output: string }> = {}
  for (const [id, v] of Object.entries(outputs)) out[id] = { output: v.output }
  return out
}

/** A stored outputs object, re-read defensively (flow_run_state.step_outputs). */
export function parseStepOutputs(raw: unknown): StepOutputs {
  const out: StepOutputs = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v && typeof v === 'object' && typeof (v as { output?: unknown }).output === 'string') {
      out[id] = (v as { truncated?: unknown }).truncated === true
        ? { output: (v as { output: string }).output, truncated: true }
        : { output: (v as { output: string }).output }
    }
  }
  return out
}

/** The text fields of a step's config that are templates (where it may reference other steps). */
export function actionTemplateFields(action: Pick<FlowAction, 'type' | 'config'>): unknown[] {
  const c = (action.config ?? {}) as Record<string, unknown>
  if (action.type === 'call_tool') return [c.input]
  if (action.type === 'http_post') return [c.body_template]
  if (action.type === 'run_skill') {
    const deliver = (c.deliver ?? {}) as Record<string, unknown>
    return [c.instructions, deliver.document_title]
  }
  if (action.type === 'run_agent') return [c.instructions]
  if (action.type === 'run_local_agent') return [c.request]
  return []
}

/** The step ids one action's templates reference. */
export function actionStepReferences(action: Pick<FlowAction, 'type' | 'config'>): string[] {
  return [...new Set(actionTemplateFields(action).flatMap((v) => stepReferences(v)))]
}

/**
 * Does this flow pass data between steps at all? Only then does a run keep its
 * outputs (one extra write per run), so a flow that doesn't costs nothing.
 */
export function flowPassesData(actions: ReadonlyArray<Pick<FlowAction, 'type' | 'config'>>): boolean {
  return actions.some((a) => a.type === 'call_tool' || actionStepReferences(a).length > 0)
}

/**
 * The save-time rule for references: a step may name only a step it chains
 * off (an ancestor through parent_id), which always runs before it. Returns
 * the first bad reference with why, or null. Pure.
 */
export function findBadStepReference(
  actions: ReadonlyArray<Pick<FlowAction, 'id' | 'type' | 'config' | 'parent_id'>>,
): { index: number; reference: string; message: string } | null {
  const byId = new Map(actions.map((a) => [a.id, a]))
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]
    const ancestors = new Set<string>()
    let cur = a.parent_id ? byId.get(a.parent_id) : undefined
    while (cur && !ancestors.has(cur.id)) {
      ancestors.add(cur.id)
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
    }
    // A coding agent's task is not rendered with step outputs: refused, never silently empty.
    const refs = actionStepReferences(a)
    if (a.type === 'run_agent' && refs.length) {
      return { index: i, reference: refs[0], message: `a run_agent step can't use another step's output ({{steps.${refs[0]}.output}})` }
    }
    // A Mac job's request stays the owner's saved words plus the trigger's
    // fenced values: an earlier step's output (outside text) never steers it.
    if (a.type === 'run_local_agent' && refs.length) {
      return { index: i, reference: refs[0], message: `a run_local_agent step can't use another step's output ({{steps.${refs[0]}.output}})` }
    }
    for (const ref of refs) {
      if (ref === a.id) {
        return { index: i, reference: ref, message: `step "${a.id}" can't use its own output` }
      }
      if (!byId.has(ref)) {
        return { index: i, reference: ref, message: `{{steps.${ref}.output}} names no step in this flow` }
      }
      if (!ancestors.has(ref)) {
        return {
          index: i,
          reference: ref,
          message: `{{steps.${ref}.output}}: step "${a.id}" must chain off "${ref}" (its parent_id, or a parent's) to use its output`,
        }
      }
    }
  }
  return null
}
