/**
 * The per-turn outside-text mark (#835 S1): what the chat tool route records
 * when a tool brought untrusted outside text into the turn, for create_flow
 * to read. Pins: keyed per turn, tools kept once each, nothing without a key,
 * forgotten after the TTL, bounded.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { goAheadTurnKey } from '../flow-go-ahead-guard'
import { markTurnReadOutside, resetTurnOutsideReads, turnOutsideReadTools, turnOutsideReadsSize } from '../turn-outside-reads'

afterEach(() => resetTurnOutsideReads())

const key = goAheadTurnKey({ userId: 'u', sessionId: 's', turnId: 't1' })

describe('turn-outside-reads', () => {
  it('marks a turn with the tools that read outside text, each once; another turn is untouched', () => {
    expect(turnOutsideReadTools(key)).toEqual([])
    markTurnReadOutside(key, 'read_email')
    markTurnReadOutside(key, 'read_email')
    markTurnReadOutside(key, 'mcp__notion__search')
    expect(turnOutsideReadTools(key)).toEqual(['read_email', 'mcp__notion__search'])
    expect(turnOutsideReadTools(goAheadTurnKey({ userId: 'u', sessionId: 's', turnId: 't2' }))).toEqual([])
  })

  it('no key: nothing is marked or read', () => {
    markTurnReadOutside(null, 'read_email')
    expect(turnOutsideReadsSize()).toBe(0)
    expect(turnOutsideReadTools(null)).toEqual([])
  })

  it('forgets a turn after the TTL, and stays bounded', () => {
    markTurnReadOutside(key, 'read_email', 0)
    expect(turnOutsideReadTools(key, 61 * 60 * 1000)).toEqual([])
    for (let i = 0; i < 5100; i++) markTurnReadOutside(`k-${i}`, 'read_email')
    expect(turnOutsideReadsSize()).toBe(5000)
  })
})
