/**
 * shareConversationWithMembers (../conversation-share.ts): the owner shares
 * their agent chat read-only with workspace members (decision 1). It writes one
 * conversation_share row per distinct grantee, source 'mention'. The insert
 * policy (migration 671) refuses a chat the caller does not own; that is not
 * exercised here (the in-memory db has no RLS). Fixtures are made up.
 */
import { describe, expect, it } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { shareConversationWithMembers } from '../conversation-share'

const WS = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-aaaaaaaaaaaa'
const CONV = 'e0000000-0000-4000-8000-000000000001'
const M1 = '33333333-3333-4333-8333-000000000001'
const M2 = '33333333-3333-4333-8333-000000000002'

describe('shareConversationWithMembers', () => {
  it('writes one share per distinct grantee, source mention', async () => {
    const tables: Record<string, Record<string, unknown>[]> = { conversation_share: [] }
    const res = await shareConversationWithMembers(memoryDb(tables), { workspaceId: WS, conversationId: CONV, userId: USER, memberIds: [M1, M2, M1] })
    expect(res.shared).toBe(2)
    expect(tables.conversation_share.map((r) => r.grantee_member_id).sort()).toEqual([M1, M2].sort())
    expect(tables.conversation_share.every((r) => r.source === 'mention' && r.shared_by === USER && r.conversation_id === CONV && r.workspace_id === WS)).toBe(true)
  })

  it('writes nothing for no members, and is idempotent (ignoreDuplicates)', async () => {
    const tables: Record<string, Record<string, unknown>[]> = { conversation_share: [] }
    expect((await shareConversationWithMembers(memoryDb(tables), { workspaceId: WS, conversationId: CONV, userId: USER, memberIds: [] })).shared).toBe(0)
    await shareConversationWithMembers(memoryDb(tables), { workspaceId: WS, conversationId: CONV, userId: USER, memberIds: [M1] })
    await shareConversationWithMembers(memoryDb(tables), { workspaceId: WS, conversationId: CONV, userId: USER, memberIds: [M1] })
    expect(tables.conversation_share).toHaveLength(1)
  })
})
