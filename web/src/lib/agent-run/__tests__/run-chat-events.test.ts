import { describe, it, expect } from 'vitest'
import type { HandleMessageStreamEvent } from 'eve/client'
import {
  reduceStreamEvent,
  toolNameForAction,
  questionPayloadForRequest,
  encodeRunChatEvent,
  readRunChatReply,
  readRunChatHistory,
  isRunChatPrimerText,
  RUN_CHAT_PRIMER_HEADING,
  REQUEST_USER_INPUT_TOOL_NAME,
  type RunChatEvent,
} from '../run-chat-events'

/**
 * The reduced NDJSON event vocabulary is the privacy fence between eve's raw
 * stream and the browser (W3 renders from these shapes alone). These tests lock
 * the translation table event-by-event, and the resume-message formatting the
 * respond route + dispatcher share.
 */

// Minimal typed factories for the eve events we translate. Cast through unknown
// where the event carries fields the reducer never reads (sequence/turnId/etc.)
// so we don't hand-build every discriminated-union member in full.
function ev(partial: unknown): HandleMessageStreamEvent {
  return partial as HandleMessageStreamEvent
}

const REQUEST = (overrides: Record<string, unknown> = {}) => ({
  requestId: 'req-1',
  prompt: 'Which approach?',
  options: [{ id: 'approve' }, { id: 'deny' }],
  action: {
    kind: 'tool-call',
    callId: 'call-1',
    toolName: REQUEST_USER_INPUT_TOOL_NAME,
    input: {
      questions: [
        {
          question: 'Which draft tone?',
          header: 'Tone',
          multiSelect: false,
          options: [
            { label: 'Formal', description: 'Buttoned-up' },
            { label: 'Casual' },
          ],
        },
      ],
    },
  },
  ...overrides,
})

