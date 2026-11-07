import { describe, it, expect } from 'vitest'
import { mergeFlywheelExport, serializeFlywheelCases } from '../import'

function entry(candidateId: string, skill: string, promotedAt: string, request = `request ${candidateId}`) {
  return { candidateId, skill, source: 'thumbs_down', polarity: 'bad', promotedAt, case: { request, loads: [], tools: [] } }
}

describe('mergeFlywheelExport', () => {
  const existing = [entry('a', 'my-todo-list', '2026-10-10T00:00:00Z')]

  it('adds new candidates, skips ones already in the file or twice in the export, and sorts by skill then promotedAt', () => {
    const out = mergeFlywheelExport(existing, [
      entry('b', 'my-todo-list', '2026-10-09T00:00:00Z'),
      entry('a', 'my-todo-list', '2026-10-10T00:00:00Z'),
      entry('c', 'instructions', '2026-10-12T00:00:00Z'),
      entry('b', 'my-todo-list', '2026-10-09T00:00:00Z'),
    ])
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.cases.map((c) => c.candidateId)).toEqual(['c', 'b', 'a'])
    expect(out.added.map((c) => c.candidateId)).toEqual(['c', 'b'])
    expect(out.skipped).toEqual([
      { candidateId: 'a', skill: 'my-todo-list', why: 'already in flywheel.json' },
      { candidateId: 'b', skill: 'my-todo-list', why: 'twice in the export' },
    ])
  })

  it('is stable: importing the same export again adds nothing and keeps the text', () => {
    const exported = [entry('b', 'meeting-prep', '2026-10-09T00:00:00Z'), entry('c', 'meeting-prep', '2026-10-09T00:00:00Z')]
    const first = mergeFlywheelExport(existing, exported)
    if (!first.ok) throw new Error('expected ok')
    const again = mergeFlywheelExport(JSON.parse(serializeFlywheelCases(first.cases)), exported)
    if (!again.ok) throw new Error('expected ok')
    expect(again.added).toEqual([])
    expect(serializeFlywheelCases(again.cases)).toBe(serializeFlywheelCases(first.cases))
    // Same skill and time: candidateId breaks the tie.
    expect(first.cases.map((c) => c.candidateId)).toEqual(['b', 'c', 'a'])
  })

  it('refuses the whole import on one bad entry, naming it', () => {
    const out = mergeFlywheelExport(existing, [entry('b', 'my-todo-list', '2026-10-09T00:00:00Z'), { ...entry('x', 'Bad Slug', '2026-10-09T00:00:00Z'), case: { request: '', loads: [], tools: [] } }])
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]).toMatch(/^export\[1\] \(x\): /)
    expect(out.errors[0]).toContain('skill')
    expect(out.errors[0]).toContain('case.request')
  })

  it('refuses a file or an export that is not a list', () => {
    expect(mergeFlywheelExport({}, [])).toEqual({ ok: false, errors: ['flywheel.json: not a JSON array of cases'] })
    expect(mergeFlywheelExport([], { cases: [] })).toEqual({ ok: false, errors: ['export: not a JSON array of cases'] })
  })

  it('serializes as two-space JSON with a final newline ([] for none)', () => {
    expect(serializeFlywheelCases([])).toBe('[]\n')
  })
})
