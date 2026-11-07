/**
 * The inbox header cache (src/lib/email/header-cache.ts): memory only; one
 * POST per 50 missing rows; a row in flight is not asked twice; a new newest
 * message is a new key (its header is fetched again).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fillHeaders, resetHeaderCache, withCachedHeaders } from '../header-cache'

beforeEach(() => resetHeaderCache())

const rows = (n: number, msg = 'm') => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, provider_message_id: `${msg}${i}`, subject: null as string | null, header_unavailable: undefined as boolean | undefined }))
const post = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { subject: `S ${id}`, snippet: null, from_name: null }])))

describe('header cache', () => {
  it('batches the rows it lacks, 50 a call, and merges them in', async () => {
    post.mockClear()
    await fillHeaders(rows(60), post)
    expect(post.mock.calls.map((c) => c[0].length)).toEqual([50, 10])
    expect(withCachedHeaders(rows(2))[1].subject).toBe('S r1')
    await fillHeaders(rows(60), post)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('never asks twice for a row in flight; a new message is a new key', async () => {
    post.mockClear()
    await Promise.all([fillHeaders(rows(3), post), fillHeaders(rows(3), post)])
    expect(post).toHaveBeenCalledTimes(1)
    await fillHeaders(rows(1, 'new'), post)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('a failed call leaves the rows without a header, marked unavailable, asked again next time', async () => {
    const failing = vi.fn(async () => { throw new Error('down') })
    await fillHeaders(rows(1), failing)
    expect(withCachedHeaders(rows(1))[0]).toMatchObject({ subject: null, header_unavailable: true })
    post.mockClear()
    await fillHeaders(rows(1), post)
    expect(post).toHaveBeenCalledTimes(1)
    expect(withCachedHeaders(rows(1))[0]).toMatchObject({ subject: 'S r0', header_unavailable: false })
  })

  it('a call that never answers times out to unavailable; a row missing from the reply is unavailable', async () => {
    const hanging = vi.fn(() => new Promise<Record<string, never>>(() => {}))
    await fillHeaders(rows(1), hanging, 5)
    expect(withCachedHeaders(rows(1))[0].header_unavailable).toBe(true)
    resetHeaderCache()
    await fillHeaders(rows(2), async () => ({ r0: { subject: 'S', snippet: null, from_name: null } }))
    expect(withCachedHeaders(rows(2)).map((r) => r.header_unavailable)).toEqual([false, true])
  })

  it('a row with nothing new comes back as the same object', async () => {
    const list = rows(1)
    expect(withCachedHeaders(list)[0]).toBe(list[0])
  })
})
