import { describe, it, expect, vi } from 'vitest'
import type { UIMessage, UIMessageChunk } from 'ai'
import {
  RunChatTransport,
  loadRunChatHistory,
  formatAnswers,
} from '../run-chat-transport'
import { BUSY_NOTICE } from '@/components/agent-run/run-chat-stream'
import type { RunChatEvent } from '../run-chat-events'

/**
 * RunChatTransport is the translation seam between W2's reduced NDJSON vocabulary
 * (text-delta / tool(name-only) / question / user-message / done / error) and the
 * AI SDK `UIMessageChunk` stream `useChat` consumes. These tests lock:
 *   - the per-event chunk translation table (tool → paired input+output; question
 *     holds the stream OPEN; done finishes; BUSY softens),
 *   - answerPermission's resume pump (output-flip first, then the resumed reply),
 *   - loadRunChatHistory folding (user turns, tool parts, answered-vs-pending final
 *     question).
 * Fetch is fully mocked — no route, no eve.
 */

type ReducedLine = RunChatEvent | { type: 'user-message'; text: string; files?: Array<{ filename?: string; mediaType: string }> }

/** A fetch Response over an NDJSON body of reduced events. */
function ndjsonResponse(events: ReducedLine[], init: { ok?: boolean; status?: number } = {}): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(`${JSON.stringify(e)}\n`))
      controller.close()
    },
  })
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    body,
    json: async () => ({}),
  } as unknown as Response
}

/** A non-OK JSON error response (for the BUSY / failure paths on POST). */
function errorResponse(status: number, payload: Record<string, unknown>): Response {
  return {
    ok: false,
    status,
    body: null,
    json: async () => payload,
  } as unknown as Response
}

/** Drain a UIMessageChunk ReadableStream to an array (rejects surface as throw). */
async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const reader = stream.getReader()
  const out: UIMessageChunk[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out.push(value)
  }
  return out
}

/**
 * Read chunks off an OPEN stream until `predicate(collected)` holds or the stream
 * settles idle for `idleWindows` consecutive short windows (the park case, where
 * the producer stops without closing). Returns the collected chunks and whether
 * the stream closed. Robust against the async fetch→NDJSON→emit pipeline (a single
 * fixed timeout races that chain nondeterministically).
 */
async function readUntil(
  reader: ReadableStreamDefaultReader<UIMessageChunk>,
  predicate: (collected: UIMessageChunk[]) => boolean,
  { idleWindows = 4, windowMs = 20 }: { idleWindows?: number; windowMs?: number } = {},
): Promise<{ collected: UIMessageChunk[]; closed: boolean }> {
  const collected: UIMessageChunk[] = []
  let idle = 0
  for (;;) {
    if (predicate(collected)) return { collected, closed: false }
    const race = await Promise.race([
      reader.read().then((r) => ({ kind: 'read' as const, r })),
      new Promise<{ kind: 'idle' }>((res) => setTimeout(() => res({ kind: 'idle' }), windowMs)),
    ])
    if (race.kind === 'idle') {
      idle += 1
      if (idle >= idleWindows) return { collected, closed: false }
      continue
    }
    idle = 0
    if (race.r.done) return { collected, closed: true }
    collected.push(race.r.value)
  }
}

/** A single user UIMessage carrying `text`. */
function userMsg(text: string): UIMessage {
  return { id: 'u1', role: 'user', parts: [{ type: 'text', text }] } as UIMessage
}

/** The options object sendMessages receives (minimal). */
function sendOpts(text: string, extra: Record<string, unknown> = {}) {
  return {
    trigger: 'submit-message' as const,
    chatId: 'run-r1',
    messageId: undefined,
    messages: [userMsg(text)],
    abortSignal: undefined,
    ...extra,
  }
}

