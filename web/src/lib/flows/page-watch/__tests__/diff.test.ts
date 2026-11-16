import { describe, expect, it } from 'vitest'
import { ADDED_LINE_MAX_CHARS, ADDED_LINES_MAX, addedLines, diffLines, FINGERPRINT_READS, fingerprint, knownHashes, lineHash, normalizeLine, readSets, rememberRead } from '../diff'
import { htmlToLines } from '../text'

describe('normalizeLine: what is certainly noise', () => {
  it.each([
    ['Posted 5 minutes ago', 'Posted 12 minutes ago'],
    ['Posted 2h ago', 'Posted 3h ago'],
    ['Posted an hour ago', 'Posted 4 hours ago'],
    ['Posted a few seconds ago', 'Posted just now'],
    ['Commented yesterday', 'Commented 2 days ago'],
    ['Refreshes in 3 hours', 'Refreshes in 20 minutes'],
    ['Sale ends 01:23:45', 'Sale ends 00:59:02'],
    ['Offer: 2d 4h 13m 22s', 'Offer: 2d 3h 58m 01s'],
    ['Sale ends in 4h 12m', 'Sale ends in 3h 57m'],
    ['Only 3 days 2 hours left', 'Only 3 days 1 hours left'],
    ['Last updated: 15 Nov 2026, 09:30 UTC', 'Last updated: 15 Nov 2026, 09:45 UTC'],
    ['Last updated Nov 14, 2026', 'Last updated Nov 15, 2026'],
    ['As of 11/15/2026 9:30am, all systems normal', 'As of 11/15/2026 9:45am, all systems normal'],
    ['Generated at 2026-11-15T09:30:12Z', 'Generated at 2026-11-15T09:45:59Z'],
    ['Server time: 09:30', 'Server time: 09:45'],
    ['Built 2026-11-15 09:30:12.123+01:00', 'Built 2026-11-15 09:45:02.004+01:00'],
    ['Date: Sun, 15 Nov 2026 09:30:12 +0000', 'Date: Sun, 15 Nov 2026 09:45:40 +0000'],
    ['Request 3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e', 'Request 0a1b2c3d-4e5f-4a6b-9c8d-7e6f5a4b3c2d'],
    ['build a8c9d0e1f2b3c4d5e6f7', 'build 9f8e7d6c5b4a39281706'],
    ['nonce Xk29fQ0aLm3pZr8vT1', 'nonce Bq72hW5yNc0sKd4eJ6'],
  ])('%s reads the same as %s', (a, b) => {
    expect(normalizeLine(a)).toBe(normalizeLine(b))
    expect(lineHash(a)).toBe(lineHash(b))
  })

  it.each([
    ['Pro plan $29 / month', 'Pro plan $39 / month'],
    ['Opens on March 3, 2027', 'Opens on March 10, 2027'],
    ['1,204 people on the waiting list', '1,310 people on the waiting list'],
    ['Version 4.2 is out', 'Version 4.3 is out'],
    ['In stock', 'Out of stock'],
    ['Ships in 3 days', 'Ships in 10 days'],
    ['Updated pricing for teams', 'New pricing for teams'],
    ['We updated 3 plans', 'We updated 4 plans'],
    ['Model WH-1000XM5 now $299', 'Model WH-1000XM6 now $299'],
    ['Store hours 9:00 to 17:00', 'Store hours 9:00 to 18:00'],
    // A plain number after a stamping word is news, not a stamp.
    ['Rate updated 4.25 percent', 'Rate updated 4.50 percent'],
    ['Updated 2.4.1 with bug fixes', 'Updated 2.4.2 with bug fixes'],
    ['Updated 2027 pricing', 'Updated 2028 pricing'],
    ['As of 3 locations', 'As of 4 locations'],
    // A product name is not a nonce.
    ['iPhone-16-Pro-Max-256GB', 'Galaxy-S25-Ultra-512GB'],
    ['Model iPhone16ProMax256GB in stock', 'Model iPhone16ProMax512GB in stock'],
  ])('kept pair %#: a real change still shows', (a, b) => {
    expect(normalizeLine(a)).not.toBe(normalizeLine(b))
  })

  it('keeps the stamping word and what follows the date', () => {
    expect(normalizeLine('Prices updated on Nov 3: $10 a seat')).toBe('Prices updated on ‹when›: $10 a seat')
    expect(normalizeLine('Updated Nov 3 on the site')).toBe('Updated ‹when› on the site')
  })

  it('keeps the numbers after a stamping word unless they are a real date or time', () => {
    expect(normalizeLine('Rate updated 4.25 percent')).toBe('Rate updated 4.25 percent')
    expect(normalizeLine('Updated 2.4.1 with bug fixes')).toBe('Updated 2.4.1 with bug fixes')
    expect(normalizeLine('Updated 15.11.2026')).toBe('Updated ‹when›')
    expect(normalizeLine('As of 2026-11-15, open')).toBe('As of ‹when›, open')
    expect(normalizeLine('Updated 9:30am')).toBe('Updated ‹when›')
  })

  it('collapses hex and base64-like runs only, never hyphenated names', () => {
    expect(normalizeLine('iPhone-16-Pro-Max-256GB')).toBe('iPhone-16-Pro-Max-256GB')
    expect(normalizeLine('Galaxy-S25-Ultra-512GB')).toBe('Galaxy-S25-Ultra-512GB')
    expect(normalizeLine('asset main.3f9a0c2e1b7d4f6a.js')).toBe('asset main.‹id›.js')
    expect(normalizeLine('token dGhpcyBpcyBhIHRlc3Q0NTY3OA9z')).toBe('token ‹id›')
  })

  it('collapses whitespace', () => {
    expect(normalizeLine('  Pro   plan\t$29  ')).toBe('Pro plan $29')
  })
})

