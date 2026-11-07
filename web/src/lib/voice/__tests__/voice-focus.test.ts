// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { VoiceSpeechEvent, VoiceStatus } from '@/lib/tauri-bridge'

/**
 * Voice focus (../voice-focus): whose voice a turn is, and whether it goes.
 *  - the speech: base64 Int16 → Float32; runs kept by turnId, bounded (runs,
 *    seconds), abandoned runs dropped on their close, chunks out of order
 *    skipped;
 *  - the verdict: you (the self vote qualifies), known (a contact at the
 *    Voice ID vote floor), unknown (below the self-mismatch floor, no contact),
 *    unsure (short, close, no contacts loaded); only unknown with Voice focus
 *    on drops;
 *  - the gate: off sends at once and only logs; on waits for the verdict,
 *    at most VERDICT_WAIT_MS (then sends, logging the late score); short
 *    audio, no voiceprint, a failing model, no audio: sent; a judge before its
 *    run closed waits for the close; logs carry ids and numbers only;
 *  - openVoiceFocus: only with the desktop's `speechAudio` and a voiceprint.
 */

const env = vi.hoisted(() => ({
  desktop: true,
  status: { available: true, dictation: true, conversation: true, stt: 'ready', tts: 'ready' } as VoiceStatus,
}))

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => env.desktop }))
vi.mock('@/lib/voice/status-store', () => ({ getVoiceStatus: () => env.status }))
vi.mock('@/lib/tauri-bridge', () => ({ tauriBridge: { voiceLog: vi.fn(async () => {}) } }))

import {
  KNOWN_VOICE_THRESHOLD,
  SpeechRuns,
  VOICE_FOCUS,
  VoiceFocusGate,
  __resetVoiceFocusForTests,
  decodePcm16,
  findVoiced,
  focusAction,
  formatFocusLine,
  judgeVoice,
  loadVoiceprint,
  openVoiceFocus,
  peekVoiceprint,
  scoreVoice,
  type VoiceFocusDeps,
  type Voiceprint,
} from '../voice-focus'
import { setVoiceFocus } from '../settings'
import { EMBEDDING_DIM, SELF_MISMATCH_THRESHOLD, SELF_VERIFY_THRESHOLD } from '@/lib/voice-profile/types'

// ── Fixtures ────────────────────────────────────────────────────────────────

const basis = (i: number) => {
  const v = new Array<number>(EMBEDDING_DIM).fill(0)
  v[i] = 1
  return v
}
/** A unit vector with cosine `self` to basis(0) (the voiceprint) and
 *  `contact` to basis(2) (Ana's voice). */
function voiceOf(self: number, contact = 0): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0)
  v[0] = self
  v[2] = contact
  v[3] = Math.sqrt(Math.max(0, 1 - self * self - contact * contact))
  return v
}

const VOICEPRINT: Voiceprint = { prototypes: [basis(0)], selfContactIds: new Set(['me-contact']) }
const GALLERY = [
  { contactId: 'ana', contactName: 'Ana Secret', prototypes: [basis(2)] },
  // The user enrolled as a contact: never "known", as Voice ID leaves it out.
  { contactId: 'me-contact', contactName: 'Me', prototypes: [basis(0)] },
]

/** `seconds` of a 200 Hz tone at `amp` (speech-loud by default; 0: silence). */
function tone(seconds: number, amp = 0.1): Float32Array {
  const out = new Float32Array(Math.round(seconds * 16000))
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * 200 * i) / 16000)
  return out
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Float32 → base64 Int16 LE, as the desktop sends it. */
function encode(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768)))
    bytes[2 * i] = v & 0xff
    bytes[2 * i + 1] = (v >> 8) & 0xff
  }
  return Buffer.from(bytes).toString('base64')
}

const chunkOf = (turnId: string, seq: number, samples: Float32Array): VoiceSpeechEvent => ({
  type: 'speech',
  turnId,
  seq,
  end: false,
  startMs: seq * 500,
  sampleRate: 16000,
  pcm: encode(samples),
})

