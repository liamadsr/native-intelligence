import { describe, it, expect, vi, beforeEach } from 'vitest'

const stateStore = new Map<string, unknown>()
vi.mock('eve/context', () => ({
  defineState: <T,>(name: string, initial: () => T) => ({
    get: () => (stateStore.has(name) ? (stateStore.get(name) as T) : initial()),
    update: (fn: (prev: T) => T) => {
      const prev = stateStore.has(name) ? (stateStore.get(name) as T) : initial()
      stateStore.set(name, fn(prev))
    },
  }),
}))

import { highestCardNumber, stampCardNumber } from '../card-numbers'

const ok = { success: true, card: { kind: 'list' } }

beforeEach(() => stateStore.clear())

describe('card numbers', () => {
  it('numbers each card once per conversation, a replayed call keeping its number', () => {
    expect(stampCardNumber(ok, 'call_a', 0)).toMatchObject({ card_number: 1 })
    expect(stampCardNumber(ok, 'call_b', 0)).toMatchObject({ card_number: 2 })
    expect(stampCardNumber(ok, 'call_a', 0)).toMatchObject({ card_number: 1 })
  })

  it("starts past the highest number the conversation's cards already have (a new session)", () => {
    expect(highestCardNumber([{ n: 7 }, { n: 4 }, { n: 'x' }])).toBe(7)
    expect(stampCardNumber(ok, 'call_c', 7)).toMatchObject({ card_number: 8 })
  })

  it('ignores an implausible number from the client, so a forged one cannot push numbering off', () => {
    expect(highestCardNumber([{ n: 1_000_000_000 }, { n: -3 }, { n: 0 }, { n: 3 }])).toBe(3)
    expect(highestCardNumber([{ n: 10_000 }])).toBe(0)
    expect(highestCardNumber([{ n: 9_999 }])).toBe(9_999)
  })

  it('leaves a refused show alone: no card, no number', () => {
    const refused = { success: false, error: 'bad field' }
    expect(stampCardNumber(refused, 'call_d', 0)).toBe(refused)
    expect(stampCardNumber(ok, 'call_e', 0)).toMatchObject({ card_number: 1 })
  })
})
