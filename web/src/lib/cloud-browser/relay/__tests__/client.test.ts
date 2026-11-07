/**
 * The relay's HTTP client (src/lib/cloud-browser/relay/client.ts): every call
 * carries the relay's mark and nothing else (the firewall adds the token), a
 * 426 means "restart with the app's new build", and a settle is retried.
 */
import { describe, expect, it, vi } from 'vitest'
import { RelayClient, RelayRestart } from '../client'

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('RelayClient', () => {
  it('marks every request and sends no credential of its own', async () => {
    const fetchImpl = vi.fn(async () => answer(200, { command: { id: 'c', command: 'run_task' } }))
    const client = new RelayClient('https://relay.test', 'build 1', fetchImpl as unknown as typeof fetch)
    expect(await client.next()).toEqual({ command: { id: 'c', command: 'run_task' } })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://relay.test/api/browser-relay/next?v=build%201')
    expect(init.headers).toEqual({ 'x-dial8-relay': '1' })
  })

  it('tells the relay to restart when the app moved to another build', async () => {
    const client = new RelayClient('https://relay.test', 'old', (async () => answer(426, { version: 'new' })) as unknown as typeof fetch)
    await expect(client.next()).rejects.toEqual(new RelayRestart('new'))
  })

  it('claims, or learns someone else did', async () => {
    const fetchImpl = vi.fn(async () => answer(409, { error: 'Command not claimable' }))
    const client = new RelayClient('https://relay.test', 'b', fetchImpl as unknown as typeof fetch)
    expect(await client.claim('c')).toBeNull()
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(init).toMatchObject({ method: 'POST', body: '{}', headers: { 'x-dial8-relay': '1', 'content-type': 'application/json' } })
  })

  it('retries a settle that failed in transit, not one the route refused', async () => {
    vi.useFakeTimers()
    try {
      const flaky = vi.fn().mockRejectedValueOnce(new Error('reset')).mockResolvedValueOnce(answer(200, { ok: true }))
      const done = new RelayClient('https://relay.test', 'b', flaky as unknown as typeof fetch).settle('c', 'completed', { ok: true }, null)
      await vi.advanceTimersByTimeAsync(2000)
      await done
      expect(flaky).toHaveBeenCalledTimes(2)
      const refused = vi.fn(async () => answer(400, { error: 'invalid settle status' }))
      await new RelayClient('https://relay.test', 'b', refused as unknown as typeof fetch).settle('c', 'completed', null, null)
      expect(refused).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
