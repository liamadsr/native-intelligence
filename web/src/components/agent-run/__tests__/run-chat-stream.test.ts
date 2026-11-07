import { describe, it, expect } from 'vitest'
import {
  applyEventToTurn,
  BUSY_NOTICE,
  parseChatLine,
  readChatStream,
  reduceError,
  type FollowUpTurn,
  type RunChatStreamEvent,
} from '../run-chat-stream'

/**
 * The follow-up-chat NDJSON reader + turn reducer (Loops v3 interactive work
 * runs). The load-bearing behaviour: fold text-deltas + tool names into the open
 * assistant turn, surface a `question`, soften a BUSY error to a gentle notice,
 * and read a chunked NDJSON stream tolerating split + garbled lines.
 */

function emptyAssistant(): FollowUpTurn {
  return { id: 'a1', role: 'assistant', text: '', tools: [] }
}

/** Build a ReadableStream over the given string chunks (as the fetch body would). */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
}

describe('applyEventToTurn', () => {
  it('appends text deltas to the turn text', () => {
    let turn = emptyAssistant()
    turn = applyEventToTurn(turn, { type: 'text-delta', delta: 'Hello' })
    turn = applyEventToTurn(turn, { type: 'text-delta', delta: ', world' })
    expect(turn.text).toBe('Hello, world')
  })

  it('collects tool names in order', () => {
    let turn = emptyAssistant()
    turn = applyEventToTurn(turn, { type: 'tool', name: 'create_email_draft' })
    turn = applyEventToTurn(turn, { type: 'tool', name: 'edit_document_content' })
    expect(turn.tools).toEqual(['create_email_draft', 'edit_document_content'])
  })

  it('attaches a question payload', () => {
    const question = { requestId: 'req-9', approveOptionId: 'approve', denyOptionId: 'deny', questions: [{ question: 'Which?', header: 'H', options: [{ label: 'A' }], multiSelect: false }] }
    const turn = applyEventToTurn(emptyAssistant(), { type: 'question', question })
    expect(turn.question).toEqual(question)
  })

  it('returns the same reference when a delta is empty (no wasted re-render)', () => {
    const turn = emptyAssistant()
    expect(applyEventToTurn(turn, { type: 'text-delta', delta: '' })).toBe(turn)
    expect(applyEventToTurn(turn, { type: 'tool', name: '' })).toBe(turn)
  })

  it('leaves the turn untouched on done / error', () => {
    const turn = { ...emptyAssistant(), text: 'x' }
    expect(applyEventToTurn(turn, { type: 'done' })).toBe(turn)
    expect(applyEventToTurn(turn, { type: 'error', message: 'boom' })).toBe(turn)
  })

  it('never folds a user-message into the assistant turn (it opens a new user turn at the caller)', () => {
    const turn = { ...emptyAssistant(), text: 'assistant reply' }
    expect(applyEventToTurn(turn, { type: 'user-message', text: 'hi there' })).toBe(turn)
  })
})

describe('reduceError', () => {
  it('softens a BUSY error to the gentle "still finishing a turn" notice', () => {
    const msg = reduceError({ type: 'error', code: 'BUSY', message: 'session not waiting' })
    expect(msg).toBe(BUSY_NOTICE)
    expect(msg).toMatch(/still finishing a turn/i)
  })

  it('surfaces a non-BUSY error message as-is', () => {
    expect(reduceError({ type: 'error', code: 'FAILED', message: 'model exploded' })).toBe('model exploded')
  })

  it('falls back to a generic message when an error carries none', () => {
    expect(reduceError({ type: 'error', message: '' })).toBe('The run session hit an error.')
  })

  it('returns null for a non-error event', () => {
    expect(reduceError({ type: 'done' })).toBeNull()
    expect(reduceError({ type: 'text-delta', delta: 'hi' })).toBeNull()
  })
})