const chunk = (turnId: string, seq: number, seconds = 0.5): VoiceSpeechEvent => chunkOf(turnId, seq, tone(seconds))
const close = (turnId: string, seq: number, outcome: 'turn' | 'abandoned' = 'turn'): VoiceSpeechEvent => ({
  type: 'speech',
  turnId,
  seq,
  end: true,
  outcome,
})

/** A run of `seconds` (0.5 s chunks) then its close. */
function speak(gate: VoiceFocusGate, turnId: string, seconds: number, outcome: 'turn' | 'abandoned' = 'turn') {
  const n = Math.ceil(seconds / 0.5)
  for (let i = 0; i < n; i++) gate.onSpeech(chunk(turnId, i))
  gate.onSpeech(close(turnId, n, outcome))
}

/** A run of exactly `audio`, sent in 0.5 s chunks as the desktop does, then its close. */
function send(gate: VoiceFocusGate, turnId: string, audio: Float32Array) {
  let seq = 0
  for (let at = 0; at < audio.length; at += 8000) gate.onSpeech(chunkOf(turnId, seq++, audio.slice(at, at + 8000)))
  gate.onSpeech(close(turnId, seq))
}

function gateWith(over: Partial<VoiceFocusDeps> & { voice?: number[]; on?: boolean } = {}) {
  const lines: string[] = []
  const embed = vi.fn(async (_audio: Float32Array) => over.voice ?? voiceOf(0.9))
  const deps: VoiceFocusDeps = {
    embed,
    voiceprint: async () => VOICEPRINT,
    gallery: async () => GALLERY,
    isOn: () => over.on ?? true,
    log: (line) => void lines.push(line),
    ...over,
  }
  return { gate: new VoiceFocusGate('conv-1', deps), lines, embed }
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  window.localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── The speech ──────────────────────────────────────────────────────────────

describe('decodePcm16', () => {
  it('reads Int16 LE into [-1, 1], and refuses junk', () => {
    const b64 = Buffer.from(new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80])).toString('base64')
    const out = decodePcm16(b64)!
    expect(Array.from(out)).toEqual([0, 32767 / 32768, -1])
    expect(decodePcm16('%%%')).toBeNull()
    expect(decodePcm16('')).toBeNull()
  })
})

describe('SpeechRuns', () => {
  it('a run closing as a turn comes back whole; an abandoned one is dropped at once', () => {
    const runs = new SpeechRuns()
    runs.add(chunk('t1', 0))
    runs.add(chunk('t1', 1))
    runs.add(chunk('t2', 0))
    const closed = runs.add(close('t1', 2))!
    expect(closed.turnId).toBe('t1')
    expect(closed.seconds).toBeCloseTo(1)
    expect(closed.audio).toHaveLength(16000)
    expect(runs.add(close('t2', 1, 'abandoned'))).toBeNull()
    expect(runs.size).toBe(0)
    expect(runs.samples).toBe(0)
  })

  it('a close with nothing heard: an empty turn', () => {
    const runs = new SpeechRuns()
    expect(runs.add(close('t9', 0))).toEqual({ turnId: 't9', audio: new Float32Array(0), seconds: 0 })
  })

  it('bounded: at most MAX_SECONDS per run and MAX_RUNS runs (the oldest goes)', () => {
    const runs = new SpeechRuns()
    for (let i = 0; i < 30; i++) runs.add(chunk('long', i))
    expect(runs.samples).toBe(VOICE_FOCUS.MAX_SECONDS * 16000)
    for (let r = 0; r < VOICE_FOCUS.MAX_RUNS + 3; r++) runs.add(chunk(`r${r}`, 0))
    expect(runs.size).toBe(VOICE_FOCUS.MAX_RUNS)
    expect(runs.has('long')).toBe(false)
    expect(runs.samples).toBeLessThanOrEqual(VOICE_FOCUS.MAX_RUNS * VOICE_FOCUS.MAX_SECONDS * 16000)
  })

  it('a chunk not past the last seq (a repeat, out of order) is skipped', () => {
    const runs = new SpeechRuns()
    runs.add(chunk('t1', 0))
    runs.add(chunk('t1', 0))
    runs.add(chunk('t1', 2))
    runs.add(chunk('t1', 1))
    expect(runs.add(close('t1', 3))!.seconds).toBeCloseTo(1)
  })
})

