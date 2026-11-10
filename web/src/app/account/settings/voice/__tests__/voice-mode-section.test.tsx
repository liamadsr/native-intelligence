// @vitest-environment jsdom
/**
 * Settings → Voice → Voice mode (docs/plans/chat-voice.md §3.4).
 *
 *  - Nothing in the browser, or on a desktop whose voice_status says no voice.
 *  - "Pause before sending" (Short 0.5 s / Normal 0.7 s / Long 1.2 s, Long by
 *    default), stored device-locally and read by voice_start.
 *  - No "Interrupt by talking" setting: talking over the agent always interrupts.
 *  - A note when voice mode's modules aren't set up yet.
 *  - No "Background noise" setting: every session asks for the quiet room.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { VoiceStatus } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({ desktop: true, status: null as VoiceStatus | null }))

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => hoisted.desktop }))
vi.mock('@/lib/voice/status-store', () => ({
  useVoiceStatus: () =>
    hoisted.status ?? { available: false, dictation: false, conversation: false, stt: 'unsupported', tts: 'unsupported' },
}))

import { VoiceModeSection } from '../voice-mode-section'
import { VOICE_PAUSE_KEY, voiceStartOptions } from '@/lib/voice/settings'

const READY: VoiceStatus = { available: true, dictation: true, conversation: true, stt: 'ready', tts: 'ready' }

let container: HTMLDivElement
let root: Root

function mount() {
  act(() => root.render(h(VoiceModeSection)))
}

beforeEach(() => {
  hoisted.desktop = true
  hoisted.status = READY
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('VoiceModeSection', () => {
  it('renders nothing in the browser or without voice', () => {
    hoisted.desktop = false
    mount()
    expect(container.innerHTML).toBe('')
    hoisted.desktop = true
    hoisted.status = { ...READY, available: false }
    mount()
    expect(container.innerHTML).toBe('')
  })

  it('shows the pause (Long by default), and no Interrupt by talking setting', () => {
    mount()
    const section = container.querySelector('[data-testid="voice-mode-section"]')!
    expect(section.textContent).toContain('Voice mode')
    expect(section.textContent).toContain('Pause before sending')
    expect(container.querySelector('[aria-label="Pause before sending"]')!.textContent).toContain('Long (1.2 s)')
    expect(container.querySelector('[aria-label="Interrupt by talking"]')).toBeNull()
    expect(section.textContent).not.toContain('Interrupt by talking')
    expect(section.textContent).not.toContain('needs On-device transcription')
  })

  it('voice_start always gets barge-in, even with an old stored "off"', () => {
    window.localStorage.setItem('ni:voice:barge-in', '0')
    mount()
    expect(voiceStartOptions().bargeIn).toBe(true)
  })

  it('reads a stored pause', () => {
    window.localStorage.setItem(VOICE_PAUSE_KEY, 'normal')
    mount()
    expect(container.querySelector('[aria-label="Pause before sending"]')!.textContent).toContain('Normal (0.7 s)')
  })

  it('no Background noise setting on any desktop: every session asks for the quiet room', () => {
    for (const noiseProfiles of [undefined, ['quiet'], ['quiet', 'noisy'], ['quiet', 'noisy', 'auto']]) {
      hoisted.status = { ...READY, noiseProfiles, readyFlag: true }
      mount()
      expect(container.querySelector('[aria-label="Background noise"]')).toBeNull()
      expect(container.textContent).not.toContain('Background noise')
      act(() => root.unmount())
      root = createRoot(container)
    }
    // A room an older build stored is not read.
    window.localStorage.setItem('ni:voice:noise', 'noisy')
    expect(voiceStartOptions().noiseProfile).toBe('quiet')
  })

  it('says what is missing when voice mode is not set up', () => {
    hoisted.status = { ...READY, conversation: false, tts: 'missing' }
    mount()
    expect(container.textContent).toContain('It needs On-device transcription (Settings → Audio) and Read aloud')
  })
})
