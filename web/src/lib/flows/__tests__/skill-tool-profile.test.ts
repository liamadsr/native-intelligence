/**
 * F1 (docs/plans/flows-connectors.md §2.5): a skill the agent writes gets a
 * tool ceiling. Without categories it reads and drafts only in act mode; with
 * them it gets exactly the categories' ceiling; a person-configured or system
 * skill keeps today's ceiling.
 */
import { describe, expect, it } from 'vitest'
import { ALL_CATEGORY_IDS, ALL_TOOL_NAMES, getToolSideEffect, getToolWriteTarget, isAttendedOnlyTool } from '@/lib/ai/tool-registry'
import { computeToolCeiling } from '@/lib/ai/tool-ceiling-core'
import { computeSkillCeiling, computeReportModeCeiling } from '../run-skill'
import {
  agentSkillConfig,
  agentSkillDraftingCeiling,
  describeSkillTools,
  skillActCeiling,
  validateToolCategories,
  widensSkillCeiling,
  withToolCategories,
} from '../skill-tool-profile'

describe('the drafting profile', () => {
  it('is reads plus artifact writes only, never a board/CRM write, an outward call or an attended-only tool', () => {
    const ceiling = agentSkillDraftingCeiling()
    for (const name of ceiling) {
      const effect = getToolSideEffect(name)
      expect(effect === 'read' || (effect === 'internal-write' && getToolWriteTarget(name) === 'artifact'), name).toBe(true)
      expect(isAttendedOnlyTool(name), name).toBe(false)
    }
    for (const name of ['create_action', 'update_action', 'complete_action', 'create_contact', 'create_calendar_event', 'push_action_to_linear', 'delete_action', 'create_flow']) {
      expect(ceiling.has(name), name).toBe(false)
    }
    for (const name of ['find', 'create_document', 'create_email_draft', 'suggest_changes', 'create_claim']) {
      expect(ceiling.has(name), name).toBe(true)
    }
    expect(ceiling.size).toBeLessThan(ALL_TOOL_NAMES.length)
  })
})

describe('computeSkillCeiling for an agent-made skill', () => {
  it('no categories: act mode is the drafting profile, not the core set', () => {
    const ceiling = computeSkillCeiling(agentSkillConfig(undefined) as never, 'act', false)
    expect(ceiling).not.toBeNull()
    expect(ceiling!.has('create_action')).toBe(false)
    expect(ceiling!.has('create_document')).toBe(true)
  })

  it('with categories: exactly the categories’ ceiling (what the runner already understands)', () => {
    const config = agentSkillConfig(['emails'])
    expect(config).toEqual({ authored_by: 'agent', enabled_tools: ['emails'] })
    const ceiling = computeSkillCeiling(config as never, 'act', false)
    const expected = computeToolCeiling(['emails'], undefined)!
    for (const name of expected) if (!isAttendedOnlyTool(name)) expect(ceiling!.has(name), name).toBe(true)
    expect(ceiling!.has('create_calendar_event')).toBe(false)
  })

  it('report mode is unchanged', () => {
    expect([...computeSkillCeiling(agentSkillConfig(undefined) as never, 'report', false)!].sort()).toEqual(
      [...computeSkillCeiling(null, 'report', false)!].sort(),
    )
    expect(computeReportModeCeiling().has('create_action')).toBe(false)
  })
})

describe('a person-configured or system skill keeps today’s ceiling', () => {
  it('a null config in act mode is still the core set', () => {
    const ceiling = computeSkillCeiling(null, 'act', false)!
    expect(ceiling.has('create_action')).toBe(true)
    expect([...skillActCeiling(null)!].sort()).toEqual([...computeToolCeiling(undefined, undefined)!].sort())
  })

  it('every category enabled is still inherit-all', () => {
    expect(computeSkillCeiling({ enabled_tools: [...ALL_CATEGORY_IDS] }, 'act', false)).toBeNull()
  })
})

describe('validateToolCategories', () => {
  it('keeps registry categories once, in order', () => {
    expect(validateToolCategories(['emails', 'calendar', 'emails'])).toEqual({ ok: true, categories: ['emails', 'calendar'] })
  })
  it('refuses an unknown id, naming the valid ones', () => {
    const res = validateToolCategories(['emails', 'create_flow'])
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('"create_flow" is not a tool category')
  })
  it('refuses an empty list', () => {
    expect(validateToolCategories([]).ok).toBe(false)
  })
})

describe('widening', () => {
  it('drafting → a category with board writes widens; a narrower set does not', () => {
    expect(widensSkillCeiling(agentSkillConfig(undefined), agentSkillConfig(['actions']))).toBe(true)
    expect(widensSkillCeiling({ enabled_tools: ['emails', 'calendar'] }, { enabled_tools: ['emails'] })).toBe(false)
    expect(widensSkillCeiling({ enabled_tools: ['emails'] }, { enabled_tools: [...ALL_CATEGORY_IDS] })).toBe(true)
    expect(widensSkillCeiling(null, withToolCategories(null, ['documents']))).toBe(true)
  })

  it('withToolCategories keeps every other key (contract keys, the marker)', () => {
    expect(withToolCategories({ authored_by: 'agent', output_contract: 'verdict', context_rules: ['x'] }, ['emails'])).toEqual({
      authored_by: 'agent',
      output_contract: 'verdict',
      context_rules: ['x'],
      enabled_tools: ['emails'],
    })
  })
})

describe('describeSkillTools (the switch-on card)', () => {
  it('says what the skill may use', () => {
    expect(describeSkillTools(null, 'report')).toMatch(/reads only/)
    expect(describeSkillTools(agentSkillConfig(undefined), 'act')).toBe('reads and drafts only')
    expect(describeSkillTools(null, 'act')).toMatch(/core tools/)
    expect(describeSkillTools({ enabled_tools: ['emails', 'calendar'] }, 'act')).toBe('Emails, Calendar (plus the core action tools)')
    expect(describeSkillTools({ enabled_tools: [...ALL_CATEGORY_IDS] }, 'act')).toBe('every tool')
    expect(describeSkillTools({ output_contract: 'verdict', enabled_tools: ['emails'] }, 'act')).toMatch(/reads only/)
  })
})