describe('RunChatTransport.sendMessages — translation table', () => {
  it('translates text-delta into start → start-step → text-start → text-delta → finish on done', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ndjsonResponse([
        { type: 'text-delta', delta: 'Hello' },
        { type: 'text-delta', delta: ', world' },
        { type: 'done' },
      ]),
    )
    const t = new RunChatTransport('r1', { fetchImpl })
    const chunks = await drain(await t.sendMessages(sendOpts('hi')))

    const types = chunks.map((c) => c.type)
    expect(types).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ])
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { delta: string }).delta)
    expect(deltas).toEqual(['Hello', ', world'])

    // The POST body carried the user's text, no inputResponses.
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as { body: string }).body)
    expect(body).toEqual({ message: 'hi' })
  })

  it('mints a synthetic callId for a reduced tool and pairs input+output immediately (used chip)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ndjsonResponse([
        { type: 'tool', name: 'create_email_draft' },
        { type: 'done' },
      ]),
    )
    const t = new RunChatTransport('r1', { fetchImpl })
    const chunks = await drain(await t.sendMessages(sendOpts('draft it')))

    const input = chunks.find((c) => c.type === 'tool-input-available') as
      | { type: 'tool-input-available'; toolCallId: string; toolName: string; input: unknown; dynamic?: boolean }
      | undefined
    const output = chunks.find((c) => c.type === 'tool-output-available') as
      | { type: 'tool-output-available'; toolCallId: string; output: unknown; dynamic?: boolean }
      | undefined
    expect(input).toBeDefined()
    expect(output).toBeDefined()
    expect(input!.toolName).toBe('create_email_draft')
    expect(input!.dynamic).toBe(true)
    expect(output!.dynamic).toBe(true)
    // Same synthetic callId pairs the two — the assembler renders a 'used' chip.
    expect(output!.toolCallId).toBe(input!.toolCallId)
    // input-available comes BEFORE output-available (assembler ordering rule).
    expect(chunks.indexOf(input!)).toBeLessThan(chunks.indexOf(output!))
  })

  it('closes an open text block before a tool', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ndjsonResponse([
        { type: 'text-delta', delta: 'thinking' },
        { type: 'tool', name: 'find' },
        { type: 'done' },
      ]),
    )
    const t = new RunChatTransport('r1', { fetchImpl })
    const chunks = await drain(await t.sendMessages(sendOpts('go')))
    const types = chunks.map((c) => c.type)
    // text-end must precede the tool-input-available.
    expect(types.indexOf('text-end')).toBeLessThan(types.indexOf('tool-input-available'))
  })

  it('holds the stream OPEN on a question (no finish) and emits the ask_user picker part', async () => {
    const question = {
      requestId: 'req-1',
      approveOptionId: 'approve',
      denyOptionId: 'deny',
      questions: [{ question: 'Tone?', header: 'Tone', options: [{ label: 'Formal' }], multiSelect: false }],
    }
    const fetchImpl = vi.fn().mockResolvedValue(
      ndjsonResponse([
        { type: 'text-delta', delta: 'One thing…' },
        { type: 'question', question },
        { type: 'done' },
      ]),
    )
    const t = new RunChatTransport('r1', { fetchImpl })
    const stream = await t.sendMessages(sendOpts('write it'))

    // Read up to the picker — the stream should NOT close (parked on the question).
    const reader = stream.getReader()
    const { collected, closed } = await readUntil(reader, (c) =>
      c.some((x) => x.type === 'tool-input-available' && (x as { toolName: string }).toolName === 'ask_user'),
    )
    const picker = collected.find(
      (c) => c.type === 'tool-input-available' && (c as { toolName: string }).toolName === 'ask_user',
    ) as { toolName: string; input: { questions: unknown[] }; toolCallId: string } | undefined
    expect(picker).toBeDefined()
    expect(picker!.input.questions).toHaveLength(1)
    // The stream is parked — it did not close, and emitted no finish.
    expect(closed).toBe(false)
    expect(collected.some((c) => c.type === 'finish')).toBe(false)
    reader.releaseLock()
  })

  it('surfaces a BUSY reduced error as a softened error chunk and closes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ndjsonResponse([{ type: 'error', message: 'busy', code: 'BUSY' }]),
    )
    const t = new RunChatTransport('r1', { fetchImpl })
    const chunks = await drain(await t.sendMessages(sendOpts('hi')))
    const err = chunks.find((c) => c.type === 'error') as { errorText: string } | undefined
    expect(err?.errorText).toBe(BUSY_NOTICE)
  })

  it('softens a non-200 BUSY POST into an error chunk (not a stream rejection)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(409, { code: 'BUSY', error: 'busy' }))
    const t = new RunChatTransport('r1', { fetchImpl })
    const chunks = await drain(await t.sendMessages(sendOpts('hi')))
    const err = chunks.find((c) => c.type === 'error') as { errorText: string } | undefined
    expect(err?.errorText).toBe(BUSY_NOTICE)
  })

  it('ignores user-message on a live send (rendered optimistically by the host)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ndjsonResponse([
        { type: 'user-message', text: 'echoed' },
        { type: 'text-delta', delta: 'reply' },
        { type: 'done' },
      ]),
    )
    const t = new RunChatTransport('r1', { fetchImpl })
    const chunks = await drain(await t.sendMessages(sendOpts('hi')))
    // No user text leaked into the assistant text stream.
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { delta: string }).delta)
    expect(deltas).toEqual(['reply'])
  })
})

