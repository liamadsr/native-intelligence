/**
 * The person's own attachment download: signed in, read live from their
 * mailbox, always answered as a download that a browser can't draw or sniff.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  read: vi.fn(),
}))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: mocks.auth }))
vi.mock('@/lib/email/email-read-service', () => ({ readEmailAttachment: mocks.read }))

import { GET } from '../route'

const request = (query: string) => new NextRequest(`http://localhost/api/account/email/threads/t1/attachment${query}`)

beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue({ user: { id: 'u1' }, workspaceId: 'w1' })
  mocks.read.mockReset()
})

describe('GET /api/account/email/threads/[threadId]/attachment', () => {
  it('answers what the auth helper answers when nobody is signed in', async () => {
    mocks.auth.mockResolvedValue(new Response(null, { status: 401 }))
    const res = await GET(request('?message=m1&name=a.pdf'))
    expect(res.status).toBe(401)
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('needs a message and a name', async () => {
    expect((await GET(request('?message=m1'))).status).toBe(400)
    expect((await GET(request('?name=a.pdf'))).status).toBe(400)
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('reads the file from the signed-in person’s mailboxes in this workspace, and sends it as a download', async () => {
    mocks.read.mockResolvedValue({ fileName: 'Lease “2027”.pdf', bytes: new Uint8Array([1, 2, 3]) })
    const res = await GET(request(`?message=m1&name=${encodeURIComponent('Lease “2027”.pdf')}`))
    expect(mocks.read).toHaveBeenCalledWith('u1', 'm1', 'Lease “2027”.pdf', 'w1')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename="Lease _2027_.pdf"; filename*=UTF-8''Lease%20%E2%80%9C2027%E2%80%9D.pdf`)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Cache-Control')).toBe('no-store, private')
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox")
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('is a 404 when no mailbox holds the file (or it is too large)', async () => {
    mocks.read.mockResolvedValue(null)
    expect((await GET(request('?message=m1&name=a.pdf'))).status).toBe(404)
  })
})
