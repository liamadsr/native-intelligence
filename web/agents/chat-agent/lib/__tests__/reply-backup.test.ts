import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  BACKUP_TOOL_OUTPUT_MAX_SERIALIZED_CHARS,
  REPLY_BACKUP_MAX_CHARS,
  REPLY_BACKUP_OMITTED,
  emptyReplyBackup,
  foldReplyBackup,
  hasReplyContent,
  saneReplyBackup,
  type ReplyBackupState,
} from '../reply-backup'

/**
 * The reply backup (hooks/reply-backup.ts + lib/reply-backup.ts): the
 * chat-agent keeps its own copy of each reply and posts it at the turn's end,
 * so a reply survives the page that asked for it.
 *
 * Pinned:
 *   1. the fold keeps only what the reducer reads, merging consecutive deltas
 *      (one object per block, never per delta);
 *   2. it is keyed by reply id: the same id continues (a HITL answer), another
 *      starts fresh (a new message, a steer), none drops it (a device ask, a
 *      home turn, an older client);
 *   3. payloads are bounded (display bound per payload, a cap per reply);
 *   4. the hook posts at turn.completed / failed / cancelled and at a park on
 *      input (never a park on tasks), with the whole reply so far, the run
 *      token and the reply id; nothing for a send without a reply id or
 *      without content; one retry on a retryable failure; it never throws.
 *
 * Lives in lib/__tests__/ (NOT hooks/__tests__/): eve's hook discovery treats
 * every path segment under hooks/ as a hook name.
 */

const ev = (type: string, data?: Record<string, unknown>) => ({ type, data: { turnId: 'turn_1', ...(data ?? {}) } })
const fold = (state: ReplyBackupState, replyId: string | null, events: unknown[]) =>
  events.reduce<ReplyBackupState>((s, e) => foldReplyBackup(s, replyId, e), state)

