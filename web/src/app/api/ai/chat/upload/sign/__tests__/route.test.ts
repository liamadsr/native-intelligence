/**
 * POST /api/ai/chat/upload/sign: fresh links for the caller's own chat uploads
 * (a message's link dies an hour after the upload). Only one object directly
 * in the caller's chat-uploads folder is ever signed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const USER = '11111111-1111-4111-8111-111111111111'
const VICTIM = '22222222-2222-4222-8222-222222222222'

const hoisted = vi.hoisted(() => ({
  requireUser: vi.fn(),
  createSignedUrls: vi.fn(),
}))
vi.mock('@/lib/api-auth', () => ({ requireUser: hoisted.requireUser }))

import { POST } from '../route'
import { CHAT_UPLOAD_SIGN_MAX, CHAT_UPLOAD_URL_TTL_SECONDS } from '@/lib/chat/fresh-upload-url'

const req = (body: unknown) =>
  new NextRequest('http://localhost/api/ai/chat/upload/sign', { method: 'POST', body: JSON.stringify(body) })

beforeEach(() => {
  hoisted.createSignedUrls.mockReset()
  hoisted.createSignedUrls.mockImplementation(async (paths: string[]) => ({
    data: paths.map((path) => ({ path, signedUrl: `https://signed/${path}`, error: null })),
    error: null,
  }))
  hoisted.requireUser.mockResolvedValue({
    user: { id: USER },
    supabase: { storage: { from: (bucket: string) => (bucket === 'attachments' ? { createSignedUrls: hoisted.createSignedUrls } : null) } },
  })
})

describe('POST /api/ai/chat/upload/sign', () => {
  it('signs the caller’s own uploads for an hour', async () => {
    const res = await POST(req({ paths: [`${USER}/chat-uploads/a.png`, `${USER}/chat-uploads/b.md`] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      urls: {
        [`${USER}/chat-uploads/a.png`]: `https://signed/${USER}/chat-uploads/a.png`,
        [`${USER}/chat-uploads/b.md`]: `https://signed/${USER}/chat-uploads/b.md`,
      },
    })
    expect(hoisted.createSignedUrls).toHaveBeenCalledWith(
      [`${USER}/chat-uploads/a.png`, `${USER}/chat-uploads/b.md`],
      CHAT_UPLOAD_URL_TTL_SECONDS,
    )
  })

  it('never signs another user’s upload, a traversal, or anything outside chat-uploads', async () => {
    const res = await POST(
      req({
        paths: [
          `${VICTIM}/chat-uploads/a.png`,
          `${USER}/chat-uploads/../../${VICTIM}/chat-uploads/a.png`,
          `${USER}/chat-uploads/%2e%2e/x.png`,
          `${USER}/notes/a.png`,
          `${USER}/chat-uploads/mine.png`,
          42,
        ],
      }),
    )
    expect(await res.json()).toEqual({ urls: { [`${USER}/chat-uploads/mine.png`]: `https://signed/${USER}/chat-uploads/mine.png` } })
    expect(hoisted.createSignedUrls).toHaveBeenCalledWith([`${USER}/chat-uploads/mine.png`], CHAT_UPLOAD_URL_TTL_SECONDS)
  })

  it('nothing of theirs asked for: an empty answer, nothing signed', async () => {
    const res = await POST(req({ paths: [`${VICTIM}/chat-uploads/a.png`] }))
    expect(await res.json()).toEqual({ urls: {} })
    expect(hoisted.createSignedUrls).not.toHaveBeenCalled()
  })

  it('a path storage could not sign is left out', async () => {
    hoisted.createSignedUrls.mockResolvedValueOnce({
      data: [{ path: `${USER}/chat-uploads/gone.png`, signedUrl: '', error: 'Object not found' }],
      error: null,
    })
    const res = await POST(req({ paths: [`${USER}/chat-uploads/gone.png`] }))
    expect(await res.json()).toEqual({ urls: {} })
  })

  it('no paths, too many, or no list: 400', async () => {
    for (const body of [{}, { paths: [] }, { paths: 'x' }, { paths: Array(CHAT_UPLOAD_SIGN_MAX + 1).fill(`${USER}/chat-uploads/a.png`) }]) {
      expect((await POST(req(body))).status).toBe(400)
    }
  })

  it('signed out: the auth answer as is', async () => {
    hoisted.requireUser.mockResolvedValueOnce(new Response('{}', { status: 401 }))
    expect((await POST(req({ paths: [`${USER}/chat-uploads/a.png`] }))).status).toBe(401)
  })
})
