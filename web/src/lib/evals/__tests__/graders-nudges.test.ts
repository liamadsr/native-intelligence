/**
 * The deterministic nudge checks (dimension `nudges`): the quiet-by-default
 * sidekick graded free over the driver's own nudge log.
 *
 * Positions are chunk indices: a nudge sits on the flush (or record turn) that
 * drained it, whose `index` is the chunk.
 */
import { describe, expect, it } from 'vitest'
import {
  firstOtherSpeakerChunk,
  gradeDeterministic,
  gradeNudges,
  nudgeLatencies,
  nudgeLogGap,
  placedNudges,
} from '../graders/deterministic'
import type { EvalTrace, FlushRecord, FrozenChunk, ScriptSegment, TraceNudge } from '../types'

let nudgeSeq = 0
function nudge(message: string): TraceNudge {
  nudgeSeq += 1
  return { id: `n${nudgeSeq}`, kind: 'insight', message, ts: nudgeSeq }
}

function flush(index: number, overrides: Partial<FlushRecord> = {}): FlushRecord {
  return {
    index,
    t_ms: index * 10_000,
    chars: 40,
    chunk_text: `[remote_1]: line ${index}`,
    response: { tool_calls: 0, tool_call_details: [], duration_ms: 900 },
    nudges: [],
    ...overrides,
  }
}

function trace(flushes: FlushRecord[], overrides: Partial<EvalTrace> = {}): EvalTrace {
  return {
    mode: 'live',
    speed: 'instant',
    driver: 'server',
    flushes,
    proposals_final: [],
    summary_final: null,
    summary_source: 'none',
    title_final: null,
    commitments: [],
    reads: [],
    usage: { tokens_in: 0, tokens_out: 0, cost_usd: 0, model: 'x' },
    ...overrides,
  }
}

const sayCall = { tool: 'say_to_user', args: { message: 'x' } }

/** Five chunks; a nudge on chunks 1 and 3. */
function fiveChunks(): EvalTrace {
  return trace([
    flush(0),
    flush(1, { nudges: [nudge('Ask about the budget.')], response: { tool_calls: 1, tool_call_details: [sayCall], duration_ms: 900 } }),
    flush(2),
    flush(3, { nudges: [nudge('Dana owns the security review.')], response: { tool_calls: 1, tool_call_details: [sayCall], duration_ms: 900 } }),
    flush(4),
  ])
}

const byKey = (checks: ReturnType<typeof gradeNudges>, key: string) => checks.find((c) => c.check_key === key)

describe('placedNudges', () => {
  it('places each nudge on the chunk its flush carried, record turns marked', () => {
    const t = trace([
      flush(0, { nudges: [nudge('a')] }),
      flush(0, { record_only: true, chunk_text: '', nudges: [nudge('b')] }),
      flush(2, { nudges: [nudge('c'), nudge('d')] }),
    ])
    expect(placedNudges(t).map((n) => [n.chunk, n.message, n.record_only ?? false])).toEqual([
      [0, 'a', false],
      [0, 'b', true],
      [2, 'c', false],
      [2, 'd', false],
    ])
  })
})

describe('gradeNudges — scope', () => {
  it('grades nothing on a batch trial: nudges are a live dimension', () => {
    expect(gradeNudges(trace([flush(0, { nudges: [nudge('x')] })], { mode: 'batch' }), { max_nudges: 0 })).toEqual([])
  })

  it('every check is in the nudges dimension and soft by default', () => {
    const checks = gradeNudges(fiveChunks(), {
      max_nudges: 5,
      no_nudge_windows: [{ from_chunk: 0, to_chunk: 0 }],
      nudges: [{ key: 'budget', about: 'the budget', after_chunk: 1, before_chunk: 2 }],
    })
    expect(checks.length).toBeGreaterThanOrEqual(4)
    expect(new Set(checks.map((c) => c.dimension))).toEqual(new Set(['nudges']))
    expect(checks.every((c) => c.severity === 'soft')).toBe(true)
  })

  it('gradeDeterministic includes the nudge checks, reading speakers off the context', () => {
    const { checks } = gradeDeterministic(fiveChunks(), {})
    expect(checks.some((c) => c.grader === 'nudge_count')).toBe(true)
  })
})

