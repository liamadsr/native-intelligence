/**
 * The project token off Vercel: made with CONNECT_ACCESS_TOKEN, cached until
 * shortly before it expires, shared by concurrent callers, never cached when
 * the request fails. Every id and token here is made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { ConnectAuthError, connectOptions, forgetConnectProjectToken } from '../connect-auth'

const NOW = Date.parse('2026-01-01T00:00:00Z')
const HOUR = 60 * 60_000

/** A made-up JWT whose payload expires `ms` after NOW. */
function jwt(ms: number, tag = 'a'): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${part({ alg: 'none' })}.${part({ project_id: 'prj_madeup0001', environment: 'development', exp: (NOW + ms) / 1000, tag })}.sig`
}

const fetchMock = vi.fn()
const answer = (token: string) => new Response(JSON.stringify({ token }), { status: 200 })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  forgetConnectProjectToken()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('CONNECT_ACCESS_TOKEN', 'made-up-access-token')
  vi.stubEnv('CONNECT_PROJECT_ID', 'prj_madeup0001')
  vi.stubEnv('CONNECT_TEAM_ID', 'team_madeup0001')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('connectOptions', () => {
  it('is undefined on Vercel, and asks for nothing', async () => {
    vi.stubEnv('CONNECT_ACCESS_TOKEN', '  ')
    await expect(connectOptions()).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('makes a project token with the access token, once, and reuses it', async () => {
    const token = jwt(12 * HOUR)
    fetchMock.mockResolvedValue(answer(token))
    await expect(connectOptions()).resolves.toEqual({ vercelToken: token })
    await expect(connectOptions()).resolves.toEqual({ vercelToken: token })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.vercel.com/v1/projects/prj_madeup0001/token?source=vercel-oidc-refresh&teamId=team_madeup0001')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ Authorization: 'Bearer made-up-access-token' })
  })

  it('names no team when CONNECT_TEAM_ID is unset', async () => {
    vi.stubEnv('CONNECT_TEAM_ID', '')
    fetchMock.mockResolvedValue(answer(jwt(HOUR)))
    await connectOptions()
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.vercel.com/v1/projects/prj_madeup0001/token?source=vercel-oidc-refresh')
  })

  it('makes a new one within minutes of expiry', async () => {
    const first = jwt(HOUR, 'first')
    const second = jwt(2 * HOUR, 'second')
    fetchMock.mockResolvedValueOnce(answer(first)).mockResolvedValueOnce(answer(second))
    await expect(connectOptions()).resolves.toEqual({ vercelToken: first })
    vi.setSystemTime(NOW + HOUR - 10 * 60_000)
    await expect(connectOptions()).resolves.toEqual({ vercelToken: first })
    vi.setSystemTime(NOW + HOUR - 4 * 60_000)
    await expect(connectOptions()).resolves.toEqual({ vercelToken: second })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('shares one request between concurrent callers', async () => {
    const token = jwt(HOUR)
    let release!: (r: Response) => void
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (release = resolve)))
    const calls = Promise.all([connectOptions(), connectOptions(), connectOptions()])
    await Promise.resolve()
    release(answer(token))
    expect(await calls).toEqual([{ vercelToken: token }, { vercelToken: token }, { vercelToken: token }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failure, and says which step failed with its status but no token', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":{"code":"forbidden"}}', { status: 403 }))
    const error = await connectOptions().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConnectAuthError)
    expect((error as Error).message).toContain('project-token request answered 403')
    expect((error as Error).message).not.toContain('made-up-access-token')

    const token = jwt(HOUR)
    fetchMock.mockResolvedValueOnce(answer(token))
    await expect(connectOptions()).resolves.toEqual({ vercelToken: token })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns the last project token when making a new one fails, and tries again next time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = jwt(HOUR, 'first')
    const second = jwt(2 * HOUR, 'second')
    fetchMock
      .mockResolvedValueOnce(answer(first))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(answer(second))
    await connectOptions()
    vi.setSystemTime(NOW + 2 * HOUR) // past its expiry
    await expect(connectOptions()).resolves.toEqual({ vercelToken: first })
    expect(JSON.stringify(warn.mock.calls)).not.toContain(first)
    await expect(connectOptions()).resolves.toEqual({ vercelToken: second })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('throws when making one fails and there is no earlier one for the same settings', async () => {
    fetchMock.mockResolvedValueOnce(answer(jwt(HOUR))).mockResolvedValueOnce(new Response('', { status: 403 }))
    await connectOptions()
    vi.stubEnv('CONNECT_PROJECT_ID', 'prj_madeup0002')
    await expect(connectOptions()).rejects.toThrow('answered 403')
  })

  it('does not reuse a token that was dropped', async () => {
    fetchMock.mockResolvedValueOnce(answer(jwt(HOUR))).mockResolvedValueOnce(new Response('', { status: 503 }))
    await connectOptions()
    forgetConnectProjectToken()
    await expect(connectOptions()).rejects.toThrow('answered 503')
  })

  it('shares one failing request between concurrent callers, all served the last token', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = jwt(HOUR, 'first')
    fetchMock.mockResolvedValueOnce(answer(first))
    await connectOptions()
    vi.setSystemTime(NOW + 2 * HOUR)
    let release!: (r: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (release = resolve)))
    const calls = Promise.all([connectOptions(), connectOptions()])
    await Promise.resolve()
    release(new Response('', { status: 500 }))
    expect(await calls).toEqual([{ vercelToken: first }, { vercelToken: first }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reports a request that could not be sent', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(connectOptions()).rejects.toThrow('could not be sent (TypeError)')
  })

  it('refuses the access token without CONNECT_PROJECT_ID, and never sends it to Connect', async () => {
    vi.stubEnv('CONNECT_PROJECT_ID', '')
    await expect(connectOptions()).rejects.toThrow('CONNECT_PROJECT_ID')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('makes a new one after it is dropped', async () => {
    fetchMock.mockResolvedValueOnce(answer(jwt(HOUR, 'first'))).mockResolvedValueOnce(answer(jwt(HOUR, 'second')))
    await connectOptions()
    forgetConnectProjectToken()
    await connectOptions()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
