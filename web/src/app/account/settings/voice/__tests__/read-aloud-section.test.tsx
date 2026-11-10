// @vitest-environment jsdom
/**
 * Settings → Voice → Read aloud (desktop local-tts).
 *
 * Contract pinned here:
 *  - Nothing in the browser, or on a desktop whose modules_list lacks
 *    local-tts (no system-voice fallback, no bridge calls in the browser).
 *  - The generic LocalModuleRow with the read-aloud copy, its download size
 *    and the Kyutai Pocket TTS / CC BY 4.0 credit (links open in the OS
 *    browser).
 *  - Once Ready: an Auto-read switch and a voice picker fed by tts_voices,
 *    both stored device-locally; Preview speaks a sample in the chosen voice.
 *
 * The real useLocalModule drives the section; the bridge is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { LocalModuleInfo, TtsStatePayload, TtsVoice } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bridge = vi.hoisted(() => ({
  desktop: true,
  modules: [] as unknown[],
  voices: [] as unknown[],
  calls: [] as Array<[string, unknown?]>,
  speakError: null as unknown,
  /** The desktop's Speed; null: a build without it. */
  rate: null as number | null,
  recording: null as null | { isRecording: boolean; isStarting: boolean },
  ttsListeners: new Set<(p: unknown) => void>(),
  openExternalUrl: vi.fn<(url: string) => Promise<void>>(),
}))

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => bridge.desktop }))
vi.mock('@/lib/open-external', () => ({ openExternalUrl: (url: string) => bridge.openExternalUrl(url) }))
vi.mock('@/hooks/recording-context', () => ({ useOptionalRecordingStable: () => bridge.recording }))
vi.mock('@/lib/tauri-bridge', () => {
  class TtsRefusedError extends Error {
    code: string
    constructor(code: string) {
      super(code)
      this.code = code
    }
  }
  return {
    TtsRefusedError,
    tauriBridge: {
      modulesList: async () => {
        bridge.calls.push(['modules_list'])
        return bridge.modules
      },
      onModuleStatus: async () => () => {},
      moduleEnable: async () => bridge.modules[0],
      moduleDisable: async () => bridge.modules[0],
      moduleRemoveAssets: async () => bridge.modules[0],
      ttsVoices: async () => {
        bridge.calls.push(['voices'])
        return bridge.voices
      },
      ttsRate: async () => bridge.rate,
      ttsSetRate: async (rate: number) => {
        bridge.calls.push(['rate', rate])
        return rate
      },
      ttsCancel: async () => {
        bridge.calls.push(['cancel'])
      },
      ttsSpeak: async (args: unknown) => {
        bridge.calls.push(['speak', args])
        if (bridge.speakError) throw bridge.speakError
      },
      onTtsState: (cb: (p: unknown) => void) => {
        bridge.ttsListeners.add(cb)
        return () => bridge.ttsListeners.delete(cb)
      },
    },
  }
})

import { ReadAloudSection, SPEEDS, nearestSpeed } from '../read-aloud-section'
import { TtsRefusedError } from '@/lib/tauri-bridge'
import { holdReadAloud } from '@/lib/read-aloud/mic-guard'

const tts: LocalModuleInfo = {
  id: 'local-tts',
  version: 'e801e7d',
  enabled: false,
  state: 'off',
  progress: null,
  downloadBytes: 144_200_000,
  assetsPresent: false,
  error: null,
}
const ready: LocalModuleInfo = { ...tts, enabled: true, state: 'ready', assetsPresent: true }

const VOICES: TtsVoice[] = [
  { id: 'anna', name: 'Anna', description: 'Warm, even.', default: false },
  { id: 'alba', name: 'Alba', description: 'Clear and bright.', default: true },
  { id: 'marius', name: 'Marius', description: 'Low and calm.', default: false },
]

let container: HTMLDivElement
let root: Root

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

async function mount() {
  await act(async () => root.render(h(ReadAloudSection)))
  await flush()
}