describe('nudge_count — reported, not a quota', () => {
  it('reports the count and the whole timeline as `unknown` when the case sets no ceiling', () => {
    const count = byKey(gradeNudges(fiveChunks(), {}), 'nudge_count')!
    expect(count.outcome).toBe('unknown')
    expect(count.score).toBe(2)
    expect(count.threshold).toBeNull()
    expect(count.evidence).toMatchObject({
      count: 2,
      say_to_user_calls: 2,
      nudges: [
        { chunk: 1, kind: 'insight', message: 'Ask about the budget.' },
        { chunk: 3, kind: 'insight', message: 'Dana owns the security review.' },
      ],
    })
  })

  it('passes at the ceiling and fails one over it', () => {
    expect(byKey(gradeNudges(fiveChunks(), { max_nudges: 2 }), 'nudge_count')!.outcome).toBe('pass')
    const over = byKey(gradeNudges(fiveChunks(), { max_nudges: 1 }), 'nudge_count')!
    expect(over.outcome).toBe('fail')
    expect(over.threshold).toBe(1)
  })

  it('a ceiling of zero passes a silent trial', () => {
    expect(byKey(gradeNudges(trace([flush(0), flush(1)]), { max_nudges: 0 }), 'nudge_count')!.outcome).toBe('pass')
  })

  it('caps a rambling nudge in the evidence', () => {
    const long = 'x'.repeat(600)
    const count = byKey(gradeNudges(trace([flush(0, { nudges: [nudge(long)] })]), {}), 'nudge_count')!
    const message = (count.evidence as { nudges: { message: string }[] }).nudges[0].message
    expect(message.length).toBe(398)
    expect(message.endsWith('…')).toBe(true)
  })
})

describe('nudge_quiet_window', () => {
  it('fails when a nudge lands inside the window, both ends inclusive', () => {
    const checks = gradeNudges(fiveChunks(), {
      no_nudge_windows: [
        { from_chunk: 3, to_chunk: 4 }, // chunk 3 is its first chunk
        { from_chunk: 0, to_chunk: 1 }, // chunk 1 is its last chunk
        { from_chunk: 4, to_chunk: 4 },
      ],
    })
    expect(byKey(checks, 'nudge_quiet_window:3-4')!.outcome).toBe('fail')
    expect(byKey(checks, 'nudge_quiet_window:0-1')!.outcome).toBe('fail')
    const clean = byKey(checks, 'nudge_quiet_window:4-4')!
    expect(clean.outcome).toBe('pass')
    expect(clean.label).toBe('Quiet during chunk 4')
  })

  it('lists only the offending nudges, and honours a gate severity', () => {
    const check = byKey(
      gradeNudges(fiveChunks(), { no_nudge_windows: [{ from_chunk: 2, to_chunk: 3, severity: 'gate' }] }),
      'nudge_quiet_window:2-3',
    )!
    expect(check.severity).toBe('gate')
    expect((check.evidence as { nudges: { chunk: number }[] }).nudges.map((n) => n.chunk)).toEqual([3])
  })

  it('reads a reversed window the right way round', () => {
    const check = byKey(gradeNudges(fiveChunks(), { no_nudge_windows: [{ from_chunk: 4, to_chunk: 2 }] }), 'nudge_quiet_window:2-4')!
    expect(check.outcome).toBe('fail')
  })

  it('counts a nudge from a record turn at the chunk it followed', () => {
    const t = trace([flush(0), flush(1), flush(1, { record_only: true, chunk_text: '', nudges: [nudge('late')] })])
    expect(byKey(gradeNudges(t, { no_nudge_windows: [{ from_chunk: 1, to_chunk: 1 }] }), 'nudge_quiet_window:1-1')!.outcome).toBe('fail')
  })
})

