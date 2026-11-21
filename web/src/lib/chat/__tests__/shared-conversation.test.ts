/**
 * The pure half of the shared-chat reader (../shared-conversation.ts,
 * docs/plans/mentions-everywhere.md JOB 2):
 *  - decideSharedAccess: an owner reads; a grantee of a share in the same
 *    workspace reads; a member with no share, a grantee from another workspace,
 *    and a share for a different conversation all get nothing (the route's 404);
 *  - shapeSharedMessages: only role + plain text survive (tool/reasoning/file/
 *    data parts and metadata are dropped), the hidden kinds (reaction turns,
 *    channel messages, opened cards) are hidden, and the newest 200 are kept.
 * Fixtures are made up (Ana, Ben, Sam, Harbor).
 */
import { describe, expect, it } from 'vitest'
import {
  decideSharedAccess,
  shapeSharedMessages,
  SHARED_CONVERSATION_MESSAGE_CAP,
  type ConversationShareRow,
  type SharedConversationRow,
  type SharedMessageRow,
} from '../shared-conversation'

const WS = 'ws-harbor'
const OTHER_WS = 'ws-elsewhere'
const CONV = 'conv-1'
const ANA_USER = 'user-ana'
const BEN_USER = 'user-ben'
const BEN_MEMBER = 'member-ben'
const SAM_MEMBER = 'member-sam'

const conv: SharedConversationRow = { id: CONV, user_id: ANA_USER, workspace_id: WS, title: 'Harbor chat' }

describe('decideSharedAccess', () => {
  it('lets the owner read', () => {
    expect(
      decideSharedAccess({ conversation: conv, callerUserId: ANA_USER, workspaceId: WS, callerMemberIds: ['member-ana'], shares: [] }),
    ).toBe('owner')
  })

  it('lets a grantee of a share in the same workspace read', () => {
    const shares: ConversationShareRow[] = [{ conversation_id: CONV, grantee_member_id: BEN_MEMBER, workspace_id: WS }]
    expect(
      decideSharedAccess({ conversation: conv, callerUserId: BEN_USER, workspaceId: WS, callerMemberIds: [BEN_MEMBER], shares }),
    ).toBe('grantee')
  })

  it('denies a member with no share', () => {
    expect(
      decideSharedAccess({ conversation: conv, callerUserId: BEN_USER, workspaceId: WS, callerMemberIds: [BEN_MEMBER], shares: [] }),
    ).toBeNull()
  })

  it('denies a grantee acting in another workspace (the conversation is not that workspace’s)', () => {
    const shares: ConversationShareRow[] = [{ conversation_id: CONV, grantee_member_id: BEN_MEMBER, workspace_id: WS }]
    // The caller is acting in OTHER_WS, but the conversation lives in WS → 404.
    expect(
      decideSharedAccess({ conversation: conv, callerUserId: BEN_USER, workspaceId: OTHER_WS, callerMemberIds: [BEN_MEMBER], shares }),
    ).toBeNull()
  })

  it('does not let a share for a DIFFERENT conversation open this one', () => {
    const shares: ConversationShareRow[] = [{ conversation_id: 'conv-other', grantee_member_id: BEN_MEMBER, workspace_id: WS }]
    expect(
      decideSharedAccess({ conversation: conv, callerUserId: BEN_USER, workspaceId: WS, callerMemberIds: [BEN_MEMBER], shares }),
    ).toBeNull()
  })

  it('does not let a share to ANOTHER member help this caller', () => {
    const shares: ConversationShareRow[] = [{ conversation_id: CONV, grantee_member_id: SAM_MEMBER, workspace_id: WS }]
    expect(
      decideSharedAccess({ conversation: conv, callerUserId: BEN_USER, workspaceId: WS, callerMemberIds: [BEN_MEMBER], shares }),
    ).toBeNull()
  })

  it('is null for no such conversation', () => {
    expect(
      decideSharedAccess({ conversation: null, callerUserId: ANA_USER, workspaceId: WS, callerMemberIds: ['member-ana'], shares: [] }),
    ).toBeNull()
  })
})

function msg(ui: Record<string, unknown>, created_at = '2026-01-01T00:00:00Z'): SharedMessageRow {
  return { ui_message: ui, created_at }
}

describe('shapeSharedMessages', () => {
  it('keeps role + plain text + created_at, dropping tool/reasoning/file parts and metadata', () => {
    const rows: SharedMessageRow[] = [
      msg({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'What did Harbor decide?' }] }, '2026-01-01T00:00:01Z'),
      msg({
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'thinking privately' },
          { type: 'tool-ni_search', state: 'output-available', input: { q: 'x' }, output: { results: ['secret'] } },
          { type: 'text', text: 'They chose the north dock.' },
          { type: 'file', filename: 'plan.pdf', url: 'https://x' },
        ],
        metadata: { eve_written: true, model: 'opus' },
      }, '2026-01-01T00:00:02Z'),
    ]
    const out = shapeSharedMessages(rows)
    expect(out).toEqual([
      { id: 'u1', role: 'user', text: 'What did Harbor decide?', createdAt: '2026-01-01T00:00:01Z' },
      { id: 'a1', role: 'assistant', text: 'They chose the north dock.', createdAt: '2026-01-01T00:00:02Z' },
    ])
  })

  it('drops an assistant message that is only tool calls (no text left)', () => {
    const out = shapeSharedMessages([
      msg({ id: 'a1', role: 'assistant', parts: [{ type: 'tool-ni_find', state: 'output-available', output: { ok: true } }] }),
    ])
    expect(out).toEqual([])
  })

  it('hides reaction turns, channel messages, opened cards, and non user/assistant roles', () => {
    const rows: SharedMessageRow[] = [
      // A reaction's own turn.
      msg({ id: 'r1', role: 'user', parts: [{ type: 'text', text: '👍' }], metadata: { kind: 'reaction', reaction: { emoji: '👍' } } }),
      // A message from an outside channel (Slack).
      msg({ id: 'slack-in:T:C:1', role: 'user', parts: [{ type: 'text', text: 'from slack' }], metadata: { kind: 'channel_message', channel: 'slack' } }),
      // A card the person opened from `/`.
      msg({ id: 'opened-card-1', role: 'user', parts: [{ type: 'data-chat-card', id: 'c1', data: { card: { kind: 'actions' } } }] }),
      // A system/context message.
      msg({ id: 's1', role: 'system', parts: [{ type: 'text', text: 'system note' }] }),
      // A real one that stays.
      msg({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'real question' }] }),
    ]
    const out = shapeSharedMessages(rows)
    expect(out.map((m) => m.id)).toEqual(['u1'])
    expect(out[0].text).toBe('real question')
  })

  it('caps to the most recent SHARED_CONVERSATION_MESSAGE_CAP, keeping the newest', () => {
    const rows: SharedMessageRow[] = Array.from({ length: SHARED_CONVERSATION_MESSAGE_CAP + 5 }, (_, i) =>
      msg({ id: `m${i}`, role: 'user', parts: [{ type: 'text', text: `message ${i}` }] }, `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`),
    )
    const out = shapeSharedMessages(rows)
    expect(out).toHaveLength(SHARED_CONVERSATION_MESSAGE_CAP)
    // The oldest five are dropped; the first kept is m5, the last is the newest.
    expect(out[0].id).toBe('m5')
    expect(out[out.length - 1].id).toBe(`m${SHARED_CONVERSATION_MESSAGE_CAP + 4}`)
  })
})