const section = () => container.querySelector('[data-testid="read-aloud-section"]')
const autoSwitch = () => container.querySelector('[role="switch"][aria-label="Auto-read replies"]') as HTMLButtonElement | null
const voiceTrigger = () => container.querySelector('[aria-label="Voice"]') as HTMLButtonElement | null
const button = (label: RegExp) =>
  [...container.querySelectorAll('button')].find((b) => label.test(b.textContent ?? '')) as HTMLButtonElement | undefined

async function emitTts(p: TtsStatePayload) {
  await act(async () => {
    for (const cb of bridge.ttsListeners) cb(p)
  })
}

beforeEach(() => {
  bridge.desktop = true
  bridge.modules = [tts]
  bridge.voices = VOICES
  bridge.calls = []
  bridge.speakError = null
  bridge.rate = null
  bridge.recording = null
  bridge.ttsListeners.clear()
  bridge.openExternalUrl.mockReset().mockResolvedValue(undefined)
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('ReadAloudSection — where it shows', () => {
  it('renders nothing in the browser, without touching the bridge', async () => {
    bridge.desktop = false
    await mount()
    expect(container.innerHTML).toBe('')
    expect(bridge.calls).toEqual([])
  })

  it('renders nothing on a desktop without the local-tts module', async () => {
    bridge.modules = [{ ...tts, id: 'local-stt' }]
    await mount()
    expect(section()).toBeNull()
  })
})

describe('ReadAloudSection — the module row', () => {
  it('shows the row with its copy, size and the Pocket TTS credit, but no options until Ready', async () => {
    await mount()
    const text = container.textContent ?? ''
    expect(text).toContain('Read aloud')
    expect(text).toContain("Reads Native Intelligence's chat replies aloud on this Mac. Runs on-device, free and unlimited.")
    expect(text).toContain('Downloads automatically (~140 MB).')
    expect(text).toContain("Speech by Kyutai's Pocket TTS, licensed CC BY 4.0")
    expect(container.querySelector('[data-testid="local-module-row-local-tts"]')).toBeTruthy()
    expect(autoSwitch()).toBeNull()
    expect(voiceTrigger()).toBeNull()
    expect(bridge.calls.some((c) => c[0] === 'voices')).toBe(false)
  })

  it('credit links open in the OS browser', async () => {
    await mount()
    const links = [...container.querySelectorAll('a')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://huggingface.co/kyutai/pocket-tts',
      'https://creativecommons.org/licenses/by/4.0/',
    ])
    await act(async () => links[0].click())
    expect(bridge.openExternalUrl).toHaveBeenCalledWith('https://huggingface.co/kyutai/pocket-tts')
  })
})

describe('ReadAloudSection — once Ready', () => {
  beforeEach(() => {
    bridge.modules = [ready]
  })

  it('Auto-read is off by default and stored device-locally when flipped', async () => {
    await mount()
    expect(autoSwitch()!.getAttribute('aria-checked')).toBe('false')
    await act(async () => autoSwitch()!.click())
    expect(autoSwitch()!.getAttribute('aria-checked')).toBe('true')
    expect(localStorage.getItem('ni:read-aloud:auto')).toBe('1')
    await act(async () => autoSwitch()!.click())
    expect(localStorage.getItem('ni:read-aloud:auto')).toBeNull()
  })

  it('reads a stored Auto-read setting', async () => {
    localStorage.setItem('ni:read-aloud:auto', '1')
    await mount()
    expect(autoSwitch()!.getAttribute('aria-checked')).toBe('true')
  })

  it('shows no Speed on a desktop without it', async () => {
    await mount()
    expect(container.querySelector('[aria-label="Speed"]')).toBeNull()
  })

  it('shows the desktop’s Speed, Normal at 1× and the nearest choice for an odd rate', async () => {
    bridge.rate = 1
    await mount()
    expect(container.querySelector('[aria-label="Speed"]')?.textContent).toContain('Normal')
    await act(async () => root.unmount())
    root = createRoot(container)
    bridge.rate = 2
    await mount()
    expect(container.querySelector('[aria-label="Speed"]')?.textContent).toContain('2×')
  })

  it('offers 0.5× to 4×', () => {
    expect(SPEEDS[0]).toBe(0.5)
    expect(SPEEDS[SPEEDS.length - 1]).toBe(4)
    expect(SPEEDS).toContain(0.75)
    expect(nearestSpeed(1.1)).toBe(1)
    expect(nearestSpeed(3.4)).toBe(3)
    expect(nearestSpeed(9)).toBe(4)
  })

  it('the voice picker shows the catalogue default, with its description', async () => {
    await mount()
    expect(voiceTrigger()!.textContent).toContain('Alba')
    expect(container.textContent).toContain('Clear and bright.')
  })

  it('shows a stored voice, and falls back to the default for one the catalogue lacks', async () => {
    localStorage.setItem('ni:read-aloud:voice', 'marius')
    await mount()
    expect(voiceTrigger()!.textContent).toContain('Marius')

    await act(async () => root.unmount())
    root = createRoot(container)
    localStorage.setItem('ni:read-aloud:voice', 'retired-voice')
    await mount()
    expect(voiceTrigger()!.textContent).toContain('Alba')
  })

  it('hides the voice picker when the desktop has no voice catalogue', async () => {
    bridge.voices = []
    await mount()
    expect(autoSwitch()).toBeTruthy()
    expect(voiceTrigger()).toBeNull()
  })

  it('Preview speaks a sample in the chosen voice, becomes Stop while playing, and resets when done', async () => {
    localStorage.setItem('ni:read-aloud:voice', 'marius')
    await mount()
    await act(async () => button(/Preview/)!.click())
    await flush()
    const speak = bridge.calls.find((c) => c[0] === 'speak')![1] as { id: string; text: string; voice: string }
    expect(bridge.calls.map((c) => c[0])).toEqual(['modules_list', 'voices', 'cancel', 'speak'])
    expect(speak.voice).toBe('marius')
    expect(speak.text).toContain("I'm Marius")
    expect(speak.id).toMatch(/^preview:/)

    await emitTts({ id: speak.id, state: 'speaking' })
    expect(button(/Stop/)).toBeTruthy()
    await emitTts({ id: speak.id, state: 'done' })
    expect(button(/Preview/)).toBeTruthy()
  })

  it('Stop on a playing preview cancels it', async () => {
    await mount()
    await act(async () => button(/Preview/)!.click())
    await flush()
    bridge.calls = []
    await act(async () => button(/Stop/)!.click())
    await flush()
    expect(bridge.calls).toEqual([['cancel']])
    expect(button(/Preview/)).toBeTruthy()
  })

  it('explains a preview refused because a capture is recording', async () => {
    bridge.speakError = new TtsRefusedError('recording')
    await mount()
    await act(async () => button(/Preview/)!.click())
    await flush()
    expect(container.textContent).toContain('Read aloud is paused while a capture is recording.')
    expect(button(/Preview/)).toBeTruthy()
  })

  it('disables Preview while recording', async () => {
    bridge.recording = { isRecording: true, isStarting: false }
    await mount()
    expect(button(/Preview/)!.disabled).toBe(true)
  })

  it('a Voice ID enrollment recording stops a playing preview and disables Preview until it ends', async () => {
    await mount()
    await act(async () => button(/Preview/)!.click())
    await flush()
    bridge.calls = []
    let release!: () => void
    await act(async () => {
      release = holdReadAloud()
    })
    await flush()
    expect(bridge.calls.map((c) => c[0])).toContain('cancel')
    expect(button(/Preview/)!.disabled).toBe(true)
    await act(async () => release())
    expect(button(/Preview/)!.disabled).toBe(false)
  })
})