describe('reduceStreamEvent — translation table', () => {
  it('message.appended → text-delta (drops empty deltas)', () => {
    expect(reduceStreamEvent(ev({ type: 'message.appended', data: { messageDelta: 'Hello' } }))).toEqual(
      [{ type: 'text-delta', delta: 'Hello' }],
    )
    expect(reduceStreamEvent(ev({ type: 'message.appended', data: { messageDelta: '' } }))).toEqual([])
  })

  it('message.received → user-message (the user’s own turn text; empty/blank dropped)', () => {
    // eve records every user follow-up turn as message.received; the reducer
    // forwards it so the GET replay can rebuild user turns (the live UI ignores it).
    expect(reduceStreamEvent(ev({ type: 'message.received', data: { message: 'How did you decide the tone?' } }))).toEqual(
      [{ type: 'user-message', text: 'How did you decide the tone?' }],
    )
    // Blank / non-string message → dropped.
    expect(reduceStreamEvent(ev({ type: 'message.received', data: { message: '   ' } }))).toEqual([])
    expect(reduceStreamEvent(ev({ type: 'message.received', data: {} }))).toEqual([])
  })

  it('message.received with files → user-message with their names and types, never a URL or bytes (bots v4)', () => {
    const dataUrl = 'data:image/png;base64,' + 'A'.repeat(64)
    const out = reduceStreamEvent(
      ev({
        type: 'message.received',
        data: {
          message: 'Look at this\n[file: shot.png (image/png)]',
          parts: [
            { type: 'text', text: 'Look at this' },
            { type: 'file', filename: 'shot.png', mediaType: 'image/png', url: dataUrl, size: 64 },
            { type: 'file', mediaType: 'text/markdown' },
          ],
        },
      }),
    )
    expect(out).toEqual([
      { type: 'user-message', text: 'Look at this', files: [{ mediaType: 'image/png', filename: 'shot.png' }, { mediaType: 'text/markdown' }] },
    ])
    expect(JSON.stringify(out)).not.toContain('base64')
    // Structured parts with no file: the flattened summary, as before.
    expect(reduceStreamEvent(ev({ type: 'message.received', data: { message: 'plain', parts: [{ type: 'text', text: 'plain' }] } }))).toEqual([
      { type: 'user-message', text: 'plain' },
    ])
  })

  it('message.received with file notes → user-message with chips; never the storage path (bots v4: a run chat names its files in text)', () => {
    const out = reduceStreamEvent(
      ev({
        type: 'message.received',
        data: {
          message: 'Summarise these\n[attached file] "notes.md" (text/markdown) storage_path: u1/chat-uploads/a.md',
          parts: [
            { type: 'text', text: 'Summarise these' },
            { type: 'text', text: '[attached file] "notes.md" (text/markdown) storage_path: u1/chat-uploads/a.md' },
            { type: 'text', text: '[attached file] "data.csv" (text/csv) storage_path: u1/chat-uploads/b.csv' },
            // Not a note (no type): the person's words, kept as text.
            { type: 'text', text: '[attached file] "x"' },
          ],
        },
      }),
    )
    expect(out).toEqual([
      {
        type: 'user-message',
        text: 'Summarise these\n[attached file] "x"',
        files: [
          { mediaType: 'text/markdown', filename: 'notes.md' },
          { mediaType: 'text/csv', filename: 'data.csv' },
        ],
      },
    ])
    expect(JSON.stringify(out)).not.toContain('chat-uploads')
    // The first part is always the person's words, even when it reads like a note.
    expect(
      reduceStreamEvent(
        ev({
          type: 'message.received',
          data: {
            message: 'x',
            parts: [
              { type: 'text', text: '[attached file] "a.md" (text/markdown)' },
              { type: 'text', text: '[attached file] "b.md" (text/markdown)' },
            ],
          },
        }),
      ),
    ).toEqual([{ type: 'user-message', text: '[attached file] "a.md" (text/markdown)', files: [{ mediaType: 'text/markdown', filename: 'b.md' }] }])
  })

  it('actions.requested → one tool event per NAMED action, never the input', () => {
    const out = reduceStreamEvent(
      ev({
        type: 'actions.requested',
        data: {
          actions: [
            { kind: 'tool-call', callId: 'c1', toolName: 'create_email_draft', input: { to: 'secret@x.com', body: 'PII' } },
            { kind: 'load-skill', callId: 'c2', input: {} },
            { kind: 'subagent-call', callId: 'c3', name: 'Researcher', subagentName: 'researcher', description: '', input: {}, nodeId: 'n1' },
          ],
        },
      }),
    )
    // Only the named tool + subagent; load-skill (control-plane) dropped. No inputs.
    expect(out).toEqual([
      { type: 'tool', name: 'create_email_draft' },
      { type: 'tool', name: 'researcher' },
    ])
    // The privacy fence: no reduced event carries the tool input.
    expect(JSON.stringify(out)).not.toContain('secret@x.com')
    expect(JSON.stringify(out)).not.toContain('PII')
  })

  it('actions.requested drops the ask tool (it surfaces as a question, not a tool line)', () => {
    const out = reduceStreamEvent(
      ev({
        type: 'actions.requested',
        data: {
          actions: [
            { kind: 'tool-call', callId: 'c1', toolName: REQUEST_USER_INPUT_TOOL_NAME, input: { questions: [] } },
          ],
        },
      }),
    )
    expect(out).toEqual([])
  })

  it('input.requested (ask tool) → question with requestId + picker-shaped questions', () => {
    const out = reduceStreamEvent(
      ev({ type: 'input.requested', data: { requests: [REQUEST()] } }),
    )
    expect(out).toEqual([
      {
        type: 'question',
        question: {
          requestId: 'req-1',
          approveOptionId: 'approve',
          denyOptionId: 'deny',
          questions: [
            {
              question: 'Which draft tone?',
              header: 'Tone',
              multiSelect: false,
              options: [
                { label: 'Formal', description: 'Buttoned-up' },
                { label: 'Casual' },
              ],
            },
          ],
        },
      },
    ])
  })

  it('input.requested for a NON-ask tool is dropped from the reduced stream', () => {
    const out = reduceStreamEvent(
      ev({
        type: 'input.requested',
        data: {
          requests: [
            { requestId: 'r2', prompt: 'Approve?', action: { kind: 'tool-call', callId: 'c', toolName: 'some_other_tool', input: {} } },
          ],
        },
      }),
    )
    expect(out).toEqual([])
  })

  it('turn.completed and session.completed → done', () => {
    expect(reduceStreamEvent(ev({ type: 'turn.completed', data: {} }))).toEqual([{ type: 'done' }])
    expect(reduceStreamEvent(ev({ type: 'session.completed' }))).toEqual([{ type: 'done' }])
  })

  it('turn.failed / step.failed / session.failed → error with FAILED code + message', () => {
    for (const type of ['turn.failed', 'step.failed', 'session.failed'] as const) {
      const out = reduceStreamEvent(ev({ type, data: { message: `${type} boom`, code: 'X' } }))
      expect(out).toEqual([{ type: 'error', message: `${type} boom`, code: 'FAILED' }])
    }
  })

  it('failure with no message falls back to a generic string', () => {
    const out = reduceStreamEvent(ev({ type: 'turn.failed', data: { message: '', code: 'X' } }))
    expect(out).toEqual([{ type: 'error', message: 'The run session hit an error.', code: 'FAILED' }])
  })

  it('drops everything else (lifecycle, reasoning, action.result, waiting, usage)', () => {
    const dropped: unknown[] = [
      { type: 'session.started', data: {} },
      { type: 'turn.started', data: {} },
      { type: 'step.started', data: {} },
      { type: 'step.completed', data: { finishReason: 'stop' } },
      { type: 'message.completed', data: { message: 'done', finishReason: 'stop' } },
      { type: 'reasoning.appended', data: { reasoningDelta: 'hmm' } },
      { type: 'reasoning.completed', data: { reasoning: 'hmm' } },
      // action.result carries tool OUTPUT — must be dropped (no PII leak, name already sent).
      { type: 'action.result', data: { result: { kind: 'tool-result', callId: 'c1', toolName: 't', output: { secret: 'leak' } }, status: 'completed' } },
      { type: 'session.waiting', data: { wait: 'next-user-message' } },
      { type: 'subagent.started', data: { callId: 'c', subagentName: 's' } },
    ]
    for (const e of dropped) {
      expect(reduceStreamEvent(ev(e))).toEqual([])
    }
  })
})