describe('foldReplyBackup', () => {
  it('merges consecutive deltas into one event per block', () => {
    const s = fold(emptyReplyBackup(), 'r-1', [
      ev('reasoning.appended', { reasoningDelta: 'Think' }),
      ev('reasoning.appended', { reasoningDelta: 'ing.' }),
      ev('message.appended', { messageDelta: 'Hel' }),
      ev('message.appended', { messageDelta: 'lo' }),
      ev('message.completed', { message: 'Hello' }),
      ev('message.appended', { messageDelta: ' again' }),
    ])
    expect(s.replyId).toBe('r-1')
    expect(s.events).toEqual([
      { type: 'reasoning.appended', data: { reasoningDelta: 'Thinking.' } },
      { type: 'message.appended', data: { messageDelta: 'Hello' } },
      { type: 'message.completed' },
      { type: 'message.appended', data: { messageDelta: ' again' } },
    ])
  })

  it('keeps only the fields the reducer reads, and skips what it ignores', () => {
    const s = fold(emptyReplyBackup(), 'r-1', [
      ev('step.started', { modelId: 'x' }),
      ev('actions.requested', {
        actions: [{ kind: 'tool-call', callId: 'c1', toolName: 'update_sequence', input: { id: 's1' }, extra: 'dropped' }],
      }),
      ev('action.partial', { result: { kind: 'tool-result', callId: 'c1', output: 'progress' } }),
      ev('action.result', { result: { kind: 'tool-result', callId: 'c1', toolName: 'update_sequence', output: { ok: true, __expertise: 'model only' } } }),
      ev('action.result', { result: { kind: 'load-skill-result', callId: 'c2', output: 'x' } }),
      ev('step.completed', { usage: {} }),
    ])
    expect(s.events).toEqual([
      { type: 'actions.requested', data: { actions: [{ kind: 'tool-call', callId: 'c1', toolName: 'update_sequence', input: { id: 's1' } }] } },
      { type: 'action.result', data: { result: { kind: 'tool-result', callId: 'c1', toolName: 'update_sequence', output: { ok: true } } } },
    ])
  })

  it("keeps an error result's output as is (the reducer turns it into errorText)", () => {
    const s = fold(emptyReplyBackup(), 'r-1', [
      ev('action.result', { result: { kind: 'tool-result', callId: 'c1', toolName: 't', isError: true, output: 'boom' } }),
    ])
    expect(s.events[0]).toEqual({ type: 'action.result', data: { result: { kind: 'tool-result', callId: 'c1', toolName: 't', isError: true, output: 'boom' } } })
  })

  it('continues the same reply id, starts fresh on another, and drops on none', () => {
    const one = fold(emptyReplyBackup(), 'r-1', [ev('message.appended', { messageDelta: 'a' }), ev('turn.completed')])
    const resumed = fold(one, 'r-1', [ev('message.appended', { messageDelta: 'b' })])
    expect(resumed.events.map((e) => e.type)).toEqual(['message.appended', 'turn.completed', 'message.appended'])
    const other = fold(resumed, 'r-2', [ev('message.appended', { messageDelta: 'c' })])
    expect(other).toMatchObject({ replyId: 'r-2', events: [{ type: 'message.appended', data: { messageDelta: 'c' } }] })
    expect(fold(other, null, [ev('message.appended', { messageDelta: 'home turn' })])).toEqual(emptyReplyBackup())
  })

  it('bounds a payload past the display bound and drops payloads past the reply cap', () => {
    const big = 'x'.repeat(BACKUP_TOOL_OUTPUT_MAX_SERIALIZED_CHARS + 1)
    const s = fold(emptyReplyBackup(), 'r-1', [ev('action.result', { result: { kind: 'tool-result', callId: 'c1', output: big } })])
    const out = (s.events[0].data!.result as { output: string }).output
    expect(out.length).toBeLessThan(11_000)
    expect(out).toContain('[output truncated for display')

    const nearlyFull: ReplyBackupState = { replyId: 'r-1', events: [], chars: REPLY_BACKUP_MAX_CHARS - 10 }
    const capped = foldReplyBackup(nearlyFull, 'r-1', ev('action.result', { result: { kind: 'tool-result', callId: 'c2', output: { rows: 'y'.repeat(100) } } }))
    expect((capped.events[0].data!.result as { output: unknown }).output).toBe(REPLY_BACKUP_OMITTED)
    // Text still goes in past the cap.
    expect(foldReplyBackup(capped, 'r-1', ev('message.appended', { messageDelta: 'done' })).events).toHaveLength(2)
  })

  it('is total: malformed events and state are skipped, never thrown', () => {
    expect(() => fold(emptyReplyBackup(), 'r-1', [null, 42, { type: 7 }, ev('actions.requested', { actions: 'nope' }), ev('input.requested', { requests: [{}] })])).not.toThrow()
    expect(saneReplyBackup('garbage')).toEqual(emptyReplyBackup())
    expect(saneReplyBackup({ replyId: 'r-1', events: [], chars: 3 })).toEqual({ replyId: 'r-1', events: [], chars: 3 })
  })

  it('has content only once something a message shows was kept', () => {
    expect(hasReplyContent(fold(emptyReplyBackup(), 'r-1', [ev('message.completed'), ev('turn.cancelled')]))).toBe(false)
    expect(hasReplyContent(fold(emptyReplyBackup(), 'r-1', [ev('message.appended', { messageDelta: 'hi' })]))).toBe(true)
    expect(hasReplyContent(fold(emptyReplyBackup(), 'r-1', [ev('input.requested', { requests: [{ requestId: 'q1', action: { callId: 'c1', toolName: 'ask_user', input: {} } }] })]))).toBe(true)
  })
})

// ── The hook ────────────────────────────────────────────────────────────────

const stateStore = new Map<string, unknown>()
vi.mock('eve/context', () => ({
  defineState: <T,>(name: string, initial: () => T) => ({
    get: () => (stateStore.has(name) ? (stateStore.get(name) as T) : initial()),
    update: (fn: (prev: T) => T) => {
      const prev = stateStore.has(name) ? (stateStore.get(name) as T) : initial()
      stateStore.set(name, fn(prev))
    },
  }),
}))

type PostResult = { ok: true } | { ok: false; status: number | 'network'; retryable: boolean }
const postReplyBackup = vi.fn<(token: string, body: unknown) => Promise<PostResult>>()
vi.mock('../spec-client', () => ({
  postReplyBackup: (t: string, b: unknown) => postReplyBackup(t, b),
  runTokenFromAuth: (auth: { current?: { attributes?: Record<string, unknown> } }) => String(auth.current?.attributes?.chatRunToken ?? ''),
  replyIdFromAuth: (auth: { current?: { attributes?: Record<string, unknown> } }) => String(auth.current?.attributes?.chatReplyId ?? ''),
}))

const { default: hook } = await import('../../hooks/reply-backup')
type Handler = (event: unknown, ctx: unknown) => Promise<void>
const handlers = (hook as unknown as { events: Record<string, Handler> }).events

function ctxFor(attributes: Record<string, string>) {
  return { session: { id: 'wrun_1', auth: { current: { attributes } } } }
}
const browser = ctxFor({ chatRunToken: 'tok.sig', chatReplyId: 'eve-msg-chat-1' })

async function emit(ctx: unknown, events: Array<{ type: string; data?: Record<string, unknown> }>) {
  for (const e of events) await handlers[e.type]?.(e, ctx)
}

