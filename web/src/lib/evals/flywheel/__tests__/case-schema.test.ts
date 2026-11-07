import { describe, it, expect } from 'vitest'
import { SKILL_EVAL_CASE_KEYS, caseShapeErrors, type SkillEvalCase } from '@/lib/packs/skill-evals'
import { FLYWHEEL_SKILL_CASE_KEYS, flywheelCaseSchema, flywheelSkillCaseSchema, validateCaseDraft, type FlywheelSkillCase } from '../case-schema'
import { FLYWHEEL_LIMITS } from '../types'
import { jsonbTextBytes } from '../bytes'

/**
 * Every field of a SkillEvalCase, set. `Required<>` makes a field added to the
 * type fail to compile here until it is added; the object literal refuses a
 * field the type lacks.
 */
const everyField: Required<SkillEvalCase> = {
  request: "what's on my plate today?",
  loads: ['my-todo-list'],
  tools: ['list_actions'],
  params: { list_actions: { assignee: 'me' } },
  avoid: ['create_action'],
  forbidParams: { list_actions: [{ filter: 'completed' }] },
  why: 'the to-do list is list_actions for me',
  noToolErrors: true,
}

// Both ways assignable: a flywheel case IS a SkillEvalCase.
const asSkillCase: SkillEvalCase = {} as FlywheelSkillCase
const asFlywheelCase: FlywheelSkillCase = {} as SkillEvalCase
void asSkillCase
void asFlywheelCase

describe('the flywheel case and SkillEvalCase stay in sync', () => {
  it('have the same keys: the type, caseShapeErrors and the schema', () => {
    const typeKeys = Object.keys(everyField).sort()
    expect([...FLYWHEEL_SKILL_CASE_KEYS].sort(), 'flywheelSkillCaseSchema (src/lib/evals/flywheel/case-schema.ts)').toEqual(typeKeys)
    expect([...SKILL_EVAL_CASE_KEYS].sort(), 'SKILL_EVAL_CASE_KEYS (src/lib/packs/skill-evals/index.ts)').toEqual(typeKeys)
  })

  it('both accept a case with every field', () => {
    expect(caseShapeErrors(everyField)).toEqual([])
    expect(flywheelSkillCaseSchema.safeParse(everyField).success).toBe(true)
  })
})

describe('flywheelSkillCaseSchema', () => {
  const base = { request: 'x', loads: [], tools: ['list_actions'] }

  it('refuses what caseShapeErrors refuses', () => {
    const bad = [
      { ...base, request: '   ' },
      { ...base, loads: 'my-todo-list' },
      { ...base, tools: [''] },
      { ...base, params: { list_actions: [] } },
      { ...base, avoid: ['list_actions'] },
      { ...base, avoid: ['show'], params: { show: {} } },
      { ...base, avoid: ['show'], forbidParams: { show: {} } },
      { ...base, noToolErrors: 'yes' },
      { ...base, extra: 1 },
    ]
    for (const c of bad) {
      expect(caseShapeErrors(c), JSON.stringify(c)).not.toEqual([])
      expect(flywheelSkillCaseSchema.safeParse(c).success, JSON.stringify(c)).toBe(false)
    }
  })
})

describe('flywheelCaseSchema', () => {
  const entry = {
    candidateId: 'c-1',
    skill: 'instructions',
    source: 'thumbs_up',
    polarity: 'good',
    promotedAt: '2026-10-16T09:00:00.123456+00:00',
    case: { request: 'hi', loads: [], tools: [] },
  }

  it('takes an exported case, with a Postgres timestamp', () => {
    expect(flywheelCaseSchema.safeParse(entry).success).toBe(true)
  })

  it('refuses a mismatched polarity, an unknown source, a bad date and a bad slug', () => {
    expect(flywheelCaseSchema.safeParse({ ...entry, polarity: 'bad' }).success).toBe(false)
    expect(flywheelCaseSchema.safeParse({ ...entry, source: 'thumbs_sideways' }).success).toBe(false)
    expect(flywheelCaseSchema.safeParse({ ...entry, promotedAt: 'yesterday' }).success).toBe(false)
    expect(flywheelCaseSchema.safeParse({ ...entry, skill: 'Write_In_Tone' }).success).toBe(false)
  })
})

describe('validateCaseDraft', () => {
  it('returns the skill and the case', () => {
    const v = validateCaseDraft({ skill: 'my-todo-list', case: { ...everyField, request: '  padded  ' } })
    expect(v).toEqual({ ok: true, value: { skill: 'my-todo-list', case: { ...everyField, request: 'padded' } } })
  })

  it('takes instructions as a skill', () => {
    expect(validateCaseDraft({ skill: 'instructions', case: { request: 'x', loads: [], tools: [] } }).ok).toBe(true)
  })

  it('says what is wrong, by path', () => {
    const v = validateCaseDraft({ skill: 'Not A Slug', case: { request: '', loads: [], tools: [] } })
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.error).toContain('skill: a skill slug in kebab-case')
      expect(v.error).toContain('case.request: the request the person types')
    }
    expect(validateCaseDraft(null).ok).toBe(false)
    expect(validateCaseDraft({ skill: 'x', case: { request: 'x', loads: [], tools: [] }, extra: 1 }).ok).toBe(false)
  })

  it('refuses a draft over the case_draft limit', () => {
    const params = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`t${i}`, { q: 'x'.repeat(40) }]))
    const v = validateCaseDraft({ skill: 'x', case: { request: 'x', loads: [], tools: [], params } })
    expect(v).toEqual({ ok: false, error: expect.stringContaining(`the most is ${FLYWHEEL_LIMITS.caseDraftBytes}`) })
  })

  it('measures the limit as the check does (case_draft::text), to the byte', () => {
    const draft = (pad: number) => ({ skill: 'x', case: { request: 'x', loads: ['a', 'b'], tools: ['t'], params: { t: { q: 'y'.repeat(pad) } } } })
    const atLimit = FLYWHEEL_LIMITS.caseDraftBytes - jsonbTextBytes(draft(0))
    expect(jsonbTextBytes(draft(atLimit))).toBe(FLYWHEEL_LIMITS.caseDraftBytes)
    expect(validateCaseDraft(draft(atLimit)).ok).toBe(true)
    // One byte over: refused, though the compact JSON (no spaces) is well under.
    expect(JSON.stringify(draft(atLimit + 1)).length).toBeLessThan(FLYWHEEL_LIMITS.caseDraftBytes)
    expect(validateCaseDraft(draft(atLimit + 1))).toEqual({ ok: false, error: `the case is ${FLYWHEEL_LIMITS.caseDraftBytes + 1} bytes; the most is ${FLYWHEEL_LIMITS.caseDraftBytes}` })
  })
})
