import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { LiveSocket } from '@/lib/calls/live-bridge'

vi.mock('@/lib/eve/utility/run-utility', () => ({ runUtilityTask: vi.fn() }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: vi.fn() }))
vi.mock('@/lib/chat/home-message-writer', () => ({ appendHomeMessage: vi.fn() }))
vi.mock('@/lib/reach/route', () => ({ requestRoute: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

const { runMeetingCall, meetingEndOf, OBJECTION_GOODBYE_MS } = await import('@/lib/meeting-agent/bridge')
const { meetingAnnouncement, objectionGoodbye } = await import('@/lib/meeting-agent/session')
const { attendanceOfRow } = await import('@/lib/meeting-agent/store')
const { attendanceRow } = await import('./fake-db')

const attendance = attendanceOfRow(attendanceRow({ status: 'in_meeting' }) as never)
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function fakeSocket() {
  let onMessage: (text: string) => void = () => {}
  let onClose: () => void = () => {}
  const sent: Array<Record<string, unknown>> = []
  const socket: LiveSocket = { send: (d) => sent.push(JSON.parse(d)), close: vi.fn(), onMessage: (fn) => (onMessage = fn), onClose: (fn) => (onClose = fn) }
  return { socket, sent, emit: (e: unknown) => onMessage(JSON.stringify(e)), drop: () => onClose() }
}

function start(over: Record<string, unknown> = {}) {
  const s = fakeSocket()
  const timers: Array<() => void> = []
  const stamps: string[] = []
  const asks: unknown[] = []
  const finish = vi.fn(async () => ({ captureId: 'cap-1' }))
  const hangups: string[] = []
  const call = runMeetingCall(
    { sessionId: 'live_m1', attendance, apiKey: 'sk-test' },
    {
      supabase: {} as SupabaseClient,
      liveDeps: {
        connect: async () => s.socket,
        hangUp: async (id) => {
          hangups.push(id)
        },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms > 0 ? 50 : 0)),
        settleMs: 0,
        settleMaxMs: 0,
      },
      stamp: (async (_svc: unknown, _id: string, col: string) => {
        stamps.push(col)
      }) as never,
      ask: (async (_svc: unknown, args: unknown) => {
        asks.push(args)
        return true
      }) as never,
      finish: finish as never,
      setTimer: (fn) => timers.push(fn),
      maxMs: 60_000,
      ...over,
    },
  )
  return { ...s, call, timers, stamps, asks, finish, hangups }
}

describe('a meeting call', () => {
  it('opens with the announcement, sent by the bridge itself', async () => {
    const c = start({ turn: vi.fn() })
    await flush()
    expect(c.sent[0]).toMatchObject({ type: 'session.commentary.append', delegation_id: null, content: meetingAnnouncement('Sam') })
    c.emit({ type: 'session.closed', reason: 'remote_hangup' })
    await c.call
  })

  it('answers a hand-off from the brief, never as a home turn, and keeps every word for the notes', async () => {
    const turn = vi.fn(async () => ({ kind: 'answer' as const, say: 'Sam can start in January.' }))
    const c = start({ turn })
    await flush()
    c.emit({ type: 'session.input_transcript.delta', delta: "When can Sam's team start?", start_ms: 0, end_ms: 900 })
    c.emit({ type: 'session.delegation.created', offset_ms: 950, delegation: { id: 'del_1' } })
    await flush()
    await flush()
    expect(c.sent.at(-1)).toMatchObject({ type: 'session.commentary.append', delegation_id: 'del_1', content: 'Sam can start in January.' })
    c.emit({ type: 'session.output_transcript.delta', delta: 'Sam can start in January.', start_ms: 1500, end_ms: 2500 })
    c.emit({ type: 'session.closed', reason: 'remote_hangup' })
    const out = await c.call
    expect(out.end).toBe('ended')
    expect((turn.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1]).toMatchObject({ attendance, delegationId: 'del_1', words: "When can Sam's team start?" })
    const notes = (c.finish.mock.calls[0] as unknown as [unknown, { notes: { transcript(): string }; end: string }])[1]
    expect(notes.end).toBe('ended')
    expect(notes.notes.transcript()).toBe("[Meeting] When can Sam's team start?\n[Sam's assistant (AI)] Sam can start in January.")
    expect(c.stamps).toContain('announced_at')
  })

  it('a check says it will check, and puts the question to the person alongside', async () => {
    const c = start({ turn: vi.fn(async () => ({ kind: 'check' as const, say: "I'll check with Sam.", question: 'Can we start Monday?' })) })
    await flush()
    c.emit({ type: 'session.input_transcript.delta', delta: 'Can we start Monday?', start_ms: 0, end_ms: 900 })
    c.emit({ type: 'session.delegation.created', offset_ms: 950, delegation: { id: 'del_2' } })
    await flush()
    await flush()
    expect(c.sent.at(-1)).toMatchObject({ delegation_id: 'del_2', content: "I'll check with Sam." })
    c.emit({ type: 'session.closed', reason: 'remote_hangup' })
    await c.call
    expect(c.asks).toEqual([{ attendance, delegationId: 'del_2', question: 'Can we start Monday?' }])
  })

  it("leaves on an objection it hears itself, whatever GPT-Live does: goodbye, then the call is closed and hung up", async () => {
    const turn = vi.fn()
    const c = start({ turn })
    await flush()
    c.emit({ type: 'session.input_transcript.delta', delta: "Sorry, I don't consent to", start_ms: 0, end_ms: 500 })
    c.emit({ type: 'session.input_transcript.delta', delta: ' being recorded.', start_ms: 500, end_ms: 900 })
    expect(c.sent.at(-1)).toMatchObject({ type: 'session.commentary.append', delegation_id: null, content: objectionGoodbye('Sam') })
    expect(c.stamps).toContain('objected_at')
    expect(c.timers).toHaveLength(1)
    c.timers[0]()
    expect(c.sent.at(-1)).toMatchObject({ type: 'session.close' })
    const out = await c.call
    expect(out.end).toBe('objected')
    expect(c.hangups).toEqual(['live_m1'])
    expect(turn).not.toHaveBeenCalled()
    expect(OBJECTION_GOODBYE_MS).toBeGreaterThan(3_000)
  })

  it('an objection the model hands over is a goodbye too, and nothing more is answered', async () => {
    const turn = vi.fn(async () => ({ kind: 'objection' as const, say: 'Of course, goodbye.' }))
    const c = start({ turn })
    await flush()
    c.emit({ type: 'session.input_transcript.delta', delta: 'We would rather keep this one private.', start_ms: 0, end_ms: 900 })
    c.emit({ type: 'session.delegation.created', offset_ms: 950, delegation: { id: 'del_3' } })
    await flush()
    await flush()
    expect(c.sent.at(-1)).toMatchObject({ delegation_id: 'del_3', content: 'Of course, goodbye.' })
    c.emit({ type: 'session.input_transcript.delta', delta: 'One more thing?', start_ms: 1000, end_ms: 1500 })
    c.emit({ type: 'session.delegation.created', offset_ms: 1600, delegation: { id: 'del_4' } })
    await flush()
    await flush()
    expect(turn).toHaveBeenCalledTimes(1)
    c.emit({ type: 'session.closed', reason: 'remote_hangup' })
    expect((await c.call).end).toBe('objected')
  })

  it('names how it ended', () => {
    expect(meetingEndOf({ closed: 'max_duration' }, false)).toBe('cut')
    expect(meetingEndOf({ closed: 'max_duration' }, true)).toBe('objected')
    expect(meetingEndOf({ closed: 'remote_hangup' }, false)).toBe('ended')
  })
})
