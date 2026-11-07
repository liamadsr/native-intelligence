import { describe, it, expect, vi } from 'vitest'
import { runVoiceIdHudAction, voiceIdHudState, type VoiceIdHudHandlers } from '../voice-id-hud'
import type { SpeakerIdentification } from '@/lib/voice-id-service'

/**
 * Voice ID in the live agent's HUD: the state the recording window sends, and
 * the HUD clicks it runs. A click arrives from another window, so it runs only
 * when well formed and for the capture this window records.
 */

function handlers(): Record<keyof VoiceIdHudHandlers, ReturnType<typeof vi.fn>> {
  return {
    assignContact: vi.fn(),
    acceptSuggestion: vi.fn(),
    dismissSuggestion: vi.fn(),
    unlinkSpeaker: vi.fn(),
    confirmPostSessionSpeaker: vi.fn(),
    reassignPostSessionSpeaker: vi.fn(),
    confirmSelf: vi.fn(),
    dismissSelf: vi.fn(),
  }
}

const base = {
  captureId: 'cap-1',
  workspaceId: 'ws-1',
  detectedSpeakers: ['local_1', 'remote_1'],
  activeSpeaker: 'remote_1',
  speakerNames: { remote_1: 'Sam' },
  postSessionReview: null,
  selfSuggestion: null,
}

describe('voiceIdHudState', () => {
  it("sets each suggestion's countdown to its live tick, with when it runs out, and leaves links alone", () => {
    const suggestion: SpeakerIdentification = {
      contactId: 'c-1', contactName: 'Sam', confidence: 0.82, isAutoMatched: true, isSuggestion: true, autoAcceptCountdown: 10,
    }
    const linked: SpeakerIdentification = { contactId: 'c-2', contactName: 'Ana', confidence: 1, isAutoMatched: false }
    const getTick = vi.fn((s: SpeakerIdentification) => (s === suggestion ? 7 : 99))

    const state = voiceIdHudState({ ...base, speakerContacts: { remote_1: suggestion, remote_2: linked } }, getTick, 1_000_000)

    expect(state.speakerContacts.remote_1).toEqual({ ...suggestion, autoAcceptCountdown: 7, autoAcceptAt: 1_007_000 })
    expect(state.speakerContacts.remote_2).toBe(linked)
    // The recording's own entry is never mutated.
    expect(suggestion.autoAcceptCountdown).toBe(10)
  })

  it('counts a suggestion from its own countdown before its first tick; one with no countdown is left as it is', () => {
    const suggestion: SpeakerIdentification = {
      contactId: 'c-1', contactName: 'Sam', confidence: 0.82, isAutoMatched: true, isSuggestion: true, autoAcceptCountdown: 10,
    }
    const state = voiceIdHudState({ ...base, speakerContacts: { remote_1: suggestion } }, () => undefined, 5_000)
    expect(state.speakerContacts.remote_1).toEqual({ ...suggestion, autoAcceptAt: 15_000 })
    const plain: SpeakerIdentification = { contactId: 'c-1', contactName: 'Sam', confidence: 0.6, isAutoMatched: false, isSuggestion: true }
    expect(voiceIdHudState({ ...base, speakerContacts: { remote_1: plain } }).speakerContacts.remote_1).toBe(plain)
  })

  it('sends the demoted self labels as a list (a Set does not cross windows)', () => {
    const state = voiceIdHudState({ ...base, speakerContacts: {}, demotedSelfLabels: new Set(['local_1']) })
    expect(state.demotedSelfLabels).toEqual(['local_1'])
    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
  })
})

describe('runVoiceIdHudAction', () => {
  it('runs every speaker action through its handler', () => {
    for (const type of [
      'acceptSuggestion',
      'dismissSuggestion',
      'unlinkSpeaker',
      'confirmSelf',
      'dismissSelf',
      'confirmPostSessionSpeaker',
    ] as const) {
      const h = handlers()
      expect(runVoiceIdHudAction({ captureId: 'cap-1', type, speaker: 'remote_1' }, 'cap-1', h)).toBe(true)
      expect(h[type]).toHaveBeenCalledWith('remote_1')
    }
  })

  it('runs a contact pick, with the contact', () => {
    const h = handlers()
    runVoiceIdHudAction(
      { captureId: 'cap-1', type: 'assignContact', speaker: 'remote_1', contactId: 'c-9', contactName: 'Lee' },
      'cap-1',
      h,
    )
    expect(h.assignContact).toHaveBeenCalledWith('remote_1', 'c-9', 'Lee')
    runVoiceIdHudAction(
      { captureId: 'cap-1', type: 'reassignPostSessionSpeaker', speaker: 'remote_1', contactId: 'c-8', contactName: 'Kim' },
      'cap-1',
      h,
    )
    expect(h.reassignPostSessionSpeaker).toHaveBeenCalledWith('remote_1', 'c-8', 'Kim')
  })

  it('ignores another capture, no capture, and anything malformed', () => {
    const h = handlers()
    const ok = { captureId: 'cap-1', type: 'acceptSuggestion', speaker: 'remote_1' }
    expect(runVoiceIdHudAction(ok, 'cap-2', h)).toBe(false)
    expect(runVoiceIdHudAction(ok, null, h)).toBe(false)
    expect(runVoiceIdHudAction(null, 'cap-1', h)).toBe(false)
    expect(runVoiceIdHudAction('acceptSuggestion', 'cap-1', h)).toBe(false)
    expect(runVoiceIdHudAction({ ...ok, speaker: '' }, 'cap-1', h)).toBe(false)
    expect(runVoiceIdHudAction({ ...ok, type: 'deleteEverything' }, 'cap-1', h)).toBe(false)
    expect(runVoiceIdHudAction({ ...ok, type: 'assignContact' }, 'cap-1', h)).toBe(false) // no contact
    expect(Object.values(h).some((fn) => fn.mock.calls.length > 0)).toBe(false)
  })
})
