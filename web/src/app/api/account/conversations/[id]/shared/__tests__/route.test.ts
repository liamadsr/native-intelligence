/**
 * GET /api/account/conversations/[id]/shared — opening an agent chat read-only
 * (docs/plans/mentions-everywhere.md JOB 2). What matters: the owner reads
 * their own chat; a grantee named by a conversation_share in the same workspace
 * reads it; a member with no share, a grantee acting in another workspace, and
 * a share for a different conversation all get 404 (never 403); tool/system
 * parts and hidden message kinds are stripped from the answer.
 *
 * The route reads the chat tables on the SERVICE client (they are owner-only
 * under RLS), so the service client is a memoryDb holding the fixtures; auth is
 * mocked to the caller requireWorkspaceMember would resolve. Fixtures are made
 * up (Ana, Ben, Sam, Harbor).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { memoryDb } from '@/test/memory-db'

const WS = '11111111-1111-4111-8111-111111111111'
const OTHER_WS = '11111111-1111-4111-8111-222222222222'
const CONV = 'c0000000-0000-4000-8000-000000000001'
const OTHER_CONV = 'c0000000-0000-4000-8000-000000000002'
const ANA_USER = 'a0000000-0000-4000-8000-00000000aaaa'
const BEN_USER = 'a0000000-0000-4000-8000-00000000bbbb'
const ANA_MEMBER = 'd0000000-0000-4000-8000-00000000aaaa'
const BEN_MEMBER = 'd0000000-0000-4000-8000-00000000bbbb'
const BEN_OTHER_MEMBER = 'd0000000-0000-4000-8000-00000000cccc'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>

const hoisted = vi.hoisted(() => ({
  auth: null as unknown,
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: vi.fn(async () => hoisted.auth),
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => memoryDb(tables),
}))

const { GET } = await import('../route')

function call(id: string) {
  return GET(new NextRequest(`http://localhost/api/account/conversations/${id}/shared`), { params: Promise.resolve({ id }) })
}

/** The caller requireWorkspaceMember resolves: acting in `workspaceId` as member `memberId`. */
function actAs(userId: string, memberId: string, workspaceId = WS) {
  hoisted.auth = { supabase: memoryDb(tables), user: { id: userId }, workspaceId, member: { id: memberId } }
}

beforeEach(() => {
  tables = {
    chat_conversations: [{ id: CONV, user_id: ANA_USER, workspace_id: WS, title: 'Harbor chat' }],
    conversation_share: [],
    member: [
      { id: ANA_MEMBER, user_id: ANA_USER, workspace_id: WS, display_name: 'Ana' },
      { id: BEN_MEMBER, user_id: BEN_USER, workspace_id: WS, display_name: 'Ben' },
      { id: BEN_OTHER_MEMBER, user_id: BEN_USER, workspace_id: OTHER_WS, display_name: 'Ben' },
    ],
    chat_messages: [
      { conversation_id: CONV, workspace_id: WS, ui_message: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'What did Harbor decide?' }] }, created_at: '2026-01-01T00:00:01Z' },
      {
        conversation_id: CONV,
        workspace_id: WS,
        ui_message: {
          id: 'a1',
          role: 'assistant',
          parts: [
            { type: 'tool-ni_search', state: 'output-available', output: { secret: true } },
            { type: 'text', text: 'The north dock.' },
          ],
          metadata: { eve_written: true },
        },
        created_at: '2026-01-01T00:00:02Z',
      },
      // A reaction turn — hidden from a reader.
      { conversation_id: CONV, workspace_id: WS, ui_message: { id: 'r1', role: 'user', parts: [{ type: 'text', text: '👍' }], metadata: { kind: 'reaction' } }, created_at: '2026-01-01T00:00:03Z' },
    ],
  }
  hoisted.auth = null
})

describe('GET /api/account/conversations/[id]/shared', () => {
  it('passes an auth/workspace failure straight through', async () => {
    hoisted.auth = new Response(null, { status: 401 })
    const res = await call(CONV)
    expect(res.status).toBe(401)
  })

  it('lets the owner read their own chat, shaped', async () => {
    actAs(ANA_USER, ANA_MEMBER)
    const res = await call(CONV)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.role).toBe('owner')
    expect(body.title).toBe('Harbor chat')
    expect(body.ownerName).toBe('Ana')
    // Tool parts stripped, reaction turn hidden.
    expect(body.messages).toEqual([
      { id: 'u1', role: 'user', text: 'What did Harbor decide?', createdAt: '2026-01-01T00:00:01Z' },
      { id: 'a1', role: 'assistant', text: 'The north dock.', createdAt: '2026-01-01T00:00:02Z' },
    ])
  })

  it('lets a grantee named by a share read it, as "Shared by <owner>"', async () => {
    tables.conversation_share.push({ conversation_id: CONV, grantee_member_id: BEN_MEMBER, workspace_id: WS, shared_by: ANA_USER })
    actAs(BEN_USER, BEN_MEMBER)
    const res = await call(CONV)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.role).toBe('grantee')
    expect(body.ownerName).toBe('Ana')
    expect(body.messages).toHaveLength(2)
  })

  it('404 for a member with no share', async () => {
    actAs(BEN_USER, BEN_MEMBER)
    const res = await call(CONV)
    expect(res.status).toBe(404)
  })

  it('404 for a grantee acting in another workspace', async () => {
    // A share exists for Ben in WS, but he is acting in OTHER_WS; the chat is WS's.
    tables.conversation_share.push({ conversation_id: CONV, grantee_member_id: BEN_MEMBER, workspace_id: WS, shared_by: ANA_USER })
    actAs(BEN_USER, BEN_OTHER_MEMBER, OTHER_WS)
    const res = await call(CONV)
    expect(res.status).toBe(404)
  })

  it('404 when the share is for a DIFFERENT conversation', async () => {
    tables.conversation_share.push({ conversation_id: OTHER_CONV, grantee_member_id: BEN_MEMBER, workspace_id: WS, shared_by: ANA_USER })
    actAs(BEN_USER, BEN_MEMBER)
    const res = await call(CONV)
    expect(res.status).toBe(404)
  })

  it('404 for a conversation that does not exist', async () => {
    actAs(ANA_USER, ANA_MEMBER)
    const res = await call('c0000000-0000-4000-8000-0000000000ff')
    expect(res.status).toBe(404)
  })
})
