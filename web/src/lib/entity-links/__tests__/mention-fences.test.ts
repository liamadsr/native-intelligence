/**
 * The fences "mentions everywhere" added to visibleMentionTargets
 * (../mentions.ts, src/lib/entity-links/mentions.ts visibleIdsOf):
 *  - an agent chat (conversation) and a mail thread (email_thread): only their
 *    owner may mention them (user_id = the writer), decision 1;
 *  - no writer (a service client acting for no one): none of these pass.
 * Restated here because these fences also run on a service client, where RLS
 * hides nothing. Fixtures are made up (Ana, Ben).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { visibleMentionTargets } from '../mentions'
import type { MentionRef } from '../mentionable'

const WS = '11111111-1111-4111-8111-111111111111'
const ANA = '22222222-2222-4222-8222-aaaaaaaaaaaa'
const BEN = '22222222-2222-4222-8222-bbbbbbbbbbbb'
const ANA_MEMBER = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const BEN_MEMBER = '33333333-3333-4333-8333-bbbbbbbbbbbb'
const PUBLIC_TEAM = 'a1000000-0000-4000-8000-000000000001'
const ANA_TEAM = 'a1000000-0000-4000-8000-000000000002'
const BEN_TEAM = 'a1000000-0000-4000-8000-000000000003'
const ANA_CHAT = 'b1000000-0000-4000-8000-000000000001'
const BEN_CHAT = 'b1000000-0000-4000-8000-000000000002'
const ANA_MAIL = 'c1000000-0000-4000-8000-000000000001'
const BEN_MAIL = 'c1000000-0000-4000-8000-000000000002'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>

beforeEach(() => {
  tables = {
    member: [
      { id: ANA_MEMBER, user_id: ANA, workspace_id: WS },
      { id: BEN_MEMBER, user_id: BEN, workspace_id: WS },
    ],
    team: [
      { id: PUBLIC_TEAM, workspace_id: WS, is_private: false },
      { id: ANA_TEAM, workspace_id: WS, is_private: true },
      { id: BEN_TEAM, workspace_id: WS, is_private: true },
    ],
    team_member: [
      { team_id: ANA_TEAM, member_id: ANA_MEMBER },
      { team_id: BEN_TEAM, member_id: BEN_MEMBER },
    ],
    chat_conversations: [
      { id: ANA_CHAT, workspace_id: WS, user_id: ANA },
      { id: BEN_CHAT, workspace_id: WS, user_id: BEN },
    ],
    email_thread_index: [
      { id: ANA_MAIL, workspace_id: WS, user_id: ANA },
      { id: BEN_MAIL, workspace_id: WS, user_id: BEN },
    ],
  }
})

const keys = (refs: MentionRef[]) => refs.map((r) => `${r.type}:${r.id}`).sort()

describe('visibleMentionTargets: mail and agent chats (owner only)', () => {
  it('passes only the writer’s own chat and mail thread', async () => {
    const visible = await visibleMentionTargets(memoryDb(tables), { workspaceId: WS, userId: ANA }, [
      { type: 'conversation', id: ANA_CHAT },
      { type: 'conversation', id: BEN_CHAT },
      { type: 'email_thread', id: ANA_MAIL },
      { type: 'email_thread', id: BEN_MAIL },
    ])
    expect(keys(visible)).toEqual([`conversation:${ANA_CHAT}`, `email_thread:${ANA_MAIL}`].sort())
  })

  it('no writer mentions no owner-fenced kind', async () => {
    const visible = await visibleMentionTargets(memoryDb(tables), { workspaceId: WS, userId: null }, [
      { type: 'conversation', id: ANA_CHAT },
      { type: 'email_thread', id: ANA_MAIL },
    ])
    expect(visible).toEqual([])
  })
})