describe('nudge_expected', () => {
  it('passes when any nudge lands in [after_chunk, before_chunk], inclusive', () => {
    const checks = gradeNudges(fiveChunks(), {
      nudges: [
        { key: 'exact_start', about: 'the budget', after_chunk: 1, before_chunk: 2 },
        { key: 'exact_end', about: 'security', after_chunk: 2, before_chunk: 3 },
        { key: 'missed', about: 'pricing', after_chunk: 4, before_chunk: 4 },
      ],
    })
    expect(byKey(checks, 'nudge_expected:exact_start')!.outcome).toBe('pass')
    expect(byKey(checks, 'nudge_expected:exact_end')!.outcome).toBe('pass')
    expect(byKey(checks, 'nudge_expected:missed')!.outcome).toBe('fail')
  })

  it('is open-ended on a missing bound', () => {
    const checks = gradeNudges(fiveChunks(), {
      nudges: [
        { key: 'anytime', about: 'anything' },
        { key: 'late', about: 'security', after_chunk: 3 },
        { key: 'early', about: 'budget', before_chunk: 1 },
        { key: 'too_late', about: 'x', after_chunk: 4 },
      ],
    })
    expect(byKey(checks, 'nudge_expected:anytime')!.outcome).toBe('pass')
    expect(byKey(checks, 'nudge_expected:late')!.outcome).toBe('pass')
    expect(byKey(checks, 'nudge_expected:early')!.outcome).toBe('pass')
    expect(byKey(checks, 'nudge_expected:too_late')!.outcome).toBe('fail')
  })

  it('is `unknown`, not a miss, when the trial stopped before the window opened', () => {
    const short = trace([flush(0), flush(1)])
    const check = byKey(gradeNudges(short, { nudges: [{ key: 'k', about: 'x', after_chunk: 3 }] }), 'nudge_expected:k')!
    expect(check.outcome).toBe('unknown')
    expect(check.rationale).toMatch(/stopped at chunk 1/)
  })

  it('carries the case severity and the about text in its label', () => {
    const check = byKey(
      gradeNudges(fiveChunks(), { nudges: [{ key: 'k', about: 'the unanswered security question', severity: 'gate' }] }),
      'nudge_expected:k',
    )!
    expect(check.severity).toBe('gate')
    expect(check.label).toBe('Speaks up about the unanswered security question')
  })
})

describe('nudge_after_first_speaker', () => {
  const script: ScriptSegment[] = [
    { t_ms: 0, speaker: 'local_1', stream: 'mic', text: 'Hi, joining now.' },
    { t_ms: 5_000, speaker: 'local_1', stream: 'mic', text: 'Still waiting on Dana.' },
    { t_ms: 20_000, speaker: 'remote_1', stream: 'system', text: 'Sorry I am late.' },
  ]
  const chunks: FrozenChunk[] = [
    { index: 0, t_ms_start: 0, t_ms_end: 1_000, segment_indices: [0], text: '[local_1]: Hi, joining now.' },
    { index: 1, t_ms_start: 5_000, t_ms_end: 6_000, segment_indices: [1], text: '[local_1]: Still waiting on Dana.' },
    { index: 2, t_ms_start: 20_000, t_ms_end: 21_000, segment_indices: [2], text: '[remote_1]: Sorry I am late.' },
  ]
  const soloStart = (nudgeAt: number) =>
    trace(chunks.map((c) => flush(c.index, { chunk_text: c.text, nudges: c.index === nudgeAt ? [nudge('Your goal is the pilot.')] : [] })))

  it('finds the first chunk where someone other than the person spoke, from the script', () => {
    expect(firstOtherSpeakerChunk(soloStart(-1), { script, chunks })).toBe(2)
  })

  it('falls back to the flush text, where anything but local_1 is someone else', () => {
    expect(firstOtherSpeakerChunk(soloStart(-1))).toBe(2)
  })

  it('fails a nudge before anyone but the person has spoken', () => {
    const check = byKey(gradeNudges(soloStart(1), {}, { script, chunks }), 'nudge_after_first_speaker')!
    expect(check.outcome).toBe('fail')
    expect(check.evidence).toMatchObject({ first_other_speaker_chunk: 2, nudges: [{ chunk: 1 }] })
  })

  it('passes a nudge on the chunk where the other side first spoke', () => {
    expect(byKey(gradeNudges(soloStart(2), {}, { script, chunks }), 'nudge_after_first_speaker')!.outcome).toBe('pass')
  })

  it('is not emitted when the case expects an opening brief', () => {
    expect(byKey(gradeNudges(soloStart(0), { opening_brief: true }, { script, chunks }), 'nudge_after_first_speaker')).toBeUndefined()
  })

  it('is not emitted when nobody but the person ever speaks', () => {
    const solo = trace([flush(0, { chunk_text: '[local_1]: a memo to self', nudges: [nudge('x')] })])
    expect(firstOtherSpeakerChunk(solo)).toBeNull()
    expect(byKey(gradeNudges(solo, {}), 'nudge_after_first_speaker')).toBeUndefined()
  })

  it('ignores an empty label line (a wrapped utterance) as speech', () => {
    const t = trace([flush(0, { chunk_text: '[remote_1]:\n[local_1]: hello' }), flush(1, { chunk_text: '[remote_1]: hi' })])
    expect(firstOtherSpeakerChunk(t)).toBe(1)
  })
})

