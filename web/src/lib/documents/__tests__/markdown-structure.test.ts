import { describe, expect, it } from 'vitest'
import {
  appendToSection,
  findMatches,
  findSection,
  insertSectionAfter,
  numberedLines,
  parseOutline,
  rebaseLineRange,
  removeSection,
  replaceLines,
  replaceSection,
  splitLines,
} from '../markdown-structure'

const DOC = [
  '# Product', // 1
  '', // 2
  'Dial8 captures meetings.', // 3
  '', // 4
  '## Positioning', // 5
  'For founders.', // 6
  '', // 7
  '### Real alternative', // 8
  'Granola plus Linear.', // 9
  '', // 10
  '## Pricing', // 11
  'Free while in beta.', // 12
  '', // 13
  '```md', // 14
  '## Not a heading', // 15
  '```', // 16
  '', // 17
  '## Positioning', // 18
  'A second section with the same heading.', // 19
].join('\n')

describe('parseOutline', () => {
  it('lists headings with level, line, extent and path, skipping fenced code', () => {
    const o = parseOutline(DOC)
    expect(o.map((e) => [e.heading, e.level, e.line, e.endLine, e.ownEndLine])).toEqual([
      ['Product', 1, 1, 19, 4],
      ['Positioning', 2, 5, 10, 7],
      ['Real alternative', 3, 8, 10, 10],
      ['Pricing', 2, 11, 17, 17],
      ['Positioning', 2, 18, 19, 19],
    ])
    expect(o[2].path).toEqual(['Product', 'Positioning', 'Real alternative'])
    expect(o[1].chars).toBe(splitLines(DOC).slice(4, 10).join('\n').length)
  })

  it('reads closing #s and emphasis-free text', () => {
    expect(parseOutline('## Goals ##\ntext').map((e) => e.heading)).toEqual(['Goals'])
    expect(parseOutline('#NoSpace\n#  \n')).toEqual([])
  })
})

describe('parseOutline: fences close as CommonMark says', () => {
  it('a shorter or other-character run, or one with text after it, does not close a fence', () => {
    const body = ['````md', '```', '# Not a heading', '~~~~', '```` still code', '# Still not', '````', '# Real'].join('\n')
    expect(parseOutline(body).map((e) => e.heading)).toEqual(['Real'])
  })

  it('a longer run of the same character closes it', () => {
    expect(parseOutline(['~~~', '# Hidden', '~~~~~', '# Shown'].join('\n')).map((e) => e.heading)).toEqual(['Shown'])
  })
})

describe('findSection', () => {
  const o = parseOutline(DOC)

  it('finds a unique heading, ignoring case and emphasis', () => {
    const r = findSection(o, '**pricing**')
    expect(r.ok && r.entry.line).toBe(11)
  })

  it('refuses an ambiguous heading with the candidates', () => {
    const r = findSection(o, 'Positioning')
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous' })
    expect(!r.ok && r.matches.map((m) => m.line)).toEqual([5, 18])
  })

  it('a path tells them apart', () => {
    const r = findSection(o, 'Positioning > Real alternative')
    expect(r.ok && r.entry.line).toBe(8)
    expect(findSection(o, 'Pricing > Real alternative').ok).toBe(false)
  })

  it('not found', () => {
    expect(findSection(o, 'Roadmap')).toMatchObject({ ok: false, reason: 'not_found', matches: [] })
  })
})

describe('reads', () => {
  it('numbers lines', () => {
    expect(numberedLines(splitLines(DOC), 11, 12)).toBe('11: ## Pricing\n12: Free while in beta.')
  })

  it('finds a phrase in the middle, with context and its section', () => {
    const r = findMatches(DOC, 'granola', 1)
    expect(r.mode).toBe('exact')
    expect(r.passages).toEqual([
      { from: 8, to: 10, match_lines: [9], section: 'Product > Positioning > Real alternative', text: '8: ### Real alternative\n9: Granola plus Linear.\n10: ' },
    ])
  })

  it('merges overlapping passages, and falls back to all the words on one line', () => {
    expect(findMatches(DOC, 'Positioning', 2).passages.map((p) => [p.from, p.to])).toEqual([
      [3, 7],
      [16, 19],
    ])
    const loose = findMatches(DOC, 'linear granola', 0)
    expect(loose.mode).toBe('all_words')
    expect(loose.passages[0].match_lines).toEqual([9])
    expect(findMatches(DOC, 'nowhere at all', 1)).toMatchObject({ mode: 'none', passages: [] })
  })

  it('a phrase across a line break counts on its first line', () => {
    expect(findMatches('one two\nthree four', 'two\nthree', 0).passages[0].match_lines).toEqual([1])
  })
})

