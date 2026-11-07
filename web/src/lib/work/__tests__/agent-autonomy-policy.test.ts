/**
 * agent-autonomy-policy — the truth table for the normaliser (B PR 1). The
 * property that matters: `mode: 'attempt'` (the default since 2026-10-17:
 * agents act by default) is honoured only when every budget present is a finite
 * non-negative integer; anything else fails closed to 'propose', and so does a
 * failed settings read. Absent fields take the defaults and are not malformed.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  AGENT_AUTONOMY_NUMERIC_KEYS,
  DEFAULT_AGENT_AUTONOMY_POLICY,
  normalizeAgentAutonomyPolicy,
  resolveAgentAutonomyPolicy,
  resolveAgentAutonomyPolicyFromSettings,
} from '../agent-autonomy-policy'

describe('normalizeAgentAutonomyPolicy', () => {
  it('defaults chat roles, preserves an empty deny-all, and fails closed on a malformed allowlist', () => {
    expect(normalizeAgentAutonomyPolicy({}).chat_can_delegate_to).toEqual(['researcher', 'writer', 'correspondent'])
    for (const bad of [[], ['developer'], ['writer', 'boss'], 'writer', null]) expect(normalizeAgentAutonomyPolicy({ chat_can_delegate_to: bad }).chat_can_delegate_to).toEqual([])
    expect(normalizeAgentAutonomyPolicy({ chat_can_delegate_to: ['writer', 'writer'] }).chat_can_delegate_to).toEqual(['writer'])
    for (const cap of [null, '3', -1, 1.5, 501]) expect(normalizeAgentAutonomyPolicy({ max_chat_delegations_per_day: cap }).chat_can_delegate_to).toEqual([])
  })

  it('no blob, or a non-object, is the default (attempt)', () => {
    for (const raw of [undefined, null, 'attempt', 7, [], true]) {
      expect(normalizeAgentAutonomyPolicy(raw), String(raw)).toEqual(DEFAULT_AGENT_AUTONOMY_POLICY)
    }
    expect(normalizeAgentAutonomyPolicy({})).toEqual(DEFAULT_AGENT_AUTONOMY_POLICY)
    expect(DEFAULT_AGENT_AUTONOMY_POLICY.mode).toBe('attempt')
  })

  it('a malformed budget with no stored mode fails closed too: the default attempt → propose', () => {
    expect(normalizeAgentAutonomyPolicy({ max_attempts_per_day: -1 }).mode).toBe('propose')
    expect(normalizeAgentAutonomyPolicy({ attempt_min_confidence: 2 }).mode).toBe('propose')
  })

  it('a well-formed attempt policy is honoured field by field', () => {
    const out = normalizeAgentAutonomyPolicy({
      mode: 'attempt',
      attempt_min_confidence: 0.6,
      max_attempts_per_capture: 2,
      max_attempts_per_day: 25,
      max_attempts_per_root: 4,
      max_delegation_depth: 1,
      max_fan_out: 2,
      role_breaker_window: 5,
      role_breaker_quiet_days: 3,
      role_breaker_resumed_at: { writer: '2026-09-20T10:00:00Z' },
    })
    expect(out).toEqual({
      chat_can_delegate_to: ['researcher', 'writer', 'correspondent'],
      max_chat_delegations_per_day: 10,
      max_chat_delegations_per_conversation: 3,
      mode: 'attempt',
      attempt_min_confidence: 0.6,
      max_attempts_per_capture: 2,
      max_attempts_per_day: 25,
      max_attempts_per_root: 4,
      max_delegation_depth: 1,
      max_fan_out: 2,
      role_breaker_window: 5,
      role_breaker_quiet_days: 3,
      role_breaker_resumed_at: { writer: '2026-09-20T10:00:00.000Z' },
    })
  })

  it('the breaker defaults: window 3, a 7-day quiet period, no manual resumes', () => {
    const out = normalizeAgentAutonomyPolicy({ mode: 'attempt' })
    expect(out.role_breaker_window).toBe(3)
    expect(out.role_breaker_quiet_days).toBe(7)
    expect(out.role_breaker_resumed_at).toEqual({})
  })

  it('a malformed quiet period refuses attempt like any bad number; bad resume entries are dropped without refusing', () => {
    expect(normalizeAgentAutonomyPolicy({ mode: 'attempt', role_breaker_quiet_days: -1 }).mode).toBe('propose')
    const out = normalizeAgentAutonomyPolicy({
      mode: 'attempt',
      role_breaker_resumed_at: { researcher: 'not a date', clerk: '2026-09-20T10:00:00Z', writer: 7, correspondent: '2026-09-21' },
    })
    expect(out.mode).toBe('attempt')
    expect(out.role_breaker_resumed_at).toEqual({ correspondent: '2026-09-21T00:00:00.000Z' })
    expect(normalizeAgentAutonomyPolicy({ mode: 'attempt', role_breaker_resumed_at: ['researcher'] }).role_breaker_resumed_at).toEqual({})
  })

  it('the frozen default map is never shared with a returned policy', () => {
    const a = normalizeAgentAutonomyPolicy(null)
    a.role_breaker_resumed_at.researcher = '2026-01-01T00:00:00.000Z'
    expect(normalizeAgentAutonomyPolicy(null).role_breaker_resumed_at).toEqual({})
  })

  it('absent numbers take the defaults and do NOT refuse attempt', () => {
    const out = normalizeAgentAutonomyPolicy({ mode: 'attempt' })
    expect(out.mode).toBe('attempt')
    for (const key of AGENT_AUTONOMY_NUMERIC_KEYS) expect(out[key]).toBe(DEFAULT_AGENT_AUTONOMY_POLICY[key])
  })

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['negative', -1],
    ['fractional', 1.5],
    ['a numeric string', '3'],
    ['null', null],
    ['an object', { n: 3 }],
  ])('a malformed budget (%s) fails closed: attempt → propose, the field → default', (_label, bad) => {
    for (const key of AGENT_AUTONOMY_NUMERIC_KEYS) {
      const out = normalizeAgentAutonomyPolicy({ mode: 'attempt', [key]: bad })
      expect(out.mode, key).toBe('propose')
      expect(out[key], key).toBe(DEFAULT_AGENT_AUTONOMY_POLICY[key])
    }
  })

  it('the attempt bar: a number in [0,1] is kept; absent or null is the flow’s own bar', () => {
    expect(DEFAULT_AGENT_AUTONOMY_POLICY.attempt_min_confidence).toBeNull()
    expect(normalizeAgentAutonomyPolicy({ mode: 'attempt', attempt_min_confidence: 0.6 })).toMatchObject({ mode: 'attempt', attempt_min_confidence: 0.6 })
    expect(normalizeAgentAutonomyPolicy({ mode: 'attempt', attempt_min_confidence: 0 }).attempt_min_confidence).toBe(0)
    expect(normalizeAgentAutonomyPolicy({ mode: 'attempt', attempt_min_confidence: null })).toMatchObject({ mode: 'attempt', attempt_min_confidence: null })
    expect(normalizeAgentAutonomyPolicy({ mode: 'attempt' }).attempt_min_confidence).toBeNull()
  })

  it.each([['above 1', 1.2], ['negative', -0.1], ['NaN', NaN], ['a string', '0.6']])(
    'a malformed attempt bar (%s) fails closed: attempt → propose, the flow’s bar',
    (_label, bad) => {
      expect(normalizeAgentAutonomyPolicy({ mode: 'attempt', attempt_min_confidence: bad })).toMatchObject({ mode: 'propose', attempt_min_confidence: null })
    },
  )

  it('a malformed budget under propose or off leaves the mode alone (off is never widened)', () => {
    expect(normalizeAgentAutonomyPolicy({ mode: 'off', max_fan_out: NaN }).mode).toBe('off')
    expect(normalizeAgentAutonomyPolicy({ mode: 'propose', max_fan_out: 'x' }).mode).toBe('propose')
  })

  it('an unknown mode is the default mode; zero is a valid budget', () => {
    expect(normalizeAgentAutonomyPolicy({ mode: 'yolo' }).mode).toBe('attempt')
    expect(normalizeAgentAutonomyPolicy({ mode: 'attempt', max_attempts_per_day: 0 })).toMatchObject({
      mode: 'attempt',
      max_attempts_per_day: 0,
    })
  })

  it('never mutates the default', () => {
    const out = normalizeAgentAutonomyPolicy({ mode: 'off', max_fan_out: 9 })
    out.max_fan_out = 1
    expect(DEFAULT_AGENT_AUTONOMY_POLICY.max_fan_out).toBe(3)
    expect(DEFAULT_AGENT_AUTONOMY_POLICY.mode).toBe('attempt')
  })
})

describe('resolveAgentAutonomyPolicyFromSettings / resolveAgentAutonomyPolicy', () => {
  it('reads settings.agent_autonomy; anything else is the default', () => {
    expect(resolveAgentAutonomyPolicyFromSettings({ agent_autonomy: { mode: 'off' } }).mode).toBe('off')
    expect(resolveAgentAutonomyPolicyFromSettings({ trust: {} })).toEqual(DEFAULT_AGENT_AUTONOMY_POLICY)
    expect(resolveAgentAutonomyPolicyFromSettings(null)).toEqual(DEFAULT_AGENT_AUTONOMY_POLICY)
  })

  it('a failed settings read fails closed (the default numbers, mode propose), never a throw; a missing row is the default', async () => {
    const failClosed = { ...DEFAULT_AGENT_AUTONOMY_POLICY, mode: 'propose' }
    const throwing = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockRejectedValue(new Error('rls')) }) }) }),
    }
    await expect(resolveAgentAutonomyPolicy(throwing as never, 'ws-1')).resolves.toEqual(failClosed)
    const erroring = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'timeout' } }) }) }) }),
    }
    await expect(resolveAgentAutonomyPolicy(erroring as never, 'ws-1')).resolves.toEqual(failClosed)
    const missing = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    }
    await expect(resolveAgentAutonomyPolicy(missing as never, 'ws-1')).resolves.toEqual(DEFAULT_AGENT_AUTONOMY_POLICY)
    const found = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { settings: { agent_autonomy: { mode: 'attempt', max_fan_out: 1 } } } }) }),
        }),
      }),
    }
    await expect(resolveAgentAutonomyPolicy(found as never, 'ws-1')).resolves.toMatchObject({ mode: 'attempt', max_fan_out: 1 })
  })
})
