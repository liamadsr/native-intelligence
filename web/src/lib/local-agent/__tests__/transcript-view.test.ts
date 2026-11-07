import { describe, it, expect } from 'vitest'
import type { LocalAgentEvent, LocalAgentEventEnvelope } from '@/lib/tauri-bridge'
import {
  IDLE_REASON,
  LOOP_EXPIRED_REASON,
  appendSent,
  applyEnvelopes,
  applyStoredEvents,
  canMessageSession,
  canResumeJob,
  canStopSession,
  emptySessionTranscript,
  emptyTranscript,
  isJobLive,
  localAgentSessionIdOf,
  prependStoredEvents,
  RECENT_IDS,
  sessionEndedText,
  sessionStatusText,
  toolLine,
  truncate,
  type SessionTranscript,
  type StoredEventLike,
  type Transcript,
} from '../transcript-view'
import { EXPIRED_REASON } from '../ledger'

/**
 * The local agent's transcript fold, moved from the L0 dev page
 * (src/app/dev/local-agent/transcript.ts) for the Agents panel (contract G):
 * the dev page's envelopes by seq, and a whole session's stored events by id.
 */

let seq = 0
function env(event: LocalAgentEvent, at?: number, jobId = 'j1'): LocalAgentEventEnvelope {
  return { jobId, seq: at ?? ++seq, event }
}

function fold(events: LocalAgentEventEnvelope[], t: Transcript = emptyTranscript('j1')): Transcript {
  return applyEnvelopes(t, events)
}

