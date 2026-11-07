import { describe, expect, it, vi } from 'vitest'
import { chunk, fetchAllRows, inChunks, type PageResult } from '../paging'

/** A fake PostgREST builder over `rows`: records order/range calls. */
function fakeQuery<T>(rows: T[], calls: string[], failAt?: number) {
  const q = {
    order(column: string) {
      calls.push(`order:${column}`)
      return q
    },
    range(from: number, to: number): PromiseLike<PageResult<T>> {
      calls.push(`range:${from}-${to}`)
      if (failAt !== undefined && from >= failAt) {
        return Promise.resolve({ data: null, error: { message: 'boom' } })
      }
      return Promise.resolve({ data: rows.slice(from, to + 1), error: null })
    },
  }
  return q
}

describe('chunk', () => {
  it('splits into slices of at most size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 2)).toEqual([])
    expect(chunk(Array.from({ length: 450 }, (_, i) => i)).map((c) => c.length)).toEqual([200, 200, 50])
  })
  it('rejects a non-positive size', () => {
    expect(() => chunk([1], 0)).toThrow()
  })
})

describe('fetchAllRows', () => {
  it('pages until a short page, ordering by id by default', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ id: i }))
    const calls: string[] = []
    const make = vi.fn(() => fakeQuery(rows, calls))
    const { data, error } = await fetchAllRows(make)
    expect(error).toBeNull()
    expect(data).toHaveLength(2500)
    expect(make).toHaveBeenCalledTimes(3)
    expect(calls).toEqual([
      'order:id', 'range:0-999',
      'order:id', 'range:1000-1999',
      'order:id', 'range:2000-2999',
    ])
  })

  it('makes one extra request when the total is an exact multiple of the page', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: i }))
    const calls: string[] = []
    const { data } = await fetchAllRows(() => fakeQuery(rows, calls), { pageSize: 2, orderBy: null })
    expect(data).toHaveLength(4)
    expect(calls).toEqual(['range:0-1', 'range:2-3', 'range:4-5'])
  })

  it('returns the error with the rows read so far', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i }))
    const { data, error } = await fetchAllRows(() => fakeQuery(rows, [], 2), { pageSize: 2 })
    expect(error).toEqual({ message: 'boom' })
    expect(data).toHaveLength(2)
  })
})

describe('inChunks', () => {
  it('runs one query per chunk and concatenates in order', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`)
    const seen: number[] = []
    const { data, error } = await inChunks(ids, 100, async (c) => {
      seen.push(c.length)
      return { data: c.map((id) => ({ id })), error: null }
    })
    expect(error).toBeNull()
    expect(seen).toEqual([100, 100, 50])
    expect(data.map((r) => r.id)).toEqual(ids)
  })

  it('makes no request for an empty list', async () => {
    const fetchPage = vi.fn()
    const { data, error } = await inChunks([], 100, fetchPage)
    expect(fetchPage).not.toHaveBeenCalled()
    expect(data).toEqual([])
    expect(error).toBeNull()
  })

  it('surfaces the first chunk error', async () => {
    const { error } = await inChunks(['a', 'b', 'c'], 1, async (c) =>
      c[0] === 'b' ? { data: null, error: { message: 'too long' } } : { data: [c[0]], error: null },
    )
    expect(error).toEqual({ message: 'too long' })
  })

  it('composes with fetchAllRows per chunk', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i }))
    const { data } = await inChunks(['x', 'y'], 1, () => fetchAllRows(() => fakeQuery(rows, []), { pageSize: 2 }))
    expect(data).toHaveLength(10)
  })
})
