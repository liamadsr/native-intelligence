/**
 * The tool ceiling of a skill the AGENT wrote (docs/plans/flows-connectors.md
 * §2.5, F1: "an agent-made skill has no tool ceiling").
 *
 * create_skill / update_skill (chat, and dial8_create_skill /
 * dial8_update_skill over MCP) still never take `agent_config`. They take a
 * small `tool_categories` list instead, validated against the registry's
 * categories, and stamp the config they write with `authored_by: 'agent'`:
 *
 *   - categories given → `enabled_tools` = those categories, the ceiling the
 *     runner already understands (computeToolCeiling: the core set plus each
 *     category's tools);
 *   - no categories   → the DRAFTING profile in act mode: reads plus artifact
 *     writes only (documents, drafts, claims, suggestions), never the board or
 *     the CRM. A null config no longer means "the core set" for a skill the
 *     agent wrote.
 *
 * A skill a person configured in the Library (no `authored_by`), and every
 * system skill, keeps today's ceiling exactly. Report mode is unchanged for
 * every skill (computeReportModeCeiling is narrower than either profile).
 *
 * Pure data and set arithmetic over the registry: no I/O, no `ai` or `zod`, so
 * run-skill.ts, the library tools and the flow tools all read it.
 */
import { computeToolCeiling } from '@/lib/ai/tool-ceiling-core'
import {
  ALL_CATEGORY_IDS,
  ALL_TOOL_NAMES,
  TOOL_CATEGORIES,
  getToolSideEffect,
  getToolWriteTarget,
  isAttendedOnlyTool,
  isChatNativeTool,
} from '@/lib/ai/tool-registry'

/** The `agent_config.authored_by` value a model-written skill carries. */
export const AGENT_AUTHORED = 'agent' as const

/** The agent_config keys this module reads. */
export interface SkillToolConfig {
  enabled_tools?: string[]
  disabled_tools?: string[]
  output_contract?: 'verdict' | 'prose'
  authored_by?: typeof AGENT_AUTHORED
}

/** True for a skill whose config the agent wrote (create_skill / update_skill). */
export function isAgentAuthored(config: SkillToolConfig | null | undefined): boolean {
  return config?.authored_by === AGENT_AUTHORED
}

/**
 * The drafting profile: every registry tool that reads, or writes only an
 * artifact (a document, a draft, a claim, a suggestion). Never a chat-native
 * or attended-only tool. The same classes as computeDraftingCeiling
 * (agent-run/run-work-spec-rebuild.ts), derived from the registry so a new
 * tool joins it only by being classified read or artifact.
 */
export function agentSkillDraftingCeiling(): Set<string> {
  const out = new Set<string>()
  for (const name of ALL_TOOL_NAMES) {
    if (isChatNativeTool(name) || isAttendedOnlyTool(name)) continue
    const effect = getToolSideEffect(name)
    if (effect === 'read' || (effect === 'internal-write' && getToolWriteTarget(name) === 'artifact')) out.add(name)
  }
  return out
}

/**
 * A skill's ACT-mode tool ceiling before the fire-context force-adds and the
 * chat-native / attended-only removal (computeSkillCeiling adds and removes
 * those). null = inherit-all (a person enabled every category).
 */
export function skillActCeiling(config: SkillToolConfig | null | undefined): Set<string> | null {
  const categories = config?.enabled_tools ?? []
  const disabled = config?.disabled_tools ?? []
  if (isAgentAuthored(config) && categories.length === 0) {
    const ceiling = agentSkillDraftingCeiling()
    for (const name of disabled) ceiling.delete(name)
    return ceiling
  }
  return computeToolCeiling(categories.length > 0 ? categories : undefined, disabled.length > 0 ? disabled : undefined)
}

/** The most categories one call may name: every category, once. */
export const MAX_SKILL_TOOL_CATEGORIES = ALL_CATEGORY_IDS.length

/**
 * Validate a model-supplied `tool_categories` list: registry category ids
 * only, each once (duplicates dropped, order kept), at least one.
 */
export function validateToolCategories(raw: readonly string[]): { ok: true; categories: string[] } | { ok: false; error: string } {
  const known = new Set(ALL_CATEGORY_IDS)
  const out: string[] = []
  for (const value of raw) {
    const id = typeof value === 'string' ? value.trim() : ''
    if (!known.has(id)) {
      return {
        ok: false,
        error: `tool_categories: "${String(value)}" is not a tool category. Use any of: ${ALL_CATEGORY_IDS.join(', ')}; or omit it for reads and drafts only.`,
      }
    }
    if (!out.includes(id)) out.push(id)
  }
  if (out.length === 0) return { ok: false, error: 'tool_categories: name at least one category, or omit it for reads and drafts only.' }
  return { ok: true, categories: out }
}

/** The agent_config create_skill writes: the marker, and the categories when given. */
export function agentSkillConfig(categories: readonly string[] | undefined): Record<string, unknown> {
  return { authored_by: AGENT_AUTHORED, ...(categories && categories.length > 0 ? { enabled_tools: [...categories] } : {}) }
}

/**
 * The agent_config update_skill writes: the stored config with its categories
 * replaced (every other key kept: the contract keys, rules, style). A skill
 * the agent wrote keeps its marker; one a person configured stays theirs.
 */
export function withToolCategories(stored: unknown, categories: readonly string[]): Record<string, unknown> {
  const base = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...(stored as Record<string, unknown>) } : {}
  return { ...base, enabled_tools: [...categories] }
}

/**
 * True when `next` grants an act-mode tool `prev` does not (a widening). A
 * null ceiling (inherit-all) is wider than any set.
 */
export function widensSkillCeiling(prev: SkillToolConfig | null | undefined, next: SkillToolConfig | null | undefined): boolean {
  const before = skillActCeiling(prev)
  const after = skillActCeiling(next)
  if (before === null) return false
  if (after === null) return true
  for (const name of after) if (!before.has(name)) return true
  return false
}

const CATEGORY_LABELS = new Map(TOOL_CATEGORIES.map((c) => [c.id, c.label]))

/**
 * What a skill may use when a loop runs it, in words, for the switch-on card:
 * "reads only (it writes its report)", "reads and drafts only", "Emails,
 * Calendar (plus the core action tools)", "every tool".
 */
export function describeSkillTools(config: SkillToolConfig | null | undefined, mode: 'report' | 'act'): string {
  if (mode === 'report' || config?.output_contract === 'verdict') return 'reads only (it writes its report)'
  const categories = config?.enabled_tools ?? []
  if (isAgentAuthored(config) && categories.length === 0) return 'reads and drafts only'
  if (categories.length === 0) return 'the core tools: reads, and creating or updating actions'
  if (skillActCeiling(config) === null) return 'every tool'
  const labels = categories.map((id) => CATEGORY_LABELS.get(id) ?? id)
  return `${labels.join(', ')} (plus the core action tools)`
}