describe('transcript fold', () => {
  it('merges text deltas into one open assistant item, closed by message', () => {
    seq = 0
    const t = fold([
      env({ kind: 'status', status: 'running' }),
      env({ kind: 'text', delta: 'Hel' }),
      env({ kind: 'text', delta: 'lo ' }),
      env({ kind: 'text', delta: 'there' }),
    ])
    expect(t.items.filter((i) => i.type === 'assistant')).toEqual([
      { type: 'assistant', key: 's2', text: 'Hello there', open: true },
    ])
    const done = applyEnvelopes(t, [env({ kind: 'message', text: 'Hello there.' })])
    expect(done.items.at(-1)).toEqual({ type: 'assistant', key: 's2', text: 'Hello there.', open: false })
    expect(done.lastSeq).toBe(5)
  })

  it('deltas spread over batches merge the same way', () => {
    seq = 0
    let t = emptyTranscript('j1')
    for (const d of ['a', 'b', 'c']) t = applyEnvelopes(t, [env({ kind: 'text', delta: d })])
    expect(t.items).toEqual([{ type: 'assistant', key: 's1', text: 'abc', open: true }])
  })

  it('a tool call between deltas starts a new segment; message then closes both', () => {
    seq = 0
    const t = fold([
      env({ kind: 'text', delta: 'Looking.' }),
      env({ kind: 'tool', callId: 'c1', name: 'bash', input: '{"command":"ls"}' }),
      env({ kind: 'text', delta: 'Found 3.' }),
      env({ kind: 'message', text: 'Looking.Found 3.' }),
    ])
    expect(t.items.map((i) => i.type)).toEqual(['assistant', 'tool', 'assistant'])
    expect(t.items.every((i) => i.type !== 'assistant' || !i.open)).toBe(true)
    expect(t.items[2]).toMatchObject({ text: 'Found 3.' })
  })

  it('a message without deltas is its own item, but not a second copy after a status closed it', () => {
    seq = 0
    const t = fold([env({ kind: 'message', text: 'Whole reply.' })])
    expect(t.items).toEqual([{ type: 'assistant', key: 's1', text: 'Whole reply.', open: false }])
    const u = fold([
      env({ kind: 'text', delta: 'Reply.' }),
      env({ kind: 'status', status: 'waiting' }),
      env({ kind: 'message', text: 'Reply.' }),
    ])
    expect(u.items.filter((i) => i.type === 'assistant')).toHaveLength(1)
  })

  it('dedupes by seq across backfill and live, in any order', () => {
    const backfill = [
      env({ kind: 'status', status: 'running' }, 1),
      env({ kind: 'text', delta: 'one ' }, 2),
      env({ kind: 'text', delta: 'two ' }, 3),
    ]
    const live = [env({ kind: 'text', delta: 'two ' }, 3), env({ kind: 'text', delta: 'three' }, 4)]
    const expected = fold([...backfill, env({ kind: 'text', delta: 'three' }, 4)])
    // Live landing in the same batch as the backfill, overlapping and reversed.
    expect(fold([...live, ...backfill].reverse()).items).toEqual(expected.items)
    // Live arriving again after: nothing changes, same object back.
    const again = applyEnvelopes(expected, live)
    expect(again).toBe(expected)
    expect(expected.items.find((i) => i.type === 'assistant')).toMatchObject({ text: 'one two three' })
  })

  it('drops other jobs’ envelopes', () => {
    const t = fold([env({ kind: 'text', delta: 'mine' }, 1), env({ kind: 'text', delta: 'theirs' }, 2, 'j2')])
    expect(t.items).toEqual([{ type: 'assistant', key: 's1', text: 'mine', open: true }])
    expect(t.lastSeq).toBe(1)
  })

  it('pairs a tool_result with its call by callId', () => {
    const t = fold([
      env({ kind: 'tool', callId: 'c1', name: 'bash', input: '{"command":"cat ../sibling/secret.txt"}' }, 1),
      env({ kind: 'tool', callId: 'c2', name: 'read_file', input: '{"path":"README.md"}' }, 2),
      env({ kind: 'tool_result', callId: 'c1', name: 'bash', ok: false, output: 'Operation not permitted' }, 3),
      env({ kind: 'tool_result', callId: 'c2', name: 'read_file', ok: true, output: '# Fixture' }, 4),
    ])
    expect(t.items).toEqual([
      {
        type: 'tool',
        key: 's1',
        callId: 'c1',
        name: 'bash',
        input: '{"command":"cat ../sibling/secret.txt"}',
        result: { ok: false, output: 'Operation not permitted' },
      },
      {
        type: 'tool',
        key: 's2',
        callId: 'c2',
        name: 'read_file',
        input: '{"path":"README.md"}',
        result: { ok: true, output: '# Fixture' },
      },
    ])
  })

  it('a result whose call fell out of the ring still shows', () => {
    const t = fold([env({ kind: 'tool_result', callId: 'c9', name: 'bash', ok: true, output: 'ok' }, 7)])
    expect(t.items).toEqual([
      { type: 'tool', key: 's7', callId: 'c9', name: 'bash', input: '', result: { ok: true, output: 'ok' } },
    ])
  })

  it('replaces only the items it touched', () => {
    const t = fold([
      env({ kind: 'report', text: 'Listing files' }, 1),
      env({ kind: 'tool', callId: 'c1', name: 'bash', input: 'ls' }, 2),
      env({ kind: 'text', delta: 'a' }, 3),
    ])
    const u = applyEnvelopes(t, [env({ kind: 'text', delta: 'b' }, 4)])
    expect(u.items).not.toBe(t.items)
    expect(u.items[0]).toBe(t.items[0])
    expect(u.items[1]).toBe(t.items[1])
    expect(u.items[2]).not.toBe(t.items[2])
  })

  it('report / ask / finish / error become highlight items', () => {
    const t = fold([
      env({ kind: 'report', text: 'Read README' }, 1),
      env({ kind: 'ask', question: 'Which folder?' }, 2),
      env({ kind: 'finish', summary: 'Writes and network were blocked.' }, 3),
      env({ kind: 'error', message: 'model 401' }, 4),
    ])
    expect(t.items).toEqual([
      { type: 'report', key: 's1', text: 'Read README' },
      { type: 'ask', key: 's2', text: 'Which folder?' },
      { type: 'finish', key: 's3', text: 'Writes and network were blocked.' },
      { type: 'error', key: 's4', text: 'model 401' },
    ])
  })

  it('status: repeated ones collapse, a turn end closes open text, a reason always shows', () => {
    const t = fold([
      env({ kind: 'status', status: 'running' }, 1),
      env({ kind: 'status', status: 'running' }, 2),
      env({ kind: 'text', delta: 'partial' }, 3),
      env({ kind: 'status', status: 'interrupted', reason: 'launcher exited (signal 9)' }, 4),
    ])
    expect(t.status).toBe('interrupted')
    expect(t.items).toEqual([
      { type: 'status', key: 's1', status: 'running', reason: null },
      { type: 'assistant', key: 's3', text: 'partial', open: false },
      { type: 'status', key: 's4', status: 'interrupted', reason: 'launcher exited (signal 9)' },
    ])
  })

  it('a sent message sits where it was sent and splits the stream', () => {
    let t = fold([env({ kind: 'text', delta: 'Working' }, 1)])
    t = appendSent(t, 'also check auth', 'steer')
    t = applyEnvelopes(t, [env({ kind: 'text', delta: 'On it.' }, 2)])
    expect(t.items).toEqual([
      { type: 'assistant', key: 's1', text: 'Working', open: true },
      { type: 'sent', key: 'sent-0', text: 'also check auth', policy: 'steer' },
      { type: 'assistant', key: 's2', text: 'On it.', open: true },
    ])
    expect(appendSent(t, 'again', 'queue').items.at(-1)).toMatchObject({ key: 'sent-1', policy: 'queue' })
  })
})

