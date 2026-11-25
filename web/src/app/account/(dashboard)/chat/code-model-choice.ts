/**
 * The model and effort the person last chose for a coding agent (721), on
 * this device: one key per agent, `ni:code:model:<agent id>`, holding
 * {model, effort} (each an id, or null for the agent's own default). Read
 * back only through the agent's offer as it is now (code-tab.ts
 * offeredModelChoice): a model the Mac no longer offers is its default again.
 * Blocked storage holds nothing: the defaults.
 */
import { isModelChoice, isWorkerId } from '@/lib/environments/types'

export const MODEL_CHOICE_KEY_PREFIX = 'ni:code:model:'

export interface ModelChoice {
  model: string | null
  effort: string | null
}

const choiceOf = (v: unknown): string | null => (isModelChoice(v) ? v : null)

/** The agent's remembered choice, or null with none (or for our own agent, which has none). */
export function readModelChoice(agent: string | null): ModelChoice | null {
  if (!agent || !isWorkerId(agent)) return null
  try {
    const raw = window.localStorage.getItem(MODEL_CHOICE_KEY_PREFIX + agent)
    if (!raw) return null
    const v = JSON.parse(raw) as { model?: unknown; effort?: unknown } | null
    if (!v || typeof v !== 'object') return null
    return { model: choiceOf(v.model), effort: choiceOf(v.effort) }
  } catch {
    return null
  }
}

/** Remember the agent's choice; both defaults forget it. */
export function writeModelChoice(agent: string | null, choice: ModelChoice): void {
  if (!agent || !isWorkerId(agent)) return
  try {
    const key = MODEL_CHOICE_KEY_PREFIX + agent
    if (choice.model === null && choice.effort === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify({ model: choice.model, effort: choice.effort }))
  } catch {
    // Storage blocked or full: the choice holds for this page only.
  }
}