describe('findVoiced (the speech in a run that includes its trailing pause)', () => {
  const S = 16000

  it('a short word then the pause: its own length, padded 100 ms for the embedding', () => {
    const v = findVoiced(concat(tone(0.3, 0), tone(0.4), tone(1.2, 0)))!
    expect(v.seconds).toBeCloseTo(0.4, 2)
    expect(v.start).toBe(Math.round(0.2 * S))
    expect(v.end).toBe(Math.round(0.8 * S))
  })

  it('silence, or room tone under the absolute floor (−55 dBFS): no speech', () => {
    expect(findVoiced(tone(2, 0))).toBeNull()
    expect(findVoiced(tone(2, 0.001))).toBeNull()
    expect(findVoiced(new Float32Array(10))).toBeNull()
  })

  it('room tone above the floor but far under the speech is not speech (the relative bar)', () => {
    const v = findVoiced(concat(tone(1, 0.005), tone(1), tone(1, 0.005)))!
    expect(v.seconds).toBeCloseTo(1, 2)
  })

  it('a short gap inside speech (a plosive, a breath) is bridged; a real pause is not counted', () => {
    // (To the 20 ms frame: the gap doesn't start on a frame boundary.)
    expect(findVoiced(concat(tone(0.5), tone(0.15, 0), tone(0.5)))!.seconds).toBeCloseTo(1.15, 1)
    expect(findVoiced(concat(tone(0.5), tone(0.6, 0), tone(0.5)))!.seconds).toBeCloseTo(1, 2)
  })
})

// ── The verdict ─────────────────────────────────────────────────────────────

describe('judgeVoice / focusAction', () => {
  const judge = (self: number, contact = 0, seconds = 3, gallery: typeof GALLERY | null = GALLERY) =>
    judgeVoice(seconds, scoreVoice(voiceOf(self, contact), VOICEPRINT, gallery))

  it('you: the self vote qualifies (threshold and margin over every contact)', () => {
    expect(judge(SELF_VERIFY_THRESHOLD + 0.01)).toEqual({ kind: 'you' })
    expect(judge(0.9, 0.5)).toEqual({ kind: 'you' })
  })

  it('the user’s own contact never counts as a known voice (nor against them)', () => {
    const scores = scoreVoice(voiceOf(0.3), VOICEPRINT, GALLERY)
    expect(scores.known?.contactId).toBe('ana')
  })

  it('known: a contact at the Voice ID vote floor', () => {
    expect(KNOWN_VOICE_THRESHOLD).toBe(0.8)
    expect(judge(0.2, 0.85)).toEqual({ kind: 'known', contactId: 'ana', contactName: 'Ana Secret' })
    // Close-ish to the user, but a contact clears the floor: known.
    expect(judge(0.55, KNOWN_VOICE_THRESHOLD + 0.01)).toMatchObject({ kind: 'known' })
    // Just under the floor, far from the user: unknown.
    expect(judge(0.2, KNOWN_VOICE_THRESHOLD - 0.01)).toEqual({ kind: 'unknown' })
  })

  it('unknown: below the self-mismatch floor and no contact known', () => {
    expect(judge(SELF_MISMATCH_THRESHOLD - 0.01, 0.79)).toEqual({ kind: 'unknown' })
    expect(judge(0.1, 0.3)).toEqual({ kind: 'unknown' })
  })

  it('unsure: close to the user without qualifying, too short, or no contacts to rule out', () => {
    expect(judge(0.7)).toEqual({ kind: 'unsure', reason: 'close' })
    expect(judge(SELF_MISMATCH_THRESHOLD)).toEqual({ kind: 'unsure', reason: 'close' })
    expect(judge(0.1, 0, VOICE_FOCUS.MIN_SECONDS - 0.1)).toEqual({ kind: 'unsure', reason: 'short' })
    expect(judge(0.1, 0, 3, null)).toEqual({ kind: 'unsure', reason: 'no_gallery' })
  })

  it('only an unknown voice with Voice focus on is dropped', () => {
    expect(focusAction({ kind: 'unknown' }, true)).toBe('drop')
    expect(focusAction({ kind: 'unknown' }, false)).toBe('send')
    for (const v of [{ kind: 'you' }, { kind: 'known', contactId: 'a', contactName: 'A' }, { kind: 'unsure', reason: 'short' }] as const) {
      expect(focusAction(v, true)).toBe('send')
    }
  })

  it('the log line: ids and numbers, never a name', () => {
    const scores = scoreVoice(voiceOf(0.2, 0.85), VOICEPRINT, GALLERY)
    const line = formatFocusLine({
      turnId: 't3',
      seconds: 2.4,
      scores,
      verdict: judgeVoice(2.4, scores),
      focusOn: false,
      action: 'send',
      ms: 312.4,
    })
    expect(line).toBe('turn t3 dur=2.4s self=0.20 known=0.85 verdict=known focus=off action=send ms=312')
    expect(line).not.toContain('Ana')
    expect(formatFocusLine({ turnId: 'a b/c', seconds: 0.5, scores: null, verdict: { kind: 'unsure', reason: 'short' }, focusOn: true, action: 'send', late: true })).toBe(
      'turn abc dur=0.5s self=- known=- verdict=unsure why=short focus=on action=send late',
    )
  })
})

