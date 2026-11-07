/**
 * Retention helpers for a tab's chat transcript.
 *
 * Two things are being pinned, and they fail in opposite directions:
 *   • the cap must actually drop messages (the 948MB/7h heap is the reason it
 *     exists), but never split an assistant tool call from the message holding
 *     its result, and never shrink a tool part still awaiting one;
 *   • every helper must return the SAME array reference when nothing changed —
 *     chat-panel's trim effect would otherwise setMessages on every render, and
 *     tab-context's persist effect diffs the chat slice by identity.
 */
import { describe, it, expect } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'
import {
  MAX_LIVE_MESSAGES,
  MAX_PART_CHARS,
  RECENT_MESSAGE_WINDOW,
  TRUNCATED_PREVIEW_CHARS,
  applyChatRetention,
  capMessages,
  findTrimStart,
  hasPendingToolCall,
  needsChatRetention,
  truncateOldParts,
} from '../message-retention'

const text = (id: string, role: 'user' | 'assistant'): UIMessage =>
  ({ id, role, parts: [{ type: 'text', text: `m-${id}` }] }) as unknown as UIMessage

/** An assistant turn carrying one settled tool part. */
const toolMsg = (id: string, output: unknown, state = 'output-available'): UIMessage =>
  ({
    id,
    role: 'assistant',
    parts: [
      { type: 'tool-search', toolCallId: `call-${id}`, state, input: { q: 'hi' }, output },
    ],
  }) as unknown as UIMessage

/** Alternating user/assistant pairs, so every even index is a user message. */
function conversation(n: number, prefix = 'm'): UIMessage[] {
  return Array.from({ length: n }, (_, i) =>
    text(`${prefix}${i}`, i % 2 === 0 ? 'user' : 'assistant'),
  )
}