describe('job helpers', () => {
  it('truncate', () => {
    expect(truncate('short', 10)).toBe('short')
    expect(truncate('0123456789abc', 10)).toBe('012345678…')
  })

  it('isJobLive goes by live, not status: a launcher can outlive a failed status', () => {
    expect(isJobLive({ live: true })).toBe(true)
    expect(isJobLive({ live: false })).toBe(false)
  })

  it('canResumeJob: no launcher and a session, whatever the status', () => {
    expect(canResumeJob({ live: false, sessionId: 's' })).toBe(true)
    expect(canResumeJob({ live: false, sessionId: null })).toBe(false)
    expect(canResumeJob({ live: true, sessionId: 's' })).toBe(false)
  })
})

// ── The Agents panel: a session's stored events ────────────────────────────

const SID = '11111111-2222-4333-8444-555555555555'

/** A stored event; the server writes `inbound` (and delivery errors), the device the rest. */
function ev(id: number, kind: string, payload: Record<string, unknown> = {}, source?: 'device' | 'server'): StoredEventLike {
  return { id, kind, payload, source: source ?? (kind === 'inbound' ? 'server' : 'device') }
}

function session(events: StoredEventLike[], t: SessionTranscript = emptySessionTranscript(SID)): SessionTranscript {
  return applyStoredEvents(t, events)
}