describe('parseChatLine', () => {
  it('parses a valid reduced event', () => {
    expect(parseChatLine('{"type":"text-delta","delta":"hi"}')).toEqual({ type: 'text-delta', delta: 'hi' })
  })

  it('skips blank + malformed + unknown-type lines', () => {
    expect(parseChatLine('')).toBeNull()
    expect(parseChatLine('   ')).toBeNull()
    expect(parseChatLine('{not json')).toBeNull()
    expect(parseChatLine('{"type":"mystery"}')).toBeNull()
    expect(parseChatLine('42')).toBeNull()
  })

  it('parses a user-message line carrying string text', () => {
    expect(parseChatLine('{"type":"user-message","text":"why contact X?"}')).toEqual({
      type: 'user-message',
      text: 'why contact X?',
    })
  })

  it('drops a user-message line without string text', () => {
    expect(parseChatLine('{"type":"user-message"}')).toBeNull()
    expect(parseChatLine('{"type":"user-message","text":42}')).toBeNull()
  })
})

describe('readChatStream', () => {
  it('reads a happy-path turn: text deltas + a tool line + done', async () => {
    const events: RunChatStreamEvent[] = []
    await readChatStream(
      streamOf([
        '{"type":"text-delta","delta":"Draft"}\n',
        '{"type":"text-delta","delta":"ed it."}\n{"type":"tool","name":"create_email_draft"}\n',
        '{"type":"done"}\n',
      ]),
      (e) => events.push(e),
    )
    // Fold them into an assistant turn to assert the end state.
    let turn = emptyAssistant()
    for (const e of events) turn = applyEventToTurn(turn, e)
    expect(turn.text).toBe('Drafted it.')
    expect(turn.tools).toEqual(['create_email_draft'])
    expect(events.at(-1)).toEqual({ type: 'done' })
  })

  it('reassembles a line split across chunk boundaries', async () => {
    const events: RunChatStreamEvent[] = []
    // The JSON object is split mid-token across two chunks.
    await readChatStream(
      streamOf(['{"type":"text-del', 'ta","delta":"whole"}\n']),
      (e) => events.push(e),
    )
    expect(events).toEqual([{ type: 'text-delta', delta: 'whole' }])
  })

  it('flushes a trailing non-newline-terminated line', async () => {
    const events: RunChatStreamEvent[] = []
    await readChatStream(streamOf(['{"type":"done"}']), (e) => events.push(e))
    expect(events).toEqual([{ type: 'done' }])
  })

  it('skips a garbled line but keeps reading the rest', async () => {
    const events: RunChatStreamEvent[] = []
    await readChatStream(
      streamOf(['{"type":"tool","name":"a"}\n', 'GARBAGE LINE\n', '{"type":"tool","name":"b"}\n']),
      (e) => events.push(e),
    )
    expect(events).toEqual([
      { type: 'tool', name: 'a' },
      { type: 'tool', name: 'b' },
    ])
  })

  it('surfaces a BUSY error mid-stream (a double-send race)', async () => {
    const events: RunChatStreamEvent[] = []
    await readChatStream(
      streamOf(['{"type":"error","code":"BUSY","message":"session not waiting"}\n']),
      (e) => events.push(e),
    )
    expect(events).toHaveLength(1)
    expect(reduceError(events[0])).toBe(BUSY_NOTICE)
  })

  it('passes user-message events through the reader (replay reconstructs user turns)', async () => {
    const events: RunChatStreamEvent[] = []
    await readChatStream(
      streamOf([
        '{"type":"user-message","text":"why contact X?"}\n',
        '{"type":"text-delta","delta":"Because…"}\n',
        '{"type":"done"}\n',
      ]),
      (e) => events.push(e),
    )
    expect(events[0]).toEqual({ type: 'user-message', text: 'why contact X?' })
  })
})

describe('parseChatLine — a user message’s files (bots v4)', () => {
  it('keeps their names and types, drops malformed ones', () => {
    expect(
      parseChatLine(JSON.stringify({ type: 'user-message', text: 'x', files: [{ filename: 'a.png', mediaType: 'image/png' }, { filename: 'no-type' }, 'junk'] })),
    ).toEqual({ type: 'user-message', text: 'x', files: [{ filename: 'a.png', mediaType: 'image/png' }] })
    expect(parseChatLine(JSON.stringify({ type: 'user-message', text: 'y', files: [] }))).toEqual({ type: 'user-message', text: 'y' })
  })
})