beforeEach(() => {
  stateStore.clear()
  postReplyBackup.mockReset()
  postReplyBackup.mockResolvedValue({ ok: true })
})

describe('reply-backup hook', () => {
  it("posts the whole reply at turn.completed, under the send's reply id and run token", async () => {
    await emit(browser, [
      ev('turn.started'),
      ev('message.appended', { messageDelta: 'Updated ' }),
      ev('message.appended', { messageDelta: 'the sequence.' }),
      ev('message.completed'),
      ev('turn.completed'),
    ])
    expect(postReplyBackup).toHaveBeenCalledTimes(1)
    const [token, body] = postReplyBackup.mock.calls[0]
    expect(token).toBe('tok.sig')
    expect(body).toEqual({
      replyId: 'eve-msg-chat-1',
      sessionId: 'wrun_1',
      turnId: 'turn_1',
      outcome: 'completed',
      events: [{ type: 'message.appended', data: { messageDelta: 'Updated the sequence.' } }, { type: 'message.completed' }, { type: 'turn.completed' }],
    })
  })

  it('posts a failed and a cancelled turn too, with their outcome', async () => {
    await emit(browser, [ev('message.appended', { messageDelta: 'a' }), ev('turn.failed', { message: 'model error' })])
    await emit(ctxFor({ chatRunToken: 'tok.sig', chatReplyId: 'r-2' }), [ev('message.appended', { messageDelta: 'b' }), ev('turn.cancelled')])
    expect(postReplyBackup.mock.calls.map(([, b]) => (b as { outcome: string }).outcome)).toEqual(['failed', 'cancelled'])
  })

  it('posts at a park on input, and again (the whole reply) when the answer completes it', async () => {
    await emit(browser, [
      ev('message.appended', { messageDelta: 'Which one?' }),
      ev('input.requested', { requests: [{ requestId: 'q1', action: { callId: 'c1', toolName: 'ask_user', input: { questions: [] } } }] }),
      ev('turn.waiting', { on: 'input' }),
    ])
    expect(postReplyBackup).toHaveBeenCalledTimes(1)
    expect((postReplyBackup.mock.calls[0][1] as { outcome: string }).outcome).toBe('waiting')

    await emit(browser, [ev('action.result', { result: { kind: 'tool-result', callId: 'c1', toolName: 'ask_user', output: {} } }), ev('message.appended', { messageDelta: 'Done.' }), ev('turn.completed')])
    expect(postReplyBackup).toHaveBeenCalledTimes(2)
    const last = postReplyBackup.mock.calls[1][1] as { replyId: string; events: Array<{ type: string }> }
    expect(last.replyId).toBe('eve-msg-chat-1')
    expect(last.events.map((e) => e.type)).toEqual(['message.appended', 'input.requested', 'action.result', 'message.appended', 'turn.completed'])
  })

  it('never posts at a wait on background tasks', async () => {
    await emit(browser, [ev('message.appended', { messageDelta: 'Starting helpers.' }), ev('turn.waiting', { on: 'tasks' })])
    expect(postReplyBackup).not.toHaveBeenCalled()
  })

  it('posts nothing for a send that names no reply (a device ask, a home turn, an older client)', async () => {
    await emit(ctxFor({ chatRunToken: 'tok.sig' }), [ev('message.appended', { messageDelta: 'hi' }), ev('turn.completed')])
    expect(postReplyBackup).not.toHaveBeenCalled()
  })

  it('posts nothing for a turn with no content, or with no run token', async () => {
    await emit(browser, [ev('turn.started'), ev('turn.cancelled')])
    await emit(ctxFor({ chatReplyId: 'r-3' }), [ev('message.appended', { messageDelta: 'hi' }), ev('turn.completed')])
    expect(postReplyBackup).not.toHaveBeenCalled()
  })

  it('retries a retryable failure once, never a final one, and never throws', async () => {
    postReplyBackup.mockResolvedValue({ ok: false, status: 503, retryable: true })
    await emit(browser, [ev('message.appended', { messageDelta: 'a' }), ev('turn.completed')])
    expect(postReplyBackup).toHaveBeenCalledTimes(2)

    postReplyBackup.mockReset()
    postReplyBackup.mockResolvedValue({ ok: false, status: 400, retryable: false })
    await emit(browser, [ev('turn.completed')])
    expect(postReplyBackup).toHaveBeenCalledTimes(1)

    postReplyBackup.mockReset()
    postReplyBackup.mockRejectedValue(new Error('network down'))
    await expect(emit(browser, [ev('turn.completed')])).resolves.toBeUndefined()
  })
})
