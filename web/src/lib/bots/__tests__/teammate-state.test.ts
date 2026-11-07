/**
 * teammateBotState (teammate-state.ts): a teammate's bot is working while it
 * runs something, asleep while it is switched off, its role's breaker is
 * open, or the AI usage limit stopped it, and idle otherwise. Running work
 * wins. teammateRest says which (off first, then paused, then the limit), in
 * the words the agent's page and the main agent's reads use.
 */
import { describe, expect, it } from 'vitest'
import { TEAMMATE_REST_WORDS, teammateBotState, teammateRest } from '../teammate-state'

const on = { autonomy: 'propose', breaker: null }

describe('teammateBotState', () => {
  it('is working while it runs something', () => {
    expect(teammateBotState(on, 1)).toBe('working')
    expect(teammateBotState({ autonomy: 'attempt', breaker: { paused: false } }, 3)).toBe('working')
  })

  it('is asleep while its autonomy is off', () => {
    expect(teammateBotState({ autonomy: 'off', breaker: null }, 0)).toBe('sleeping')
  })

  it('is asleep while its role’s breaker has paused its attempts', () => {
    expect(teammateBotState({ autonomy: 'attempt', breaker: { paused: true } }, 0)).toBe('sleeping')
  })

  it('is asleep while the AI usage limit has stopped it', () => {
    expect(teammateBotState(on, 0, true)).toBe('sleeping')
  })

  it('running work wins over off, paused and the AI limit', () => {
    expect(teammateBotState({ autonomy: 'off', breaker: { paused: true } }, 1)).toBe('working')
    expect(teammateBotState(on, 2, true)).toBe('working')
  })

  it('is idle otherwise', () => {
    expect(teammateBotState(on, 0)).toBe('default')
    expect(teammateBotState({ autonomy: 'attempt', breaker: { paused: false } }, 0)).toBe('default')
    expect(teammateBotState({ autonomy: null, breaker: null }, 0)).toBe('default')
  })
})

describe('teammateRest', () => {
  it('says why it sleeps: switched off first, then its attempts paused, then the AI limit', () => {
    expect(teammateRest({ autonomy: 'off', breaker: { paused: true } }, true)).toBe('off')
    expect(teammateRest({ autonomy: 'attempt', breaker: { paused: true } }, true)).toBe('paused')
    expect(teammateRest(on, true)).toBe('ai_limit')
    expect(teammateRest(on)).toBeNull()
  })

  it('in the words its bubble, page and list entry say', () => {
    expect(TEAMMATE_REST_WORDS).toEqual({ off: 'Switched off', paused: 'Attempts paused', ai_limit: 'Stopped by the AI limit' })
  })
})