describe('line edits', () => {
  const body = 'a\nb\nc\nd'

  it('replaces, inserts and deletes', () => {
    expect(replaceLines(body, 2, 3, 'B\nC')).toEqual({ ok: true, content: 'a\nB\nC\nd' })
    expect(replaceLines(body, 3, 2, 'x')).toEqual({ ok: true, content: 'a\nb\nx\nc\nd' })
    expect(replaceLines(body, 5, 4, 'e')).toEqual({ ok: true, content: 'a\nb\nc\nd\ne' })
    expect(replaceLines(body, 2, 2, '')).toEqual({ ok: true, content: 'a\nc\nd' })
    expect(replaceLines(body, 1, 1, '\n')).toEqual({ ok: true, content: '\nb\nc\nd' })
  })

  it('refuses a range outside the document', () => {
    expect(replaceLines(body, 0, 1, 'x').ok).toBe(false)
    expect(replaceLines(body, 6, 5, 'x').ok).toBe(false)
    expect(replaceLines(body, 2, 9, 'x').ok).toBe(false)
    expect(replaceLines(body, 3, 1, 'x').ok).toBe(false)
  })

  it('rebases a range read at an older revision onto the current text', () => {
    const base = 'intro\n## Risks\nNone yet.\nend'
    const now = 'new line\nintro\n## Risks\nNone yet.\nend'
    expect(rebaseLineRange(base, now, 3, 3)).toEqual({ from: 4, to: 4 })
    // An insert between two lines that moved.
    expect(rebaseLineRange(base, now, 3, 2)).toEqual({ from: 4, to: 3 })
    // The block is gone, or no longer unique, or only blank lines: not placed.
    expect(rebaseLineRange(base, 'intro\nend', 3, 3)).toBeNull()
    expect(rebaseLineRange(base, `${now}\nNone yet.`, 3, 3)).toBeNull()
    expect(rebaseLineRange('a\n\nb', 'x\na\n\nb', 2, 2)).toBeNull()
  })
})

describe('line edits on a body that ends in a newline', () => {
  const body = 'a\nb\n' // lines: a, b, and the empty last line
  it('appending at the end goes before the empty last line, and the newline stays', () => {
    expect(replaceLines(body, 4, 3, 'c')).toEqual({ ok: true, content: 'a\nb\nc\n' })
  })

  it('an edit that takes in the empty last line keeps the newline; deleting everything leaves nothing', () => {
    expect(replaceLines(body, 1, 3, 'x')).toEqual({ ok: true, content: 'x\n' })
    expect(replaceLines(body, 2, 2, 'B')).toEqual({ ok: true, content: 'a\nB\n' })
    expect(replaceLines(body, 1, 3, '')).toEqual({ ok: true, content: '' })
  })
})

describe('section edits', () => {
  const o = parseOutline(DOC)
  const pricing = o[3]
  const real = o[2]
  const positioning = o[1]

  it('replace_section keeps the heading, its spacing and the rest', () => {
    const next = replaceSection(DOC, pricing, 'Paid from January.')
    expect(next).toContain('## Pricing\nPaid from January.\n\n## Positioning')
    // A blank line under the heading stays one.
    expect(replaceSection('# A\n\n## B\n\nold\n', parseOutline('# A\n\n## B\n\nold\n')[1], 'new')).toBe('# A\n\n## B\n\nnew\n')
    expect(next).not.toContain('Free while in beta.')
    expect(next).not.toContain('Not a heading')
    expect(next.startsWith('# Product\n\nDial8 captures meetings.')).toBe(true)
  })

  it('replace_section can rename the heading', () => {
    expect(replaceSection(DOC, pricing, 'x', 'Price')).toContain('## Price\nx\n\n## Positioning')
  })

  it('append_to_section lands before the first subsection', () => {
    const next = appendToSection(DOC, positioning, 'And small teams.')
    expect(next).toContain('## Positioning\nFor founders.\n\nAnd small teams.\n\n### Real alternative')
  })

  it('remove_section takes the heading and its subsections', () => {
    const next = removeSection(DOC, positioning)
    expect(next).not.toContain('For founders.')
    expect(next).not.toContain('Real alternative')
    expect(next).toContain('Dial8 captures meetings.\n\n## Pricing')
  })

  it('insert_section_after goes after the subsections, at the same level by default', () => {
    const next = insertSectionAfter(DOC, real, 'Proof', 'Three pilots.')
    expect(next).toContain('Granola plus Linear.\n\n### Proof\n\nThree pilots.\n\n## Pricing')
    expect(insertSectionAfter('Intro.', null, 'Notes', 'x')).toBe('Intro.\n\n## Notes\n\nx')
  })

  it('keeps a trailing newline', () => {
    expect(removeSection(`${DOC}\n`, o[4]).endsWith('\n')).toBe(true)
  })
})
