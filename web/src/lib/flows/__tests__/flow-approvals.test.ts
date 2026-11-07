/**
 * The F1 review's fixes to the flow-card helpers: the stored side of an edit
 * is normalized before the diff (a dropped legacy key is no change), removing
 * steps narrows, trust is read with the workspace's policy, and the
 * definition hash covers each skill's prompt.
 */
import { describe, expect, it } from 'vitest'
import type { ResolvedTrustPolicy } from '@/lib/proposed-changes/trust-policy'
import { classifyStepEdit, flowDefinitionHash, isRiskyFlow, raisesTrust } from '../flow-approvals'
import type { FlowAction } from '../types'

const SKILL = '11111111-1111-4111-8111-111111111111'
const step = (over: Partial<FlowAction> & { id: string }): FlowAction =>
  ({ type: 'run_skill', config: { skill_id: SKILL, mode: 'act' }, condition: null, parent_id: null, enabled: true, bearer_token_encrypted: null, ...over }) as FlowAction
const http = (id: string, over: Partial<FlowAction> = {}): FlowAction =>
  step({ id, type: 'http_post', config: { method: 'POST', url: `https://example.com/${id}`, headers: {}, body_template: '' } as never, ...over })

describe('classifyStepEdit: the stored side is normalized first', () => {
  it("a legacy model pin, a runtime key or empty instructions the validator drops is not a change", () => {
    const stored = step({ id: 's', config: { skill_id: SKILL, mode: 'act', model: 'claude-old', runtime: 'local', instructions: '  ' } as never })
    const next = step({ id: 's', config: { skill_id: SKILL, mode: 'act' } })
    expect(classifyStepEdit([stored], [next], false)).toBe('none')
  })

  it('removing steps narrows; removing one another step chains off, or reordering, widens', () => {
    const a = http('a')
    const b = http('b')
    const child = http('c', { parent_id: 'a' })
    expect(classifyStepEdit([a, b], [a], false)).toBe('narrowing')
    expect(classifyStepEdit([a, child, b], [child, b], false)).toBe('widening')
    expect(classifyStepEdit([a, b], [b, a], false)).toBe('widening')
    expect(classifyStepEdit([a], [a, b], false)).toBe('widening')
  })
})

describe('raisesTrust reads the workspace policy (resolveTrust)', () => {
  const policy = (minConfidence: number, enabled = true): ResolvedTrustPolicy =>
    ({
      explicit: true,
      enabled,
      actions: { enabled: true, min_confidence: minConfidence, require_explicit: false },
      decisions: { enabled: true, min_confidence: 0.9, require_explicit: true },
      milestones: { enabled: true, min_confidence: 0.9, require_explicit: true },
    }) as unknown as ResolvedTrustPolicy

  it('a flow min_confidence below the INHERITED workspace bar is a raise; above it, a lowering', () => {
    const inherit = { mode: 'act' as const, skill_id: SKILL, trust: { auto_apply: true } as never }
    const explicitLow = { mode: 'act' as const, skill_id: SKILL, trust: { auto_apply: true, min_confidence: 0.7 } as never }
    const explicitHigh = { mode: 'act' as const, skill_id: SKILL, trust: { auto_apply: true, min_confidence: 0.95 } as never }
    expect(raisesTrust(inherit, explicitLow, policy(0.8))).toBe(true)
    expect(raisesTrust(inherit, explicitHigh, policy(0.8))).toBe(false)
    // Without the policy the default (0.85) is the bar: 0.8 inherited vs 0.85 would mislead.
    expect(raisesTrust(explicitHigh, inherit, policy(0.8))).toBe(true)
  })

  it("a workspace kill switch means nothing auto-applies: turning a flow's auto_apply on raises nothing", () => {
    const off = { mode: 'act' as const, skill_id: SKILL, trust: { auto_apply: false } as never }
    const on = { mode: 'act' as const, skill_id: SKILL, trust: { auto_apply: true } as never }
    expect(raisesTrust(off, on, policy(0.8, false))).toBe(false)
    expect(raisesTrust(off, on, policy(0.8, true))).toBe(true)
  })
})

describe('flowDefinitionHash covers what the skills say', () => {
  it("a rewritten prompt or new context rules change the loop's hash", () => {
    const flow = { trigger_type: 'schedule', trigger_config: {}, actions: [step({ id: 's' })], created_by: 'u' }
    const base = flowDefinitionHash(flow, new Map([[SKILL, { agent_config: { context_rules: ['a'] }, system_prompt: 'do X' }]]))
    expect(flowDefinitionHash(flow, new Map([[SKILL, { agent_config: { context_rules: ['a'] }, system_prompt: 'do Y' }]]))).not.toBe(base)
    expect(flowDefinitionHash(flow, new Map([[SKILL, { agent_config: { context_rules: ['b'] }, system_prompt: 'do X' }]]))).not.toBe(base)
    expect(flowDefinitionHash(flow, new Map([[SKILL, { agent_config: { context_rules: ['a'] }, system_prompt: 'do X' }]]))).toBe(base)
  })

  it('isRiskyFlow: http_post, act-mode skills and run_agent', () => {
    expect(isRiskyFlow([http('a')])).toBe(true)
    expect(isRiskyFlow([step({ id: 's', config: { skill_id: SKILL, mode: 'report' } })])).toBe(false)
  })
})
