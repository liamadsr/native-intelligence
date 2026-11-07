import { describe, it, expect } from 'vitest'
import { ECHO_OVERLAP, MIN_FUZZY_LETTERS, isEchoOf, matchWakeWord, phoneticKey } from '../wake-word'

/**
 * Interactive mode's wake word (../wake-word): the assistant's name heard in a
 * transcript, forgiving what on-device speech recognition gets wrong, and the
 * request that is left once the name (and its filler) is taken out.
 */

const ask = (text: string, name = 'Joseph') => matchWakeWord(text, name)

describe('matchWakeWord: the name', () => {
  it('matches the name at the start, in the middle and at the end', () => {
    expect(ask('Joseph, can you look something up for me?')).toEqual({
      matched: true,
      request: 'Can you look something up for me?',
    })
    expect(ask('Can you, Joseph, look this up')).toEqual({ matched: true, request: 'Can you look this up' })
    expect(ask("What's on my calendar tomorrow, Joseph?")).toEqual({
      matched: true,
      request: "What's on my calendar tomorrow?",
    })
  })

  it('ignores case, punctuation and accents', () => {
    expect(ask('JOSEPH! stop')).toEqual({ matched: true, request: 'Stop' })
    expect(ask('joseph... what time is it')).toEqual({ matched: true, request: 'What time is it' })
    expect(ask('José, hola', 'Jose').matched).toBe(true)
    expect(ask('Jose, hola', 'José').matched).toBe(true)
  })

  it('counts a possessive or contraction on the name', () => {
    expect(ask("Joseph's the deal still on?").matched).toBe(true)
    expect(ask('Joseph’s calendar is full').matched).toBe(true)
    expect(ask("Joseph'll know").matched).toBe(true)
  })

  it('takes a leading "hey" / "ok" with the name', () => {
    expect(ask('Hey Joseph, what changed in this thread?')).toEqual({
      matched: true,
      request: 'What changed in this thread?',
    })
    expect(ask('ok joseph summarize it')).toEqual({ matched: true, request: 'Summarize it' })
    expect(ask('Okay, so, Joseph read me the next one')).toEqual({ matched: true, request: 'Read me the next one' })
  })

  it('a longer name forgives one slip that keeps the first sound, and spellings that sound the same', () => {
    expect('Joseph'.length).toBeGreaterThanOrEqual(MIN_FUZZY_LETTERS)
    expect(ask('Josephs, are you there').matched).toBe(true)
    expect(ask('Joaeph what is this').matched).toBe(true)
    expect(ask('Josef, open my inbox').matched).toBe(true)
    expect(ask('Jozef open my inbox').matched).toBe(true)
    // Two words run together into it.
    expect(ask('joe seph can you help')).toEqual({ matched: true, request: 'Can you help' })
    // Not the first sound, and not alike.
    expect(ask('Hoseph, help').matched).toBe(false)
    expect(ask('Joker, help').matched).toBe(false)
    expect(ask('Josh, help').matched).toBe(false)
  })

  it('a short name only matches exactly', () => {
    expect(ask('Max, what is next', 'Max')).toEqual({ matched: true, request: 'What is next' })
    expect(ask('max what is next', 'Max').matched).toBe(true)
    expect(ask('Mac, what is next', 'Max').matched).toBe(false)
    expect(ask('That makes sense', 'Max').matched).toBe(false)
    expect(ask('Alex? are you there', 'Alex').matched).toBe(true)
    expect(ask('Alec, are you there', 'Alex').matched).toBe(false)
  })

  it('matches a name of several words in a row, hyphenated or run together', () => {
    expect(ask('Mary Jane, find the contract', 'Mary Jane')).toEqual({ matched: true, request: 'Find the contract' })
    expect(ask('mary-jane find the contract', 'Mary Jane').matched).toBe(true)
    expect(ask('Maryjane find the contract', 'Mary-Jane').matched).toBe(true)
    expect(ask('Find the contract, Mary Jane.', 'Mary-Jane')).toEqual({ matched: true, request: 'Find the contract.' })
    // Only one of the words is no call.
    expect(ask('Mary, find the contract', 'Mary Jane').matched).toBe(false)
    expect(ask('Jane find the contract', 'Mary Jane').matched).toBe(false)
  })

  it('takes an apostrophe in the name as written or not', () => {
    expect(ask("O'Neil, call it", "O'Neil").matched).toBe(true)
    expect(ask('Oneil call it', "O'Neil").matched).toBe(true)
  })

  it('does not match without the name, inside another word, or with no name at all', () => {
    expect(ask('Can you look something up for me?')).toEqual({ matched: false, request: '' })
    expect(ask('Josephine said hi').matched).toBe(false)
    expect(ask('')).toEqual({ matched: false, request: '' })
    expect(ask('Joseph, hi', '')).toEqual({ matched: false, request: '' })
    expect(ask('Joseph, hi', '  - ')).toEqual({ matched: false, request: '' })
  })
})