// ── The gate ────────────────────────────────────────────────────────────────

describe('VoiceFocusGate: the voiced span', () => {
  it('a short word followed by the 1.2 s pause is too short to judge: sent, never embedded', async () => {
    const { gate, lines, embed } = gateWith({ voice: voiceOf(0.1) })
    send(gate, 't1', concat(tone(0.3, 0), tone(0.4), tone(1.2, 0)))
    const action = gate.judge('t1')
    await flush()
    expect(await action).toBe('send')
    expect(embed).not.toHaveBeenCalled()
    expect(lines).toEqual([expect.stringMatching(/^turn t1 dur=0\.4s run=1\.9s self=- known=- verdict=unsure why=short focus=on action=send$/)])
  })

  it('a 2.5 s utterance with its trailing pause is embedded from the voiced span only', async () => {
    const { gate, lines, embed } = gateWith({ voice: voiceOf(0.1) })
    send(gate, 't1', concat(tone(0.3, 0), tone(2.5), tone(1.2, 0)))
    const action = gate.judge('t1')
    await flush()
    expect(await action).toBe('drop')
    expect(embed).toHaveBeenCalledTimes(1)
    const embedded = embed.mock.calls[0][0]
    // 0.2 s … 2.9 s of the run: the speech ± 100 ms, none of the pause.
    expect(embedded.length).toBe(Math.round(2.7 * 16000))
    expect(lines[0]).toMatch(/dur=2\.5s run=4\.0s/)
  })

  it('a run of silence is no audio: sent, never embedded', async () => {
    const { gate, lines, embed } = gateWith({ voice: voiceOf(0.1) })
    send(gate, 't1', tone(3, 0))
    const action = gate.judge('t1')
    await flush()
    expect(await action).toBe('send')
    expect(embed).not.toHaveBeenCalled()
    expect(lines[0]).toContain('why=no_audio')
  })
})

describe('VoiceFocusGate: focus off', () => {
  it('focusOn reads the setting; observe never decides, only logs the score once it is in', async () => {
    let on = false
    const { gate, lines } = gateWith({ voice: voiceOf(0.1), isOn: () => on })
    expect(gate.focusOn()).toBe(false)
    on = true
    expect(gate.focusOn()).toBe(true)
    on = false
    speak(gate, 't1', 3)
    expect(gate.observe('t1')).toBeUndefined()
    await flush()
    expect(lines).toEqual([expect.stringContaining('verdict=unknown focus=off action=send')])
    expect(gate.held.scored).toBe(0)
  })
})

