/**
 * How a reply points at the message it answers (reply-link.ts, GEN-353):
 * which bubble, the capsule's copy, and where the ┐ goes.
 */
import { describe, it, expect } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'
import { messageReplyMetadata } from '@/lib/chat/message-reply'
import { REPLY_HOOK_PX, repliedBubbleIndex, replyCopyFor, replyHookPlacement } from '../reply-link'

const said = (id: string, ...texts: string[]): UIMessage =>
  ({ id, role: 'assistant', parts: texts.flatMap((text, i) => [...(i ? [{ type: 'dynamic-tool', toolName: 't', toolCallId: `c${i}`, state: 'output-available', input: {}, output: {} }] : []), { type: 'text', text }]) }) as UIMessage
const answering = (id: string, messageId: string, quote: string, extra: Record<string, unknown> = {}): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text: 'ok' }], metadata: messageReplyMetadata({ messageId, role: 'assistant', quote, part: false, ...extra }) }) as UIMessage

describe('repliedBubbleIndex', () => {
  const turn = said('a', 'Looking at your board.', 'Want me to close **ENG-4**?')
  it('the bubble whose quote it is, the one holding the words selected, the only one; else null', () => {
    expect(repliedBubbleIndex(turn, { quote: 'Want me to close ENG-4?', part: true })).toBe(1)
    expect(repliedBubbleIndex(turn, { quote: 'close ENG-4', part: true, selected: true })).toBe(1)
    expect(repliedBubbleIndex(turn, { quote: 'nowhere', part: true })).toBeNull()
    expect(repliedBubbleIndex(said('b', 'Only one.'), { quote: 'something else', part: false })).toBe(0)
  })
})

describe('replyCopyFor', () => {
  const a = said('a', '**Bold** words.')
  const drawn = (...ms: UIMessage[]) => new Map(ms.map((m) => [m.id, m]))
  it('the bubble answered, as written, wherever it is drawn', () => {
    expect(replyCopyFor(answering('u', 'a', 'Bold words.'), drawn(a))).toBe('**Bold** words.')
    const turn = said('t', 'Looking at your board.', 'Want me to close it?')
    expect(replyCopyFor(answering('u', 't', 'Looking at your board.', { part: true }), drawn(turn))).toBe('Looking at your board.')
    expect(replyCopyFor(answering('u', 't', 'Want me to close it?', { part: true }), drawn(turn))).toBe('Want me to close it?')
  })
  it('the whole message when its bubble can’t be told and it answered all of it; nothing for a part it can’t find', () => {
    const turn = said('t', 'One.', 'Two.')
    expect(replyCopyFor(answering('u', 't', 'One. Two.'), drawn(turn))).toBe('One.\n\nTwo.')
    expect(replyCopyFor(answering('u', 't', 'Three.', { part: true }), drawn(turn))).toBeNull()
  })
  it('the person’s own message too', () => {
    const own = { id: 'o', role: 'user', parts: [{ type: 'text', text: 'which account?' }] } as UIMessage
    const reply = { ...answering('u', 'o', 'which account?'), metadata: messageReplyMetadata({ messageId: 'o', role: 'user', quote: 'which account?', part: false }) } as UIMessage
    expect(replyCopyFor(reply, drawn(own))).toBe('which account?')
  })
  it('words selected (the capsule holds those), not drawn, not a reply, or not the person’s: null', () => {
    expect(replyCopyFor(answering('u', 'a', 'words', { part: true, selected: true }), drawn(a))).toBeNull()
    expect(replyCopyFor(answering('u', 'a', 'Bold words.'), drawn())).toBeNull()
    expect(replyCopyFor({ id: 'u', role: 'user', parts: [] } as UIMessage, drawn(a))).toBeNull()
    expect(replyCopyFor(a, drawn(a))).toBeNull()
  })
})

describe('replyHookPlacement', () => {
  const frame = { left: 100, top: 500 }
  const at = (from: { left: number; top: number; right: number; bottom: number }, to: { left: number; top: number; right: number; bottom: number }) => {
    const p = replyHookPlacement(from, to, frame)
    return p && { left: p.left + 100, top: p.top + 500, right: p.left + 100 + REPLY_HOOK_PX, bottom: p.top + 500 + REPLY_HOOK_PX }
  }
  it('a 26px glyph 18px right of the capsule, its top leg level with its foot, when there’s room under it', () => {
    expect(REPLY_HOOK_PX).toBe(26)
    expect(at({ left: 100, top: 300, right: 578, bottom: 420 }, { left: 300, top: 480, right: 634, bottom: 524 })).toEqual({ left: 596, top: 420, right: 622, bottom: 446 })
  })
  it('the capsule stacked on the reply (8px above it, 3.5rem in from the right): in that margin, rising beside its foot, 10px above the reply, 12px inside its right edge', () => {
    // Row right edge 634: the capsule ends at 634 - 56, the reply's top 8px under the capsule's foot.
    expect(at({ left: 100, top: 300, right: 578, bottom: 420 }, { left: 300, top: 428, right: 634, bottom: 472 })).toEqual({ left: 596, top: 392, right: 622, bottom: 418 })
  })
  it('its down leg stays 12px inside the reply’s right edge', () => {
    expect(at({ left: 100, top: 300, right: 600, bottom: 420 }, { left: 560, top: 428, right: 634, bottom: 472 })!.right).toBe(622)
  })
  it('somewhere for any laid-out capsule and reply, however close (it rises beside the capsule); null only before layout', () => {
    for (const gap of [0, 4, 8, 40]) {
      const p = at({ left: 100, top: 300, right: 578, bottom: 420 }, { left: 300, top: 420 + gap, right: 634, bottom: 470 + gap })!
      expect(p.bottom).toBeLessThanOrEqual(420 + gap - 10)
      expect(p.left).toBe(596)
    }
    const zero = { left: 0, top: 0, right: 0, bottom: 0 }
    expect(replyHookPlacement(zero, zero, { left: 0, top: 0 })).toBeNull()
  })
})
