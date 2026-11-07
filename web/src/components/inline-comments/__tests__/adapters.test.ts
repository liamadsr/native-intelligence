/**
 * A loaded comment with no member author belongs to a guest or a former member
 * (migration 320), never to the viewer: it must not take the viewer's name,
 * avatar or member id (which would offer them Edit and Delete). Only the reply
 * to the viewer's own post fills gaps from their identity.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createAuthenticatedAPI, mapAuthComments } from '../adapters'

const identity = { mode: 'authenticated' as const, memberId: 'm-viewer', displayName: 'Viewer', avatarUrl: 'https://x/viewer.png' }

afterEach(() => vi.unstubAllGlobals())

describe('inline comment adapters', () => {
  it('a former member’s loaded comment keeps its own name and no member, avatar or edit rights', () => {
    const [c] = mapAuthComments(
      [{ id: 'c1', body: 'I left', author_id: null, author_user_id: null, author_name: 'Bo', author_avatar: null, is_guest: false, created_at: 't' }],
      identity,
    )
    expect(c).toMatchObject({ author_id: null, author_name: 'Bo', author_avatar: null, is_guest: false })
  })

  it('a member’s loaded comment is theirs, not the viewer’s', () => {
    const [c] = mapAuthComments(
      [{ id: 'c2', body: 'hi', author_id: 'm-ana', author_name: 'Ana', author_avatar: null, created_at: 't' }],
      identity,
    )
    expect(c).toMatchObject({ author_id: 'm-ana', author_name: 'Ana', author_avatar: null })
  })

  it('the reply to the viewer’s own post fills gaps from their identity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ comment: { id: 'c3', body: 'mine', created_at: 't' } }), { status: 200 })))
    const posted = await createAuthenticatedAPI('document', 'doc-1', identity).postComment({ content: 'mine' } as never)
    expect(posted).toMatchObject({ author_id: 'm-viewer', author_name: 'Viewer', author_avatar: 'https://x/viewer.png' })
  })
})