describe('matchWakeWord: the request', () => {
  it('is empty for the name alone, or the name with only fillers', () => {
    expect(ask('Joseph?')).toEqual({ matched: true, request: '' })
    expect(ask('Hey Joseph.')).toEqual({ matched: true, request: '' })
    expect(ask('um, joseph, uh')).toEqual({ matched: true, request: '' })
    expect(ask('Joseph')).toEqual({ matched: true, request: '' })
  })

  it('keeps the question mark that ended the sentence when the name came last', () => {
    expect(ask('Is it raining, Joseph?').request).toBe('Is it raining?')
    expect(ask('Is it raining Joseph').request).toBe('Is it raining')
  })

  it('takes the first time the name is heard', () => {
    expect(ask('Joseph, tell Joseph hi').request).toBe('Tell Joseph hi')
  })

  it('capitalizes the request and tidies its spaces', () => {
    expect(ask('joseph,    what   is   next').request).toBe('What is next')
  })

  it('keeps a filler that is not a lead-in to the name', () => {
    expect(ask('So what do you think, Joseph?').request).toBe('So what do you think?')
  })
})

describe('phoneticKey', () => {
  it('folds spellings that sound alike together', () => {
    expect(phoneticKey('Joseph')).toBe(phoneticKey('Josef'))
    expect(phoneticKey('Joseph')).toBe(phoneticKey('Jozef'))
    expect(phoneticKey('Catherine')).toBe(phoneticKey('Katherine'))
    expect(phoneticKey('Sarah')).toBe(phoneticKey('Sara'))
    expect(phoneticKey('Joseph')).not.toBe(phoneticKey('Josh'))
  })

  it('is empty for nothing to sound out', () => {
    expect(phoneticKey('')).toBe('')
    expect(phoneticKey('123')).toBe('')
  })
})

describe('isEchoOf (the echo guard)', () => {
  const reading = ['Joseph said the budget is due on Friday.', 'Maya will review it first.']

  it('is an echo when the words are inside a sentence just said, in order', () => {
    expect(isEchoOf('Joseph said the budget', reading)).toBe(true)
    expect(isEchoOf('the budget is due on friday', reading)).toBe(true)
    // Straddling the last two.
    expect(isEchoOf('on Friday Maya will review', reading)).toBe(true)
  })

  it('is an echo when most of its words are in one sentence just said', () => {
    expect(ECHO_OVERLAP).toBe(0.7)
    // The recogniser garbled the order and a word, but it is the reading.
    expect(isEchoOf('Joseph said budget due Friday is the', reading)).toBe(true)
    expect(isEchoOf('Joseph says the budget is due Friday', reading)).toBe(true)
  })

  it('is not an echo when it is the user’s own words', () => {
    expect(isEchoOf('Joseph, can you summarize this for me?', reading)).toBe(false)
    expect(isEchoOf('Joseph, who is Maya?', reading)).toBe(false)
  })

  it('nothing said, or nothing heard: not an echo', () => {
    expect(isEchoOf('Joseph said the budget', [])).toBe(false)
    expect(isEchoOf('', reading)).toBe(false)
    expect(isEchoOf('...', reading)).toBe(false)
  })
})
