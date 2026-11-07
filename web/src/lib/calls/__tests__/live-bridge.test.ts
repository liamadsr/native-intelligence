import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NO_NEW_WORDS, NOTHING_TO_ADD, commentaryChunks, runLiveCall, speakable, type LiveSocket } from '../live-bridge'
import type { CallTurnResult } from '../call-turn-server'
import type { CallCaller } from '../caller'

const CALLER: CallCaller = { userId: 'u1', workspaceId: 'w1', via: 'verified_phone' }

/** A sideband socket the test drives: `emit` is GPT-Live speaking, `sent` what the bridge sent. */
function fakeSocket() {
  let onMessage: (text: string) => void = () => {}
  let onClose: () => void = () => {}
  const sent: Array<Record<string, unknown>> = []
  const socket: LiveSocket = {
    send: (data) => sent.push(JSON.parse(data)),
    close: vi.fn(),
    onMessage: (fn) => (onMessage = fn),
    onClose: (fn) => (onClose = fn),
  }
  return { socket, sent, emit: (event: unknown) => onMessage(JSON.stringify(event)), drop: () => onClose() }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

type RunTurn = (args: { words: string; delegationId: string }, background: (work: Promise<void>) => void) => Promise<CallTurnResult>

async function startCall(runTurn: RunTurn, opts: { maxMs?: number } = {}) {
  const s = fakeSocket()
  const urls: string[] = []
  const hangups: string[] = []
  const call = runLiveCall(
    { sessionId: 'live_1', caller: CALLER, apiKey: 'sk-test' },
    {
      supabase: {} as SupabaseClient,
      connect: async (url) => {
        urls.push(url)
        return s.socket
      },
      runTurn,
      hangUp: async (id) => {
        hangups.push(id)
      },
      // The settle is instant; the end-of-call grace waits a little (for background turns).
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms > 0 ? 200 : 0)),
      settleMs: 0,
      settleMaxMs: 0,
      maxMs: opts.maxMs ?? 60_000,
    },
  )
  await flush()
  return { ...s, call, urls, hangups }
}

