// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { insertDictation, splitTranscript, tailPrefix, tailSuffix, newVoiceSessionId, isVoiceReadyState, isVoiceReadyEvent } from '../dictation-text'
import { VOICE_PAUSE_KEY, getVoicePause, interactiveStartOptions, setVoicePause, voiceStartOptions } from '../settings'

describe('insertDictation', () => {
  it('into an empty field: just the words, caret after them', () => {
    expect(insertDictation('', 0, 0, '  hello world ')).toEqual({ value: 'hello world', caret: 11 })
  })

  it('after text: a separating space', () => {
    expect(insertDictation('Draft', 5, 5, 'the reply')).toEqual({ value: 'Draft the reply', caret: 15 })
    // Already a space: no second one.
    expect(insertDictation('Draft ', 6, 6, 'the reply')).toEqual({ value: 'Draft the reply', caret: 15 })
  })

  it('mid-text: spaces on both sides, but none before punctuation', () => {
    expect(insertDictation('Ask about', 3, 3, 'Maya')).toEqual({ value: 'Ask Maya about', caret: 8 })
    expect(insertDictation('Call her.', 8, 8, 'tomorrow')).toEqual({ value: 'Call her tomorrow.', caret: 17 })
  })

  it('replaces a selection', () => {
    expect(insertDictation('Email Bob today', 6, 9, 'Alice')).toEqual({ value: 'Email Alice today', caret: 11 })
  })

  it('no words → no change', () => {
    expect(insertDictation('abc', 1, 1, '   ')).toEqual({ value: 'abc', caret: 1 })
  })

  it('clamps a caret past the end', () => {
    expect(insertDictation('ab', 99, 99, 'c')).toEqual({ value: 'ab c', caret: 4 })
  })
})

describe('splitTranscript / tail spacing', () => {
  it('the text past the last final is interim', () => {
    expect(splitTranscript('hello there wor', 'hello there')).toEqual({ final: 'hello there', interim: ' wor' })
    expect(splitTranscript('hello', '')).toEqual({ final: '', interim: 'hello' })
    // A revision that no longer extends the final: all interim.
    expect(splitTranscript('yellow', 'hello')).toEqual({ final: '', interim: 'yellow' })
  })

  it('the preview gets the same spaces the insert will', () => {
    expect(tailPrefix('Draft', 5)).toBe(' ')
    expect(tailPrefix('Draft ', 6)).toBe('')
    expect(tailPrefix('', 0)).toBe('')
    expect(tailSuffix('about')).toBe(' ')
    expect(tailSuffix('.')).toBe('')
    expect(tailSuffix('')).toBe('')
  })

  it('session ids are unique and name their mode', () => {
    const a = newVoiceSessionId('dictation')
    const b = newVoiceSessionId('dictation')
    expect(a).not.toBe(b)
    expect(a.startsWith('dict-')).toBe(true)
    expect(newVoiceSessionId('conversation').startsWith('conv-')).toBe(true)
  })
})

describe('isVoiceReadyState', () => {
  it('any state past starting means the model is up; muted hides it', () => {
    expect(isVoiceReadyState('starting')).toBe(false)
    expect(isVoiceReadyState('muted')).toBe(false)
    for (const state of ['listening', 'user_speaking', 'processing', 'agent_speaking'] as const) {
      expect(isVoiceReadyState(state)).toBe(true)
    }
  })
})

describe('isVoiceReadyEvent', () => {
  it('with `ready` (a readyFlag desktop): the flag alone decides, whatever the state', () => {
    // Muted before ready, then readiness re-sent under the same muted state.
    expect(isVoiceReadyEvent({ state: 'muted', ready: false })).toBe(false)
    expect(isVoiceReadyEvent({ state: 'muted', ready: true })).toBe(true)
    // Speech that began while local-stt was still loading.
    expect(isVoiceReadyEvent({ state: 'user_speaking', ready: false })).toBe(false)
    expect(isVoiceReadyEvent({ state: 'user_speaking', ready: true })).toBe(true)
    expect(isVoiceReadyEvent({ state: 'listening', ready: false })).toBe(false)
  })

  it('without it (0.2.45): inferred from the state', () => {
    expect(isVoiceReadyEvent({ state: 'starting' })).toBe(false)
    expect(isVoiceReadyEvent({ state: 'muted' })).toBe(false)
    expect(isVoiceReadyEvent({ state: 'listening' })).toBe(true)
    expect(isVoiceReadyEvent({ state: 'user_speaking' })).toBe(true)
  })
})

describe('voice mode settings', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('defaults: Long pause (1200 ms), barge-in always on — nothing stored', () => {
    expect(getVoicePause()).toBe('long')
    expect(voiceStartOptions()).toEqual({ endSilenceMs: 1200, bargeIn: true, noiseProfile: 'quiet' })
  })

  it('stores only non-defaults, and maps to voice_start', () => {
    setVoicePause('short')
    expect(window.localStorage.getItem(VOICE_PAUSE_KEY)).toBe('short')
    expect(voiceStartOptions()).toEqual({ endSilenceMs: 500, bargeIn: true, noiseProfile: 'quiet' })
    setVoicePause('normal')
    expect(window.localStorage.getItem(VOICE_PAUSE_KEY)).toBe('normal')
    expect(voiceStartOptions().endSilenceMs).toBe(700)
    setVoicePause('long')
    expect(window.localStorage.getItem(VOICE_PAUSE_KEY)).toBeNull()
  })

  it('junk or throwing storage reads as defaults', () => {
    window.localStorage.setItem(VOICE_PAUSE_KEY, 'forever')
    expect(getVoicePause()).toBe('long')
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(getVoicePause()).toBe('long')
    expect(() => setVoicePause('short')).not.toThrow()
  })

  it('every session asks for the quiet room: turns by speech alone, whatever an older build stored', () => {
    expect(voiceStartOptions().noiseProfile).toBe('quiet')
    expect(interactiveStartOptions()).toEqual({ endSilenceMs: 1200, noiseProfile: 'quiet' })
    for (const stored of ['noisy', 'auto', 'quiet']) {
      window.localStorage.setItem('ni:voice:noise', stored)
      expect(voiceStartOptions().noiseProfile).toBe('quiet')
      expect(interactiveStartOptions().noiseProfile).toBe('quiet')
    }
  })
})
