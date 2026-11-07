// @vitest-environment jsdom
/**
 * Voice copy and Esc:
 *  - An `unavailable` refusal with a runtime detail (the mic or the audio
 *    thread didn't start) says so; only the bare code or a missing command
 *    reads "not available on this version" (W-8).
 *  - An idle end while the reply is pending doesn't claim 5 minutes of
 *    silence (W-10).
 *  - isVoiceEscape leaves an Esc someone else claimed alone (W-4).
 */
import { describe, it, expect } from 'vitest'
import { VoiceRefusedError } from '@/lib/tauri-bridge'
import { voiceEndedMessage, voiceRefusalInfo, voiceRefusalMessage } from '../messages'
import { isVoiceEscape } from '../escape'

const VERSION = 'Voice isn’t available on this version of Dial8.'

describe('voiceRefusalInfo', () => {
  it('reads the code and the desktop detail from the bridge error', () => {
    // The bridge keeps the whole desktop text as the detail, so its code repeats.
    const err = new VoiceRefusedError('unavailable', 'unavailable: the microphone could not start: device busy')
    expect(voiceRefusalInfo(err)).toEqual({ code: 'unavailable', detail: 'the microphone could not start: device busy' })
    expect(voiceRefusalInfo(new VoiceRefusedError('unavailable'))).toEqual({ code: 'unavailable', detail: null })
    expect(voiceRefusalInfo(new VoiceRefusedError('busy', 'busy'))).toEqual({ code: 'busy', detail: null })
    expect(voiceRefusalInfo(new VoiceRefusedError('unavailable', 'command voice_start not found'))).toEqual({
      code: 'unavailable',
      detail: 'command voice_start not found',
    })
    expect(voiceRefusalInfo(new Error('boom'))).toEqual({ code: 'unavailable', detail: 'boom' })
    expect(voiceRefusalInfo(null)).toEqual({ code: 'unavailable', detail: null })
  })
})

describe('voiceRefusalMessage', () => {
  it('unavailable with a runtime detail: the microphone could not start, with the reason', () => {
    expect(voiceRefusalMessage('unavailable', 'the audio thread could not start')).toBe(
      'Couldn’t start the microphone (the audio thread could not start).',
    )
    expect(voiceRefusalMessage('unavailable', 'the microphone start failed.')).toBe(
      'Couldn’t start the microphone (the microphone start failed).',
    )
    const long = voiceRefusalMessage('unavailable', 'x'.repeat(400))
    expect(long.length).toBeLessThan(200)
  })

  it('unavailable bare, or a command the desktop does not have: this version', () => {
    expect(voiceRefusalMessage('unavailable')).toBe(VERSION)
    expect(voiceRefusalMessage('unavailable', null)).toBe(VERSION)
    expect(voiceRefusalMessage('unavailable', 'command voice_start not found')).toBe(VERSION)
    expect(voiceRefusalMessage('unavailable', 'voice_start not allowed. Plugin not found')).toBe(VERSION)
  })

  it('unavailable: lid_closed (the MacBook mic, lid shut): says so and what to do', () => {
    const LID = 'Your MacBook’s lid is closed, so its microphone is off. Connect a mic or open the lid.'
    // The way it arrives from the bridge: the code repeated in the detail.
    const info = voiceRefusalInfo(new VoiceRefusedError('unavailable', 'unavailable: lid_closed'))
    expect(info).toEqual({ code: 'unavailable', detail: 'lid_closed' })
    expect(voiceRefusalMessage(info.code, info.detail)).toBe(LID)
    expect(voiceRefusalMessage('unavailable', 'lid_closed: built-in mic')).toBe(LID)
    // Not a prefix match on something else.
    expect(voiceRefusalMessage('unavailable', 'lid_closedish')).not.toBe(LID)
  })

  it('the other codes keep their own copy whatever the detail', () => {
    expect(voiceRefusalMessage('busy', 'another window')).toBe('Voice is already in use in another Dial8 window.')
    expect(voiceRefusalMessage('mic_denied')).toContain('Privacy & Security')
  })
})

describe('voiceEndedMessage', () => {
  it('idle: silence, or, with a reply still coming, that Dial8 was still working', () => {
    expect(voiceEndedMessage('idle', 'conversation')).toBe('Voice mode ended after 5 minutes of silence.')
    const pending = voiceEndedMessage('idle', 'conversation', { replyPending: true })!
    expect(pending).not.toContain('silence')
    expect(pending).toContain('still working')
    expect(voiceEndedMessage('idle', 'dictation', { replyPending: true })).toBeNull()
  })
})

describe('isVoiceEscape', () => {
  const esc = (target: Element, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init })
    let result = false
    const listen = (ev: KeyboardEvent) => {
      result = isVoiceEscape(ev)
    }
    document.addEventListener('keydown', listen)
    target.dispatchEvent(e)
    document.removeEventListener('keydown', listen)
    return result
  }

  it('a plain Esc is voice’s; another key, a handled or composing Esc is not', () => {
    expect(esc(document.body)).toBe(true)
    expect(esc(document.body, { key: 'Enter' })).toBe(false)
    expect(esc(document.body, { isComposing: true })).toBe(false)
    const handled = document.createElement('input')
    handled.addEventListener('keydown', (e) => e.preventDefault())
    document.body.appendChild(handled)
    expect(esc(handled)).toBe(false)
    handled.remove()
  })

  it('from inside an overlay without the voice controls: not voice’s', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const inner = document.createElement('button')
    dialog.appendChild(inner)
    document.body.appendChild(dialog)
    expect(esc(inner)).toBe(false)
    const mic = document.createElement('button')
    mic.setAttribute('data-voice-control', 'dictation')
    dialog.appendChild(mic)
    expect(esc(inner)).toBe(true)
    dialog.remove()
  })
})
