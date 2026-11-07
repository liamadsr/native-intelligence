/**
 * The call_tool config at save time (queries.ts, F4): its shape, a known
 * template vocabulary, the size a card can show; validateActions keeps it,
 * rejects a reference to a step it does not chain off, and a skill step's
 * connections are ids. A call_tool step is risky (its switch-on is a card).
 */
import { describe, expect, it } from 'vitest'
import { CALL_TOOL_INPUT_MAX_BYTES, validateActions, validateCallToolConfig, validateRunSkillConfig } from '../queries'
import { isRiskyAction } from '../flow-approvals'

const CONN = '22222222-2222-4222-8222-222222222222'
const SKILL = '11111111-1111-4111-8111-111111111111'

describe('validateCallToolConfig', () => {
  it('keeps a connection id, the tool name and a templated input', () => {
    expect(validateCallToolConfig({ connection: CONN, tool: 'append_block', input: { text: '{{steps.lens.output}}' } })).toEqual({
      connection: CONN, tool: 'append_block', input: { text: '{{steps.lens.output}}' },
    })
  })

  it('refuses a non-id connection, a bad tool name, a non-object input, an unknown token, an input too big to show', () => {
    expect(validateCallToolConfig({ connection: 'notion', tool: 't', input: {} })).toBeInstanceOf(Error)
    expect(validateCallToolConfig({ connection: CONN, tool: 'has space', input: {} })).toBeInstanceOf(Error)
    expect(validateCallToolConfig({ connection: CONN, tool: 't', input: [] })).toBeInstanceOf(Error)
    expect(String(validateCallToolConfig({ connection: CONN, tool: 't', input: { a: '{{env.SECRET}}' } }))).toContain('{{env.SECRET}}')
    expect(validateCallToolConfig({ connection: CONN, tool: 't', input: { a: 'x'.repeat(CALL_TOOL_INPUT_MAX_BYTES) } })).toBeInstanceOf(Error)
  })
})

describe('validateActions with data passing', () => {
  const skill = { id: 'lens', type: 'run_skill', config: { skill_id: SKILL, mode: 'report' } }
  it('keeps a call_tool that uses its parent\'s output', () => {
    const out = validateActions([skill, { id: 'log', type: 'call_tool', parent_id: 'lens', config: { connection: CONN, tool: 'append_block', input: { text: '{{steps.lens.output}}' } } }])
    expect(out).not.toBeInstanceOf(Error)
    expect((out as Array<{ type: string }>)[1].type).toBe('call_tool')
  })

  it('rejects one that uses a step it does not chain off', () => {
    const out = validateActions([skill, { id: 'log', type: 'call_tool', parent_id: null, config: { connection: CONN, tool: 'append_block', input: { text: '{{steps.lens.output}}' } } }])
    expect(String(out)).toContain('must chain off "lens"')
  })

  it('a skill step\'s connections are connection ids, at most 5', () => {
    expect(validateRunSkillConfig({ skill_id: SKILL, mode: 'act', connections: [CONN, CONN] })).toMatchObject({ connections: [CONN] })
    expect(validateRunSkillConfig({ skill_id: SKILL, connections: ['notion'] })).toBeInstanceOf(Error)
    expect(validateRunSkillConfig({ skill_id: SKILL, connections: [] })).not.toHaveProperty('connections')
  })
})

describe('isRiskyAction (F1\'s switch-on card)', () => {
  it('a call_tool, or a skill given connections, is risky; a plain report skill is not', () => {
    expect(isRiskyAction({ type: 'call_tool', config: { connection: CONN, tool: 'x', input: {} } })).toBe(true)
    expect(isRiskyAction({ type: 'run_skill', config: { skill_id: SKILL, mode: 'report', connections: [CONN] } })).toBe(true)
    expect(isRiskyAction({ type: 'run_skill', config: { skill_id: SKILL, mode: 'report' } })).toBe(false)
  })
})

describe('N2: a run_agent step can\'t use step outputs', () => {
  it('is refused at save, never rendered empty', () => {
    const out = validateActions([
      { id: 'lens', type: 'run_skill', config: { skill_id: SKILL, mode: 'report' } },
      { id: 'code', type: 'run_agent', parent_id: 'lens', config: { agent_id: SKILL, repo: 'a/b', instructions: 'Fix {{steps.lens.output}}' } },
    ])
    expect(String(out)).toContain("a run_agent step can't use another step's output")
  })
})