describe('runLiveCall', () => {
  it('hands what the caller said to a call turn and sends its answer back as commentary', async () => {
    const turns: Array<{ words: string; delegationId: string }> = []
    const { emit, sent, call, urls } = await startCall(async (args) => {
      turns.push({ words: args.words, delegationId: args.delegationId })
      return { kind: 'reply', text: 'You have **two** meetings: standup at 9:30 and [lunch](https://x.test) at 12:15.', outcome: 'written', rowId: 'r1' }
    })
    expect(urls).toEqual(['wss://api.openai.com/v1/live/sessions/live_1/attach'])
    emit({ type: 'session.input_transcript.delta', delta: "What's on tomorrow?", start_ms: 0, end_ms: 900 })
    emit({ type: 'session.output_transcript.delta', delta: 'Let me check.', start_ms: 1000, end_ms: 1500 })
    emit({ type: 'session.delegation.created', event_id: 'e1', offset_ms: 950, delegation: { id: 'del_1', type: 'delegation', target: 'client' } })
    await flush()
    await flush()
    emit({ type: 'session.closed', reason: 'remote_hangup' })
    const summary = await call
    expect(turns).toEqual([{ words: "What's on tomorrow?", delegationId: 'del_1' }])
    expect(sent).toEqual([
      { type: 'session.commentary.append', delegation_id: 'del_1', content: 'You have two meetings: standup at 9:30 and lunch at 12:15.', event_id: 'dial8_1' },
    ])
    expect(summary).toMatchObject({ handoffs: 1, replies: 1, closed: 'remote_hangup', callerChars: 19, agentChars: 13 })
  })

  it('opens with the greeting once attached, as commentary with no delegation', async () => {
    const s = fakeSocket()
    const call = runLiveCall(
      { sessionId: 'live_g', caller: CALLER, apiKey: 'k', greeting: "Hi Liam, it's your Dial8 agent. What can I do for you?" },
      { supabase: {} as SupabaseClient, connect: async () => s.socket, runTurn: async () => ({ kind: 'quiet', outcome: 'quiet' }), hangUp: async () => {}, sleep: async () => {} },
    )
    await flush()
    expect(s.sent).toEqual([{ type: 'session.commentary.append', delegation_id: null, content: "Hi Liam, it's your Dial8 agent. What can I do for you?", event_id: 'dial8_1' }])
    s.emit({ type: 'session.closed', reason: 'remote_hangup' })
    expect((await call).types).toEqual({ 'session.closed': 1 })
  })

  it('runs hand-offs one at a time, in order, each with its own words', async () => {
    let release!: () => void
    const order: string[] = []
    const { emit, sent, call } = await startCall(async (args) => {
      order.push(`start:${args.delegationId}:${args.words}`)
      if (args.delegationId === 'del_1') await new Promise<void>((resolve) => (release = resolve))
      order.push(`end:${args.delegationId}`)
      return { kind: 'reply', text: `Answer ${args.delegationId}.`, outcome: 'written', rowId: 'r' }
    })
    emit({ type: 'session.input_transcript.delta', delta: 'First question.', start_ms: 0, end_ms: 500 })
    emit({ type: 'session.delegation.created', delegation: { id: 'del_1' } })
    await flush()
    emit({ type: 'session.input_transcript.delta', delta: 'Second question.', start_ms: 2000, end_ms: 2500 })
    emit({ type: 'session.delegation.created', delegation: { id: 'del_2' } })
    await flush()
    expect(order).toEqual(['start:del_1:First question.'])
    release()
    await flush()
    await flush()
    await flush()
    emit({ type: 'session.closed', reason: 'remote_hangup' })
    await call
    expect(order).toEqual(['start:del_1:First question.', 'end:del_1', 'start:del_2:Second question.', 'end:del_2'])
    expect(sent.map((e) => [e.delegation_id, e.content])).toEqual([
      ['del_1', 'Answer del_1.'],
      ['del_2', 'Answer del_2.'],
    ])
  })

  it("a queued hand-off takes only what was said before its offset, not the next one's words", async () => {
    let release!: () => void
    const turns: string[] = []
    const { emit, sent, call } = await startCall(async (args) => {
      turns.push(`${args.delegationId}:${args.words}`)
      if (args.delegationId === 'del_a') await new Promise<void>((resolve) => (release = resolve))
      return { kind: 'reply', text: 'OK.', outcome: 'written', rowId: 'r' }
    })
    // Each question comes after GPT-Live answered the one before: seconds apart.
    emit({ type: 'session.input_transcript.delta', delta: 'Question A.', start_ms: 0, end_ms: 500 })
    emit({ type: 'session.delegation.created', offset_ms: 600, delegation: { id: 'del_a' } })
    await flush()
    emit({ type: 'session.input_transcript.delta', delta: 'Question B.', start_ms: 6000, end_ms: 6500 })
    emit({ type: 'session.delegation.created', offset_ms: 6600, delegation: { id: 'del_b' } })
    emit({ type: 'session.input_transcript.delta', delta: 'Question C.', start_ms: 12000, end_ms: 12500 })
    emit({ type: 'session.delegation.created', offset_ms: 12600, delegation: { id: 'del_c' } })
    release()
    for (let i = 0; i < 6; i++) await flush()
    emit({ type: 'session.closed', reason: 'remote_hangup' })
    await call
    expect(turns).toEqual(['del_a:Question A.', 'del_b:Question B.', 'del_c:Question C.'])
    expect(sent.filter((e) => e.type === 'session.thinking.append')).toEqual([])
  })

  it("keeps the caller's last word when GPT-Live hands off before they finish", async () => {
    let release!: () => void
    const turns: string[] = []
    const { emit, call } = await startCall(async (args) => {
      turns.push(`${args.delegationId}:${args.words}`)
      if (args.delegationId === 'del_a') await new Promise<void>((resolve) => (release = resolve))
      return { kind: 'reply', text: 'OK.', outcome: 'written', rowId: 'r' }
    })
    // A turn is still running, so the next hand-off queues with its words arriving around it.
    emit({ type: 'session.input_transcript.delta', delta: 'Earlier question.', start_ms: 0, end_ms: 500 })
    emit({ type: 'session.delegation.created', offset_ms: 600, delegation: { id: 'del_a' } })
    await flush()
    emit({ type: 'session.input_transcript.delta', delta: "What's on my calendar for", start_ms: 5000, end_ms: 6200 })
    emit({ type: 'session.delegation.created', offset_ms: 6300, delegation: { id: 'del_b' } })
    emit({ type: 'session.input_transcript.delta', delta: 'tomorrow?', start_ms: 6400, end_ms: 6900 })
    emit({ type: 'session.input_transcript.delta', delta: 'And what are my to-dos?', start_ms: 12000, end_ms: 13000 })
    emit({ type: 'session.delegation.created', offset_ms: 13100, delegation: { id: 'del_c' } })
    release()
    for (let i = 0; i < 6; i++) await flush()
    emit({ type: 'session.closed', reason: 'remote_hangup' })
    await call
    expect(turns).toEqual(['del_a:Earlier question.', "del_b:What's on my calendar for tomorrow?", 'del_c:And what are my to-dos?'])
  })

  it('never lets the grace reach past the next hand-off: two quick questions keep their own words', async () => {
    let release!: () => void
    const turns: string[] = []
    const { emit, call } = await startCall(async (args) => {
      turns.push(`${args.delegationId}:${args.words}`)
      if (args.delegationId === 'del_a') await new Promise<void>((resolve) => (release = resolve))
      return { kind: 'reply', text: 'OK.', outcome: 'written', rowId: 'r' }
    })
    emit({ type: 'session.input_transcript.delta', delta: 'Earlier question.', start_ms: 0, end_ms: 500 })
    emit({ type: 'session.delegation.created', offset_ms: 600, delegation: { id: 'del_a' } })
    await flush()
    emit({ type: 'session.input_transcript.delta', delta: 'What time is it in Tokyo?', start_ms: 5000, end_ms: 6000 })
    emit({ type: 'session.delegation.created', offset_ms: 6100, delegation: { id: 'del_b' } })
    emit({ type: 'session.input_transcript.delta', delta: 'And London?', start_ms: 6300, end_ms: 7000 })
    emit({ type: 'session.delegation.created', offset_ms: 7100, delegation: { id: 'del_c' } })
    release()
    for (let i = 0; i < 6; i++) await flush()
    emit({ type: 'session.closed', reason: 'remote_hangup' })
    await call
    expect(turns).toEqual(['del_a:Earlier question.', 'del_b:What time is it in Tokyo?', 'del_c:And London?'])
  })

  it('still runs a hand-off the caller hung up on while it settled, saying nothing', async () => {
    const s = fakeSocket()
    let clock = 0
    const turns: string[] = []
    const call = runLiveCall(
      { sessionId: 'live_h', caller: CALLER, apiKey: 'k' },
      {
        supabase: {} as SupabaseClient,
        connect: async () => s.socket,
        runTurn: async (args) => {
          turns.push(args.words)
          return { kind: 'reply', text: "I've texted Jess.", outcome: 'written', rowId: 'r' }
        },
        hangUp: async () => {},
        now: () => clock,
        // The caller hangs up during the hand-off's settle.
        sleep: async (ms) => {
          clock += ms
          if (clock === 500) s.emit({ type: 'session.closed', reason: 'remote_hangup' })
        },
      },
    )
    await flush()
    s.emit({ type: 'session.input_transcript.delta', delta: "Text Jess I'm on my way, bye.", start_ms: 0, end_ms: 1500 })
    s.emit({ type: 'session.delegation.created', offset_ms: 1600, delegation: { id: 'del_1' } })
    const summary = await call
    expect(turns).toEqual(["Text Jess I'm on my way, bye."])
    expect(s.sent).toEqual([])
    expect(summary).toMatchObject({ closed: 'remote_hangup', handoffs: 1, replies: 0 })
  })

  it('waits for the caller to stop before reading a hand-off, within a cap', async () => {
    const s = fakeSocket()
    let clock = 0
    const words: string[] = []
    const call = runLiveCall(
      { sessionId: 'live_q', caller: CALLER, apiKey: 'k' },
      {
        supabase: {} as SupabaseClient,
        connect: async () => s.socket,
        runTurn: async (args) => {
          words.push(args.words)
          return { kind: 'quiet', outcome: 'quiet' }
        },
        hangUp: async () => {},
        now: () => clock,
        // Each wait moves the clock on. One fragment lands during the minimum
        // wait, the next only while the bridge waits for quiet.
        sleep: async (ms) => {
          clock += ms
          if (clock === 500) s.emit({ type: 'session.input_transcript.delta', delta: 'tomorrow', start_ms: 1300, end_ms: 1700 })
          if (clock === 700) s.emit({ type: 'session.input_transcript.delta', delta: 'morning?', start_ms: 1800, end_ms: 2300 })
        },
      },
    )
    await flush()
    s.emit({ type: 'session.input_transcript.delta', delta: "What's on for", start_ms: 0, end_ms: 1100 })
    s.emit({ type: 'session.delegation.created', offset_ms: 1200, delegation: { id: 'del_1' } })
    for (let i = 0; i < 4; i++) await flush()
    s.emit({ type: 'session.closed', reason: 'remote_hangup' })
    await call
    expect(words).toEqual(["What's on for tomorrow morning?"])
  })

  it('a reply that is only a link says nothing aloud', async () => {
    const { emit, sent, call } = await startCall(async () => ({ kind: 'reply', text: 'https://dial8.ai/x', outcome: 'written', rowId: 'r' }))
    emit({ type: 'session.input_transcript.delta', delta: 'Send me the link.', start_ms: 0, end_ms: 400 })
    emit({ type: 'session.delegation.created', delegation: { id: 'del_1' } })
    await flush()
    await flush()
    emit({ type: 'session.closed', reason: 'remote_hangup' })
    expect((await call).replies).toBe(0)
    expect(sent).toEqual([{ type: 'session.thinking.append', delegation_id: 'del_1', content: NOTHING_TO_ADD, event_id: 'dial8_1' }])
  })

  it('waits for a slow turn finishing in the background before it returns', async () => {
    let finished = false
    const { emit, call } = await startCall(async (_args, background) => {
      background(
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 20))
          finished = true
        })(),
      )
      return { kind: 'notice', text: "That's taking me a while.", outcome: 'slow', rowId: 'r' }
    })
    emit({ type: 'session.input_transcript.delta', delta: 'Research Dana.', start_ms: 0, end_ms: 400 })
    emit({ type: 'session.delegation.created', delegation: { id: 'del_1' } })
    await flush()
    await flush()
    emit({ type: 'session.closed', reason: 'remote_hangup' })
    await call
    expect(finished).toBe(true)
  })

  it('waits too for a background finish handed on after the call ended (the caller hung up mid-read)', async () => {
    let release!: () => void
    let finished = false
    const { emit, call } = await startCall(async (_args, background) => {
      await new Promise<void>((resolve) => (release = resolve))
      background(
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 20))
          finished = true
        })(),
      )
      return { kind: 'notice', text: "That's taking me a while.", outcome: 'slow', rowId: 'r' }
    })
    emit({ type: 'session.input_transcript.delta', delta: 'Research Dana.', start_ms: 0, end_ms: 400 })
    emit({ type: 'session.delegation.created', delegation: { id: 'del_1' } })
    await flush()
    emit({ type: 'session.closed', reason: 'remote_hangup' })
    await flush()
    release()
    await call
    expect(finished).toBe(true)
  })

  it('a quiet turn, or a hand-off with no new words, answers silently', async () => {
    const runTurn = vi.fn(async (): Promise<CallTurnResult> => ({ kind: 'quiet', outcome: 'quiet', rowId: 'r' }))
    const { emit, sent, call } = await startCall(runTurn)
    emit({ type: 'session.delegation.created', delegation: { id: 'del_empty' } })
    await flush()
    emit({ type: 'session.input_transcript.delta', delta: 'Thanks.', start_ms: 0, end_ms: 400 })
    emit({ type: 'session.delegation.created', delegation: { id: 'del_quiet' } })
    await flush()
    await flush()
    emit({ type: 'session.closed', reason: 'remote_hangup' })
    const summary = await call
    expect(runTurn).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([
      { type: 'session.thinking.append', delegation_id: 'del_empty', content: NO_NEW_WORDS, event_id: 'dial8_1' },
      { type: 'session.thinking.append', delegation_id: 'del_quiet', content: NOTHING_TO_ADD, event_id: 'dial8_2' },
    ])
    expect(summary).toMatchObject({ handoffs: 2, empty: 1, quiet: 1, replies: 0 })
  })

  it('a notice is said like an answer', async () => {
    const { emit, sent, call } = await startCall(async () => ({ kind: 'notice', text: "That needs your OK first. It's waiting for you in the Dial8 app.", outcome: 'written' }))
    emit({ type: 'session.input_transcript.delta', delta: 'Email Dana.', start_ms: 0, end_ms: 400 })
    emit({ type: 'session.delegation.created', delegation: { id: 'del_1' } })
    await flush()
    await flush()
    emit({ type: 'session.closed', reason: 'remote_hangup' })
    expect((await call).notices).toBe(1)
    expect(sent[0]).toMatchObject({ type: 'session.commentary.append', content: "That needs your OK first. It's waiting for you in the Dial8 app." })
  })

  it('drops the answer of a turn that finished after the call ended, but waits for it', async () => {
    let release!: () => void
    const finished = vi.fn()
    const { emit, sent, call } = await startCall(async () => {
      await new Promise<void>((resolve) => (release = resolve))
      finished()
      return { kind: 'reply', text: 'Too late.', outcome: 'written', rowId: 'r' }
    })
    emit({ type: 'session.input_transcript.delta', delta: 'Question.', start_ms: 0, end_ms: 400 })
    emit({ type: 'session.delegation.created', delegation: { id: 'del_1' } })
    await flush()
    emit({ type: 'session.closed', reason: 'remote_hangup' })
    await flush()
    release()
    await call
    expect(finished).toHaveBeenCalled()
    expect(sent).toEqual([])
  })

  it('ends when the socket closes, and closes the session at the cost cap, hanging up either way', async () => {
    const dropped = await startCall(async () => ({ kind: 'quiet', outcome: 'quiet' }))
    dropped.drop()
    expect((await dropped.call).closed).toBe('connection_lost')
    expect(dropped.hangups).toEqual(['live_1'])

    const hungUp = await startCall(async () => ({ kind: 'quiet', outcome: 'quiet' }))
    hungUp.emit({ type: 'session.closed', reason: 'remote_hangup' })
    await hungUp.call
    expect(hungUp.hangups).toEqual([])

    vi.useFakeTimers()
    try {
      const capped = await (async () => {
        const s = fakeSocket()
        const hangups: string[] = []
        const call = runLiveCall(
          { sessionId: 'live_2', caller: CALLER, apiKey: 'k' },
          {
            supabase: {} as SupabaseClient,
            connect: async () => s.socket,
            runTurn: async () => ({ kind: 'quiet', outcome: 'quiet' }),
            hangUp: async (id) => {
              hangups.push(id)
            },
            sleep: async () => {},
            maxMs: 1_000,
          },
        )
        await vi.advanceTimersByTimeAsync(1_001)
        return { ...s, hangups, summary: await call }
      })()
      expect(capped.sent).toEqual([{ type: 'session.close', event_id: 'dial8_1' }])
      expect(capped.summary.closed).toBe('max_duration')
      expect(capped.hangups).toEqual(['live_2'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts an error event and ignores what it can’t read', async () => {
    const { emit, call } = await startCall(async () => ({ kind: 'quiet', outcome: 'quiet' }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    emit({ type: 'error', error: { type: 'invalid_request_error', code: 'unknown_delegation' } })
    emit({ type: 'session.delegation.created', delegation: {} })
    emit({ type: 'session.closed', reason: 'remote_hangup' })
    const summary = await call
    expect(summary).toMatchObject({ errors: 1, handoffs: 0 })
    expect(warn.mock.calls[0][0]).toContain('error=unknown_delegation')
    warn.mockRestore()
  })
})

describe('speakable', () => {
  it('drops markdown, list marks and URLs, keeping the words', () => {
    expect(speakable('## Today\n- **Standup** at 9:30\n- `Review` with Ken\nSee https://dial8.ai/x for more.')).toBe('Today Standup at 9:30 Review with Ken See for more.')
    expect(speakable('Plain words stay: 3 o’clock, $600.')).toBe('Plain words stay: 3 o’clock, $600.')
  })
})

describe('commentaryChunks', () => {
  it('splits at sentence ends under the cap, and cuts a sentence past it', () => {
    expect(commentaryChunks('One. Two! Three?', 10)).toEqual(['One. Two!', 'Three?'])
    expect(commentaryChunks('abcdefghijklmnopqrstuvwxyz', 10)).toEqual(['abcdefghij', 'klmnopqrst', 'uvwxyz'])
    expect(commentaryChunks('Short answer.')).toEqual(['Short answer.'])
    expect(commentaryChunks('')).toEqual([])
  })
})
