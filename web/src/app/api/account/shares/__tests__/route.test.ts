/**
 * /api/account/shares — external share links, gated on capture visibility.
 *
 * These routes previously had NO ownership check at all: any member could list
 * (and mint) share links for any shareable_id in the workspace. That becomes
 * critical with private captures — publishing someone else's "Only me" capture
 * to a public link would defeat the scope entirely. Document sharing keeps its
 * existing (workspace-wide) behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest } from '@/test/integration'
import { withMemberSchema } from '@/test/member-schema'

const hoisted = vi.hoisted(() => ({
  client: vi.fn(),
  workspaceId: vi.fn(),
  insertSpy: vi.fn(),
  createNotification: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: hoisted.client }))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: hoisted.workspaceId }))
vi.mock('@/lib/share-token', () => ({ generateShareToken: () => 'tok-123' }))
vi.mock('@/lib/notifications', () => ({ createNotification: hoisted.createNotification }))

/**
 * The service client: the workspace's members (real member columns only, so
 * a member query naming one it lacks fails as PostgREST fails it) and their
 * sign-in emails on the auth users. Tess is a teammate.
 */
const service = withMemberSchema({
  from(table: string) {
    const query: Record<string, unknown> = {}
    query.select = () => query
    query.eq = () => query
    query.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({
        data: table === 'member' ? [{ id: 'member-tess', user_id: 'user-tess', display_name: 'Tess' }] : [],
        error: null,
      }).then(resolve)
    return query
  },
  auth: {
    admin: {
      getUserById: async (id: string) => ({
        data: { user: { id, email: id === 'user-tess' ? 'tess@acme.com' : null } },
        error: null,
      }),
    },
  },
})
vi.mock('@/lib/admin', () => ({ getServiceClient: () => service }))

const WORKSPACE_ID = 'ws-test-1'
const USER_ID = 'user-1'
const CAPTURE_ID = 'cap-1'
const DOC_ID = 'doc-1'

type CaptureRow = { id: string; user_id: string; visibility: string } | null

/**
 * `captureRow` is what the visibility-filtered lookup returns — pass null to
 * simulate a capture the RLS/or-predicate hides from this caller.
 */
function makeClient(captureRow: CaptureRow, requesterId = USER_ID, documentRow: { id: string; kind?: string } | null = { id: DOC_ID }) {
  const captureChain: Record<string, unknown> = {
    select: () => captureChain,
    eq: () => captureChain,
    or: () => captureChain,
    maybeSingle: async () => ({ data: captureRow, error: null }),
    single: async () => ({ data: captureRow, error: null }),
  }

  const documentChain: Record<string, unknown> = {
    select: () => documentChain,
    eq: () => documentChain,
    maybeSingle: async () => ({ data: documentRow, error: null }),
    single: async () => ({ data: documentRow, error: null }),
  }

  const memberChain: Record<string, unknown> = {
    select: () => memberChain,
    eq: () => memberChain,
    single: async () => ({ data: { id: 'member-1', display_name: 'Me' }, error: null }),
  }

  const shareChain: Record<string, unknown> = {
    select: () => shareChain,
    eq: () => shareChain,
    order: () => shareChain,
    // No pre-existing link share.
    single: async () => ({ data: null, error: null }),
    insert: (row: Record<string, unknown>) => {
      hoisted.insertSpy(row)
      return shareChain
    },
    then: (resolve: (v: { data: unknown; error: null; count?: number }) => unknown) =>
      resolve({ data: [], error: null, count: 0 }),
  }

  // The share INSERT ends .insert().select().single() — return the created row.
  const shareInsertResult = {
    id: 'share-1',
    share_token: 'tok-123',
  }

  return withMemberSchema({
    from: (table: string) => {
      if (table === 'captures') return captureChain
      if (table === 'document') return documentChain
      if (table === 'member') return memberChain
      if (table === 'share') {
        return {
          ...shareChain,
          insert: (row: Record<string, unknown>) => {
            hoisted.insertSpy(row)
            return {
              select: () => ({ single: async () => ({ data: shareInsertResult, error: null }) }),
            }
          },
        }
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              then: (r: (v: { count: number }) => unknown) => r({ count: 0 }),
            }),
          }),
        }),
      }
    },
    auth: { getUser: async () => ({ data: { user: { id: requesterId } } }) },
  })
}

function setup(captureRow: CaptureRow, requesterId = USER_ID, documentRow: { id: string; kind?: string } | null = { id: DOC_ID }) {
  hoisted.client.mockResolvedValue(makeClient(captureRow, requesterId, documentRow))
  hoisted.workspaceId.mockResolvedValue(WORKSPACE_ID)
}

function getReq(query: string): NextRequest {
  return {
    nextUrl: new URL(`https://dial8.ai/api/account/shares${query}`),
  } as unknown as NextRequest
}

function postReq(body: unknown): NextRequest {
  return buildRequest({
    url: 'https://dial8.ai/api/account/shares',
    method: 'POST',
    body,
  }) as unknown as NextRequest
}

const { GET, POST } = await import('@/app/api/account/shares/route')
const { _resetMemberEmailCacheForTests } = await import('@/lib/workspace-member-emails')

