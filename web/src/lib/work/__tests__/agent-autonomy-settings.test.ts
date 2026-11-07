/**
 * The settings surface's write contract (plan Part 5 row 9): strict validation
 * (a bad number names its field instead of silently turning attempt into
 * propose), and a merge that never lets a policy write touch the per-role
 * resumes (Resume's alone), even when a patch carries them.
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_AGENT_AUTONOMY_POLICY, type AgentAutonomyPolicy } from '../agent-autonomy-policy'
import { AGENT_AUTONOMY_MAX, mergeAgentAutonomyPolicy, validateAgentAutonomyPatch, type AgentAutonomyPatch } from '../agent-autonomy-settings'

describe('validateAgentAutonomyPatch', () => {
  it('validates chat role permissions and independently bounded launch caps', () => {
    expect(validateAgentAutonomyPatch({ chat_can_delegate_to: [], max_chat_delegations_per_day: 0, max_chat_delegations_per_conversation: 3 })).toMatchObject({ ok: true, patch: { chat_can_delegate_to: [], max_chat_delegations_per_day: 0 } })
    expect(validateAgentAutonomyPatch({ chat_can_delegate_to: ['writer', 'writer'] })).toMatchObject({ ok: true, patch: { chat_can_delegate_to: ['writer'] } })
    for (const p of [{ chat_can_delegate_to: ['developer'] }, { chat_can_delegate_to: null }, { max_chat_delegations_per_day: 501 }, { max_chat_delegations_per_conversation: '3' }]) expect(validateAgentAutonomyPatch(p).ok).toBe(false)
  })

  it('takes the mode and whole numbers in range, and drops anything else', () => {
    expect(validateAgentAutonomyPatch({ mode: 'attempt', max_attempts_per_day: 0, role_breaker_resumed_at: { writer: 'x' }, other: 1 })).toEqual({
      ok: true,
      patch: { mode: 'attempt', max_attempts_per_day: 0 },
    })
    expect(validateAgentAutonomyPatch({ max_attempts_per_day: AGENT_AUTONOMY_MAX.max_attempts_per_day })).toMatchObject({ ok: true })
  })

  it('names the field it refuses', () => {
    expect(validateAgentAutonomyPatch({ mode: 'always' })).toEqual({ ok: false, error: 'mode must be one of off, propose, attempt' })
    for (const v of [-1, 2.5, '3', null, Number.NaN, AGENT_AUTONOMY_MAX.role_breaker_window + 1]) {
      const res = validateAgentAutonomyPatch({ role_breaker_window: v })
      expect(res.ok, String(v)).toBe(false)
      if (!res.ok) expect(res.error).toContain('role_breaker_window')
    }
    expect(validateAgentAutonomyPatch([])).toMatchObject({ ok: false })
    expect(validateAgentAutonomyPatch(null)).toMatchObject({ ok: false })
  })
})

describe('validateAgentAutonomyPatch — the attempt bar', () => {
  it('takes a number from 0 to 1, or null for the flow’s own bar', () => {
    expect(validateAgentAutonomyPatch({ attempt_min_confidence: 0.6 })).toEqual({ ok: true, patch: { attempt_min_confidence: 0.6 } })
    expect(validateAgentAutonomyPatch({ attempt_min_confidence: null })).toEqual({ ok: true, patch: { attempt_min_confidence: null } })
    for (const bad of [1.5, -0.2, '0.6', NaN]) {
      const res = validateAgentAutonomyPatch({ attempt_min_confidence: bad })
      expect(res.ok, String(bad)).toBe(false)
      if (!res.ok) expect(res.error).toContain('attempt_min_confidence')
    }
  })

  it('merges over the stored policy', () => {
    expect(mergeAgentAutonomyPolicy(DEFAULT_AGENT_AUTONOMY_POLICY, { attempt_min_confidence: 0.6 }).attempt_min_confidence).toBe(0.6)
  })
})

describe('mergeAgentAutonomyPolicy', () => {
  const current: AgentAutonomyPolicy = {
    ...DEFAULT_AGENT_AUTONOMY_POLICY,
    max_attempts_per_capture: 2,
    role_breaker_resumed_at: { writer: '2026-09-01T00:00:00.000Z' },
  }

  it('the patch over the stored policy', () => {
    expect(mergeAgentAutonomyPolicy(current, { mode: 'attempt', max_attempts_per_day: 4 })).toEqual({
      ...current,
      mode: 'attempt',
      max_attempts_per_day: 4,
    })
  })

  it('keeps the stored resumes even when a patch carries its own', () => {
    const sneaky = { role_breaker_resumed_at: { writer: '1999-01-01T00:00:00.000Z' } } as unknown as AgentAutonomyPatch
    expect(mergeAgentAutonomyPolicy(current, sneaky).role_breaker_resumed_at).toEqual({ writer: '2026-09-01T00:00:00.000Z' })
  })
})
