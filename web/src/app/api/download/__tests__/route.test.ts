/**
 * /api/download: a redirect to APP_DOWNLOAD_URL (macOS) or
 * APP_DOWNLOAD_URL_WINDOWS (?platform=windows), and 404 when that URL isn't
 * set. There is no built-in file to fall back to.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const capture = vi.fn()
vi.mock('@/lib/posthog', () => ({
  getPostHogServerClient: () => ({ capture }),
  serverDefaultProperties: {},
}))

import { GET } from '../route'

const MAC = 'https://downloads.example.com/App.dmg'
const WINDOWS = 'https://downloads.example.com/App-setup.exe'

afterEach(() => {
  vi.unstubAllEnvs()
  capture.mockReset()
})

describe('GET /api/download', () => {
  it('redirects to APP_DOWNLOAD_URL', async () => {
    vi.stubEnv('APP_DOWNLOAD_URL', MAC)
    const res = await GET(new Request('https://app.example.com/api/download'))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(MAC)
    expect(capture).toHaveBeenCalledOnce()
  })

  it('redirects ?platform=windows to APP_DOWNLOAD_URL_WINDOWS', async () => {
    vi.stubEnv('APP_DOWNLOAD_URL', MAC)
    vi.stubEnv('APP_DOWNLOAD_URL_WINDOWS', WINDOWS)
    const res = await GET(new Request('https://app.example.com/api/download?platform=windows'))
    expect(res.headers.get('location')).toBe(WINDOWS)
  })

  it('answers 404, and counts no download, when APP_DOWNLOAD_URL is unset', async () => {
    vi.stubEnv('APP_DOWNLOAD_URL', '')
    const res = await GET(new Request('https://app.example.com/api/download'))
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' })
    expect(capture).not.toHaveBeenCalled()
  })

  it('answers 404 for Windows when only the Mac file is set', async () => {
    vi.stubEnv('APP_DOWNLOAD_URL', MAC)
    vi.stubEnv('APP_DOWNLOAD_URL_WINDOWS', ' ')
    const res = await GET(new Request('https://app.example.com/api/download?platform=windows'))
    expect(res.status).toBe(404)
  })
})