describe('session fold (stored events)', () => {
  it('folds device events and the server inbound messages in id order, across turns', () => {
    const t = session([
      ev(10, 'status', { kind: 'status', status: 'running' }),
      ev(11, 'text', { kind: 'text', delta: 'Looking at ' }),
      ev(12, 'text', { kind: 'text', delta: 'the repo.' }),
      ev(13, 'message', { kind: 'message', text: 'Looking at the repo.' }),
      ev(14, 'finish', { kind: 'finish', summary: 'It is a Next.js app.' }),
      ev(15, 'status', { kind: 'status', status: 'waiting' }),
      ev(16, 'inbound', { author: 'person', text: 'Now check the tests', policy: 'queue', messageId: 'm1' }),
      ev(17, 'status', { kind: 'status', status: 'running' }),
      ev(18, 'text', { kind: 'text', delta: 'Running them.' }),
    ])
    expect(t.lastId).toBe(18)
    expect(t.status).toBe('running')
    expect(t.items.map((i) => i.type)).toEqual(['status', 'assistant', 'finish', 'status', 'inbound', 'status', 'assistant'])
    expect(t.items[1]).toEqual({ type: 'assistant', key: 'e11', text: 'Looking at the repo.', open: false })
    expect(t.items[4]).toEqual({ type: 'inbound', key: 'e16', author: 'person', text: 'Now check the tests', policy: 'queue' })
    expect(t.items[6]).toMatchObject({ type: 'assistant', text: 'Running them.', open: true })
  })

  it('labels the Dial8 agent and the person apart, and a steer splits the stream', () => {
    const t = session([
      ev(1, 'text', { delta: 'Reading' }),
      ev(2, 'inbound', { author: 'agent', text: 'Focus on auth', policy: 'steer' }),
      ev(3, 'text', { delta: 'Auth it is.' }),
    ])
    expect(t.items).toEqual([
      { type: 'assistant', key: 'e1', text: 'Reading', open: true },
      { type: 'inbound', key: 'e2', author: 'agent', text: 'Focus on auth', policy: 'steer' },
      { type: 'assistant', key: 'e3', text: 'Auth it is.', open: true },
    ])
  })

  it('repeats (a page and realtime overlapping) change nothing, and return the same transcript', () => {
    const t = session([ev(1, 'text', { delta: 'a' }), ev(2, 'text', { delta: 'b' })])
    expect(applyStoredEvents(t, [ev(1, 'text', { delta: 'a' }), ev(2, 'text', { delta: 'b' })])).toBe(t)
    const again = applyStoredEvents(t, [ev(2, 'text', { delta: 'b' }), ev(3, 'text', { delta: 'c' }), ev(3, 'text', { delta: 'c' })])
    expect(again.items).toEqual([{ type: 'assistant', key: 'e1', text: 'abc', open: true }])
    expect(again.lastId).toBe(3)
  })

  it('a late id (committed after a higher one) folds nothing and marks it stale, to be read again', () => {
    const t = session([ev(1, 'text', { delta: 'one ' }), ev(3, 'text', { delta: 'three' })])
    const late = applyStoredEvents(t, [ev(2, 'inbound', { author: 'person', text: 'hi', policy: 'steer' }), ev(4, 'text', { delta: '!' })])
    expect(late.stale).toBe(true)
    expect(late.items).toBe(t.items)
    expect(late.lastId).toBe(3)
    // Read again in the server's order, it is in its place.
    const again = session([
      ev(1, 'text', { delta: 'one ' }),
      ev(2, 'inbound', { author: 'person', text: 'hi', policy: 'steer' }),
      ev(3, 'text', { delta: 'three' }),
    ])
    expect(again.stale).toBe(false)
    expect(again.items.map((i) => i.type)).toEqual(['assistant', 'inbound', 'assistant'])
  })

  it('keeps no raw events: only the newest ids, to tell repeats from late commits', () => {
    const many = Array.from({ length: RECENT_IDS + 50 }, (_, i) => ev(i + 1, 'text', { delta: 'x' }))
    const t = session(many)
    expect(t).not.toHaveProperty('events')
    expect(t.recentIds).toHaveLength(RECENT_IDS)
    expect(t.recentIds[0]).toBe(51)
    expect(t.firstId).toBe(1)
    // A repeat older than the recent ids is a repeat, not a late commit.
    expect(applyStoredEvents(t, [ev(3, 'text', { delta: 'x' })])).toBe(t)
  })

  it('S4: an inbound row folds only from the server, never a device’s or one that doesn’t say', () => {
    const t = session([
      ev(1, 'inbound', { author: 'agent', text: 'from a device', policy: 'steer' }, 'device'),
      { id: 2, kind: 'inbound', payload: { author: 'person', text: 'no source', policy: 'steer' } },
      ev(3, 'inbound', { author: 'person', text: 'real', policy: 'steer' }, 'server'),
    ])
    expect(t.items).toEqual([{ type: 'inbound', key: 'e3', author: 'person', text: 'real', policy: 'steer' }])
  })

  it('a server error naming a message is an undelivered row; a device error stays an error', () => {
    const t = session([
      ev(1, 'inbound', { author: 'person', text: 'check auth', policy: 'steer', messageId: 'm1' }),
      ev(2, 'error', { message: 'the Mac app is not running this job', messageId: 'm1' }, 'server'),
      ev(3, 'error', { message: 'model 401', messageId: 'm9' }, 'device'),
    ])
    expect(t.items.slice(1)).toEqual([
      { type: 'undelivered', key: 'e2', messageId: 'm1', reason: 'the Mac app is not running this job' },
      { type: 'error', key: 'e3', text: 'model 401' },
    ])
  })
})

