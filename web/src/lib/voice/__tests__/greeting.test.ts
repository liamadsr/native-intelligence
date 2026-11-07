import { describe, it, expect, beforeEach } from 'vitest'
import { VOICE_GREETINGS, __resetGreetingForTests, pickGreeting } from '../greeting'

describe('pickGreeting', () => {
  beforeEach(() => __resetGreetingForTests())

  it('says one of the four lines', () => {
    expect(VOICE_GREETINGS).toEqual(['Hey', 'Yo', "What's up?", 'What we doing?'])
    expect(VOICE_GREETINGS).toContain(pickGreeting())
  })

  it('never says the same one twice in a row, even when the dice insist', () => {
    const stuck = () => 0
    const picks = Array.from({ length: 12 }, () => pickGreeting(stuck))
    for (let i = 1; i < picks.length; i++) expect(picks[i]).not.toBe(picks[i - 1])
    // The edge of the range (random() just under 1) stays in bounds.
    expect(VOICE_GREETINGS).toContain(pickGreeting(() => 0.999999))
  })

  it('over many starts: never a repeat, and every line comes up', () => {
    const picks = Array.from({ length: 400 }, () => pickGreeting())
    for (let i = 1; i < picks.length; i++) expect(picks[i]).not.toBe(picks[i - 1])
    expect(new Set(picks)).toEqual(new Set(VOICE_GREETINGS))
  })
})
