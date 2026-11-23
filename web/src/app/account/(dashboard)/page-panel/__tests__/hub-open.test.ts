/**
 * Which hub row is lit when the card in front names no record (../hub-open.ts):
 * the card that came in front for the open, soon after it; or the card in
 * front at the open, when it was moved in place (team chat, one card: a
 * channel to the next). Any later card in front lights nothing.
 */
import { describe, expect, it } from 'vitest'
import { openedRowLit, openedRowStep, type OpenedRow } from '../hub-open'

const opened = (frontId: string | null, at = 0): OpenedRow => ({ key: 'team_chat_channel:c1', frontId, at, settled: false })

describe('the opened row', () => {
  it('is the card that came in front for it', () => {
    const next = openedRowStep(opened(null), 'tc', 100)!
    expect(next.settled).toBe(true)
    expect(openedRowLit(next, 'tc')).toBe('team_chat_channel:c1')
    // Another card later: nothing lit, and it stays that card's.
    expect(openedRowLit(openedRowStep(next, 'r9', 50_000), 'r9')).toBeNull()
  })

  it('is the card moved in place (flipping one team chat card from channel to channel)', () => {
    const entry = opened('tc')
    expect(openedRowLit(openedRowStep(entry, 'tc', 100), 'tc')).toBe('team_chat_channel:c1')
    // Long after, another card: not this row's.
    const later = openedRowStep(entry, 'doc', 10_000)!
    expect(later.settled).toBe(true)
    expect(openedRowLit(later, 'doc')).toBeNull()
  })

  it('lights nothing with nothing in front', () => {
    expect(openedRowLit(opened('tc'), null)).toBeNull()
  })
})