describe('GET /api/account/shares — capture visibility gate', () => {
  beforeEach(() => {
    hoisted.client.mockReset()
    hoisted.workspaceId.mockReset()
    hoisted.insertSpy.mockReset()
  })

  it('lists shares for a visible capture', async () => {
    setup({ id: CAPTURE_ID, user_id: USER_ID, visibility: 'workspace' })
    const res = await GET(getReq(`?shareable_type=capture&shareable_id=${CAPTURE_ID}`))
    expect(res.status).toBe(200)
  })

  it('404s for a capture the caller cannot see', async () => {
    setup(null, 'user-other')
    const res = await GET(getReq(`?shareable_type=capture&shareable_id=${CAPTURE_ID}`))
    expect(res.status).toBe(404)
  })

  it('does not gate document shares on the capture check', async () => {
    setup(null)
    const res = await GET(getReq(`?shareable_type=document&shareable_id=${DOC_ID}`))
    expect(res.status).toBe(200)
  })

  it("404s for someone else's private document (RLS hides it, migration 369)", async () => {
    setup(null, 'user-other', null)
    const res = await GET(getReq(`?shareable_type=document&shareable_id=${DOC_ID}`))
    expect(res.status).toBe(404)
  })

  it("never mints a link for someone else's private document", async () => {
    setup(null, 'user-other', null)
    const res = await POST(postReq({ shareable_type: 'document', shareable_id: DOC_ID, share_type: 'link' }))
    expect(res.status).toBe(404)
    expect(hoisted.insertSpy).not.toHaveBeenCalled()
  })

  it('never shares the person’s own Now file, by link or email (migration 440)', async () => {
    for (const share_type of ['link', 'email']) {
      setup(null, USER_ID, { id: DOC_ID, kind: 'now' })
      const res = await POST(postReq({ shareable_type: 'document', shareable_id: DOC_ID, share_type, shared_with_email: 'tess@acme.com' }))
      expect(res.status).toBe(403)
      expect((await res.json()).error).toMatch(/always private/)
    }
    expect(hoisted.insertSpy).not.toHaveBeenCalled()
  })
})

describe('POST /api/account/shares — private captures are creator-only', () => {
  beforeEach(() => {
    hoisted.client.mockReset()
    hoisted.workspaceId.mockReset()
    hoisted.insertSpy.mockReset()
  })

  const linkShare = {
    shareable_type: 'capture',
    shareable_id: CAPTURE_ID,
    share_type: 'link',
  }

  it('lets the creator share their own private capture', async () => {
    setup({ id: CAPTURE_ID, user_id: USER_ID, visibility: 'private' }, USER_ID)
    const res = await POST(postReq(linkShare))
    expect(res.status).toBe(200)
    expect(hoisted.insertSpy).toHaveBeenCalled()
  })

  it('lets any member share a workspace capture (unchanged behavior)', async () => {
    setup({ id: CAPTURE_ID, user_id: 'user-creator', visibility: 'workspace' }, USER_ID)
    const res = await POST(postReq(linkShare))
    expect(res.status).toBe(200)
    expect(hoisted.insertSpy).toHaveBeenCalled()
  })

  it('403s when a non-creator tries to share a private capture', async () => {
    // A row can reach here for a non-creator only if RLS/the predicate let it
    // through; the explicit check is the backstop that must still refuse.
    setup({ id: CAPTURE_ID, user_id: 'user-creator', visibility: 'private' }, USER_ID)
    const res = await POST(postReq(linkShare))
    expect(res.status).toBe(403)
    expect(hoisted.insertSpy).not.toHaveBeenCalled()
  })

  it('404s when the capture is invisible to the caller', async () => {
    setup(null, 'user-other')
    const res = await POST(postReq(linkShare))
    expect(res.status).toBe(404)
    expect(hoisted.insertSpy).not.toHaveBeenCalled()
  })

  it('document shares are unaffected', async () => {
    setup(null)
    const res = await POST(
      postReq({ shareable_type: 'document', shareable_id: DOC_ID, share_type: 'link' }),
    )
    expect(res.status).toBe(200)
    expect(hoisted.insertSpy).toHaveBeenCalled()
  })
})

describe('POST /api/account/shares — an email share with a teammate', () => {
  beforeEach(() => {
    hoisted.client.mockReset()
    hoisted.workspaceId.mockReset()
    hoisted.insertSpy.mockReset()
    hoisted.createNotification.mockReset()
    _resetMemberEmailCacheForTests()
  })

  const emailShare = (email: string) => ({
    shareable_type: 'capture',
    shareable_id: CAPTURE_ID,
    share_type: 'email',
    shared_with_email: email,
  })

  it('notifies the teammate whose sign-in email it is', async () => {
    // member has no email column: matching `.eq('email', …)` made PostgREST
    // refuse the read, so no teammate was ever notified.
    setup({ id: CAPTURE_ID, user_id: USER_ID, visibility: 'workspace' })
    const res = await POST(postReq(emailShare('Tess@Acme.com')))

    expect(res.status).toBe(200)
    expect(hoisted.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: 'member-tess', actorId: 'member-1', type: 'capture_shared' }),
    )
  })

  it('notifies no one when the address is not a teammate', async () => {
    setup({ id: CAPTURE_ID, user_id: USER_ID, visibility: 'workspace' })
    const res = await POST(postReq(emailShare('stranger@elsewhere.com')))

    expect(res.status).toBe(200)
    expect(hoisted.createNotification).not.toHaveBeenCalled()
  })
})
