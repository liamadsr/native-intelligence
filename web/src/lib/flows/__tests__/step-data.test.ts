/**
 * F4 step outputs: redacted of secrets, capped per step and per run, and a
 * step may only use the output of a step it chains off.
 */
import { describe, expect, it } from 'vitest'
import {
  capStepOutput,
  findBadStepReference,
  flowPassesData,
  parseStepOutputs,
  redactSecrets,
  REDACTED,
  RUN_OUTPUTS_MAX_CHARS,
  STEP_OUTPUT_MAX_CHARS,
  withStepOutput,
} from '../step-data'
import type { FlowAction } from '../types'

describe('redactSecrets', () => {
  it('removes tokens, keys and secret-named fields, keeping the rest', () => {
    const text = [
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
      'key sk-live-abcdefghijklmnopqrstuvwx',
      'gh token ghp_abcdefghijklmnopqrstuvwxyz0123',
      'slack xoxb-1234567890-abcdefghij',
      'aws AKIAABCDEFGHIJKLMNOP',
      '{"password": "hunter2", "title": "Q3 plan"}',
      'api_key=abc123def',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepart123',
    ].join('\n')
    const out = redactSecrets(text)
    for (const secret of ['abcdefghijklmnopqrstuvwxyz123456', 'sk-live-', 'ghp_', 'xoxb-', 'AKIAABCD', 'hunter2', 'abc123def', 'eyJhbGci']) {
      expect(out).not.toContain(secret)
    }
    expect(out).toContain('Q3 plan')
    expect(out).toContain(REDACTED)
  })

  it('leaves ordinary prose alone', () => {
    const prose = 'They asked about SSO pricing and the token of appreciation they sent.'
    expect(redactSecrets(prose)).toBe(prose)
  })
})

describe('caps', () => {
  it('a step keeps at most STEP_OUTPUT_MAX_CHARS, marked truncated', () => {
    const out = capStepOutput('x'.repeat(STEP_OUTPUT_MAX_CHARS + 50))
    expect(out.truncated).toBe(true)
    expect(out.output.length).toBeLessThan(STEP_OUTPUT_MAX_CHARS + 20)
  })

  it('the run keeps at most RUN_OUTPUTS_MAX_CHARS across its steps', () => {
    let outputs = {}
    for (let i = 0; i < 6; i++) outputs = withStepOutput(outputs, `s${i}`, 'y'.repeat(STEP_OUTPUT_MAX_CHARS))
    const total = Object.values(outputs as Record<string, { output: string }>).reduce((n, v) => n + v.output.length, 0)
    expect(total).toBeLessThanOrEqual(RUN_OUTPUTS_MAX_CHARS + 6 * 20)
  })

  it('re-reads stored outputs defensively', () => {
    expect(parseStepOutputs({ a: { output: 'x' }, b: { output: 3 }, c: null, d: { output: 'y', truncated: true } })).toEqual({ a: { output: 'x' }, d: { output: 'y', truncated: true } })
    expect(parseStepOutputs('nope')).toEqual({})
  })
})

const step = (id: string, parent: string | null, config: Record<string, unknown>, type: FlowAction['type'] = 'call_tool') =>
  ({ id, parent_id: parent, type, config }) as Pick<FlowAction, 'id' | 'type' | 'config' | 'parent_id'>

describe('findBadStepReference (the save-time rule)', () => {
  it('a step may use its ancestors\' outputs', () => {
    const actions = [
      step('summarise', null, { skill_id: 'x', instructions: '' }, 'run_skill'),
      step('draft', 'summarise', { skill_id: 'y', instructions: 'Draft from {{steps.summarise.output}}' }, 'run_skill'),
      step('queue', 'draft', { connection: 'c', tool: 't', input: { text: '{{steps.draft.output}}', note: '{{steps.summarise.output}}' } }),
    ]
    expect(findBadStepReference(actions)).toBeNull()
  })

  it('refuses a sibling, an unknown step and its own output, saying why', () => {
    expect(findBadStepReference([step('a', null, { input: {} }), step('b', null, { input: { t: '{{steps.a.output}}' } })])?.message).toContain('must chain off "a"')
    expect(findBadStepReference([step('a', null, { input: { t: '{{steps.ghost.output}}' } })])?.message).toContain('names no step')
    expect(findBadStepReference([step('a', null, { input: { t: '{{steps.a.output}}' } })])?.message).toContain('its own output')
  })
})

describe('flowPassesData', () => {
  it('only a flow with a call_tool or a step reference keeps outputs (no cost otherwise)', () => {
    expect(flowPassesData([{ type: 'run_skill', config: { skill_id: 'x', instructions: 'hi {{entity.name}}' } } as never])).toBe(false)
    expect(flowPassesData([{ type: 'http_post', config: { body_template: '{"t":"{{steps.a.output}}"}' } } as never])).toBe(true)
    expect(flowPassesData([{ type: 'call_tool', config: { connection: 'c', tool: 't', input: {} } } as never])).toBe(true)
  })
})
