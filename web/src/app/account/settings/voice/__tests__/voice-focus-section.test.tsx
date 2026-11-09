// @vitest-environment jsdom
/**
 * Settings → Voice → Voice focus (src/lib/voice/voice-focus.ts):
 *  - nothing in the browser, or on a desktop whose voice_status lacks
 *    `speechAudio`;
 *  - not trained: the switch off and disabled, "Train your voice" opens the
 *    enrollment flow (whatever was stored stays unused);
 *  - trained: a working switch, off by default, stored device-locally
 *    (`dial8:voice:focus` = 'on', absent = off).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { VoiceStatus } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({ desktop: true, status: null as VoiceStatus | null }))

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => hoisted.desktop }))
vi.mock('@/lib/voice/status-store', () => ({ useVoiceStatus: () => hoisted.status }))

import { VoiceFocusSection } from '../voice-focus-section'
import { VOICE_FOCUS_KEY, getVoiceFocus } from '@/lib/voice/settings'

const SPEECH: VoiceStatus = { available: true, dictation: true, conversation: true, stt: 'ready', tts: 'ready', speechAudio: true }

let container: HTMLDivElement
let root: Root
const onTrain = vi.fn()

function mount(trained: boolean) {
  act(() => root.render(h(VoiceFocusSection, { trained, onTrain })))
}

const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"]')
const trainButton = () => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Train your voice'))

beforeEach(() => {
  hoisted.desktop = true
  hoisted.status = SPEECH
  onTrain.mockReset()
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('VoiceFocusSection', () => {
  it('renders nothing in the browser, or without the desktop’s speech audio', () => {
    hoisted.desktop = false
    mount(true)
    expect(container.innerHTML).toBe('')
    hoisted.desktop = true
    hoisted.status = { ...SPEECH, speechAudio: undefined }
    mount(true)
    expect(container.innerHTML).toBe('')
  })

  it('says what it does', () => {
    mount(true)
    expect(container.textContent).toContain('Voice focus')
    expect(container.textContent).toContain(
      'Only respond to you and people Native Intelligence recognises by voice. Voices it doesn’t know, like a TV or people nearby, are ignored. Turn it off to hear everyone.',
    )
  })

  it('not trained: the switch is off and disabled, and "Train your voice" opens the enrollment flow', () => {
    window.localStorage.setItem(VOICE_FOCUS_KEY, 'on')
    mount(false)
    expect(container.querySelector('[data-testid="voice-focus-section"]')?.getAttribute('data-trained')).toBe('false')
    expect(toggle()?.getAttribute('aria-checked')).toBe('false')
    expect(toggle()?.disabled).toBe(true)
    expect(container.textContent).toContain('Train your voice first so Native Intelligence knows it’s you.')
    act(() => trainButton()!.click())
    expect(onTrain).toHaveBeenCalledTimes(1)
  })

  it('trained: off by default, and the switch turns it on and off on this device', () => {
    mount(true)
    expect(trainButton()).toBeUndefined()
    expect(toggle()?.disabled).toBe(false)
    expect(toggle()?.getAttribute('aria-checked')).toBe('false')
    act(() => toggle()!.click())
    expect(toggle()?.getAttribute('aria-checked')).toBe('true')
    expect(window.localStorage.getItem(VOICE_FOCUS_KEY)).toBe('on')
    expect(getVoiceFocus()).toBe(true)
    act(() => toggle()!.click())
    expect(window.localStorage.getItem(VOICE_FOCUS_KEY)).toBeNull()
    expect(getVoiceFocus()).toBe(false)
  })

  it('trained, with it stored on: shows on', () => {
    window.localStorage.setItem(VOICE_FOCUS_KEY, 'on')
    mount(true)
    expect(toggle()?.getAttribute('aria-checked')).toBe('true')
  })
})
