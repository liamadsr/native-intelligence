import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecisionContext } from '../contracts'
import type { RetrievalRelevanceInput } from '../tasks/retrieval-relevance'

const mocks = vi.hoisted(() => ({ decide: vi.fn() }))
vi.mock('../run-decision', () => ({ runDecision: mocks.decide }))
import { filterRetrievalPassages, RETRIEVAL_FILTER_BUDGET_MS, type RetrievalPassage } from '../retrieval-filter'

const passage = (id: string, workspaceId = 'workspace'): RetrievalPassage => ({
  id, workspaceId, title: 'A source', text: `Passage ${id} discusses the quarterly hosting budget and pricing changes.`, complete: true,
})
const args = { userId: 'user', workspaceIds: ['workspace'], query: 'Why did pricing change?', passages: [passage('a'), passage('b')] }
const accepted = (irrelevantIds: string[]) => ({ status: 'accepted', value: { irrelevantIds }, inferenceId: 'inference', version: 'v1' })
beforeEach(() => { mocks.decide.mockReset().mockResolvedValue({ status: 'escalate', reason: 'uncertain' }) })
afterEach(() => vi.useRealTimers())

describe('bounded retrieval filtering', () => {
  it.each(['', ' ', '*', '%%', 'all', 'everything', 'list all meetings', 'show every document'])('does not spend on broad listing query %j', async query => {
    expect((await filterRetrievalPassages({ ...args, query })).irrelevantIds.size).toBe(0)
    expect(mocks.decide).not.toHaveBeenCalled()
  })

  it('retains missing, incomplete, clipped and oversized evidence without a decision call', async () => {
    const passages = [
      { ...passage('a'), text: '' }, { ...passage('b'), complete: false },
      { ...passage('c'), text: 'x'.repeat(5001) }, { ...passage('d'), text: 'An incomplete passage that ends before its actual subject...' },
    ]
    expect((await filterRetrievalPassages({ ...args, passages })).irrelevantIds.size).toBe(0)
    expect(mocks.decide).not.toHaveBeenCalled()
  })

  it.each(['uncertain', 'not_authorized', 'budget_unavailable', 'accounting_unavailable', 'unavailable'])('retains evidence on %s', async reason => {
    mocks.decide.mockResolvedValue({ status: 'escalate', reason })
    expect((await filterRetrievalPassages(args)).irrelevantIds.size).toBe(0)
  })

  it('keeps other results and rejects foreign or invented IDs from an accepted batch', async () => {
    mocks.decide.mockResolvedValue(accepted(['b', 'foreign', 'invented']))
    const result = await filterRetrievalPassages({ ...args, passages: [...args.passages, passage('foreign', 'not-authorized')] })
    expect([...result.irrelevantIds]).toEqual(['b'])
    expect(mocks.decide.mock.calls[0][1].passages.map((p: RetrievalPassage) => p.id)).toEqual(['a', 'b'])
  })

  it('uses at most two calls for eight of thirty results, authorized separately per workspace', async () => {
    mocks.decide.mockImplementation(async (_kind: string, input: RetrievalRelevanceInput) => accepted(input.passages.map(p => p.id)))
    const passages = Array.from({ length: 30 }, (_, index) => passage(String(index), index < 4 ? 'workspace' : index < 8 ? 'other' : 'third'))
    const result = await filterRetrievalPassages({ ...args, workspaceIds: ['workspace', 'other', 'third'], passages })
    expect(mocks.decide).toHaveBeenCalledTimes(2)
    expect([...result.irrelevantIds]).toEqual(['0', '1', '2', '3', '4', '5', '6', '7'])
    for (const [, input, ctx] of mocks.decide.mock.calls as [string, RetrievalRelevanceInput, DecisionContext][]) {
      expect(input.passages.length).toBeLessThanOrEqual(4)
      expect(input.passages.every(p => passages.find(original => original.id === p.id)!.workspaceId === ctx.workspaceId)).toBe(true)
      expect(ctx.userId).toBe('user')
    }
  })

  it('preserves a failed batch while allowing an independently accepted batch', async () => {
    mocks.decide.mockResolvedValueOnce(accepted(['a'])).mockRejectedValueOnce(new Error('outage'))
    const result = await filterRetrievalPassages({ ...args, workspaceIds: ['workspace', 'other'], passages: [passage('a'), passage('b', 'other')] })
    expect([...result.irrelevantIds]).toEqual(['a'])
  })

  it('bounds the whole operation even when authorization or accounting ignores abort, and aborts both underlying calls', async () => {
    vi.useFakeTimers()
    mocks.decide.mockImplementation(() => new Promise(() => {}))
    const pending = filterRetrievalPassages({ ...args, passages: Array.from({ length: 8 }, (_, i) => passage(String(i))) })
    expect(mocks.decide).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(RETRIEVAL_FILTER_BUDGET_MS)
    expect((await pending).irrelevantIds.size).toBe(0)
    for (const call of mocks.decide.mock.calls) expect(call[2].signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains every result on caller cancellation, including a completed first batch', async () => {
    const controller = new AbortController()
    mocks.decide.mockResolvedValueOnce(accepted(['0'])).mockImplementationOnce(() => new Promise(() => {}))
    const pending = filterRetrievalPassages({ ...args, signal: controller.signal, passages: Array.from({ length: 8 }, (_, i) => passage(String(i))) })
    controller.abort()
    expect((await pending).irrelevantIds.size).toBe(0)
  })

  it('ignores late accepted results even before the timeout callback gets an event-loop turn', async () => {
    vi.useFakeTimers()
    mocks.decide.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + RETRIEVAL_FILTER_BUDGET_MS + 1)
      return accepted(['a'])
    })
    expect((await filterRetrievalPassages(args)).irrelevantIds.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
