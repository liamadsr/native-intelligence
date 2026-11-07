import { describe, expect, it } from 'vitest'
import { CALL_HANDOFF_MAX_CHARS, CallTranscript } from '../transcript'

describe('CallTranscript', () => {
  it('takes what the caller said since the last hand-off, joined into words', () => {
    const t = new CallTranscript()
    t.addInput('What is on', 0, 600)
    t.addInput(' my calendar', 600, 1100)
    t.addInput('tomorrow?', 1200, 1700)
    t.addOutput('Let me check.', 1900, 2500)
    expect(t.takeCallerWords()).toBe('What is on my calendar tomorrow?')
    // Taken: the next hand-off starts after it.
    expect(t.takeCallerWords()).toBe('')
    t.addInput('And Friday', 4000, 4600)
    t.addInput(', too.', 4600, 4900)
    expect(t.takeCallerWords()).toBe('And Friday, too.')
  })

  it("with a hand-off's offset, takes only what was said before it; later words wait for the next", () => {
    const t = new CallTranscript()
    t.addInput('Book lunch with Dana.', 0, 1500)
    t.addInput('And what time is standup?', 6000, 7500)
    expect(t.hasCallerWordsBefore(2000)).toBe(true)
    expect(t.takeCallerWords(2000)).toBe('Book lunch with Dana.')
    expect(t.hasCallerWordsBefore(2000)).toBe(false)
    expect(t.takeCallerWords(8000)).toBe('And what time is standup?')
  })

  it("drops GPT-Live's special tokens, whole or split across fragments", () => {
    const t = new CallTranscript()
    t.addInput('Then also, do I', 0, 800)
    t.addInput(' |>have any new emails?', 800, 2000)
    expect(t.takeCallerWords()).toBe('Then also, do I have any new emails?')
    t.addInput('What about <|Spawn', 3000, 3500)
    t.addInput('Thinking|> tomorrow?', 3500, 4000)
    expect(t.takeCallerWords()).toBe('What about tomorrow?')
    t.addInput('Keep 5 < 6 and a|b as they are.', 5000, 6000)
    expect(t.takeCallerWords()).toBe('Keep 5 < 6 and a|b as they are.')
  })

  it('ignores empty or non-text fragments, and fills missing times', () => {
    const t = new CallTranscript()
    t.addInput('', 0, 10)
    t.addInput(7, 0, 10)
    t.addInput('Hi', undefined, undefined)
    expect(t.takeCallerWords()).toBe('Hi')
    expect(t.lastCallerEndMs()).toBe(0)
  })

  it('keeps the newest words when a hand-off carries too many, cut at a word', () => {
    const t = new CallTranscript()
    for (let i = 0; i < 1000; i++) t.addInput(`word${i}`, i * 10, i * 10 + 9)
    const words = t.takeCallerWords()
    expect(words.length).toBeLessThanOrEqual(CALL_HANDOFF_MAX_CHARS)
    expect(words.endsWith('word999')).toBe(true)
    expect(words.split(' ')[0]).toMatch(/^word\d+$/)
  })

  it('counts characters for the log, both sides', () => {
    const t = new CallTranscript()
    t.addInput('hello', 0, 1)
    t.addOutput('hi there', 2, 3)
    expect(t.counts()).toEqual({ callerChars: 5, agentChars: 8 })
  })
})