describe('RunChatTransport.answerPermission — resume pump', () => {
  const question = {
    requestId: 'req-9',
    approveOptionId: 'approve',
    denyOptionId: 'deny',
    questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }],
  }

  async function parkOnQuestion(fetchImpl: ReturnType<typeof vi.fn>) {
    const t = new RunChatTransport('r1', { fetchImpl })
    const stream = await t.sendMessages(sendOpts('go'))
    const reader = stream.getReader()
    // Read until the picker appears — the park leaves the stream open.
    const { collected } = await readUntil(reader, (c) =>
      c.some((x) => x.type === 'tool-input-available' && (x as { toolName: string }).toolName === 'ask_user'),
    )
    const pickerChunk = collected.find(
      (c) => c.type === 'tool-input-available' && (c as { toolName: string }).toolName === 'ask_user',
    ) as { toolCallId: string } | undefined
    const pickerCallId = pickerChunk?.toolCallId ?? ''
    return { t, reader, collected, pickerCallId }
  }

  it('flips the picker to output-available then pumps the resumed reply and finishes', async () => {
    const fetchImpl = vi
      .fn()
      // Turn 1: parks on the question.
      .mockResolvedValueOnce(ndjsonResponse([{ type: 'question', question }, { type: 'done' }]))
      // Resume: the agent replies and completes.
      .mockResolvedValueOnce(ndjsonResponse([{ type: 'text-delta', delta: 'Done A.' }, { type: 'done' }]))

    const { t, reader, pickerCallId } = await parkOnQuestion(fetchImpl)
    expect(pickerCallId).not.toBe('')

    // Answer it (approve). Kick off the resume; continue reading the SAME stream.
    const answerP = t.answerPermission('run-r1', pickerCallId, { Which: 'A' })

    const rest: UIMessageChunk[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      rest.push(value)
    }
    await answerP

    // The picker flips to output-available FIRST (its own callId), carrying answers.
    const flip = rest.find(
      (c) => c.type === 'tool-output-available' && (c as { toolCallId: string }).toolCallId === pickerCallId,
    ) as { output: { answers: Record<string, string> } } | undefined
    expect(flip?.output.answers).toEqual({ Which: 'A' })
    // Then the resumed reply streams and the stream finishes.
    const deltas = rest.filter((c) => c.type === 'text-delta').map((c) => (c as { delta: string }).delta)
    expect(deltas).toEqual(['Done A.'])
    expect(rest.some((c) => c.type === 'finish')).toBe(true)

    // The resume POST carried the eve inputResponses (approve) + formatted message.
    const resumeBody = JSON.parse((fetchImpl.mock.calls[1][1] as { body: string }).body)
    expect(resumeBody.inputResponses).toEqual([{ requestId: 'req-9', optionId: 'approve' }])
    expect(resumeBody.message).toContain('Pick')
  })

  it('a skip resumes with the deny option id', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ndjsonResponse([{ type: 'question', question }, { type: 'done' }]))
      .mockResolvedValueOnce(ndjsonResponse([{ type: 'text-delta', delta: 'ok' }, { type: 'done' }]))

    const { t, reader, pickerCallId } = await parkOnQuestion(fetchImpl)
    const answerP = t.answerPermission('run-r1', pickerCallId, {}, '(skipped)')
    // Drain.
    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }
    await answerP

    const resumeBody = JSON.parse((fetchImpl.mock.calls[1][1] as { body: string }).body)
    expect(resumeBody.inputResponses).toEqual([{ requestId: 'req-9', optionId: 'deny' }])
    expect(resumeBody.message).toBe('The user skipped this question.')
  })

  it('no-ops (logs) an answerPermission for an unknown toolCallId', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ndjsonResponse([{ type: 'question', question }, { type: 'done' }]))
    const { t, reader, pickerCallId } = await parkOnQuestion(fetchImpl)
    expect(pickerCallId).not.toBe('')
    // Answer a bogus id — the real question stays open, no second fetch.
    await t.answerPermission('run-r1', 'bogus-callid', { Which: 'A' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    reader.releaseLock()
  })
})