describe('nudgeLogGap — broadcasts against say_to_user calls', () => {
  const said = (n = 1, message: string = 'x') => ({
    tool_calls: n,
    tool_call_details: Array.from({ length: n }, () => ({ tool: 'say_to_user', args: { message } })),
    duration_ms: 900,
  })

  it('has no gap when every call arrived', () => {
    expect(nudgeLogGap(fiveChunks())).toEqual({ said: 2, received: 2, missing: 0, uncertainFromChunk: null })
  })

  it('tolerates a late broadcast that drained into the next flush', () => {
    const t = trace([flush(0, { response: said() }), flush(1, { nudges: [nudge('late')] })])
    expect(nudgeLogGap(t).uncertainFromChunk).toBeNull()
  })

  it('puts a total miss from the first say_to_user flush on', () => {
    const t = trace([flush(0), flush(1, { response: said() }), flush(2)])
    expect(nudgeLogGap(t)).toEqual({ said: 1, received: 0, missing: 1, uncertainFromChunk: 1 })
  })

  it('puts a lost LAST nudge at the tail only', () => {
    const t = trace([
      flush(0, { response: said(), nudges: [nudge('a')] }),
      flush(1),
      flush(2, { response: said() }),
    ])
    expect(nudgeLogGap(t)).toEqual({ said: 2, received: 1, missing: 1, uncertainFromChunk: 2 })
  })

  it('does not count a say_to_user call with an empty message (the tool refuses it)', () => {
    expect(nudgeLogGap(trace([flush(0, { response: said(1, '  ') })])).missing).toBe(0)
  })
})

describe('an incomplete nudge log marks only the verdicts it could flip', () => {
  const said = { tool_calls: 1, tool_call_details: [sayCall], duration_ms: 900 }

  it('a total miss: everything that reaches the uncertain chunks is unknown, a sure count stands', () => {
    const t = trace([flush(0, { response: said }), flush(1)])
    const checks = gradeNudges(t, {
      max_nudges: 3,
      no_nudge_windows: [{ from_chunk: 0, to_chunk: 1 }],
      nudges: [{ key: 'k', about: 'x' }],
    })
    expect(byKey(checks, 'nudge_quiet_window:0-1')!.outcome).toBe('unknown')
    expect(byKey(checks, 'nudge_expected:k')!.outcome).toBe('unknown')
    expect(byKey(checks, 'nudge_expected:k')!.rationale).toMatch(/1 say_to_user call\(s\) but 0 nudge\(s\) arrived/)
    // One call against a ceiling of three passes whatever arrived.
    expect(byKey(checks, 'nudge_count')!.outcome).toBe('pass')
  })

  it('a lost last nudge: the tail is unknown, the earlier chunks keep their verdicts', () => {
    const t = trace([
      flush(0, { response: said, nudges: [nudge('early')] }),
      flush(1),
      flush(2),
      flush(3, { response: said }), // its broadcast never arrived
    ])
    const checks = gradeNudges(t, {
      max_nudges: 1,
      no_nudge_windows: [
        { from_chunk: 3, to_chunk: 3 }, // clean only because the nudge is missing
        { from_chunk: 1, to_chunk: 2 }, // before the tail: a sure pass
        { from_chunk: 0, to_chunk: 3 }, // holds a RECEIVED nudge: a sure fail
      ],
      nudges: [
        { key: 'tail', about: 'x', after_chunk: 3 }, // may be the missing one
        { key: 'middle', about: 'y', after_chunk: 1, before_chunk: 2 }, // a sure miss
        { key: 'start', about: 'z', before_chunk: 0 }, // a sure hit
      ],
    })
    expect(byKey(checks, 'nudge_quiet_window:3-3')!.outcome).toBe('unknown')
    expect(byKey(checks, 'nudge_quiet_window:1-2')!.outcome).toBe('pass')
    expect(byKey(checks, 'nudge_quiet_window:0-3')!.outcome).toBe('fail')
    expect(byKey(checks, 'nudge_expected:tail')!.outcome).toBe('unknown')
    expect(byKey(checks, 'nudge_expected:middle')!.outcome).toBe('fail')
    expect(byKey(checks, 'nudge_expected:start')!.outcome).toBe('pass')
    // One arrived under a ceiling of one, but two were sent: unsure.
    const count = byKey(checks, 'nudge_count')!
    expect(count.outcome).toBe('unknown')
    expect(count.evidence).toMatchObject({ say_to_user_calls: 2, missing: 1, uncertain_from_chunk: 3 })
  })

  it('a sure count fail stands', () => {
    const t = trace([
      flush(0, { response: said, nudges: [nudge('a')] }),
      flush(1, { response: said, nudges: [nudge('b')] }),
      flush(2, { response: said }),
    ])
    expect(byKey(gradeNudges(t, { max_nudges: 1 }), 'nudge_count')!.outcome).toBe('fail')
  })

  it('a quiet opening reaching the uncertain chunks is unknown', () => {
    const t = trace([
      flush(0, { chunk_text: '[local_1]: hi', response: said }),
      flush(1, { chunk_text: '[remote_1]: hello' }),
    ])
    expect(byKey(gradeNudges(t, {}), 'nudge_after_first_speaker')!.outcome).toBe('unknown')
  })

  it('grades a genuinely silent trial normally', () => {
    const checks = gradeNudges(trace([flush(0), flush(1)]), { nudges: [{ key: 'k', about: 'x' }] })
    expect(byKey(checks, 'nudge_expected:k')!.outcome).toBe('fail')
  })
})

