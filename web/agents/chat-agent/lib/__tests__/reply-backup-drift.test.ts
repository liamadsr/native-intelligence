import { describe, it, expect } from 'vitest'
import type { HandleMessageStreamEvent } from 'eve/client'
import {
  BACKUP_MODEL_ONLY_TOOL_FIELDS,
  BACKUP_TOOL_OUTPUT_HEAD_CHARS,
  BACKUP_TOOL_OUTPUT_MAX_SERIALIZED_CHARS,
  BACKUP_TOOL_OUTPUT_TAIL_CHARS,
  boundToolPayload,
  emptyReplyBackup,
  foldReplyBackup,
} from '../reply-backup'
import { CHAT_REPLY_ID_HEADER as AGENT_HEADER } from '../auth'
import { CHAT_REPLY_ID_HEADER as APP_HEADER } from '@/lib/chat/chat-run-token'
import {
  MODEL_ONLY_TOOL_FIELDS,
  TOOL_OUTPUT_HEAD_CHARS,
  TOOL_OUTPUT_MAX_SERIALIZED_CHARS,
  TOOL_OUTPUT_TAIL_CHARS,
  truncateToolOutput,
} from '@/lib/chat/eve/tool-output-truncation'
import { reduceEveTurnParts } from '@/lib/chat/eve-turn-parts'
import liveStreams from '../../../../src/lib/chat/eve/__tests__/fixtures/eve-0.66.3-live-streams.json'

/**
 * The server's copy of a reply must be the message the browser stores. The
 * eve runtime can't import the app's reducer, so the hook keeps the events
 * the reducer reads (lib/reply-backup.ts) and the app reduces them
 * (src/lib/chat/reply-backup.ts). Pinned here:
 *   - over real recorded eve streams, the kept events reduce to exactly the
 *     parts the raw stream does (the browser's reducer, eve-turn-parts.ts);
 *   - the payload bound is truncateToolOutput's, so a bounded output reduces
 *     to the same display string;
 *   - the twins (header name, bounds, model-only fields) match their originals.
 */

const REPLY = 'eve-msg-chat-1'
const streams = liveStreams as unknown as Record<string, HandleMessageStreamEvent[] | string>

function kept(events: unknown[]): HandleMessageStreamEvent[] {
  const state = events.reduce((s: ReturnType<typeof emptyReplyBackup>, e) => foldReplyBackup(s, REPLY, e), emptyReplyBackup())
  return state.events as unknown as HandleMessageStreamEvent[]
}

describe('reply backup ⇄ browser reducer parity', () => {
  const recorded = Object.entries(streams).filter((entry): entry is [string, HandleMessageStreamEvent[]] => Array.isArray(entry[1]))

  it('has recorded streams to compare', () => {
    expect(recorded.length).toBeGreaterThan(5)
  })

  for (const [name, events] of recorded) {
    it(`reduces the kept events of "${name}" to the browser's parts`, () => {
      expect(reduceEveTurnParts(REPLY, kept(events))).toEqual(reduceEveTurnParts(REPLY, events))
    })
  }

  it('a parked ask_user and its answer, kept as one reply, reduce to the same parts', () => {
    const both = [...(streams.askUserApprovalPark as HandleMessageStreamEvent[]), ...(streams.askUserApprovalResume as HandleMessageStreamEvent[])]
    expect(reduceEveTurnParts(REPLY, kept(both))).toEqual(reduceEveTurnParts(REPLY, both))
  })

  it('bounded and model-only tool payloads reduce to the same display output', () => {
    const big = { rows: 'z'.repeat(TOOL_OUTPUT_MAX_SERIALIZED_CHARS) }
    const events = [
      { type: 'message.appended', data: { messageDelta: 'Looking.' } },
      {
        type: 'actions.requested',
        data: {
          actions: [
            { kind: 'tool-call', callId: 'c1', toolName: 'search', input: { q: 'x' } },
            { kind: 'tool-call', callId: 'c2', toolName: 'read', input: { id: 'd' } },
            { kind: 'tool-call', callId: 'c3', toolName: 'write', input: { id: 'd' } },
          ],
        },
      },
      { type: 'action.result', data: { result: { kind: 'tool-result', callId: 'c1', toolName: 'search', output: big } } },
      { type: 'action.result', data: { result: { kind: 'tool-result', callId: 'c2', toolName: 'read', output: { text: 'ok', __expertise: 'pack '.repeat(20_000) } } } },
      { type: 'action.result', data: { result: { kind: 'tool-result', callId: 'c3', toolName: 'write', isError: true, output: { error: 'e'.repeat(70_000) } } } },
      { type: 'message.appended', data: { messageDelta: 'Done.' } },
      { type: 'turn.completed', data: {} },
    ] as unknown as HandleMessageStreamEvent[]
    expect(reduceEveTurnParts(REPLY, kept(events))).toEqual(reduceEveTurnParts(REPLY, events))
  })
})

describe('reply backup twins', () => {
  it('names the same reply-id header as the app', () => {
    expect(AGENT_HEADER).toBe(APP_HEADER)
  })

  it("bounds a payload exactly as truncateToolOutput does", () => {
    expect(BACKUP_TOOL_OUTPUT_MAX_SERIALIZED_CHARS).toBe(TOOL_OUTPUT_MAX_SERIALIZED_CHARS)
    expect(BACKUP_TOOL_OUTPUT_HEAD_CHARS).toBe(TOOL_OUTPUT_HEAD_CHARS)
    expect(BACKUP_TOOL_OUTPUT_TAIL_CHARS).toBe(TOOL_OUTPUT_TAIL_CHARS)
    const samples: unknown[] = [
      'short',
      { a: 1 },
      'x'.repeat(TOOL_OUTPUT_MAX_SERIALIZED_CHARS),
      'x'.repeat(TOOL_OUTPUT_MAX_SERIALIZED_CHARS + 1),
      { rows: Array.from({ length: 5_000 }, (_, i) => ({ i, name: `row ${i}` })) },
      undefined,
      null,
    ]
    for (const s of samples) expect(boundToolPayload(s)).toEqual(truncateToolOutput(s))
  })

  it('strips the same model-only fields', () => {
    expect(BACKUP_MODEL_ONLY_TOOL_FIELDS).toEqual(MODEL_ONLY_TOOL_FIELDS)
  })
})