describe('loadRunChatHistory — replay folding', () => {
  it('folds user turns and assistant text/tool runs into messages', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ndjsonResponse([
        { type: 'text-delta', delta: 'I drafted it.' },
        { type: 'tool', name: 'create_email_draft' },
        { type: 'done' },
        { type: 'user-message', text: 'make it shorter' },
        { type: 'text-delta', delta: 'Shorter now.' },
        { type: 'done' },
      ]),
    )
    const { messages, pendingQuestions } = await loadRunChatHistory('r1', { fetchImpl })
    expect(pendingQuestions.size).toBe(0)
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant'])

    const firstAssistant = messages[0]
    const toolPart = firstAssistant.parts.find((p) => p.type === 'dynamic-tool') as
      | { toolName: string; state: string }
      | undefined
    expect(toolPart?.toolName).toBe('create_email_draft')
    // Replayed tools render as 'used' (output-available), never pending.
    expect(toolPart?.state).toBe('output-available')

    const userText = (messages[1].parts[0] as { text: string }).text
    expect(userText).toBe('make it shorter')
  })

  it('marks an earlier question turn answered (inert) and a final question pending (armable)', async () => {
    const q1 = {
      requestId: 'req-a',
      approveOptionId: 'approve',
      denyOptionId: 'deny',
      questions: [{ question: 'Q1?', header: 'H1', options: [{ label: 'x' }], multiSelect: false }],
    }
    const q2 = {
      requestId: 'req-b',
      approveOptionId: 'approve',
      denyOptionId: 'deny',
      questions: [{ question: 'Q2?', header: 'H2', options: [{ label: 'y' }], multiSelect: false }],
    }
    const fetchImpl = vi.fn().mockResolvedValue(
      ndjsonResponse([
        { type: 'question', question: q1 },
        { type: 'user-message', text: 'answered q1' },
        { type: 'text-delta', delta: 'thanks' },
        { type: 'question', question: q2 },
        { type: 'done' },
      ]),
    )
    const { messages, pendingQuestions } = await loadRunChatHistory('r1', { fetchImpl })

    // Exactly one pending question (the FINAL one, req-b).
    expect(pendingQuestions.size).toBe(1)
    const [[pendingCallId, payload]] = [...pendingQuestions.entries()]
    expect(payload.requestId).toBe('req-b')

    // The pending picker part is input-available (the host will open the picker).
    const pendingPart = messages
      .flatMap((m) => m.parts)
      .find(
        (p) => p.type === 'dynamic-tool' && (p as { toolCallId: string }).toolCallId === pendingCallId,
      ) as { state: string } | undefined
    expect(pendingPart?.state).toBe('input-available')

    // The earlier q1 part is output-available (inert receipt) — NOT re-armed.
    const askParts = messages
      .flatMap((m) => m.parts)
      .filter((p) => p.type === 'dynamic-tool' && (p as { toolName: string }).toolName === 'ask_user')
    expect(askParts).toHaveLength(2)
    const inertQ1 = askParts.find((p) => (p as { toolCallId: string }).toolCallId !== pendingCallId) as
      | { state: string }
      | undefined
    expect(inertQ1?.state).toBe('output-available')
  })

  it('returns empty on a non-OK replay', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(500, {}))
    const { messages, pendingQuestions } = await loadRunChatHistory('r1', { fetchImpl })
    expect(messages).toEqual([])
    expect(pendingQuestions.size).toBe(0)
  })
})

