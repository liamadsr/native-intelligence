import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  CHAT_UPLOAD_SIGN_MAX,
  freshUploadUrl,
  isStaleUpload,
  resetFreshUploadUrlsForTests,
  signedUploadOf,
} from '@/lib/chat/fresh-upload-url'

const NOW = Date.parse('2026-10-08T12:00:00Z')
const USER = '11111111-1111-4111-8111-111111111111'

/** A Supabase signed link to `path` in the attachments bucket, its token expiring at `expMs`. */
function signedLink(path: string, expMs: number): string {
  const payload = Buffer.from(JSON.stringify({ url: `attachments/${path}`, exp: Math.floor(expMs / 1000) })).toString('base64url')
  return `https://ref.supabase.co/storage/v1/object/sign/attachments/${path}?token=eyJhbGciOiJIUzI1NiJ9.${payload}.sig`
}

describe('signedUploadOf', () => {
  it('reads a chat upload’s path and expiry off its signed link', () => {
    expect(signedUploadOf(signedLink(`${USER}/chat-uploads/a.png`, NOW + 3_600_000))).toEqual({
      path: `${USER}/chat-uploads/a.png`,
      expiresAt: NOW + 3_600_000,
    })
    // An encoded name decodes.
    expect(signedUploadOf(signedLink(`${USER}/chat-uploads/my%20shot.png`, NOW))?.path).toBe(`${USER}/chat-uploads/my shot.png`)
  })

  it('a link whose token has no readable expiry: path known, expiry null', () => {
    expect(signedUploadOf(`https://ref.supabase.co/storage/v1/object/sign/attachments/${USER}/chat-uploads/a.png?token=opaque`)).toEqual({
      path: `${USER}/chat-uploads/a.png`,
      expiresAt: null,
    })
  })

  it('anything else is no chat upload', () => {
    for (const url of [
      'blob:http://localhost/abc',
      'not a url',
      'https://nativeintelligence.dev/account',
      signedLink(`${USER}/notes/a.png`, NOW),
      signedLink(`${USER}/chat-uploads/sub/a.png`, NOW),
      `https://ref.supabase.co/storage/v1/object/sign/avatars/${USER}/chat-uploads/a.png?token=t`,
      `https://ref.supabase.co/storage/v1/object/public/attachments/${USER}/chat-uploads/a.png`,
    ]) {
      expect(signedUploadOf(url), url).toBeNull()
    }
  })
})

describe('isStaleUpload', () => {
  it('stale when expired, within a minute of it, or of unknown expiry', () => {
    expect(isStaleUpload({ path: 'p', expiresAt: NOW + 3_600_000 }, NOW)).toBe(false)
    expect(isStaleUpload({ path: 'p', expiresAt: NOW + 30_000 }, NOW)).toBe(true)
    expect(isStaleUpload({ path: 'p', expiresAt: NOW - 1 }, NOW)).toBe(true)
    expect(isStaleUpload({ path: 'p', expiresAt: null }, NOW)).toBe(true)
  })
})

describe('freshUploadUrl', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    resetFreshUploadUrlsForTests()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const answer = (urls: Record<string, string>) => new Response(JSON.stringify({ urls }), { status: 200 })

  it('paths asked for in the same tick go in one request; a fresh link is reused while it lasts', async () => {
    const a = `${USER}/chat-uploads/a.png`
    const b = `${USER}/chat-uploads/b.png`
    const later = Date.now() + 3_600_000
    fetchMock.mockResolvedValueOnce(answer({ [a]: signedLink(a, later), [b]: signedLink(b, later) }))
    const [ua, ub, ua2] = await Promise.all([freshUploadUrl(a), freshUploadUrl(b), freshUploadUrl(a)])
    expect(ua).toBe(signedLink(a, later))
    expect(ub).toBe(signedLink(b, later))
    expect(ua2).toBe(ua)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/ai/chat/upload/sign')
    expect(JSON.parse(init.body as string)).toEqual({ paths: [a, b] })
    // Cached: no second request.
    expect(await freshUploadUrl(a)).toBe(ua)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('more paths than one request carries are split', async () => {
    const paths = Array.from({ length: CHAT_UPLOAD_SIGN_MAX + 1 }, (_, i) => `${USER}/chat-uploads/${i}.png`)
    fetchMock.mockImplementation(async () => answer({}))
    await Promise.all(paths.map((p) => freshUploadUrl(p)))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('not signed (not theirs, gone) or a failed request: null', async () => {
    fetchMock.mockResolvedValueOnce(answer({}))
    expect(await freshUploadUrl(`${USER}/chat-uploads/gone.png`)).toBeNull()
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }))
    expect(await freshUploadUrl(`${USER}/chat-uploads/x.png`)).toBeNull()
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    expect(await freshUploadUrl(`${USER}/chat-uploads/y.png`)).toBeNull()
  })
})
