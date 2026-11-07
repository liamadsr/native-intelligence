import { describe, it, expect, vi, beforeEach } from 'vitest'
import { chatMessagesFake } from '@/test/chat-messages-fake'
import { EVE_PROVISIONAL_METADATA_KEY } from '../eve-message-writer'
import type { ChatRunTokenClaims } from '../chat-run-token'

/**
 * The reply backup, server half (reply-backup.ts): parse the hook's body, reduce
 * the kept events with the browser's reducer, write a provisional row under the
 * reply id in the TOKEN's conversation, and fire the knowledge hook only when
 * that write inserted the row (never for a bot's own thread).
 */

const inngestSend = vi.fn(async (..._a: unknown[]) => undefined)
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: (...a: unknown[]) => inngestSend(...a) } }))

const { parseReplyBackupBody, persistReplyBackup } = await import('../reply-backup')

const CONV = { id: 'conv-1', user_id: 'u-1', workspace_id: 'ws-1' }
const claims: ChatRunTokenClaims = { conversationId: 'conv-1', userId: 'u-1', workspaceId: 'ws-1', exp: Date.now() + 60_000 }
const events = [
  { type: 'message.appended', data: { messageDelta: 'Updated all three steps.' } },
  { type: 'message.completed' },
  { type: 'turn.completed' },
]
const body = (over: Record<string, unknown> = {}) => ({ replyId: 'eve-msg-1', sessionId: 'wrun_1', turnId: 'turn_5', outcome: 'completed', events, ...over })

beforeEach(() => inngestSend.mockClear())

describe('parseReplyBackupBody', () => {
  it('accepts the hook body', () => {
    const parsed = parseReplyBackupBody(body())
    expect(parsed.ok).toBe(true)
  })

  it.each([
    ['no replyId', { replyId: undefined }],
    ['a replyId with spaces', { replyId: 'a b' }],
    ['an unknown outcome', { outcome: 'exploded' }],
    ['events not an array', { events: 'x' }],
    ['an event type the hook never keeps', { events: [{ type: 'step.completed', data: {} }] }],
    ['actions without call ids', { events: [{ type: 'actions.requested', data: { actions: [{}] } }] }],
    ['a result without a call id', { events: [{ type: 'action.result', data: { result: {} } }] }],
    ['a delta without data', { events: [{ type: 'message.appended' }] }],
  ])('rejects %s', (_label, over) => {
    expect(parseReplyBackupBody(body(over as Record<string, unknown>)).ok).toBe(false)
  })
})

describe('persistReplyBackup', () => {
  it("writes the reply as a provisional row in the token's conversation and fires the knowledge hook once", async () => {
    const db = chatMessagesFake([CONV])
    const parsed = parseReplyBackupBody(body())
    if (!parsed.ok) throw new Error(parsed.error)
    const res = await persistReplyBackup(db.client, claims, parsed.body)
    expect(res).toMatchObject({ written: true, replaced: false, activityFired: true })
    expect(db.thread()).toEqual([{ role: 'assistant', id: 'eve-msg-1' }])
    const row = db.messages[0]
    expect(row.ui_message.parts).toEqual([{ type: 'text', text: 'Updated all three steps.' }])
    expect(row.ui_message.metadata?.[EVE_PROVISIONAL_METADATA_KEY]).toBe(true)
    expect(inngestSend).toHaveBeenCalledTimes(1)

    // The same post again (the hook's retry): no new row, no second extraction.
    const again = await persistReplyBackup(db.client, claims, parsed.body)
    expect(again).toMatchObject({ written: false, activityFired: false })
    expect(db.messages).toHaveLength(1)
    expect(inngestSend).toHaveBeenCalledTimes(1)
  })

  it('writes nothing for events that reduce to no parts', async () => {
    const db = chatMessagesFake([CONV])
    const parsed = parseReplyBackupBody(body({ events: [{ type: 'turn.cancelled' }] }))
    if (!parsed.ok) throw new Error(parsed.error)
    expect(await persistReplyBackup(db.client, claims, parsed.body)).toMatchObject({ written: false, reason: 'empty' })
    expect(db.messages).toHaveLength(0)
  })

  it("refuses a conversation the token's user doesn't own", async () => {
    const db = chatMessagesFake([{ ...CONV, user_id: 'someone-else' }])
    const parsed = parseReplyBackupBody(body())
    if (!parsed.ok) throw new Error(parsed.error)
    expect(await persistReplyBackup(db.client, claims, parsed.body)).toMatchObject({ written: false, reason: 'owner_mismatch' })
    expect(db.messages).toHaveLength(0)
  })

  it("never feeds the knowledge hook from a bot's own thread", async () => {
    const db = chatMessagesFake([CONV])
    const parsed = parseReplyBackupBody(body())
    if (!parsed.ok) throw new Error(parsed.error)
    const res = await persistReplyBackup(db.client, { ...claims, teammateId: 'bot-1' }, parsed.body)
    expect(res).toMatchObject({ written: true, activityFired: false })
    expect(inngestSend).not.toHaveBeenCalled()
  })
})