describe('older pages (prependStoredEvents)', () => {
  it('puts an older page in front, keeping the held items’ objects', () => {
    const t = session([ev(10, 'inbound', { author: 'person', text: 'next', policy: 'queue' }), ev(11, 'text', { delta: 'ok' })])
    const older = prependStoredEvents(t, [ev(1, 'text', { delta: 'Earlier.' }), ev(2, 'message', { text: 'Earlier.' }), ev(3, 'finish', { summary: 'Done' })])
    expect(older.items.map((i) => i.type)).toEqual(['assistant', 'finish', 'inbound', 'assistant'])
    expect(older.items[2]).toBe(t.items[0])
    expect(older.firstId).toBe(1)
    expect(older.lastId).toBe(11)
    // Ids it already holds are skipped.
    expect(prependStoredEvents(older, [ev(10, 'text', { delta: 'dup' })])).toBe(older)
  })

  it('stitches a page boundary: a call takes back its result, split text joins, a repeated status goes', () => {
    const t = session([
      ev(5, 'status', { status: 'running' }),
      ev(6, 'text', { delta: ' world' }),
      ev(7, 'tool_result', { callId: 'c1', name: 'bash', ok: true, output: 'files' }),
    ])
    const older = prependStoredEvents(t, [
      ev(1, 'status', { status: 'running' }),
      ev(2, 'tool', { callId: 'c1', name: 'bash', input: '{"command":"ls"}' }),
      ev(3, 'text', { delta: 'Hello' }),
    ])
    expect(older.items).toEqual([
      { type: 'status', key: 'e1', status: 'running', reason: null },
      { type: 'tool', key: 'e2', callId: 'c1', name: 'bash', input: '{"command":"ls"}', result: { ok: true, output: 'files' } },
      { type: 'assistant', key: 'e6', text: 'Hello world', open: true },
    ])
  })

  it('a whole message on the newer side replaces the older side’s deltas', () => {
    const t = session([ev(4, 'message', { text: 'Hello world.' })])
    const older = prependStoredEvents(t, [ev(1, 'text', { delta: 'Hello' }), ev(2, 'text', { delta: ' wor' })])
    expect(older.items).toEqual([{ type: 'assistant', key: 'e4', text: 'Hello world.', open: false }])
  })

  it('an unchanged row keeps its object, so a memoized row does not re-render', () => {
    const t = session([ev(1, 'inbound', { author: 'agent', text: 'Look around', policy: 'steer' }), ev(2, 'text', { delta: 'x' })])
    const next = applyStoredEvents(t, [ev(3, 'text', { delta: 'y' })])
    expect(next.items[0]).toBe(t.items[0])
    expect(next.items[1]).not.toBe(t.items[1])
  })

  it('tool calls take their result by callId; the branch card and highlights fold in', () => {
    const t = session([
      ev(1, 'tool', { callId: 'c1', name: 'read_file', input: '{"path":"src/app/page.tsx"}' }),
      ev(2, 'tool_result', { callId: 'c1', name: 'read_file', ok: true, output: 'export default…' }),
      ev(3, 'ask', { question: 'Which branch?' }),
      ev(4, 'report', { text: 'Half way' }),
      ev(5, 'branch', { branch: 'dial8/site-ab12', commit: 'abcdef1234', filesChanged: 3, insertions: 10, deletions: 2 }),
    ])
    expect(t.items).toEqual([
      {
        type: 'tool',
        key: 'e1',
        callId: 'c1',
        name: 'read_file',
        input: '{"path":"src/app/page.tsx"}',
        result: { ok: true, output: 'export default…' },
      },
      { type: 'ask', key: 'e3', text: 'Which branch?' },
      { type: 'report', key: 'e4', text: 'Half way' },
      { type: 'branch', key: 'e5', name: 'dial8/site-ab12', commit: 'abcdef1234', filesChanged: 3, insertions: 10, deletions: 2 },
    ])
  })

  it('skips what it cannot show: unknown kinds, bad ids, a status it does not know, an empty inbound', () => {
    const t = session([
      ev(1, 'heartbeat', {}),
      { id: Number.NaN, kind: 'text', payload: { delta: 'x' } },
      { id: -4, kind: 'text', payload: { delta: 'x' } },
      ev(2, 'status', { status: 'exploded' }),
      ev(3, 'inbound', { author: 'person', text: '' }),
      ev(4, 'tool', { name: 'bash' }),
    ])
    expect(t.items).toEqual([])
    expect(t.lastId).toBe(4)
  })
})