describe('capMessages', () => {
  it('returns the SAME array when under the cap (identity contract)', () => {
    const msgs = conversation(10)
    expect(capMessages(msgs)).toBe(msgs)
    expect(capMessages(msgs, 10)).toBe(msgs)
  })

  it('drops the oldest messages once past the cap', () => {
    const msgs = conversation(MAX_LIVE_MESSAGES + 40)
    const capped = capMessages(msgs)
    expect(capped).not.toBe(msgs)
    expect(capped.length).toBeLessThanOrEqual(MAX_LIVE_MESSAGES)
    // The newest message always survives.
    expect(capped[capped.length - 1]).toBe(msgs[msgs.length - 1])
  })

  it('always cuts ON a user message, so a tool-call/result pair is never split', () => {
    const msgs = conversation(50)
    const capped = capMessages(msgs, 21) // desired cut = index 29, an assistant
    expect(capped[0].role).toBe('user')
    // It kept the FOLLOWING user message, i.e. fewer than `max`, not more.
    expect(capped.length).toBeLessThanOrEqual(21)
  })

  it('keeps a tool-call chain intact rather than orphaning a result', () => {
    // user, assistant(tool call), assistant(tool result), user, assistant…
    const msgs: UIMessage[] = [
      text('u0', 'user'),
      toolMsg('a0-call', 'result payload'),
      text('a0-answer', 'assistant'),
      text('u1', 'user'),
      text('a1', 'assistant'),
    ]
    // Desired cut = index 1 (the tool call); the boundary must move to u1.
    const capped = capMessages(msgs, 4)
    expect(capped.map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  it('is a no-op (same reference) for every length at or under the cap', () => {
    for (const n of [1, 2, 3, 9, 10, 299, 300]) {
      const msgs = conversation(n)
      expect(capMessages(msgs)).toBe(msgs)
      expect(capMessages(msgs, n)).toBe(msgs)
    }
    const empty: UIMessage[] = []
    expect(capMessages(empty)).toBe(empty)
  })

  // ── MUST_FIX 1 · assistant-only transcripts ────────────────────────────────
  // The live-capture / ambient-agent tab is assistant-only by construction:
  // conversation-writer.ts writes ONLY assistant rows and use-live-conversation
  // merges them into useChat for the whole meeting. The old findTrimStart
  // walked forward for a `user` role and returned 0 when it found none, so the
  // cap silently never fired for exactly the tab that needed it most.
  it('caps an assistant-only transcript (the live-capture tab shape)', () => {
    const msgs: UIMessage[] = [
      text('u0', 'user'),
      ...Array.from({ length: 5000 }, (_, i) => text(`a${i}`, 'assistant')),
    ]
    const capped = capMessages(msgs)
    expect(capped).not.toBe(msgs)
    // OLD BEHAVIOUR was 5001 kept. The cap must actually bind.
    expect(capped.length).toBeLessThanOrEqual(MAX_LIVE_MESSAGES)
    expect(capped[capped.length - 1].id).toBe('a4999')
  })

  it('caps a transcript with NO user message at all', () => {
    const msgs = Array.from({ length: 900 }, (_, i) => text(`a${i}`, 'assistant'))
    const capped = capMessages(msgs)
    expect(capped.length).toBe(MAX_LIVE_MESSAGES)
    expect(capped[capped.length - 1].id).toBe('a899')
  })

  it('caps when the only user message is far BEHIND the desired cut', () => {
    // user at 0, then 400 assistants; desired cut is 401-300 = 101, and the
    // nearest user (index 0) is way outside the backward-is-cheap zone — but
    // the hard cut must still bound the array.
    const msgs: UIMessage[] = [
      text('u0', 'user'),
      ...Array.from({ length: 400 }, (_, i) => text(`a${i}`, 'assistant')),
    ]
    const capped = capMessages(msgs)
    expect(capped.length).toBeLessThanOrEqual(MAX_LIVE_MESSAGES)
  })

  // ── MUST_FIX 2 · a pending ask in the drop zone must survive ───────────────
  it('clamps the cut in front of a message with a PENDING tool call', () => {
    const pendingAsk = {
      id: 'ask',
      role: 'assistant',
      parts: [
        {
          type: 'tool-ask_user',
          toolCallId: 'call-ask',
          state: 'input-available',
          input: { questions: [{ question: 'which?' }] },
        },
      ],
    } as unknown as UIMessage
    // The ask sits at index 5 — deep inside what a cap of 20 would drop.
    const msgs: UIMessage[] = [...conversation(5), pendingAsk, ...conversation(400, 'z')]
    const capped = capMessages(msgs, 20)
    expect(capped[0].id).toBe('ask')
    expect(capped.find((m) => m.id === 'ask')).toBe(pendingAsk)
  })

  it('clamps for an approval-requested part too', () => {
    const pendingApproval = toolMsg('appr', undefined, 'approval-requested')
    const msgs: UIMessage[] = [...conversation(4), pendingApproval, ...conversation(400, 'z')]
    expect(capMessages(msgs, 20)[0]).toBe(pendingApproval)
  })

  it('still drops freely when the pending message is NEWER than the cut', () => {
    const pending = toolMsg('p', undefined, 'input-available')
    const msgs: UIMessage[] = [...conversation(400), pending, ...conversation(4, 'z')]
    const capped = capMessages(msgs)
    expect(capped.length).toBeLessThanOrEqual(MAX_LIVE_MESSAGES)
    expect(capped).toContain(pending)
  })
})

describe('findTrimStart', () => {
  it('walks forward to the next user message', () => {
    const msgs = conversation(10)
    expect(findTrimStart(msgs, 3)).toBe(4)
    expect(findTrimStart(msgs, 4)).toBe(4)
  })

  it('walks BACKWARD to the nearest user message when none is ahead (within the window)', () => {
    // user at 0, assistants after: forward finds nothing, backward finds 0.
    const msgs: UIMessage[] = [
      text('u', 'user'),
      ...Array.from({ length: 5 }, (_, i) => text(`a${i}`, 'assistant')),
    ]
    expect(findTrimStart(msgs, 4)).toBe(0)
  })

  it('hard-cuts at `desired` when there is no user message in EITHER direction', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => text(`a${i}`, 'assistant'))
    expect(findTrimStart(msgs, 6)).toBe(6)
  })

  it('bounds the BACKWARD walk too — a lone opening user message cannot pin the cut to 0', () => {
    // The live-capture shape: one user prompt, then hundreds of assistant rows.
    // An unbounded backward walk would return 0 here and the cap would never
    // bind — the same bug as the unbounded forward walk, through the other door.
    const msgs: UIMessage[] = [
      text('u0', 'user'),
      ...Array.from({ length: 400 }, (_, i) => text(`a${i}`, 'assistant')),
    ]
    expect(findTrimStart(msgs, 101)).toBe(101)
  })

  it('bounds the forward walk — a far-off user message does not win', () => {
    // desired = 1; the only user message is 200 ahead, past the lookahead.
    // The old unbounded walk returned 200 (or 0); the new one must not reach it.
    const msgs: UIMessage[] = [
      ...Array.from({ length: 200 }, (_, i) => text(`a${i}`, 'assistant')),
      text('far-user', 'user'),
    ]
    const start = findTrimStart(msgs, 1)
    expect(start).toBeLessThan(200)
    expect(start).toBe(1) // no user forward within 50, none backward → hard cut
  })

  it('returns 0 for a non-positive desired point', () => {
    expect(findTrimStart(conversation(4), 0)).toBe(0)
    expect(findTrimStart(conversation(4), -3)).toBe(0)
  })
})

describe('hasPendingToolCall', () => {
  it('flags input-available, input-streaming and approval-requested', () => {
    expect(hasPendingToolCall(toolMsg('x', undefined, 'input-available'))).toBe(true)
    expect(hasPendingToolCall(toolMsg('x', undefined, 'input-streaming'))).toBe(true)
    expect(hasPendingToolCall(toolMsg('x', undefined, 'approval-requested'))).toBe(true)
  })
  it('ignores settled and non-tool parts', () => {
    expect(hasPendingToolCall(toolMsg('x', 'done'))).toBe(false)
    expect(hasPendingToolCall(toolMsg('x', undefined, 'output-error'))).toBe(false)
    expect(hasPendingToolCall(text('x', 'user'))).toBe(false)
  })
})

describe('truncateOldParts', () => {
  const big = 'x'.repeat(MAX_PART_CHARS + 5_000)
  /** n filler messages after the tool message, so it falls outside the window. */
  const withTail = (m: UIMessage, n = RECENT_MESSAGE_WINDOW + 1) => [
    m,
    ...Array.from({ length: n }, (_, i) => text(`t${i}`, i % 2 === 0 ? 'user' : 'assistant')),
  ]

  it('replaces an oversized STRING output with a marker, keeping identity fields', () => {
    const msgs = withTail(toolMsg('old', big))
    const out = truncateOldParts(msgs)
    expect(out).not.toBe(msgs)
    const part = (out[0].parts as unknown as Array<Record<string, unknown>>)[0]
    expect(part.state).toBe('output-available')
    expect(part.toolCallId).toBe('call-old')
    expect(part.input).toEqual({ q: 'hi' })
    const output = part.output as string
    expect(output.startsWith('x'.repeat(100))).toBe(true)
    expect(output).toContain('truncated')
    expect(output).toContain('full output is saved in chat history')
    expect(output.length).toBeLessThan(TRUNCATED_PREVIEW_CHARS + 200)
    // The original message object is untouched — trimming is copy-on-write.
    expect(
      ((msgs[0].parts as unknown as Array<Record<string, unknown>>)[0].output as string).length,
    ).toBe(big.length)
  })

  it('never touches STRUCTURED outputs — card renderers destructure them', () => {
    const structured = { results: Array.from({ length: 4000 }, (_, i) => ({ i, url: 'u'.repeat(50) })) }
    const msgs = withTail(toolMsg('old', structured))
    expect(truncateOldParts(msgs)).toBe(msgs)
  })

  it('leaves the RECENT_MESSAGE_WINDOW tail whole', () => {
    const msgs = [...conversation(5), toolMsg('recent', big)]
    expect(truncateOldParts(msgs)).toBe(msgs)
  })

  it('never touches a message with a still-pending tool call', () => {
    const pending = {
      id: 'p',
      role: 'assistant',
      parts: [
        { type: 'tool-a', toolCallId: 'c1', state: 'output-available', input: {}, output: big },
        { type: 'tool-b', toolCallId: 'c2', state: 'input-available', input: {} },
      ],
    } as unknown as UIMessage
    const msgs = withTail(pending)
    expect(truncateOldParts(msgs)).toBe(msgs)
  })

  it('returns the SAME array when every output is small', () => {
    const msgs = withTail(toolMsg('old', 'small'))
    expect(truncateOldParts(msgs)).toBe(msgs)
  })

  it('handles a message with no parts', () => {
    const msgs = withTail({ id: 'bare', role: 'assistant' } as unknown as UIMessage)
    expect(truncateOldParts(msgs)).toBe(msgs)
  })

  // ── SHOULD_FIX 3 · text parts and errorText were unbounded ────────────────
  it('shrinks an oversized TEXT part on an old message', () => {
    const longText = {
      id: 'wall',
      role: 'assistant',
      parts: [{ type: 'text', text: big }],
    } as unknown as UIMessage
    const msgs = withTail(longText)
    const out = truncateOldParts(msgs)
    expect(out).not.toBe(msgs)
    const part = (out[0].parts as unknown as Array<Record<string, unknown>>)[0]
    expect(part.type).toBe('text')
    const value = part.text as string
    expect(value.length).toBeLessThan(TRUNCATED_PREVIEW_CHARS + 200)
    expect(value).toContain('full output is saved in chat history')
    // Copy-on-write: the source message is untouched.
    expect(
      ((msgs[0].parts as unknown as Array<Record<string, unknown>>)[0].text as string).length,
    ).toBe(big.length)
  })

  it('shrinks oversized errorText on an output-error part', () => {
    const failed = {
      id: 'boom',
      role: 'assistant',
      parts: [
        { type: 'tool-Bash', toolCallId: 'c-boom', state: 'output-error', input: {}, errorText: big },
      ],
    } as unknown as UIMessage
    const out = truncateOldParts(withTail(failed))
    const part = (out[0].parts as unknown as Array<Record<string, unknown>>)[0]
    expect(part.state).toBe('output-error')
    expect(part.toolCallId).toBe('c-boom')
    expect((part.errorText as string).length).toBeLessThan(TRUNCATED_PREVIEW_CHARS + 200)
  })

  it('leaves a RECENT oversized text part whole', () => {
    const longText = {
      id: 'fresh-wall',
      role: 'assistant',
      parts: [{ type: 'text', text: big }],
    } as unknown as UIMessage
    const msgs = [...conversation(4), longText]
    expect(truncateOldParts(msgs)).toBe(msgs)
  })

  it('leaves an oversized text part on a PENDING message whole', () => {
    const pending = {
      id: 'p2',
      role: 'assistant',
      parts: [
        { type: 'text', text: big },
        { type: 'tool-ask', toolCallId: 'c9', state: 'input-available', input: {} },
      ],
    } as unknown as UIMessage
    const msgs = withTail(pending)
    expect(truncateOldParts(msgs)).toBe(msgs)
  })
})

describe('applyChatRetention / needsChatRetention', () => {
  it('is a no-op (same reference) for a short, small conversation', () => {
    const msgs = conversation(20)
    expect(applyChatRetention(msgs)).toBe(msgs)
    expect(needsChatRetention(msgs)).toBe(false)
  })

  it('caps and truncates in one pass', () => {
    const big = 'y'.repeat(MAX_PART_CHARS * 2)
    const msgs = [
      ...conversation(MAX_LIVE_MESSAGES + 20),
      toolMsg('bigone', big),
      ...conversation(RECENT_MESSAGE_WINDOW + 2),
    ]
    const out = applyChatRetention(msgs)
    expect(needsChatRetention(msgs)).toBe(true)
    expect(out.length).toBeLessThanOrEqual(MAX_LIVE_MESSAGES)
    const bigOne = out.find((m) => m.id === 'bigone')!
    const output = (bigOne.parts as unknown as Array<Record<string, unknown>>)[0].output as string
    expect(output.length).toBeLessThan(TRUNCATED_PREVIEW_CHARS + 200)
  })

  it('is idempotent — a second pass returns the same reference', () => {
    const big = 'z'.repeat(MAX_PART_CHARS * 2)
    const msgs = [...conversation(MAX_LIVE_MESSAGES + 20), toolMsg('b', big), ...conversation(12)]
    const once = applyChatRetention(msgs)
    expect(applyChatRetention(once)).toBe(once)
    expect(needsChatRetention(once)).toBe(false)
  })
})
