// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  DeepgramConnection,
  createSegmentIdFactory,
  dispatchDeepgramMessage,
  parseDeepgramMessage,
  type TranscriptSegment,
  type TranscriptWord,
  type VadEvent,
} from '../deepgram-stream'

/**
 * The Deepgram message parser was extracted out of DeepgramConnection so the
 * desktop's on-device engine (which emits Deepgram-shaped JSON over
 * stt://message) can share it. The contract: every message produces EXACTLY
 * what DeepgramConnection.handleMessage produced before the extraction — same
 * segments (ids included), same speaker labels, same VAD events, same order.
 *
 * `legacyHandleMessage` below is the pre-extraction method body, copied
 * verbatim (only `this.*` turned into parameters), and serves as the oracle.
 */

type Sink = {
  segments: TranscriptSegment[]
  finals: TranscriptSegment[]
  vad: Array<[VadEvent, 'mic' | 'system']>
}

function newSink(): Sink {
  return { segments: [], finals: [], vad: [] }
}

// ── Oracle: DeepgramConnection.handleMessage as it was ──────────────
function legacyHandleMessage(
  self: { stream: 'mic' | 'system'; speakerPrefix: string; segmentCounter: number },
  sink: Sink,
  data: any,
) {
  if (data.type === 'SpeechStarted') {
    sink.vad.push(['speech_started', self.stream])
    return
  }
  if (data.type === 'UtteranceEnd') {
    sink.vad.push(['utterance_end', self.stream])
    return
  }
  if (data.type !== 'Results') return
  const channel = data.channel
  if (!channel?.alternatives?.[0]) return
  const alt = channel.alternatives[0]
  const transcript = alt.transcript
  if (!transcript || transcript.trim() === '') return
  const words: TranscriptWord[] = (alt.words || []).map((w: any) => ({
    word: w.word,
    start: w.start,
    end: w.end,
    confidence: w.confidence,
    speaker: w.speaker,
  }))
  const speakerNum = words.length > 0 && words[0].speaker !== undefined ? words[0].speaker : 0
  const speaker = `${self.speakerPrefix}_${speakerNum + 1}`
  const startTime = data.start ?? channel.start ?? 0
  const endTime = startTime + (data.duration ?? channel.duration ?? 0)
  self.segmentCounter++
  const segment: TranscriptSegment = {
    id: `${self.stream}-${self.segmentCounter}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    text: transcript,
    stream: self.stream,
    speaker,
    startTime,
    endTime,
    isFinal: data.is_final === true,
    words,
  }
  sink.segments.push(segment)
  if (segment.isFinal) sink.finals.push(segment)
}

// ── Fixtures: real Deepgram live-message shapes ─────────────────────
const word = (w: string, start: number, speaker?: number) => ({
  word: w.toLowerCase(),
  punctuated_word: w,
  start,
  end: start + 0.3,
  confidence: 0.97,
  ...(speaker !== undefined ? { speaker } : {}),
})

const FIXTURES: unknown[] = [
  { type: 'Metadata', request_id: 'r1', model_info: {} },
  { type: 'SpeechStarted', channel: [0], timestamp: 1.2 },
  {
    type: 'Results',
    start: 1.2,
    duration: 0.9,
    is_final: false,
    speech_final: false,
    channel: { alternatives: [{ transcript: 'so the plan', confidence: 0.9, words: [word('So', 1.2, 1), word('the', 1.5, 1), word('plan', 1.8, 1)] }] },
  },
  {
    type: 'Results',
    start: 1.2,
    duration: 2.4,
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ transcript: 'So the plan is set.', confidence: 0.95, words: [word('So', 1.2, 1), word('the', 1.5, 1), word('plan', 1.8, 1), word('is', 2.3, 1), word('set.', 2.9, 1)] }] },
  },
  // Empty interim (silence) — produces nothing and must not bump the counter.
  { type: 'Results', start: 3.6, duration: 0.5, is_final: false, channel: { alternatives: [{ transcript: '', words: [] }] } },
  // Whitespace-only transcript.
  { type: 'Results', start: 3.6, duration: 0.5, is_final: true, channel: { alternatives: [{ transcript: '   ', words: [] }] } },
  // No words array → speaker defaults to _1; timing from the channel.
  { type: 'Results', is_final: true, channel: { start: 4.1, duration: 1.1, alternatives: [{ transcript: 'Okay.' }] } },
  // Words without diarization tags → _1.
  { type: 'Results', start: 5.2, duration: 0.8, is_final: true, channel: { alternatives: [{ transcript: 'Yes', words: [word('Yes', 5.2)] }] } },
  // Speaker 0, cross-talk (first word's speaker wins).
  { type: 'Results', start: 6, duration: 1.4, is_final: true, channel: { alternatives: [{ transcript: 'Right, and', words: [word('Right,', 6, 0), word('and', 6.6, 2)] }] } },
  // No timing at all → 0.
  { type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'hmm', words: [word('hmm', 0, 3)] }] } },
  // Missing channel / alternatives → nothing.
  { type: 'Results', is_final: true },
  { type: 'Results', is_final: true, channel: { alternatives: [] } },
  { type: 'UtteranceEnd', channel: [0, 1], last_word_end: 7.4 },
]

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(1_750_000_000_000)
  vi.spyOn(Math, 'random').mockReturnValue(0.123456789)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseDeepgramMessage — identical to the pre-extraction handleMessage', () => {
  for (const stream of ['mic', 'system'] as const) {
    it(`produces the same segments, ids, speakers and VAD events (${stream})`, () => {
      const legacy = newSink()
      const self = { stream, speakerPrefix: stream === 'mic' ? 'local' : 'remote', segmentCounter: 0 }
      for (const msg of FIXTURES) legacyHandleMessage(self, legacy, msg)

      const extracted = newSink()
      const nextId = createSegmentIdFactory(stream)
      for (const msg of FIXTURES) {
        dispatchDeepgramMessage(msg, stream, nextId, {
          onSegment: (s) => extracted.segments.push(s),
          onFinalSegment: (s) => extracted.finals.push(s),
          onVad: (e, st) => extracted.vad.push([e, st]),
        })
      }

      expect(extracted).toEqual(legacy)
      // Sanity: the fixtures really exercise every branch.
      expect(extracted.segments).toHaveLength(6)
      expect(extracted.finals).toHaveLength(5)
      expect(extracted.vad).toEqual([['speech_started', stream], ['utterance_end', stream]])
    })
  }

  it('labels speakers local_N / remote_N from the first word (0-based → 1-based)', () => {
    const final = FIXTURES[3]
    const mic = parseDeepgramMessage(final, 'mic', () => 'id')
    const sys = parseDeepgramMessage(final, 'system', () => 'id')
    expect(mic?.kind === 'segment' && mic.segment.speaker).toBe('local_2')
    expect(sys?.kind === 'segment' && sys.segment.speaker).toBe('remote_2')
    const crossTalk = parseDeepgramMessage(FIXTURES[8], 'system', () => 'id')
    expect(crossTalk?.kind === 'segment' && crossTalk.segment.speaker).toBe('remote_1')
  })

  it('computes start/end from the message, then the channel, then 0', () => {
    const top = parseDeepgramMessage(FIXTURES[3], 'mic', () => 'id')
    expect(top).toMatchObject({ kind: 'segment', segment: { startTime: 1.2, endTime: 1.2 + 2.4, isFinal: true } })
    const fromChannel = parseDeepgramMessage(FIXTURES[6], 'mic', () => 'id')
    expect(fromChannel).toMatchObject({ kind: 'segment', segment: { startTime: 4.1, endTime: 4.1 + 1.1 } })
    const none = parseDeepgramMessage(FIXTURES[9], 'mic', () => 'id')
    expect(none).toMatchObject({ kind: 'segment', segment: { startTime: 0, endTime: 0 } })
  })

  it('returns null (and mints no id) for everything that is not a transcript or VAD event', () => {
    const nextId = vi.fn(() => 'id')
    for (const msg of [null, undefined, 'Results', 42, [], FIXTURES[0], FIXTURES[4], FIXTURES[5], FIXTURES[10], FIXTURES[11]]) {
      expect(parseDeepgramMessage(msg, 'mic', nextId)).toBeNull()
    }
    // A non-string transcript used to throw inside handleMessage (swallowed by
    // onmessage's catch) — the pure parser just says "nothing".
    expect(parseDeepgramMessage({ type: 'Results', channel: { alternatives: [{ transcript: 7 }] } }, 'mic', nextId)).toBeNull()
    expect(nextId).not.toHaveBeenCalled()
  })

  it('segment ids keep the historical format and count only produced segments', () => {
    vi.restoreAllMocks()
    const nextId = createSegmentIdFactory('system')
    const ids = FIXTURES.map((m) => parseDeepgramMessage(m, 'system', nextId))
      .flatMap((p) => (p?.kind === 'segment' ? [p.segment.id] : []))
    expect(ids).toHaveLength(6)
    ids.forEach((id, i) => expect(id).toMatch(new RegExp(`^system-${i + 1}-\\d+-[a-z0-9]{0,4}$`)))
  })
})

// ── Through the real DeepgramConnection (WebSocket path) ────────────
let sockets: MockWebSocket[] = []

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = MockWebSocket.CONNECTING
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  constructor() {
    sockets.push(this)
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN
      this.onopen?.()
    })
  }
  send() {}
  close() {
    this.readyState = MockWebSocket.CLOSED
  }
}

describe('DeepgramConnection delivers what the parser produces', () => {
  beforeEach(() => {
    sockets = []
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('segments, finals and VAD events match the legacy oracle message-for-message', async () => {
    const got = newSink()
    const conn = new DeepgramConnection(
      'system',
      (s) => got.segments.push(s),
      (s) => got.finals.push(s),
      (e, st) => got.vad.push([e, st]),
    )
    const connecting = conn.connect('key')
    await Promise.resolve()
    await Promise.resolve()
    await connecting

    for (const msg of FIXTURES) sockets[0].onmessage?.({ data: JSON.stringify(msg) })
    // Non-JSON frames are ignored, as before.
    sockets[0].onmessage?.({ data: 'not json' })

    const legacy = newSink()
    const self = { stream: 'system' as const, speakerPrefix: 'remote', segmentCounter: 0 }
    for (const msg of FIXTURES) legacyHandleMessage(self, legacy, JSON.parse(JSON.stringify(msg)))

    expect(got).toEqual(legacy)
    // Finals are the same objects the transcript received (Voice ID relies on it).
    expect(got.finals.every((f) => got.segments.includes(f))).toBe(true)
    conn.close()
  })
})
