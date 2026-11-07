import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ send: vi.fn(async () => undefined) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.send, createFunction: (c: { id: string }) => ({ id: c.id }) } }))

import { __resetHarvestRequestsForTests, requestVocabularyHarvest } from '../harvest-trigger'

beforeEach(() => {
  hoisted.send.mockClear()
  __resetHarvestRequestsForTests()
})

describe('requestVocabularyHarvest', () => {
  it('sends one harvest request per person per hour', async () => {
    expect(requestVocabularyHarvest('ws', 'u1', 0)).toBe(true)
    expect(requestVocabularyHarvest('ws', 'u1', 30 * 60_000)).toBe(false)
    expect(requestVocabularyHarvest('ws', 'u2', 30 * 60_000)).toBe(true)
    expect(requestVocabularyHarvest('ws', 'u1', 61 * 60_000)).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(hoisted.send).toHaveBeenCalledTimes(3)
    expect(hoisted.send).toHaveBeenCalledWith({ name: 'vocabulary/harvest.requested', data: { workspace_id: 'ws', user_id: 'u1', harvest_key: 'ws:u1' } })
  })

  it('never throws when the send fails', async () => {
    hoisted.send.mockRejectedValueOnce(new Error('down'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(requestVocabularyHarvest('ws', 'u1', 0)).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})