describe('session helpers', () => {
  it('localAgentSessionIdOf: a local_agent row naming a uuid session', () => {
    expect(localAgentSessionIdOf({ kind: 'local_agent', source: { local_agent_session_id: SID } })).toBe(SID)
    expect(localAgentSessionIdOf({ kind: 'local_agent', source: { local_agent_session_id: 'nope' } })).toBeNull()
    expect(localAgentSessionIdOf({ kind: 'local_agent', source: null })).toBeNull()
    expect(localAgentSessionIdOf({ kind: 'work_run', source: { local_agent_session_id: SID } })).toBeNull()
  })

  it('messaging and Stop: anything but an ended session (idle and interrupted included)', () => {
    for (const s of ['queued', 'starting', 'running', 'waiting', 'interrupted'] as const) {
      expect(canMessageSession(s)).toBe(true)
      expect(canStopSession(s)).toBe(true)
    }
    for (const s of ['cancelled', 'failed', 'expired'] as const) {
      expect(canMessageSession(s)).toBe(false)
      expect(canStopSession(s)).toBe(false)
    }
  })

  it('status text says when it asks', () => {
    expect(sessionEndedText('expired', IDLE_REASON)).toBe('It sat idle for 24 hours, so it ended.')
    expect(sessionEndedText('expired', EXPIRED_REASON)).toBe('Your Mac didn’t pick this up in time.')
    expect(sessionEndedText('expired', LOOP_EXPIRED_REASON)).toBe('Your Mac didn’t pick this up within 15 minutes.')
    expect(sessionEndedText('failed', 'boom')).toBe('This local agent failed.')
    expect(sessionEndedText('cancelled', null)).toBe('This local agent was stopped.')
    expect(sessionEndedText('cancelled', 'Another chat started Dial8 in this folder.')).toBe('It ended: Another chat started Dial8 in this folder.')
    expect(sessionStatusText('waiting', 'ask')).toBe('Has a question')
    expect(sessionStatusText('waiting', 'finish')).toMatch(/Idle/)
    expect(sessionStatusText('queued', null)).toBe('Waiting for your Mac')
  })

  it('toolLine: a verb and the path or command, else the name', () => {
    expect(toolLine('read_file', '{"path":"src/app/page.tsx"}')).toBe('Reading src/app/page.tsx')
    expect(toolLine('bash', '{"command":"git   status"}')).toBe('Running git status')
    expect(toolLine('report', '{"text":"x"}')).toBe('report')
    expect(toolLine('bash', '{"command":')).toBe('Running')
  })
})