describe('reduceStreamEvent — a reopened chat’s restored history never shows', () => {
  const primer = `${RUN_CHAT_PRIMER_HEADING}\nThis chat continues in a new session…\n<run-history part="task">\nDraft the Q3 note\n</run-history>`

  it('drops the history part that leads a reopened chat’s first message: the person’s words alone, never the flattened message', () => {
    const out = reduceStreamEvent(
      ev({
        type: 'message.received',
        data: { message: `${primer}\nmake it shorter`, parts: [{ type: 'text', text: primer }, { type: 'text', text: 'make it shorter' }] },
      }),
    )
    expect(out).toEqual([{ type: 'user-message', text: 'make it shorter' }])
    expect(JSON.stringify(out)).not.toContain('run-history')
  })

  it('the person’s words stay the first part after it, and their files still become chips', () => {
    const out = reduceStreamEvent(
      ev({
        type: 'message.received',
        data: {
          message: 'x',
          parts: [
            { type: 'text', text: primer },
            { type: 'text', text: '[attached file] "a.md" (text/markdown) storage_path: u1/chat-uploads/a.md' },
            { type: 'text', text: '[attached file] "b.csv" (text/csv) storage_path: u1/chat-uploads/b.csv' },
          ],
        },
      }),
    )
    // The words part reads like a note, but the first part after the history is always the person's words.
    expect(out).toEqual([
      {
        type: 'user-message',
        text: '[attached file] "a.md" (text/markdown) storage_path: u1/chat-uploads/a.md',
        files: [{ mediaType: 'text/csv', filename: 'b.csv' }],
      },
    ])
  })

  it('only a leading part of a multi-part message is history: a single part, or one later in the message, is the person’s', () => {
    expect(reduceStreamEvent(ev({ type: 'message.received', data: { message: primer, parts: [{ type: 'text', text: primer }] } }))).toEqual([
      { type: 'user-message', text: primer },
    ])
    expect(
      reduceStreamEvent(
        ev({ type: 'message.received', data: { message: 'x', parts: [{ type: 'text', text: 'hi' }, { type: 'text', text: primer }] } }),
      ),
    ).toEqual([{ type: 'user-message', text: 'x' }])
    expect(isRunChatPrimerText(primer)).toBe(true)
    expect(isRunChatPrimerText(` ${primer}`)).toBe(false)
  })
})

describe('readRunChatHistory (a reopened chat’s primer reads the last few)', () => {
  const q = (question: string): RunChatEvent => ({
    type: 'question',
    question: { requestId: 'r', approveOptionId: 'approve', denyOptionId: 'cancel', questions: [{ question, header: '', options: [], multiSelect: false }] },
  })

  it('one message per turn, oldest first: what was sent (with its files’ names), what the agent wrote and asked, never a tool', () => {
    expect(
      readRunChatHistory([
        { type: 'user-message', text: 'make it formal', files: [{ mediaType: 'text/markdown', filename: 'notes.md' }, { mediaType: 'text/csv' }] },
        { type: 'text-delta', delta: 'On it, ' },
        { type: 'tool', name: 'revise_email_draft' },
        { type: 'text-delta', delta: 'done.' },
        { type: 'done' },
        { type: 'user-message', text: 'and the date?' },
        { type: 'text-delta', delta: 'One thing first.' },
        q('Fiscal or calendar?'),
        { type: 'done' },
        { type: 'user-message', text: '' },
        { type: 'text-delta', delta: 'cut short' },
      ]),
    ).toEqual([
      { from: 'person', text: 'make it formal\n(attached: notes.md, text/csv)' },
      { from: 'agent', text: 'On it, done.' },
      { from: 'person', text: 'and the date?' },
      { from: 'agent', text: 'One thing first.\n[asked: Fiscal or calendar?]' },
      { from: 'agent', text: 'cut short' },
    ])
    expect(readRunChatHistory([])).toEqual([])
  })
})

