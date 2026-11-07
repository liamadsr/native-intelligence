/**
 * Mail indexes a search result the index doesn't have before acting on it
 * (ensure-indexed.ts): only rows marked `indexed: false`, one request per
 * thread at a time, the row id back, null when it couldn't be done.
 */
import { describe, expect, it, vi } from 'vitest'
import { ensureIndexed } from '../ensure-indexed'

const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response

describe('ensureIndexed', () => {
  it('asks once for an unindexed row, with its thread and mailbox', async () => {
    const doFetch = vi.fn(async () => ok({ id: 'idx-9' }))
    const row = { provider_thread_id: 'thr-old', account_id: 'acct-g', indexed: false }
    const [a, b] = await Promise.all([ensureIndexed(row, doFetch as never), ensureIndexed(row, doFetch as never)])
    expect([a, b]).toEqual(['idx-9', 'idx-9'])
    expect(doFetch).toHaveBeenCalledTimes(1)
    const [url, init] = (doFetch.mock.calls[0] as unknown as [string, RequestInit])
    expect(url).toBe('/api/account/email/threads/materialize')
    expect(JSON.parse(String(init.body))).toEqual({ threadId: 'thr-old', accountId: 'acct-g' })
  })

  it('leaves an indexed row (or one with no mailbox) alone', async () => {
    const doFetch = vi.fn()
    expect(await ensureIndexed({ provider_thread_id: 't', account_id: 'a', indexed: true }, doFetch as never)).toBeNull()
    expect(await ensureIndexed({ provider_thread_id: 't', account_id: 'a' }, doFetch as never)).toBeNull()
    expect(await ensureIndexed({ provider_thread_id: 't', account_id: null, indexed: false }, doFetch as never)).toBeNull()
    expect(doFetch).not.toHaveBeenCalled()
  })

  it('a refusal or a network error is null', async () => {
    expect(await ensureIndexed({ provider_thread_id: 't1', account_id: 'a', indexed: false }, (async () => ({ ok: false })) as never)).toBeNull()
    expect(await ensureIndexed({ provider_thread_id: 't2', account_id: 'a', indexed: false }, (async () => { throw new Error('x') }) as never)).toBeNull()
  })
})
