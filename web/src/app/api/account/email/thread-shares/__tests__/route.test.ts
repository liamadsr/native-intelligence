/**
 * The thread-share routes (migration 673): a mail thread shared with a person
 * by an @-mention. The server lib (member-share.ts) is mocked here — its own
 * tests cover the share/read/revoke rules; these pin the HTTP wiring: who may
 * call, the status codes, and the shapes. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { readJson } from '@/test/integration'

const req = (url: string, method = 'GET') => new NextRequest(url, { method })

const USER = '22222222-2222-4222-8222-aaaaaaaaaaaa'
const WS = '11111111-1111-4111-8111-111111111111'
const MEMBER = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const SHARE = '66666666-6666-4666-8666-000000000001'
const INDEX = '55555555-5555-4555-8555-000000000001'

const hoisted = vi.hoisted(() => ({
  requireWorkspaceMember: vi.fn(),
  read: vi.fn(),
  revoke: vi.fn(),
  find: vi.fn(),
  attachment: vi.fn(),
}))

vi.mock('@/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-auth')>()),
  requireWorkspaceMember: hoisted.requireWorkspaceMember,
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/email-share/member-share', () => ({
  readSharedEmailThreadForMember: hoisted.read,
  revokeEmailThreadShare: hoisted.revoke,
  findMemberShareId: hoisted.find,
  readSharedEmailAttachmentForMember: hoisted.attachment,
}))

import { GET, DELETE } from '@/app/api/account/email/thread-shares/[id]/route'
import { GET as GET_INDEX } from '@/app/api/account/email/thread-shares/route'
import { GET as GET_ATTACHMENT } from '@/app/api/account/email/thread-shares/[id]/attachment/route'

const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireWorkspaceMember.mockResolvedValue({
    supabase: {},
    user: { id: USER },
    workspaceId: WS,
    member: { id: MEMBER },
  })
})

describe('GET /api/account/email/thread-shares/[id]', () => {
  it('returns the read-only thread when the caller may read it', async () => {
    const thread = { subject: 'Harbor renewal terms', messages: [{ id: 'm1' }], missing: 0, blockedImages: 1 }
    hoisted.read.mockResolvedValue({ state: 'available', shareId: SHARE, threadIndexId: INDEX, mine: false, thread })
    const res = await GET(req(`https://x/api/account/email/thread-shares/${SHARE}`), params(SHARE))
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual(thread)
    expect(hoisted.read).toHaveBeenCalledWith({}, { shareId: SHARE, callerUserId: USER, workspaceId: WS, images: false })
  })

  it('passes images=1 through', async () => {
    hoisted.read.mockResolvedValue({ state: 'unavailable' })
    await GET(req(`https://x/api/account/email/thread-shares/${SHARE}?images=1`), params(SHARE))
    expect(hoisted.read).toHaveBeenCalledWith({}, { shareId: SHARE, callerUserId: USER, workspaceId: WS, images: true })
  })

  it('404 for a caller the share does not reach', async () => {
    hoisted.read.mockResolvedValue({ state: 'not_found' })
    const res = await GET(req(`https://x/api/account/email/thread-shares/${SHARE}`), params(SHARE))
    expect(res.status).toBe(404)
  })

  it('410 when the mail is no longer available', async () => {
    hoisted.read.mockResolvedValue({ state: 'unavailable' })
    const res = await GET(req(`https://x/api/account/email/thread-shares/${SHARE}`), params(SHARE))
    expect(res.status).toBe(410)
    expect((await readJson<{ code?: string }>(res)).code).toBe('unavailable')
  })
})

describe('DELETE /api/account/email/thread-shares/[id]', () => {
  it('un-shares for the owner', async () => {
    hoisted.revoke.mockResolvedValue({ ok: true })
    const res = await DELETE(req(`https://x/api/account/email/thread-shares/${SHARE}`, 'DELETE'), params(SHARE))
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ ok: true })
    expect(hoisted.revoke).toHaveBeenCalledWith({}, { shareId: SHARE, ownerUserId: USER, workspaceId: WS })
  })

  it('404 for a non-owner (never 403)', async () => {
    hoisted.revoke.mockResolvedValue({ ok: false, status: 404 })
    const res = await DELETE(req(`https://x/api/account/email/thread-shares/${SHARE}`, 'DELETE'), params(SHARE))
    expect(res.status).toBe(404)
  })
})

describe('GET /api/account/email/thread-shares?thread=', () => {
  it('returns the caller’s own active share id when they are a grantee', async () => {
    hoisted.find.mockResolvedValue(SHARE)
    const res = await GET_INDEX(req(`https://x/api/account/email/thread-shares?thread=${INDEX}`))
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ shareId: SHARE })
    expect(hoisted.find).toHaveBeenCalledWith({}, { threadIndexId: INDEX, callerUserId: USER, workspaceId: WS })
  })

  it('404 when the caller is not a grantee', async () => {
    hoisted.find.mockResolvedValue(null)
    const res = await GET_INDEX(req(`https://x/api/account/email/thread-shares?thread=${INDEX}`))
    expect(res.status).toBe(404)
  })

  it('400 without a thread param', async () => {
    const res = await GET_INDEX(req('https://x/api/account/email/thread-shares'))
    expect(res.status).toBe(400)
  })
})

describe('GET /api/account/email/thread-shares/[id]/attachment', () => {
  const attUrl = (opts: { message?: string; key?: string } = {}) =>
    `https://x/api/account/email/thread-shares/${SHARE}/attachment?message=${encodeURIComponent(opts.message ?? 'm1')}&key=${encodeURIComponent(opts.key ?? 'att-1')}`

  it('streams the file as a download, never inline, with the message and key passed through', async () => {
    hoisted.attachment.mockResolvedValue({
      state: 'file',
      file: { name: 'terms.pdf', mimeType: 'application/pdf', size: 4, body: new Uint8Array([1, 2, 3, 4]) },
    })
    const res = await GET_ATTACHMENT(req(attUrl()), params(SHARE))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toContain('attachment;')
    expect(res.headers.get('content-disposition')).toContain('terms.pdf')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    expect(res.headers.get('cache-control')).toBe('no-store, private')
    expect(res.headers.get('content-length')).toBe('4')
    expect(hoisted.attachment).toHaveBeenCalledWith({}, { shareId: SHARE, messageId: 'm1', key: 'att-1', callerUserId: USER, workspaceId: WS })
  })

  it('an active content type is handed on as bytes, never drawn on our origin', async () => {
    hoisted.attachment.mockResolvedValue({
      state: 'file',
      file: { name: 'evil.html', mimeType: 'text/html', size: 3, body: new Uint8Array([1, 2, 3]) },
    })
    const res = await GET_ATTACHMENT(req(attUrl({ key: 'att-html' })), params(SHARE))
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
  })

  it('404 for a caller the share does not reach (or a message/key it refuses)', async () => {
    hoisted.attachment.mockResolvedValue({ state: 'not_found' })
    const res = await GET_ATTACHMENT(req(attUrl()), params(SHARE))
    expect(res.status).toBe(404)
  })

  it('410 when the owner’s mailbox can’t give it any more', async () => {
    hoisted.attachment.mockResolvedValue({ state: 'unavailable' })
    const res = await GET_ATTACHMENT(req(attUrl()), params(SHARE))
    expect(res.status).toBe(410)
    expect((await readJson<{ code?: string }>(res)).code).toBe('unavailable')
  })

  it('refuses a device/agent Bearer caller (shared mail opens in the app)', async () => {
    const withBearer = new NextRequest(attUrl(), { headers: { authorization: 'Bearer nid_madeupdevicetoken' } })
    const res = await GET_ATTACHMENT(withBearer, params(SHARE))
    expect(res.status).toBe(403)
    expect(hoisted.attachment).not.toHaveBeenCalled()
  })
})