describe('fingerprint and addedLines', () => {
  const before = [
    'Example Widgets',
    'Pricing',
    'Starter $9 / month',
    'Pro $29 / month',
    'Last updated: Nov 14, 2026 09:30 UTC',
    'Posted 5 minutes ago',
    'Request id 3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e',
  ]

  it('a page whose only differences are noise yields no added lines', () => {
    const after = [
      'Example Widgets',
      'Pricing',
      'Starter $9 / month',
      'Pro $29 / month',
      'Last updated: Nov 15, 2026 10:45 UTC',
      'Posted 20 minutes ago',
      'Request id 0a1b2c3d-4e5f-4a6b-9c8d-7e6f5a4b3c2d',
    ]
    expect(addedLines(fingerprint(before), after)).toEqual([])
  })

  it('order and whitespace do not matter, and a removed line is not news', () => {
    const after = ['Pro   $29 / month', 'Pricing', 'Example Widgets', 'Starter $9 / month']
    expect(addedLines(fingerprint(before), after)).toEqual([])
  })

  it('returns new lines as the page wrote them, once each, in page order', () => {
    const after = [...before, 'Team $99 / month', 'Pro $25 / month', 'Team $99 / month', 'Team   $99 / month']
    expect(addedLines(fingerprint(before), after)).toEqual(['Team $99 / month', 'Pro $25 / month'])
  })

  it('caps the count and the length', () => {
    const many = Array.from({ length: ADDED_LINES_MAX + 20 }, (_, i) => `New item number ${i} ${'x'.repeat(400)}`)
    const added = addedLines([], many)
    expect(added).toHaveLength(ADDED_LINES_MAX)
    expect(added.every((l) => l.length <= ADDED_LINE_MAX_CHARS)).toBe(true)
    expect(added[0].startsWith('New item number 0 ')).toBe(true)
  })

  it('a changed table cell is a new line that says which row: "Basic | $12" even when "$12" is elsewhere', () => {
    const page = (basic: string) => htmlToLines(`<table><tr><td>Basic</td><td>${basic}</td></tr><tr><td>Pro</td><td>$12</td></tr></table>`)
    expect(addedLines(fingerprint(page('$10')), page('$12'))).toEqual(['Basic | $12'])
  })

  it('new lines past the cap are reported by hash, so they can be left out of the stored read', () => {
    const lines = Array.from({ length: ADDED_LINES_MAX + 5 }, (_, i) => `Opening ${i}`)
    const { added, unreported } = diffLines(new Set(), lines)
    expect(added).toHaveLength(ADDED_LINES_MAX)
    expect(unreported).toEqual(lines.slice(ADDED_LINES_MAX).map(lineHash))
  })

  it('remembers the last reads, newest first, and compares with their union', () => {
    let sets: string[][] = []
    for (const quote of ['Quote A', 'Quote B', 'Quote C', 'Quote D']) sets = rememberRead(sets, fingerprint(['Pricing', quote]))
    expect(sets).toHaveLength(FINGERPRINT_READS)
    const known = knownHashes(sets)
    // A rotating block seen in the last three reads is not news; one older than that is.
    expect(addedLines([...known], ['Pricing', 'Quote B'])).toEqual([])
    expect(addedLines([...known], ['Pricing', 'Quote A'])).toEqual(['Quote A'])
    expect(readSets(sets)).toEqual(sets)
    expect(readSets(['a', 'b'])).toEqual([['a', 'b']])
    expect(readSets({})).toEqual([])
    expect(readSets([['a', 1], 'x', ['b'], ['c'], ['d']])).toEqual([['a'], ['b'], ['c']])
  })

  it('fingerprints are distinct, stable and skip empty lines', () => {
    const fp = fingerprint(['A', 'B', 'A', '   ', ''])
    expect(fp).toHaveLength(2)
    expect(fingerprint(['A', 'B'])).toEqual(fp)
    expect(fp.every((h) => /^[0-9a-z]+$/.test(h))).toBe(true)
  })
})