describe('VoiceFocusGate', () => {
  it('on: an unknown voice is dropped; the log says so', async () => {
    const { gate, lines } = gateWith({ voice: voiceOf(0.2) })
    speak(gate, 't1', 3)
    const action = gate.judge('t1')
    await flush()
    expect(await action).toBe('drop')
    expect(lines).toEqual([
      expect.stringMatching(/^turn t1 dur=3\.0s run=3\.0s self=0\.20 known=0\.00 verdict=unknown focus=on action=drop ms=\d+$/),
    ])
  })

  it('on: the user, and a known contact, are sent', async () => {
    const you = gateWith({ voice: voiceOf(0.9) })
    speak(you.gate, 't1', 2)
    const a = you.gate.judge('t1')
    await flush()
    expect(await a).toBe('send')
    const known = gateWith({ voice: voiceOf(0.1, 0.9) })
    speak(known.gate, 't1', 2)
    const b = known.gate.judge('t1')
    await flush()
    expect(await b).toBe('send')
    expect(known.lines[0]).toContain('verdict=known')
  })

  it('off (shadow): sent at once, still scored and logged', async () => {
    const { gate, lines, embed } = gateWith({ voice: voiceOf(0.2), on: false })
    speak(gate, 't1', 3)
    let action: string | null = null
    void gate.judge('t1').then((a) => (action = a))
    await Promise.resolve()
    expect(action).toBe('send')
    await flush()
    expect(embed).toHaveBeenCalledTimes(1)
    expect(lines).toEqual([expect.stringContaining('verdict=unknown focus=off action=send')])
  })

  it('fails open: no verdict within VERDICT_WAIT_MS sends; the late score is logged', async () => {
    let finish!: (v: number[]) => void
    const { gate, lines } = gateWith({ embed: () => new Promise<number[]>((r) => (finish = r)) })
    speak(gate, 't1', 3)
    let action: string | null = null
    void gate.judge('t1').then((a) => (action = a))
    await vi.advanceTimersByTimeAsync(VOICE_FOCUS.VERDICT_WAIT_MS - 1)
    expect(action).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(action).toBe('send')
    finish(voiceOf(0.1))
    await flush()
    expect(lines).toEqual([expect.stringMatching(/verdict=unknown focus=on action=send late/)])
  })

  it('too short to judge, no voiceprint, a failing model, nothing heard: sent', async () => {
    const short = gateWith({ voice: voiceOf(0.1) })
    speak(short.gate, 't1', 1)
    const a = short.gate.judge('t1')
    await flush()
    expect(await a).toBe('send')
    expect(short.embed).not.toHaveBeenCalled()
    expect(short.lines[0]).toContain('why=short')

    const none = gateWith({ voice: voiceOf(0.1), voiceprint: async () => null })
    speak(none.gate, 't1', 3)
    const b = none.gate.judge('t1')
    await flush()
    expect(await b).toBe('send')
    expect(none.lines[0]).toContain('why=no_voiceprint')

    const broken = gateWith({ embed: async () => Promise.reject(new Error('worker crashed')) })
    speak(broken.gate, 't1', 3)
    const c = broken.gate.judge('t1')
    await flush()
    expect(await c).toBe('send')
    expect(broken.lines[0]).toContain('why=model')

    const silent = gateWith()
    const d = silent.gate.judge('never-heard')
    await flush()
    expect(await d).toBe('send')
    expect(silent.lines[0]).toContain('why=no_audio')
  })

  it('contacts that could not load: an unknown-looking voice is sent', async () => {
    const { gate, lines } = gateWith({ voice: voiceOf(0.1), gallery: async () => null })
    speak(gate, 't1', 3)
    const action = gate.judge('t1')
    await flush()
    expect(await action).toBe('send')
    expect(lines[0]).toContain('why=no_gallery')
  })

  it('a judge before its run closed waits for the close (within the budget)', async () => {
    const { gate } = gateWith({ voice: voiceOf(0.1) })
    for (let i = 0; i < 6; i++) gate.onSpeech(chunk('t1', i))
    const action = gate.judge('t1')
    await vi.advanceTimersByTimeAsync(200)
    gate.onSpeech(close('t1', 6))
    await flush()
    expect(await action).toBe('drop')
  })

  it('abandoned runs go at once; scored turns waiting for their turn are bounded; dispose empties it', async () => {
    const { gate } = gateWith()
    speak(gate, 'gone', 3, 'abandoned')
    expect(gate.held).toEqual({ runs: 0, samples: 0, scored: 0 })
    for (let i = 0; i < VOICE_FOCUS.MAX_SCORED + 4; i++) speak(gate, `t${i}`, 2)
    expect(gate.held.scored).toBe(VOICE_FOCUS.MAX_SCORED)
    gate.onSpeech(chunk('open', 0))
    expect(gate.held.runs).toBe(1)
    gate.dispose()
    expect(gate.held).toEqual({ runs: 0, samples: 0, scored: 0 })
  })

  it('reads Voice focus at each turn', async () => {
    let on = false
    const { gate } = gateWith({ voice: voiceOf(0.1), isOn: () => on })
    speak(gate, 't1', 3)
    expect(await gate.judge('t1')).toBe('send')
    on = true
    speak(gate, 't2', 3)
    const action = gate.judge('t2')
    await flush()
    expect(await action).toBe('drop')
  })
})