describe('toolNameForAction', () => {
  it('maps each action kind to its display name (or null for control-plane)', () => {
    expect(toolNameForAction({ kind: 'tool-call', callId: 'c', toolName: 'x', input: {} } as never)).toBe('x')
    expect(
      toolNameForAction({ kind: 'subagent-call', callId: 'c', name: 'N', subagentName: 'sub', description: '', input: {}, nodeId: 'n' } as never),
    ).toBe('sub')
    expect(
      toolNameForAction({ kind: 'remote-agent-call', callId: 'c', name: 'N', remoteAgentName: 'remote', description: '', input: {}, nodeId: 'n' } as never),
    ).toBe('remote')
    expect(toolNameForAction({ kind: 'load-skill', callId: 'c', input: {} } as never)).toBeNull()
  })
})

describe('questionPayloadForRequest', () => {
  it('returns null when the request is not the ask tool', () => {
    expect(
      questionPayloadForRequest(REQUEST({ action: { kind: 'tool-call', callId: 'c', toolName: 'other', input: { questions: [] } } }) as never),
    ).toBeNull()
  })

  it('returns null when questions are absent/malformed', () => {
    expect(
      questionPayloadForRequest(REQUEST({ action: { kind: 'tool-call', callId: 'c', toolName: REQUEST_USER_INPUT_TOOL_NAME, input: {} } }) as never),
    ).toBeNull()
    // A question with no text is skipped → empty → null.
    expect(
      questionPayloadForRequest(
        REQUEST({ action: { kind: 'tool-call', callId: 'c', toolName: REQUEST_USER_INPUT_TOOL_NAME, input: { questions: [{ header: 'x', options: [], multiSelect: false }] } } }) as never,
      ),
    ).toBeNull()
  })

  it('sanitizes options (drops non-string labels, keeps optional descriptions)', () => {
    const payload = questionPayloadForRequest(
      REQUEST({
        action: {
          kind: 'tool-call',
          callId: 'c',
          toolName: REQUEST_USER_INPUT_TOOL_NAME,
          input: {
            questions: [
              {
                question: 'Q?',
                header: 'H',
                multiSelect: true,
                options: [{ label: 'A' }, { notLabel: 1 }, { label: 'B', description: 'desc' }],
              },
            ],
          },
        },
      }) as never,
    )
    expect(payload).toEqual({
      requestId: 'req-1',
      approveOptionId: 'approve',
      denyOptionId: 'deny',
      questions: [
        {
          question: 'Q?',
          header: 'H',
          multiSelect: true,
          options: [{ label: 'A' }, { label: 'B', description: 'desc' }],
        },
      ],
    })
  })
})

describe('encodeRunChatEvent', () => {
  it('encodes as one NDJSON line', () => {
    const e: RunChatEvent = { type: 'text-delta', delta: 'hi' }
    expect(encodeRunChatEvent(e)).toBe('{"type":"text-delta","delta":"hi"}\n')
  })
})

describe('readRunChatReply (the relay reads a turn on the server, bots-v4 Phase A3)', () => {
  const q = (question: string): RunChatEvent => ({
    type: 'question',
    question: { requestId: 'r', approveOptionId: 'approve', denyOptionId: 'cancel', questions: [{ question, header: '', options: [], multiSelect: false }] },
  })

  it('keeps the text after the last tool call: "on it", acts, then reports', () => {
    const reply = readRunChatReply([
      { type: 'user-message', text: 'make it formal' },
      { type: 'text-delta', delta: 'On it, ' },
      { type: 'text-delta', delta: 'rewriting now.' },
      { type: 'tool', name: 'revise_email_draft' },
      { type: 'text-delta', delta: 'Done: the draft ' },
      { type: 'text-delta', delta: 'is formal now.' },
      { type: 'done' },
    ])
    expect(reply).toEqual({ text: 'Done: the draft is formal now.', tools: ['revise_email_draft'], questions: [], ended: true })
  })

  it('falls back to the last text it wrote when nothing follows its last tool call', () => {
    const reply = readRunChatReply([{ type: 'text-delta', delta: 'Checking.' }, { type: 'tool', name: 'find' }, { type: 'done' }])
    expect(reply.text).toBe('Checking.')
  })

  it('never takes the echoed message as the reply, and reads nothing as empty', () => {
    expect(readRunChatReply([{ type: 'user-message', text: 'hello' }, { type: 'done' }]).text).toBe('')
    expect(readRunChatReply([])).toEqual({ text: '', tools: [], questions: [], ended: false })
  })

  it('collects the questions it asked, and a failure', () => {
    const reply = readRunChatReply([{ type: 'text-delta', delta: 'One thing first.' }, q('Fiscal or calendar?'), { type: 'error', message: 'boom', code: 'FAILED' }])
    expect(reply.questions).toEqual(['Fiscal or calendar?'])
    expect(reply.text).toBe('One thing first.')
    expect(reply.error).toBe('boom')
    expect(reply.ended).toBe(false)
  })
})
