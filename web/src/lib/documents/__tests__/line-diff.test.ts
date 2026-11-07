import { describe, expect, it } from 'vitest'
import { diffLines, diffStats, foldDiff, matchLines, merge3 } from '../line-diff'

describe('matchLines / diffLines', () => {
  it('finds the unchanged lines in order', () => {
    expect(matchLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])).toEqual([
      [0, 0],
      [2, 2],
      [3, 3],
    ])
  })

  it('diffs a one-line change in a long document', () => {
    const before = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const after = before.replace('line 250', 'line 250 edited')
    const d = diffLines(before, after)
    expect(diffStats(d)).toEqual({ added: 1, removed: 1 })
    expect(d.find((l) => l.kind === 'removed')).toMatchObject({ text: 'line 250', oldLine: 251 })
    expect(d.find((l) => l.kind === 'added')).toMatchObject({ text: 'line 250 edited', newLine: 251 })
  })

  it('handles an empty side and no change', () => {
    expect(diffStats(diffLines('', 'a\nb'))).toEqual({ added: 2, removed: 1 })
    expect(diffStats(diffLines('a', 'a'))).toEqual({ added: 0, removed: 0 })
  })

  it('finds matches in the middle of interleaved changes', () => {
    const d = diffLines('a\nb\nc\nd\ne', 'a\nB\nc\nD\ne')
    expect(d.map((l) => `${l.kind[0]}${l.text}`)).toEqual(['sa', 'rb', 'aB', 'sc', 'rd', 'aD', 'se'])
  })

  it('folds unchanged runs around the changes', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
    const after = before.replace('l10', 'L10')
    const folded = foldDiff(diffLines(before, after), 2)
    expect(folded[0]).toEqual({ kind: 'fold', count: 8 })
    expect(folded.filter((l) => l.kind !== 'fold')).toHaveLength(6)
    expect(folded[folded.length - 1]).toEqual({ kind: 'fold', count: 7 })
  })

  it('a full rewrite is one changed block', () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`).join('\n')
    expect(diffStats(diffLines(a, b))).toEqual({ added: 50, removed: 50 })
  })
})

describe('merge3', () => {
  const base = ['# Plan', '', '## Goals', 'Ship it.', '', '## Risks', 'None yet.', ''].join('\n')

  it('keeps both sides when they touch different lines', () => {
    const mine = base.replace('Ship it.', 'Ship it by Friday.')
    const theirs = base.replace('None yet.', 'Vendor delay.')
    expect(merge3(base, mine, theirs)).toEqual({
      ok: true,
      text: base.replace('Ship it.', 'Ship it by Friday.').replace('None yet.', 'Vendor delay.'),
    })
  })

  it('keeps a change both sides made once (the editor already shows the agent edit)', () => {
    const agent = base.replace('None yet.', 'Vendor delay.')
    const mine = agent.replace('Ship it.', 'Ship it now.')
    expect(merge3(base, mine, agent)).toEqual({ ok: true, text: mine })
  })

  it('refuses two different changes to the same line', () => {
    expect(merge3(base, base.replace('Ship it.', 'A'), base.replace('Ship it.', 'B'))).toEqual({ ok: false })
  })

  it('short-circuits when one side is unchanged', () => {
    const theirs = base + '\nmore'
    expect(merge3(base, base, theirs)).toEqual({ ok: true, text: theirs })
    expect(merge3(base, theirs, base)).toEqual({ ok: true, text: theirs })
  })

  it('merges an inserted section with an edit elsewhere', () => {
    const mine = base.replace('## Risks', '## Notes\nCall Ana.\n\n## Risks')
    const theirs = base.replace('# Plan', '# Plan v2')
    const r = merge3(base, mine, theirs)
    expect(r.ok && r.text).toBe(mine.replace('# Plan', '# Plan v2'))
  })
})
