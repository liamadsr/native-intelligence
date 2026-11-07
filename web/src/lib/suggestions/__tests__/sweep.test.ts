import { describe, it, expect, vi } from 'vitest'
import { expireStaleSuggestions, purgeResolvedSuggestions } from '../sweep'

function rpcClient(result: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn(async () => result)
  return { client: { rpc } as never, rpc }
}

describe('suggestion sweeps', () => {
  const now = new Date('2026-10-08T12:00:00Z')

  it('expire passes now and the batch cap, and counts the rows', async () => {
    const { client, rpc } = rpcClient({ data: [{ id: 'a' }, { id: 'b' }], error: null })
    expect(await expireStaleSuggestions(client, now)).toEqual({ expired: 2 })
    expect(rpc).toHaveBeenCalledWith('expire_stale_suggestions', { p_now: '2026-10-08T12:00:00.000Z', p_limit: 500 })
  })

  it('purge cuts off 60 days back', async () => {
    const { client, rpc } = rpcClient({ data: 7, error: null })
    expect(await purgeResolvedSuggestions(client, now)).toEqual({ purged: 7 })
    expect(rpc).toHaveBeenCalledWith('purge_resolved_suggestions', { p_before: '2026-08-09T12:00:00.000Z', p_limit: 1000 })
  })

  it('a failing RPC throws so the cron logs it', async () => {
    const { client } = rpcClient({ data: null, error: { message: 'boom' } })
    await expect(purgeResolvedSuggestions(client, now)).rejects.toThrow('boom')
  })
})