describe('an expected window past the end of the script', () => {
  it('says the case is wrong, not that the trial stopped early', () => {
    const t = trace([flush(0), flush(1)])
    const chunks: FrozenChunk[] = [
      { index: 0, t_ms_start: 0, t_ms_end: 1, segment_indices: [], text: 'a' },
      { index: 1, t_ms_start: 2, t_ms_end: 3, segment_indices: [], text: 'b' },
    ]
    const check = byKey(gradeNudges(t, { nudges: [{ key: 'k', about: 'x', after_chunk: 5 }] }, { chunks }), 'nudge_expected:k')!
    expect(check.outcome).toBe('unknown')
    expect(check.rationale).toMatch(/starts past the script's last chunk \(1\)/)
    expect(check.evidence).toMatchObject({ last_chunk: 1 })
  })
})

describe('stale drops (the route’s time guard) are intentional, not missing', () => {
  it('nudgeLogGap does not count a say_to_user the route dropped as stale', () => {
    const t = trace([
      flush(0, { response: { tool_calls: 2, tool_call_details: [sayCall, sayCall], duration_ms: 900 }, nudges: [nudge('a')], stale_nudge_drops: 1 }),
      flush(1),
    ])
    expect(nudgeLogGap(t)).toEqual({ said: 1, received: 1, missing: 0, uncertainFromChunk: null })
  })

  it('nudgeLogGap does not count a say_to_user a nudge.worth gate held', () => {
    const t = trace([
      flush(0, { response: { tool_calls: 2, tool_call_details: [sayCall, sayCall], duration_ms: 900 }, nudges: [nudge('a')], held_nudge_drops: 1 }),
    ])
    expect(nudgeLogGap(t)).toEqual({ said: 1, received: 1, missing: 0, uncertainFromChunk: null })
  })

  it('nudge_count reports the drops, and no verdict turns unknown over them', () => {
    const t = trace([flush(0, { response: { tool_calls: 1, tool_call_details: [sayCall], duration_ms: 900 }, stale_nudge_drops: 1 })])
    const checks = gradeNudges(t, { no_nudge_windows: [{ from_chunk: 0, to_chunk: 0 }] })
    expect(byKey(checks, 'nudge_count')!.evidence).toMatchObject({ stale_drops: 1, say_to_user_calls: 0 })
    expect(byKey(checks, 'nudge_quiet_window:0-0')!.outcome).toBe('pass')
  })
})

describe('nudge lateness', () => {
  /** A 10-second chunk clock: chunk i speaks from i*10s to i*10s + 9s. */
  const clock: FrozenChunk[] = [0, 1, 2, 3, 4].map((i) => ({
    index: i,
    t_ms_start: i * 10_000,
    t_ms_end: i * 10_000 + 9_000,
    segment_indices: [i],
    text: `[remote_1]: line ${i}`,
  }))
  const say = { tool_calls: 1, tool_call_details: [sayCall], duration_ms: 30_000 }
  const at = (ts: number, message = 'x'): TraceNudge => ({ id: `t${ts}`, kind: 'insight', message, ts })

  it('lag_chunks on nudge_expected: the first nudge in the window minus after_chunk', () => {
    const t = trace([flush(0), flush(1), flush(2, { nudges: [nudge('late')], response: say }), flush(3)])
    const expected = byKey(gradeNudges(t, { nudges: [{ key: 'k', about: 'x', after_chunk: 1, before_chunk: 3 }] }), 'nudge_expected:k')!
    expect(expected.outcome).toBe('pass')
    expect(expected.evidence).toMatchObject({ lag_chunks: 1 })
    // A miss carries no lag.
    const miss = byKey(gradeNudges(trace([flush(0), flush(1)]), { nudges: [{ key: 'k', about: 'x', after_chunk: 0 }] }), 'nudge_expected:k')!
    expect(miss.evidence).not.toHaveProperty('lag_chunks')
  })

  it('simulates arrival on the script clock: the produced chunk’s end + time-to-nudge', () => {
    const t = trace([
      flush(0, { started_at_ms: 100_000 }),
      // Chunk 1 ends at 19 s; 8 s later is 27 s, during chunk 2 (in the gap
      // after chunk 2 would still be chunk 2).
      flush(1, { started_at_ms: 101_000, response: say, nudges: [at(109_000)] }),
      // Chunk 2 ends at 29 s; 0.5 s later sits in the silence before chunk 3: on time.
      flush(2, { started_at_ms: 140_000, response: say, nudges: [at(140_500)] }),
    ])
    expect(nudgeLatencies(t, { chunks: clock }).map((l) => [l.produced_chunk, l.time_to_nudge_ms, l.landed_chunk, l.lag_chunks, l.bound])).toEqual([
      [1, 8_000, 2, 1, 'measured'],
      [2, 500, 2, 0, 'measured'],
    ])
  })

  it('a broadcast that drained into the next flush is timed from the flush that produced it', () => {
    const t = trace([
      flush(0, { started_at_ms: 1_000, response: say }),
      flush(1, { started_at_ms: 5_000, nudges: [at(3_000)] }),
    ])
    const [l] = nudgeLatencies(t, { chunks: clock })
    expect(l).toMatchObject({ chunk: 1, produced_chunk: 0, time_to_nudge_ms: 2_000, landed_chunk: 1, lag_chunks: 1 })
  })

  it('without send times, duration_ms is the upper bound', () => {
    const t = trace([flush(0), flush(1, { response: say, nudges: [at(1)] })])
    const [l] = nudgeLatencies(t, { chunks: clock })
    expect(l).toMatchObject({ produced_chunk: 1, time_to_nudge_ms: 30_000, bound: 'upper', landed_chunk: 4, lag_chunks: 3 })
  })

  it('nudge_latency is informational without max_nudge_lag_chunks', () => {
    const t = trace([flush(0, { started_at_ms: 0 }), flush(1, { started_at_ms: 1_000, response: say, nudges: [at(9_000)] })])
    const latency = byKey(gradeNudges(t, {}, { chunks: clock }), 'nudge_latency')!
    expect(latency).toMatchObject({ outcome: 'unknown', severity: 'soft', score: 1, threshold: null })
    expect(latency.evidence).toMatchObject({ max_lag_chunks: 1, nudges: [{ chunk: 1, lag_chunks: 1, landed_chunk: 2, time_to_nudge_ms: 8_000 }] })
  })

  it('max_nudge_lag_chunks gates it: within passes, past it fails', () => {
    const t = trace([flush(0, { started_at_ms: 0 }), flush(1, { started_at_ms: 1_000, response: say, nudges: [at(9_000)] })])
    expect(byKey(gradeNudges(t, { max_nudge_lag_chunks: 1 }, { chunks: clock }), 'nudge_latency')!.outcome).toBe('pass')
    const late = byKey(gradeNudges(t, { max_nudge_lag_chunks: 0 }, { chunks: clock }), 'nudge_latency')!
    expect(late).toMatchObject({ outcome: 'fail', threshold: 0, score: 1 })
  })

  it('a fail measured only on upper bounds is unknown', () => {
    const t = trace([flush(0), flush(1, { response: say, nudges: [at(1)] })])
    expect(byKey(gradeNudges(t, { max_nudge_lag_chunks: 1 }, { chunks: clock }), 'nudge_latency')!.outcome).toBe('unknown')
  })

  it('no nudges, no nudge_latency check', () => {
    expect(byKey(gradeNudges(trace([flush(0)]), { max_nudge_lag_chunks: 1 }), 'nudge_latency')).toBeUndefined()
  })
})