describe('the teammate plan in the thread', () => {
  const stored = (events: Array<[string, Record<string, unknown>, ('device' | 'server')?]>): SessionTranscript =>
    applyStoredEvents(
      emptySessionTranscript('s'),
      events.map(([kind, payload, source], i) => ({ id: i + 1, kind, payload, source: source ?? 'device' })),
    )

  it('shows the teammate tools as the server’s ask and report, never again as tool calls', () => {
    const t = stored([
      ['tool', { callId: 'c1', name: 'message_teammate', input: '{"text":"Which branch?"}' }],
      ['tool_result', { callId: 'c1', name: 'message_teammate', ok: true, output: '{}' }],
      ['ask', { question: 'Which branch?', via: 'message_teammate', key: 'k' }, 'server'],
      ['report', { text: 'Reading tests', via: 'report_to_person', key: 'k2' }, 'server'],
      ['ask', { question: 'Old-style question' }],
      ['tool', { callId: 'c2', name: 'read_file', input: '{}' }],
    ])
    expect(t.items.map((i) => i.type)).toEqual(['ask', 'report', 'ask', 'tool'])
    expect(t.items[0]).toMatchObject({ type: 'ask', text: 'Which branch?', teammate: true })
    expect(t.items[1]).toMatchObject({ type: 'report', teammate: true })
    expect(t.items[2]).not.toHaveProperty('teammate')
  })

  it('folds a native question on the Mac into one line that follows its answer', () => {
    const t = stored([
      ['prompt', { id: 'p-1', prompt: 'push', state: 'asking' }],
      ['text', { delta: 'Waiting on you.' }],
      ['prompt', { id: 'p-1', prompt: 'push', state: 'allowed' }],
      ['prompt', { id: 'p-2', prompt: 'fence', state: 'refused', why: 'it holds credentials' }],
      ['prompt', { id: 'p-3', prompt: 'other', state: 'asking' }],
      ['prompt', { id: 'p-4', prompt: 'push', state: 'maybe' }],
    ])
    const prompts = t.items.filter((i) => i.type === 'prompt')
    expect(prompts).toEqual([
      { type: 'prompt', key: 'e1', id: 'p-1', prompt: 'push', state: 'allowed', why: null },
      { type: 'prompt', key: 'e4', id: 'p-2', prompt: 'fence', state: 'refused', why: 'it holds credentials' },
    ])
    // It stays where it was asked, before the text that followed.
    expect(t.items[0].type).toBe('prompt')
  })

  it('reads the pull request event: a link only for a real pull request URL', () => {
    const t = stored([
      ['pull_request', { ok: true, branch: 'dial8/x-1', url: 'https://github.com/o/r/pull/12', via: 'server' }],
      ['pull_request', { ok: false, branch: 'dial8/x-1', pushed: false, error: 'rejected' }],
      ['pull_request', { ok: false, branch: 'dial8/x-1', pushed: null, error: 'Dial8 quit' }],
      ['pull_request', { ok: true, branch: 'dial8/x-1', url: 'javascript:alert(1)' }],
    ])
    expect(t.items).toEqual([
      { type: 'pull_request', key: 'e1', ok: true, url: 'https://github.com/o/r/pull/12', branch: 'dial8/x-1', via: 'server', pushed: true, error: null },
      { type: 'pull_request', key: 'e2', ok: false, url: null, branch: 'dial8/x-1', via: null, pushed: false, error: 'rejected' },
      { type: 'pull_request', key: 'e3', ok: false, url: null, branch: 'dial8/x-1', via: null, pushed: null, error: 'Dial8 quit' },
      { type: 'pull_request', key: 'e4', ok: false, url: null, branch: 'dial8/x-1', via: null, pushed: null, error: null },
    ])
  })
})