// ── Wiring ──────────────────────────────────────────────────────────────────

describe('openVoiceFocus', () => {
  beforeEach(() => {
    __resetVoiceFocusForTests()
    env.desktop = true
    env.status = { available: true, dictation: true, conversation: true, stt: 'ready', tts: 'ready', speechAudio: true }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    __resetVoiceFocusForTests()
  })

  function stubProfile(prototypes: number[][]) {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/account/voice-profile')) {
        return new Response(JSON.stringify({ enrolled: prototypes.length > 0, prototypes, selfContactIds: ['me-contact'] }))
      }
      return new Response(JSON.stringify({ enrollments: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('none without the desktop’s speechAudio, or in the browser', () => {
    stubProfile([basis(0)])
    env.status = { ...env.status, speechAudio: undefined }
    expect(openVoiceFocus('conv-1')).toBeNull()
    env.status = { ...env.status, speechAudio: true }
    env.desktop = false
    expect(openVoiceFocus('conv-1')).toBeNull()
  })

  it('a gate while the voiceprint is unknown or present; none once it is known to be absent', async () => {
    stubProfile([basis(0)])
    const gate = openVoiceFocus('conv-1')
    expect(gate).not.toBeNull()
    await flush()
    expect(peekVoiceprint()).toBe('present')
    gate!.dispose()

    __resetVoiceFocusForTests()
    stubProfile([])
    await loadVoiceprint()
    await flush()
    expect(peekVoiceprint()).toBe('absent')
    expect(openVoiceFocus('conv-2')).toBeNull()
  })

  it('loads the voiceprint as Voice ID does: wrong-sized vectors dropped, the rest unit-norm', async () => {
    const twice = basis(0).map((x) => x * 2)
    stubProfile([twice, [1, 2, 3]])
    const vp = await loadVoiceprint()
    expect(vp?.prototypes).toHaveLength(1)
    expect(vp?.prototypes[0][0]).toBeCloseTo(1)
    expect([...(vp?.selfContactIds ?? [])]).toEqual(['me-contact'])
  })

  it('with Voice focus on, the contacts are warmed as the session opens', async () => {
    const fetchMock = stubProfile([basis(0)])
    await loadVoiceprint()
    await flush()
    setVoiceFocus(true)
    const gate = openVoiceFocus('conv-1')
    expect(fetchMock).toHaveBeenCalledWith('/api/account/voice-enrollments')
    gate?.dispose()
  })
})
