import { describe, expect, it } from 'vitest'
import { hear, isLiveWordsEvent, KEEP_FINALS, NOTHING_HEARD, type LiveWordsEvent } from '../live-words'
import { easeStep, scrollTarget } from '../scroll'

const ev = (seq: number, final: boolean, text: string): LiveWordsEvent => ({ sessionId: 's', seq, final, words: text.split(' ').map((t, i) => ({ text: t, startMs: i * 300, endMs: i * 300 + 250 })) })
const words = (tokens: { word: string }[]) => tokens.map((t) => t.word).join(' ')

describe('hear', () => {
  it('replaces the interim guess, and a final keeps its words and clears the guess', () => {
    let h = hear(NOTHING_HEARD, ev(0, false, 'open the'))
    h = hear(h, ev(1, false, 'open the deals'))
    expect(words(h.interim)).toBe('open the deals')
    expect(h.finals).toEqual([])
    h = hear(h, ev(2, true, 'open the deals board'))
    expect(words(h.finals)).toBe('open the deals board')
    expect(h.interim).toEqual([])
    h = hear(h, ev(3, true, 'from the sidebar'))
    expect(words(h.finals)).toBe('open the deals board from the sidebar')
  })

  it('drops an event older than one already heard', () => {
    const h = hear(hear(NOTHING_HEARD, ev(5, true, 'later words')), ev(4, false, 'earlier guess'))
    expect(h.interim).toEqual([])
    expect(h.seq).toBe(5)
  })

  it('keeps a bounded number of finals', () => {
    let h = NOTHING_HEARD
    for (let i = 0; i < 100; i++) h = hear(h, ev(i, true, 'one two three four five'))
    expect(h.finals.length).toBe(KEEP_FINALS)
  })
})

describe('isLiveWordsEvent', () => {
  it('accepts the desktop’s shape only', () => {
    expect(isLiveWordsEvent(ev(0, true, 'hi'))).toBe(true)
    expect(isLiveWordsEvent({ sessionId: 's', seq: 0, final: true })).toBe(false)
    expect(isLiveWordsEvent({ sessionId: 's', seq: '0', final: true, words: [] })).toBe(false)
    expect(isLiveWordsEvent({ sessionId: 's', seq: 0, final: true, words: [{ startMs: 1 }] })).toBe(false)
    expect(isLiveWordsEvent(null)).toBe(false)
  })
})

describe('scroll', () => {
  it('puts the line a third of the way down, within the content', () => {
    expect(scrollTarget(600, 30, 300, 2000)).toBe(600 + 15 - 100)
    expect(scrollTarget(20, 30, 300, 2000)).toBe(0)
    expect(scrollTarget(1990, 30, 300, 2000)).toBe(1700)
    expect(scrollTarget(50, 30, 300, 200)).toBe(0)
  })

  it('eases toward the target without overshooting, and lands', () => {
    let at = 0
    const seen: number[] = []
    for (let i = 0; i < 200 && at !== 500; i++) { at = easeStep(at, 500, 16); seen.push(at) }
    expect(at).toBe(500)
    expect(seen.every((v, i) => v <= 500 && (i === 0 || v >= seen[i - 1]!))).toBe(true)
    expect(easeStep(100, 100.3, 16)).toBe(100.3)
    expect(easeStep(100, 200, 0)).toBe(100)
  })
})
