import { describe, expect, it, vi } from 'vitest'
import { RELAY_MAX_CHARS, ReplyRelay, ownerRepliesSince, recordAnswer, relayedAnswer, replyTextOf } from '@/lib/meeting-agent/reply-relay'
import { attendanceRow, fakeDb, ATT, ME } from './fake-db'

const A = { id: ATT, userId: ME, ownerFirstName: 'Sam' }
const ASKED = '2026-11-30T18:10:00.000Z'

describe("the person's answer, read out as theirs", () => {
  it('says it in their name, speakable and cut', () => {
    expect(relayedAnswer('Sam', 'Yes, **Monday** works. See https://example.com')).toBe('Sam says: Yes, Monday works. See')
    const long = relayedAnswer('Sam', 'word '.repeat(200))
    expect(long.startsWith('Sam says: ')).toBe(true)
    expect(long.length).toBeLessThanOrEqual('Sam says: '.length + RELAY_MAX_CHARS + 1)
    expect(long.endsWith('…')).toBe(true)
  })
  it("reads a message's text parts only", () => {
    expect(replyTextOf({ parts: [{ type: 'text', text: 'Yes' }, { type: 'file', url: 'x' }, { type: 'text', text: ' Monday ' }] })).toBe('Yes Monday')
    expect(replyTextOf(null)).toBe('')
  })

  it('one reply answers the oldest open ask, a second the next; a reply seen once is never said again', async () => {
    const replies = vi.fn(async () => [
      { id: 'm1', createdAt: '2026-11-30T18:11:00.000Z', text: 'Yes, Monday.' },
      { id: 'm2', createdAt: '2026-11-30T18:13:00.000Z', text: 'No discount.' },
    ])
    const record = vi.fn(async () => {})
    const relay = new ReplyRelay({} as never, A, { replies, record })
    relay.add({ messageId: 'ask-1', conversationId: 'conv-1', askedAt: ASKED })
    relay.add({ messageId: 'ask-2', conversationId: 'conv-1', askedAt: '2026-11-30T18:12:00.000Z' })
    expect(await relay.poll()).toEqual(['Sam says: Yes, Monday.', 'Sam says: No discount.'])
    expect(record).toHaveBeenNthCalledWith(1, {}, ATT, 'ask-1', { messageId: 'm1', at: '2026-11-30T18:11:00.000Z' })
    expect(record).toHaveBeenNthCalledWith(2, {}, ATT, 'ask-2', { messageId: 'm2', at: '2026-11-30T18:13:00.000Z' })
    expect(relay.hasOpen()).toBe(false)
    expect(await relay.poll()).toEqual([])
  })

  it('a reply written before the second ask answers only the first', async () => {
    const relay = new ReplyRelay({} as never, A, { replies: vi.fn(async () => [{ id: 'm1', createdAt: '2026-11-30T18:11:00.000Z', text: 'Yes.' }]), record: vi.fn(async () => {}) })
    relay.add({ messageId: 'ask-1', conversationId: 'conv-1', askedAt: ASKED })
    relay.add({ messageId: 'ask-2', conversationId: 'conv-1', askedAt: '2026-11-30T18:12:00.000Z' })
    expect(await relay.poll()).toEqual(['Sam says: Yes.'])
    expect(relay.hasOpen()).toBe(true)
  })

  it('with nothing open it reads nothing, and a failed read says nothing and never throws', async () => {
    const replies = vi.fn(async () => {
      throw new Error('db down')
    })
    const relay = new ReplyRelay({} as never, A, { replies })
    expect(await relay.poll()).toEqual([])
    expect(replies).not.toHaveBeenCalled()
    relay.add({ messageId: 'ask-1', conversationId: 'conv-1', askedAt: ASKED })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await relay.poll()).toEqual([])
    warn.mockRestore()
    expect(relay.hasOpen()).toBe(true)
  })
})

describe('the reads and writes', () => {
  it("reads only the person's own messages in that thread after the ask, with words", async () => {
    const db = fakeDb({
      chat_messages: [
        { id: 'm0', conversation_id: 'conv-1', user_id: ME, role: 'user', created_at: '2026-11-30T18:09:00.000Z', ui_message: { parts: [{ type: 'text', text: 'before' }] } },
        { id: 'm1', conversation_id: 'conv-1', user_id: ME, role: 'user', created_at: '2026-11-30T18:11:00.000Z', ui_message: { parts: [{ type: 'text', text: 'Yes' }] } },
        { id: 'm2', conversation_id: 'conv-1', user_id: ME, role: 'assistant', created_at: '2026-11-30T18:11:30.000Z', ui_message: { parts: [{ type: 'text', text: 'agent' }] } },
        { id: 'm3', conversation_id: 'conv-2', user_id: ME, role: 'user', created_at: '2026-11-30T18:12:00.000Z', ui_message: { parts: [{ type: 'text', text: 'other thread' }] } },
        { id: 'm4', conversation_id: 'conv-1', user_id: 'user-other', role: 'user', created_at: '2026-11-30T18:12:00.000Z', ui_message: { parts: [{ type: 'text', text: 'someone else' }] } },
        { id: 'm5', conversation_id: 'conv-1', user_id: ME, role: 'user', created_at: '2026-11-30T18:13:00.000Z', ui_message: { parts: [{ type: 'file' }] } },
      ],
    })
    expect(await ownerRepliesSince(db.client, { conversationId: 'conv-1', userId: ME, sinceIso: ASKED })).toEqual([{ id: 'm1', createdAt: '2026-11-30T18:11:00.000Z', text: 'Yes' }])
  })
  it('marks the ask answered on the attendance', async () => {
    const db = fakeDb({ meeting_attendance: [attendanceRow({ asks: [{ at: ASKED, question: 'Monday?', message_id: 'ask-1' }, { at: ASKED, question: 'Price?', message_id: 'ask-2' }] })] })
    await recordAnswer(db.client, ATT, 'ask-1', { messageId: 'm1', at: '2026-11-30T18:11:00.000Z' })
    expect(db.tables.meeting_attendance[0].asks).toEqual([
      { at: ASKED, question: 'Monday?', message_id: 'ask-1', answered_at: '2026-11-30T18:11:00.000Z', answer_message_id: 'm1' },
      { at: ASKED, question: 'Price?', message_id: 'ask-2' },
    ])
  })
})
