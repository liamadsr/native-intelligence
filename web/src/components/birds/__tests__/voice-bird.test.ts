// @vitest-environment jsdom
/**
 * The voice bird's summon, hatch and leave (voice-bird.ts), with the main
 * chat's host played by a window listener.
 *
 * Pinned:
 *  - five clicks in a row (detail 5) within SUMMON_WINDOW_MS hit; four, a
 *    triple-click, a double-click then a triple-click, or five spread out don't;
 *  - the five clicks call the bird only where voice mode can start (none on
 *    the web), and it hatches only once voice mode started and is on;
 *  - a refusal, or no host, leaves no bird;
 *  - it leaves when voice mode ends, on sendVoiceBirdAway (a click on it) and
 *    on the five clicks again, ending its voice mode; sent away while voice
 *    mode was starting, nothing starts, and an old summon's answer never acts
 *    on a newer one;
 *  - the agent card's Call (callMainVoice / endMainVoice) starts and ends the
 *    main chat's voice mode the same way, but hatches no bird.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  SUMMON_WINDOW_MS,
  VOICE_BIRD_EVENT,
  __resetVoiceBirdForTests,
  callMainVoice,
  endMainVoice,
  mainVoice,
  createClickBurst,
  isVoiceBirdHere,
  parseVoiceBirdDetail,
  reportMainVoice,
  sendVoiceBirdAway,
  subscribeVoiceBird,
  toggleVoiceBird,
  voiceBirdState,
  type VoiceBirdDetail,
} from '../voice-bird'

describe('createClickBurst', () => {
  it('five quick clicks in a row hit, then it starts over', () => {
    const burst = createClickBurst()
    const hits = [0, 120, 240, 360, 480].map((t, i) => burst.hit(t, i + 1))
    expect(hits).toEqual([false, false, false, false, true])
    expect(burst.hit(600, 6)).toBe(false)
  })

  it('a triple-click (and four) never hits', () => {
    const burst = createClickBurst()
    expect([0, 100, 200].map((t, i) => burst.hit(t, i + 1))).toEqual([false, false, false])
    expect(burst.hit(300, 4)).toBe(false)
  })

  it('a double-click then a triple-click (five presses, never five in a row) doesn’t hit', () => {
    const burst = createClickBurst()
    const details = [1, 2, 1, 2, 3]
    expect([0, 100, 400, 500, 600].map((t, i) => burst.hit(t, details[i]))).toEqual([false, false, false, false, false])
  })

  it('five clicks in a row spread past the window don’t hit', () => {
    const burst = createClickBurst()
    const step = SUMMON_WINDOW_MS / 3
    expect([0, step, 2 * step, 3 * step, 4 * step].map((t, i) => burst.hit(t, i + 1))).toEqual([false, false, false, false, false])
  })
})

describe('parseVoiceBirdDetail', () => {
  it('reads start and end, and drops anything else', () => {
    expect(parseVoiceBirdDetail({ action: 'end' })).toEqual({ action: 'end' })
    expect(parseVoiceBirdDetail({ action: 'start', take: () => {}, wanted: () => true, onResult: () => {} })?.action).toBe('start')
    expect(parseVoiceBirdDetail({ action: 'start', take: () => {}, onResult: () => {} })).toBeNull()
    expect(parseVoiceBirdDetail(null)).toBeNull()
    expect(parseVoiceBirdDetail({ action: 'fly' })).toBeNull()
  })
})

describe('the voice bird', () => {
  let events: VoiceBirdDetail[]
  /** What the host answers a start with: started, refused, or later (null). */
  let answer: boolean | null
  let pending: Array<{ wanted: () => boolean; onResult: (started: boolean) => void }>
  let host: (e: Event) => void

  beforeEach(() => {
    __resetVoiceBirdForTests()
    events = []
    answer = true
    pending = []
    host = (e: Event) => {
      const detail = parseVoiceBirdDetail((e as CustomEvent).detail)!
      events.push(detail)
      if (detail.action !== 'start') return
      detail.take()
      if (answer === null) {
        pending.push(detail)
        return
      }
      // Voice mode on before start() resolves, as the panel reports it.
      if (answer) reportMainVoice(true, 'starting')
      detail.onResult(answer)
    }
    window.addEventListener(VOICE_BIRD_EVENT, host)
  })

  afterEach(() => {
    window.removeEventListener(VOICE_BIRD_EVENT, host)
  })

  it('hatches once voice mode started', () => {
    const seen: boolean[] = []
    const unsubscribe = subscribeVoiceBird(() => seen.push(isVoiceBirdHere()))
    toggleVoiceBird({ canHatch: true })
    expect(events.map((e) => e.action)).toEqual(['start'])
    expect(isVoiceBirdHere()).toBe(true)
    expect(seen.at(-1)).toBe(true)
    unsubscribe()
  })

  it('on the web (voice mode can’t start) nothing hatches and nothing is asked', () => {
    toggleVoiceBird({ canHatch: false })
    expect(events).toEqual([])
    expect(voiceBirdState()).toMatchObject({ here: false, calling: false })
  })

  it('a refusal leaves no bird', () => {
    answer = false
    toggleVoiceBird({ canHatch: true })
    expect(isVoiceBirdHere()).toBe(false)
    expect(voiceBirdState().calling).toBe(false)
  })

  it('no host to take the summon: no bird, and nothing left waiting', () => {
    window.removeEventListener(VOICE_BIRD_EVENT, host)
    toggleVoiceBird({ canHatch: true })
    expect(voiceBirdState()).toMatchObject({ here: false, calling: false })
  })

  it('started but voice mode already gone: no bird', () => {
    answer = null
    toggleVoiceBird({ canHatch: true })
    pending[0].onResult(true)
    expect(isVoiceBirdHere()).toBe(false)
  })

  it('leaves when voice mode ends, from any side', () => {
    toggleVoiceBird({ canHatch: true })
    reportMainVoice(true, 'speaking')
    expect(isVoiceBirdHere()).toBe(true)
    expect(voiceBirdState().phase).toBe('speaking')
    reportMainVoice(false, null)
    expect(isVoiceBirdHere()).toBe(false)
    // Its leaving asked nothing: voice mode had already ended.
    expect(events.map((e) => e.action)).toEqual(['start'])
  })

  it('a click on it sends it away and ends its voice mode', () => {
    toggleVoiceBird({ canHatch: true })
    sendVoiceBirdAway()
    expect(isVoiceBirdHere()).toBe(false)
    expect(events.map((e) => e.action)).toEqual(['start', 'end'])
  })

  it('the five clicks again send it away (even where it couldn’t hatch now)', () => {
    toggleVoiceBird({ canHatch: true })
    toggleVoiceBird({ canHatch: false })
    expect(isVoiceBirdHere()).toBe(false)
    expect(events.map((e) => e.action)).toEqual(['start', 'end'])
  })

  it('sent away before voice mode could start: the summon is no longer wanted, and no bird', () => {
    answer = null
    toggleVoiceBird({ canHatch: true })
    expect(pending[0].wanted()).toBe(true)
    toggleVoiceBird({ canHatch: true })
    expect(events.map((e) => e.action)).toEqual(['start', 'end'])
    // The host asks before starting: nothing starts.
    expect(pending[0].wanted()).toBe(false)
    // An answer that comes anyway acts on nothing, and sends no second end.
    pending[0].onResult(true)
    expect(isVoiceBirdHere()).toBe(false)
    expect(events.map((e) => e.action)).toEqual(['start', 'end'])
  })

  it('summon, send away, summon: the first call’s answer never acts on the second', () => {
    answer = null
    toggleVoiceBird({ canHatch: true })
    toggleVoiceBird({ canHatch: true })
    toggleVoiceBird({ canHatch: true })
    expect(events.map((e) => e.action)).toEqual(['start', 'end', 'start'])
    const [first, second] = pending
    expect(first.wanted()).toBe(false)
    expect(second.wanted()).toBe(true)
    // The first started (and was ended): its late answer hatches nothing and ends nothing.
    first.onResult(true)
    expect(voiceBirdState()).toMatchObject({ calling: true, here: false })
    expect(events.map((e) => e.action)).toEqual(['start', 'end', 'start'])
    // The second fails: no bird, and still nothing ended.
    second.onResult(false)
    expect(voiceBirdState()).toMatchObject({ calling: false, here: false })
    // Or a later summon that starts hatches.
    answer = true
    toggleVoiceBird({ canHatch: true })
    expect(isVoiceBirdHere()).toBe(true)
  })

  it('normal voice mode (the waveform) brings no bird, and away sends nothing', () => {
    reportMainVoice(true, 'listening')
    expect(isVoiceBirdHere()).toBe(false)
    sendVoiceBirdAway()
    expect(events).toEqual([])
  })

  it('the agent card’s Call starts voice mode through the host, no bird; End call ends it', async () => {
    await expect(callMainVoice()).resolves.toBe(true)
    expect(events.map((e) => e.action)).toEqual(['start'])
    expect(voiceBirdState()).toMatchObject({ voiceActive: true, here: false, calling: false })
    expect(mainVoice()).toBe('starting')
    reportMainVoice(true, 'listening')
    expect(mainVoice()).toBe('on')
    endMainVoice()
    expect(events.map((e) => e.action)).toEqual(['start', 'end'])
    reportMainVoice(false, null)
    expect(mainVoice()).toBe('off')
  })

  it('End call while the bird is out ends its voice mode, and it leaves', () => {
    toggleVoiceBird({ canHatch: true })
    expect(isVoiceBirdHere()).toBe(true)
    endMainVoice()
    expect(events.map((e) => e.action)).toEqual(['start', 'end'])
    // The host ends voice mode; the panel reports it off.
    reportMainVoice(false, null)
    expect(isVoiceBirdHere()).toBe(false)
  })

  it('a refused Call resolves false; with no host, nothing starts', async () => {
    answer = false
    await expect(callMainVoice()).resolves.toBe(false)
    window.removeEventListener(VOICE_BIRD_EVENT, host)
    await expect(callMainVoice()).resolves.toBe(false)
    expect(voiceBirdState().here).toBe(false)
  })
})