describe('loadRunChatHistory — refusals versus failures in passing', () => {
  const answer = (status: number, body: unknown = {}) =>
    vi.fn(async () => ({ ok: status < 400, status, body: null, json: async () => body }) as unknown as Response)

  it('the route’s refusals that hold (400, 403, 404, 409) are `refusal`, with the code', async () => {
    for (const [status, code] of [[403, 'FORBIDDEN'], [409, 'NOT_TERMINAL'], [409, 'NO_SESSION'], [400, 'INVALID_KIND'], [404, undefined]] as const) {
      const result = await loadRunChatHistory('r1', { fetchImpl: answer(status, code ? { code } : {}) as never })
      expect(result.refusal).toEqual({ status, code: code ?? null })
      expect(result.failed).toBeUndefined()
    }
  })

  it('401, 5xx and the network are failures in passing: no refusal (the composer stays), `failed`', async () => {
    for (const status of [401, 500, 502, 503]) {
      const result = await loadRunChatHistory('r1', { fetchImpl: answer(status) as never })
      expect(result.refusal).toBeUndefined()
      expect(result.failed).toBe(true)
    }
    const offline = await loadRunChatHistory('r1', { fetchImpl: vi.fn(async () => Promise.reject(new Error('offline'))) as never })
    expect(offline).toMatchObject({ messages: [], failed: true })
    expect(offline.refusal).toBeUndefined()
  })
})

describe('formatAnswers', () => {
  it('renders a labeled line per question', () => {
    const payload = {
      requestId: 'r',
      approveOptionId: 'approve',
      denyOptionId: 'deny',
      questions: [
        { question: 'Tone?', header: 'Tone', options: [], multiSelect: false },
        { question: 'Length?', header: '', options: [], multiSelect: false },
      ],
    }
    const msg = formatAnswers(payload, { 'Tone?': 'Formal', 'Length?': 'Short' })
    expect(msg).toContain('- Tone: Formal')
    expect(msg).toContain('- Length?: Short')
  })

  it('marks an unanswered question (no selection)', () => {
    const payload = {
      requestId: 'r',
      approveOptionId: 'approve',
      denyOptionId: 'deny',
      questions: [{ question: 'Tone?', header: 'Tone', options: [], multiSelect: false }],
    }
    expect(formatAnswers(payload, {})).toContain('- Tone: (no selection)')
  })
})

describe('the full composer’s turn (bots v4)', () => {
  it('forwards the composer’s extras with the message, untouched (the route checks them)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ndjsonResponse([{ type: 'done' }]))
    const t = new RunChatTransport('r1', { fetchImpl })
    const extras = {
      skillId: 'skill-1',
      files: [{ storagePath: 'u/chat-uploads/a.md', fileName: 'a.md', fileSize: 3, mimeType: 'text/markdown' }],
      mentions: { captureIds: ['c1'] },
    }
    await drain(
      await t.sendMessages(
        sendOpts('look at this', {
          body: { ...extras, searchSettings: { timeWindow: 'all', includeTranscripts: false, includeAttachments: true }, unknownKey: 'dropped' },
        }),
      ),
    )
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as { body: string }).body)
    // "My captures" and anything else unknown stay behind: a run's turn doesn't carry them.
    expect(body).toEqual({ message: 'look at this', ...extras })
  })

  it('a plain send (no body) carries the message alone', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ndjsonResponse([{ type: 'done' }]))
    const t = new RunChatTransport('r1', { fetchImpl })
    await drain(await t.sendMessages(sendOpts('hi')))
    expect(JSON.parse((fetchImpl.mock.calls[0][1] as { body: string }).body)).toEqual({ message: 'hi' })
  })

  it('a replayed message’s files come back as chips: names and types, no link', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ndjsonResponse([
        { type: 'user-message', text: 'see attached', files: [{ filename: 'shot.png', mediaType: 'image/png' }] },
        { type: 'text-delta', delta: 'Got it.' },
        { type: 'done' },
      ]),
    )
    const { messages } = await loadRunChatHistory('r1', { fetchImpl })
    expect(messages[0].role).toBe('user')
    expect(messages[0].parts).toEqual([
      { type: 'text', text: 'see attached' },
      { type: 'file', mediaType: 'image/png', filename: 'shot.png', url: '' },
    ])
  })
})

