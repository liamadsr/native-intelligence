// @vitest-environment jsdom
/**
 * The composer's voice controls (docs/plans/chat-voice.md §3.4), with the
 * voice bridge mocked and voice mode stubbed.
 *
 * Contract pinned here:
 *  - Gating: no voice (the browser, `available` false) → no mic, no waveform;
 *    a capture recording / Voice ID enrolling → both render disabled; a module
 *    missing → the control opens a set-up popover that goes to the Settings
 *    page with that module's row.
 *  - The mic sits left of send. Dictated words land at the caret with a
 *    separating space; while listening they preview as a tail (final solid,
 *    interim muted); the field keeps its value otherwise.
 *  - Send becomes the waveform (same slot) only with an empty field, no
 *    attachments and nothing streaming; it starts voice mode.
 *  - Voice mode has no bar: the field stays (read-only, its value untouched)
 *    and previews the words heard like dictation does; the composer lights up
 *    with the voice glow (mic and agent levels, the travelling beam while
 *    thinking, off while muted), and a live call never lights it; send's slot becomes a stop square (no ring,
 *    no waveform) that ends it, and while a reply generates it is the only
 *    stop (Stop generating returns once voice mode ends); mute takes the
 *    mic's spot; the phase is announced in a hidden live region; and a tap
 *    on the field interrupts whenever the agent speaks, whatever the echo
 *    state (W-1).
 *  - Enter or Send while dictating: stop, merge the words, then send (W-3).
 *  - The mic picker's chevron groups with send's slot whatever it shows (send,
 *    the waveform, a stop square), once the desktop's input-device list has
 *    loaded (useInputDevices mocked; the picker itself: mic-picker.test.tsx).
 *    Nothing in the action row remounts or changes size as dictation starts
 *    and stops, the field fills and empties, voice mode starts and ends, or a
 *    reply generates: the same group, slot and chevron stay, with the same
 *    classes, and only the slot's button changes (jsdom has no layout, so
 *    sizes are pinned by their classes).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useState } from 'react'
import type { VoiceEvent } from '@/lib/tauri-bridge'
import type { VoiceAvailability } from '@/hooks/use-voice-availability'
import type { VoiceModeHandle, VoiceLive, VoiceLiveStore } from '@/hooks/use-voice-mode'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const hoisted = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown?]>,
  listeners: new Map<string, (e: VoiceEvent) => void>(),
  toasts: [] as string[],
  openSettings: vi.fn(),
  startError: null as unknown,
  /** The last props voice-glow's VoiceBeam rendered with (null: never mounted). */
  beam: null as null | { active: boolean; level: () => number; processing?: boolean },
  /** useInputDevices: the status it reports, and each `enabled` it was called with. */
  inputDevicesStatus: 'unsupported' as 'loading' | 'ready' | 'unsupported',
  inputDevicesEnabled: [] as Array<boolean | undefined>,
}))

vi.mock('@/hooks/use-input-devices', () => ({
  useInputDevices: (opts?: { enabled?: boolean }) => {
    hoisted.inputDevicesEnabled.push(opts?.enabled)
    const ready = hoisted.inputDevicesStatus === 'ready'
    return {
      status: hoisted.inputDevicesStatus,
      snapshot: ready
        ? {
            customised: false,
            overrideId: null,
            devices: [
              {
                id: 'builtin',
                name: 'MacBook Pro Microphone',
                transport: 'builtIn',
                available: true,
                isDefault: true,
                active: true,
                live: false,
                firstSeenAt: '',
                lastSeenAt: '',
              },
            ],
          }
        : null,
      setPriority: async () => true,
      setOverride: async () => 'ok' as const,
      reset: async () => true,
      forget: async () => true,
      setDragging: () => {},
    }
  },
}))

vi.mock('voice-glow', () => ({
  VoiceBeam: (props: { active: boolean; level: () => number; processing?: boolean }) => {
    hoisted.beam = props
    return null
  },
}))

// A call is live throughout: the main composer must never light up for it
// (the call's glow is on the HUD's chat box, components/live-chat/call-glow).
vi.mock('@/hooks/recording-context', () => ({
  useRecordingStable: () => ({
    isRecording: true,
    isPaused: false,
    isStarting: false,
    getLevels: () => ({ micLevel: 0.5, systemLevel: 0.5, timestamp: 0 }),
  }),
}))
vi.mock('@/app/account/(dashboard)/top-bar/capture-bar-button', () => ({ CaptureBarButton: () => null }))
vi.mock('../slash-command-picker', () => ({ useRecipeCommands: () => [], SlashCommandPicker: () => null }))
vi.mock('../../settings-overlay', () => ({ useOptionalSettingsOverlay: () => ({ openSettings: hoisted.openSettings }) }))
vi.mock('@/lib/voice/messages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/voice/messages')>()),
  voiceToast: (m: string) => hoisted.toasts.push(m),
  voiceRefusalMessage: (c: string, d?: string | null) => (d ? `refused:${c}:${d}` : `refused:${c}`),
  voiceEndedMessage: () => null,
}))
vi.mock('@/lib/voice/status-store', () => ({ refreshVoiceStatus: async () => {} }))
vi.mock('@/lib/tauri-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri-bridge')>()
  return {
    ...actual,
    tauriBridge: {
      ...actual.tauriBridge,
      voiceStart: async (args: unknown) => {
        hoisted.calls.push(['start', args])
        if (hoisted.startError) throw hoisted.startError
      },
      voiceStop: async (id: string) => void hoisted.calls.push(['stop', id]),
      voiceCancel: async (id: string) => void hoisted.calls.push(['cancel', id]),
      onVoiceEvent: (id: string, cb: (e: VoiceEvent) => void) => {
        hoisted.listeners.set(id, cb)
        return () => hoisted.listeners.delete(id)
      },
    },
  }
})

import { ChatInput, type ChatInputVoice } from '../chat-input'
import { CAPTURE_LEVEL_GAIN } from '../composer-voice-glow'
import { VoiceRefusedError } from '@/lib/tauri-bridge'
import { VOICE_BIRD_EVENT, __resetVoiceBirdForTests, isVoiceBirdHere, parseVoiceBirdDetail, reportMainVoice } from '@/components/birds/voice-bird'

const READY: VoiceAvailability = {
  hasVoice: true,
  visible: true,
  dictation: true,
  conversation: true,
  blocked: null,
  status: { available: true, dictation: true, conversation: true, stt: 'ready', tts: 'ready' },
}

/** Voice mode's live store, settable like the hook's own. */
function makeLive(init: Partial<VoiceLive> = {}) {
  let value: VoiceLive = { mic: 0, agent: 0, transcript: null, ...init }
  const listeners = new Set<() => void>()
  const store: VoiceLiveStore & { set: (patch: Partial<VoiceLive>) => void } = {
    subscribe: (l) => {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    get: () => value,
    set: (patch) => {
      value = { ...value, ...patch }
      for (const l of [...listeners]) l()
    },
  }
  return store
}

const liveStore = makeLive({ mic: 0.4 })

function voiceMode(over: Partial<VoiceModeHandle> = {}): VoiceModeHandle {
  return {
    active: false,
    phase: 'listening',
    echo: 'cancelling',
    muted: false,
    agentSpeaking: false,
    live: liveStore,
    start: vi.fn(async () => null),
    end: vi.fn(),
    toggleMute: vi.fn(),
    interrupt: vi.fn(),
    ...over,
  }
}

let container: HTMLDivElement
let root: Root
let changes: string[]
/** The field's value each time the composer submitted. */
let submits: string[]
/** Stop generating's clicks. */
let stops: number

interface Setup {
  voice?: ChatInputVoice
  value?: string
  isLoading?: boolean
  files?: number
  /** Show the row under the box (a dimmed agent control, as a teammate's chat has). */
  agent?: boolean
  /** False: a teammate's or a run's composer (not the main chat's). */
  mainComposer?: boolean
}

function Composer({ voice, value: initial = '', isLoading = false, files = 0, agent = false, mainComposer }: Setup) {
  const [value, setValue] = useState(initial)
  return h(ChatInput, {
    value,
    onChange: (v: string) => {
      changes.push(v)
      setValue(v)
    },
    onSubmit: () => void submits.push(value),
    onStop: () => void stops++,
    isLoading,
    attachedNotes: [],
    onAttachNote: () => {},
    onRemoveNote: () => {},
    attachedFiles: Array.from({ length: files }, (_, i) => ({
      id: `f${i}`,
      file: new File(['x'], `f${i}.txt`, { type: 'text/plain' }),
      status: 'ready' as const,
    })),
    onAttachFiles: () => {},
    onRemoveFile: () => {},
    ...(agent ? { unavailable: { agent: { label: 'Scout', reason: 'This chat is Scout’s run.' } } } : {}),
    ...(mainComposer === false ? { mainComposer: false } : {}),
    voice,
  })
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

async function mount(setup: Setup) {
  await act(async () => root.render(h(Composer, setup)))
  await flush()
}

const q = <T extends Element = HTMLElement>(sel: string) => document.body.querySelector(sel) as T | null
const mic = () => q<HTMLButtonElement>('[data-voice-control="dictation"]')
const waveform = () => q<HTMLButtonElement>('[data-voice-control="conversation"]')
const send = () => q<HTMLButtonElement>('button[aria-label="Send message"]')
const stopGenerating = () => q<HTMLButtonElement>('button[aria-label="Stop generating"]')
const textarea = () => q<HTMLTextAreaElement>('textarea')!

async function emit(ev: VoiceEvent) {
  const [id] = [...hoisted.listeners.keys()]
  await act(async () => hoisted.listeners.get(id)?.(ev))
  await flush()
}

async function press(el: HTMLElement, k: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
  await flush()
}

beforeEach(() => {
  hoisted.calls = []
  hoisted.listeners.clear()
  hoisted.toasts = []
  hoisted.startError = null
  hoisted.beam = null
  hoisted.openSettings.mockReset()
  hoisted.inputDevicesStatus = 'unsupported'
  hoisted.inputDevicesEnabled = []
  changes = []
  submits = []
  stops = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('gating', () => {
  it('no voice (the browser, or voice_status unavailable): no mic, no waveform', async () => {
    await mount({})
    expect(mic()).toBeNull()
    expect(waveform()).toBeNull()
    expect(send()).not.toBeNull()

    act(() => root.unmount())
    root = createRoot(container)
    await mount({ voice: { availability: { ...READY, visible: false }, mode: voiceMode() } })
    expect(mic()).toBeNull()
    expect(waveform()).toBeNull()
  })

  it('a capture recording: both render disabled, and nothing starts', async () => {
    await mount({ voice: { availability: { ...READY, blocked: 'recording' }, mode: voiceMode() } })
    expect(mic()!.disabled).toBe(true)
    expect(waveform()!.disabled).toBe(true)
    await press(mic()!, 'Enter')
    expect(hoisted.calls).toEqual([])
  })

  // The speech models download on their own (local-modules-keeper.ts): a mode
  // whose models aren't in yet has no control at all, never a set-up prompt.
  it('transcription still downloading: no mic and no waveform, just send', async () => {
    const availability: VoiceAvailability = {
      ...READY,
      visible: false,
      dictation: false,
      conversation: false,
      status: { available: true, dictation: false, conversation: false, stt: 'downloading', tts: 'ready' },
    }
    hoisted.inputDevicesStatus = 'ready'
    await mount({ voice: { availability, mode: voiceMode() } })
    expect(mic()).toBeNull()
    expect(waveform()).toBeNull()
    expect(send()).not.toBeNull()
    expect(q('[data-voice-setup]')).toBeNull()
    expect(hoisted.calls).toEqual([])
    // The mic picker stays: it also picks the mic captures record from.
    expect(q('[data-mic-picker]')!.contains(send())).toBe(true)
    expect(q('[data-testid="mic-picker-chevron"]')).not.toBeNull()
  })

  it('read aloud still downloading: the mic dictates, but no waveform until it is in', async () => {
    const availability: VoiceAvailability = {
      ...READY,
      conversation: false,
      status: { available: true, dictation: true, conversation: false, stt: 'ready', tts: 'downloading' },
    }
    await mount({ voice: { availability, mode: voiceMode() } })
    expect(mic()).not.toBeNull()
    expect(waveform()).toBeNull()
    expect(send()).not.toBeNull()
    expect(q('[data-voice-setup]')).toBeNull()
  })
})

describe('dictation', () => {
  it('sits left of send', async () => {
    await mount({ voice: { availability: READY, mode: voiceMode() }, value: 'Hi' })
    const buttons = [...document.body.querySelectorAll('button')]
    expect(buttons.indexOf(mic()!)).toBeLessThan(buttons.indexOf(send()!))
    expect(mic()!.getAttribute('aria-pressed')).toBe('false')
  })

  it('previews the words at the caret, then inserts them there with a separating space', async () => {
    await mount({ voice: { availability: READY, mode: voiceMode() }, value: 'Draft' })
    textarea().focus()
    textarea().setSelectionRange(5, 5)
    await press(mic()!, 'Enter')
    expect(hoisted.calls[0]).toEqual(['start', expect.objectContaining({ mode: 'dictation' })])
    expect(mic()!.getAttribute('aria-pressed')).toBe('true')

    await emit({ type: 'transcript', turnId: 't', text: 'the', final: true })
    await emit({ type: 'transcript', turnId: 't', text: 'the rep', final: false })
    const tail = q('[data-dictation-tail]')!
    expect(q('[data-dictation-final]')!.textContent).toBe(' the')
    expect(q('[data-dictation-interim]')!.textContent).toBe(' rep')
    expect(tail.textContent).toBe('Draft the rep')
    expect(textarea().value).toBe('Draft') // not inserted yet

    await press(mic()!, 'Enter')
    expect(hoisted.calls.at(-1)?.[0]).toBe('stop')
    await emit({ type: 'ended', reason: 'stopped', text: 'the reply' })
    expect(changes.at(-1)).toBe('Draft the reply')
    expect(textarea().value).toBe('Draft the reply')
    expect(textarea().selectionStart).toBe(15)
    expect(document.activeElement).toBe(textarea())
    expect(q('[data-dictation-tail]')).toBeNull()
  })

  it('an empty field: "Listening…" until words arrive, then only the tail (the glyphs hide under it)', async () => {
    // PromptInputTextarea drops its placeholder below 220 px; jsdom lays out nothing.
    const width = vi.spyOn(HTMLTextAreaElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
    await mount({ voice: { availability: READY, mode: voiceMode() } })
    expect(textarea().placeholder).toBe('@ to mention')
    await press(mic()!, 'Enter')
    expect(textarea().placeholder).toBe('Listening…')
    await emit({ type: 'transcript', turnId: 't', text: 'hello', final: false })
    expect(textarea().placeholder).toBe('')
    expect(textarea().style.color).toBe('transparent')
    expect(q('[data-dictation-tail]')!.textContent).toBe('hello')
    await press(mic()!, 'Enter')
    await emit({ type: 'ended', reason: 'stopped', text: 'hello' })
    expect(textarea().style.color).toBe('')
    expect(textarea().value).toBe('hello')
    width.mockRestore()
  })

  it('inserts mid-text at the caret', async () => {
    await mount({ voice: { availability: READY, mode: voiceMode() }, value: 'Ask about pricing' })
    textarea().setSelectionRange(3, 3)
    await press(mic()!, ' ')
    await press(mic()!, ' ')
    await emit({ type: 'ended', reason: 'stopped', text: 'Maya' })
    expect(textarea().value).toBe('Ask Maya about pricing')
  })

  it('Esc cancels: nothing is inserted', async () => {
    await mount({ voice: { availability: READY, mode: voiceMode() }, value: 'Keep' })
    await press(mic()!, 'Enter')
    await emit({ type: 'transcript', turnId: 't', text: 'discard me', final: true })
    await press(textarea(), 'Escape')
    expect(hoisted.calls.at(-1)?.[0]).toBe('cancel')
    expect(changes).toEqual([])
    expect(textarea().value).toBe('Keep')
  })
})

describe('Enter or Send while dictating (stop, merge the words, then send)', () => {
  it('Enter: the dictated words go out with the typed ones, once they land', async () => {
    await mount({ voice: { availability: READY, mode: voiceMode() }, value: 'Draft an email to' })
    textarea().focus()
    textarea().setSelectionRange(17, 17)
    await press(mic()!, 'Enter')
    const [id] = [...hoisted.listeners.keys()]
    await emit({ type: 'transcript', turnId: 't', text: 'Sarah about the', final: false })

    await press(textarea(), 'Enter')
    // Not sent yet: the desktop is finalizing.
    expect(submits).toEqual([])
    expect(hoisted.calls.at(-1)).toEqual(['stop', id])

    await emit({ type: 'ended', reason: 'stopped', text: 'Sarah about the renewal' })
    // The dictation finishes its sentence (@/lib/voice/punctuation): the engine never ends one with a full stop.
    expect(submits).toEqual(['Draft an email to Sarah about the renewal.'])
  })

  it('Send is enabled by the dictated words alone, and sends them', async () => {
    await mount({ voice: { availability: READY, mode: voiceMode() } })
    await press(mic()!, 'Enter')
    expect(send()!.disabled).toBe(true) // nothing heard yet
    await emit({ type: 'transcript', turnId: 't', text: 'hello there', final: false })
    expect(send()!.disabled).toBe(false)
    await act(async () => send()!.click())
    await flush()
    expect(hoisted.calls.at(-1)?.[0]).toBe('stop')
    expect(submits).toEqual([])
    await emit({ type: 'ended', reason: 'stopped', text: 'hello there' })
    expect(submits).toEqual(['hello there'])
  })

  it('no words came: the typed text is still sent after the stop', async () => {
    await mount({ voice: { availability: READY, mode: voiceMode() }, value: 'Typed' })
    await press(mic()!, 'Enter')
    await press(textarea(), 'Enter')
    await emit({ type: 'ended', reason: 'stopped', text: '' })
    expect(submits).toEqual(['Typed'])
  })

  it('Esc before the words land drops the send (and the words)', async () => {
    await mount({ voice: { availability: READY, mode: voiceMode() }, value: 'Typed' })
    await press(mic()!, 'Enter')
    await emit({ type: 'transcript', turnId: 't', text: 'more', final: true })
    await press(textarea(), 'Enter')
    await press(textarea(), 'Escape')
    expect(hoisted.calls.at(-1)?.[0]).toBe('cancel')
    expect(submits).toEqual([])
    expect(textarea().value).toBe('Typed')
  })

  it('not dictating: Enter sends straight away', async () => {
    await mount({ voice: { availability: READY, mode: voiceMode() }, value: 'Now' })
    await press(textarea(), 'Enter')
    expect(submits).toEqual(['Now'])
  })
})

describe('the send slot', () => {
  it('empty field → the waveform; words, files or a stream → send / stop', async () => {
    const mode = voiceMode()
    await mount({ voice: { availability: READY, mode } })
    expect(waveform()?.getAttribute('aria-label')).toBe('Start voice mode')
    expect(send()).toBeNull()
    await act(async () => waveform()!.click())
    expect(mode.start).toHaveBeenCalledTimes(1)

    act(() => root.unmount())
    root = createRoot(container)
    await mount({ voice: { availability: READY, mode }, value: 'hello' })
    expect(waveform()).toBeNull()
    expect(send()).not.toBeNull()

    act(() => root.unmount())
    root = createRoot(container)
    await mount({ voice: { availability: READY, mode }, files: 1 })
    expect(waveform()).toBeNull()

    act(() => root.unmount())
    root = createRoot(container)
    await mount({ voice: { availability: READY, mode }, isLoading: true })
    expect(waveform()).toBeNull()
    expect(q('button[aria-label="Start voice mode"]')).toBeNull()
    expect(stopGenerating()).not.toBeNull()
  })

  it('a refused start is reported', async () => {
    const mode = voiceMode({ start: vi.fn(async () => ({ code: 'busy' as const, detail: null })) })
    await mount({ voice: { availability: READY, mode } })
    await act(async () => waveform()!.click())
    await flush()
    expect(hoisted.toasts).toEqual(['refused:busy'])
  })

  it('a refusal detail reaches the toast (voice mode and dictation)', async () => {
    const mode = voiceMode({
      start: vi.fn(async () => ({ code: 'unavailable' as const, detail: 'the audio thread could not start' })),
    })
    await mount({ voice: { availability: READY, mode } })
    await act(async () => waveform()!.click())
    await flush()
    expect(hoisted.toasts).toEqual(['refused:unavailable:the audio thread could not start'])

    act(() => root.unmount())
    root = createRoot(container)
    hoisted.toasts = []
    hoisted.startError = new VoiceRefusedError('unavailable', 'unavailable: the microphone start failed')
    await mount({ voice: { availability: READY, mode: voiceMode() }, value: 'x' })
    await press(mic()!, 'Enter')
    expect(hoisted.toasts).toEqual(['refused:unavailable:the microphone start failed'])
  })
})

describe('voice mode', () => {
  const on = (over: Partial<VoiceModeHandle> = {}) => voiceMode({ active: true, ...over })

  it('no bar: the field stays, read-only and untouched; a stop square ends it; mute takes the mic’s spot', async () => {
    const mode = on({ phase: 'listening' })
    await mount({ voice: { availability: READY, mode } })
    expect(q('[data-voice-bar]')).toBeNull()
    expect(q('[data-level]')).toBeNull()
    expect(textarea().readOnly).toBe(true)
    expect(textarea().value).toBe('')
    expect(mic()).toBeNull()
    // Send's slot is voice mode's end now (an X on a neutral circle), not the waveform.
    expect(waveform()!.getAttribute('aria-label')).toBe('End voice mode')
    expect(waveform()!.hasAttribute('aria-pressed')).toBe(false)
    expect(waveform()!.querySelector('svg.lucide-x')).not.toBeNull()
    expect(waveform()!.querySelector('svg.lucide-audio-lines')).toBeNull()
    expect(waveform()!.className).not.toContain('ring-2')
    // Mute sits left of the stop, where the mic was.
    const buttons = [...document.body.querySelectorAll('button')]
    const mute = q<HTMLButtonElement>('button[aria-label="Mute microphone"]')!
    expect(mute.getAttribute('data-voice-control')).toBe('mute')
    expect(mute.getAttribute('aria-pressed')).toBe('false')
    expect(buttons.indexOf(mute)).toBeLessThan(buttons.indexOf(waveform()!))

    await act(async () => mute.click())
    expect(mode.toggleMute).toHaveBeenCalledTimes(1)
    await act(async () => waveform()!.click())
    expect(mode.end).toHaveBeenCalledTimes(1)
    // Nothing to interrupt while nobody speaks.
    expect(q('button[aria-label="Interrupt"]')).toBeNull()
  })

  it('Enter in the field sends nothing: voice mode sends what is said', async () => {
    await mount({ voice: { availability: READY, mode: on({ phase: 'listening' }) }, files: 1 })
    await press(textarea(), 'Enter')
    expect(submits).toEqual([])
  })

  it('muted: the mute reads pressed with the muted icon', async () => {
    await mount({ voice: { availability: READY, mode: on({ phase: 'muted', muted: true }) } })
    const unmute = q<HTMLButtonElement>('button[aria-label="Unmute microphone"]')!
    expect(unmute.getAttribute('aria-pressed')).toBe('true')
    expect(unmute.querySelector('.lucide-mic-off')).not.toBeNull()
  })

  it('the words heard preview in the field like dictation (final solid, interim muted), and clear with the turn', async () => {
    const live = makeLive()
    const width = vi.spyOn(HTMLTextAreaElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
    await mount({ voice: { availability: READY, mode: on({ phase: 'listening', live }) } })
    expect(q('[data-dictation-tail]')).toBeNull()
    expect(textarea().placeholder).toBe('') // no "Listening…"
    width.mockRestore()

    await act(async () => live.set({ transcript: { final: 'book the', interim: ' room' } }))
    expect(q('[data-dictation-final]')!.textContent).toBe('book the')
    expect(q('[data-dictation-interim]')!.textContent).toBe(' room')
    expect(q('[data-dictation-interim]')!.className).toContain('text-muted-foreground')
    expect(textarea().style.color).toBe('transparent')
    // Previewed only: the field's value is never written.
    expect(textarea().value).toBe('')
    expect(changes).toEqual([])

    // The turn is sent: the hook clears the words, the field is clean again.
    await act(async () => live.set({ transcript: null }))
    expect(q('[data-dictation-tail]')).toBeNull()
    expect(textarea().style.color).toBe('')
    expect(changes).toEqual([])
  })

  it('a turn Voice focus ignored: a quiet, muted line in the field while listening; words heard take over', async () => {
    const live = makeLive({ notice: 'Ignored a voice Dial8 doesn’t recognise' })
    await mount({ voice: { availability: READY, mode: on({ phase: 'listening', live }) } })
    expect(q('[data-dictation-final]')!.textContent).toBe('')
    expect(q('[data-dictation-interim]')!.textContent).toBe('Ignored a voice Dial8 doesn’t recognise')
    expect(q('[data-dictation-interim]')!.className).toContain('text-muted-foreground')
    expect(textarea().value).toBe('')
    await act(async () => live.set({ transcript: { final: '', interim: 'what time' } }))
    expect(q('[data-dictation-interim]')!.textContent).toBe('what time')
    // Not while thinking (the reply is what matters then).
    await act(async () => live.set({ transcript: null }))
    await mount({ voice: { availability: READY, mode: on({ phase: 'thinking', live }) } })
    expect(q('[data-dictation-tail]')).toBeNull()
  })

  it('the preview waits out the agent speaking and a mute', async () => {
    const live = makeLive({ transcript: { final: '', interim: 'uh' } })
    await mount({ voice: { availability: READY, mode: on({ phase: 'thinking', live }) } })
    expect(q('[data-dictation-tail]')!.textContent).toBe('uh')
    await mount({ voice: { availability: READY, mode: on({ phase: 'speaking', agentSpeaking: true, live }) } })
    expect(q('[data-dictation-tail]')).toBeNull()
    await mount({ voice: { availability: READY, mode: on({ phase: 'muted', muted: true, live }) } })
    expect(q('[data-dictation-tail]')).toBeNull()
  })

  it('lights the composer with the voice glow: mic and agent levels, the beam while thinking, off when muted', async () => {
    const live = makeLive()
    await mount({ voice: { availability: READY, mode: voiceMode({ live }) } })
    expect(hoisted.beam).toBeNull() // off: nothing mounted

    await mount({ voice: { availability: READY, mode: on({ phase: 'listening', live }) } })
    expect(hoisted.beam!.active).toBe(true)
    expect(hoisted.beam!.processing).toBe(false)
    // The level gain on the louder of the two voices, clamped.
    live.set({ mic: 0.02, agent: 0 })
    expect(hoisted.beam!.level()).toBeCloseTo(0.02 * CAPTURE_LEVEL_GAIN)
    live.set({ mic: 0.001, agent: 0.03 })
    expect(hoisted.beam!.level()).toBeCloseTo(0.03 * CAPTURE_LEVEL_GAIN)
    live.set({ mic: 0.5, agent: 0 })
    expect(hoisted.beam!.level()).toBe(1)

    await mount({ voice: { availability: READY, mode: on({ phase: 'thinking', live }) } })
    expect(hoisted.beam!.processing).toBe(true)

    await mount({ voice: { availability: READY, mode: on({ phase: 'muted', muted: true, live }) } })
    expect(hoisted.beam!.active).toBe(false) // fades out
  })

  it('a live call never lights the main composer (its glow is on the HUD now)', async () => {
    await mount({})
    expect(hoisted.beam).toBeNull()
    await mount({ voice: { availability: READY, mode: voiceMode() } })
    expect(hoisted.beam).toBeNull()
    expect(q('[data-voice-beam]')).toBeNull()
  })

  it('the glow stays off on an inactive tab', async () => {
    await act(async () =>
      root.render(
        h(ChatInput, {
          value: '',
          onChange: () => {},
          onSubmit: () => {},
          onStop: () => {},
          isLoading: false,
          attachedNotes: [],
          onAttachNote: () => {},
          onRemoveNote: () => {},
          attachedFiles: [],
          onAttachFiles: () => {},
          onRemoveFile: () => {},
          isActive: false,
          voice: { availability: READY, mode: on({ phase: 'listening' }) },
        }),
      ),
    )
    await flush()
    expect(hoisted.beam).toBeNull()
  })

  it('announces the phase in a hidden live region, and nothing once it ends', async () => {
    for (const [phase, label] of [
      ['starting', 'Starting…'],
      ['listening', 'Listening'],
      ['thinking', 'Thinking…'],
      ['speaking', 'Speaking…'],
      ['muted', 'Muted'],
    ] as const) {
      await mount({ voice: { availability: READY, mode: on({ phase, muted: phase === 'muted' }) } })
      const region = q('[aria-live="polite"]')!
      expect(region.className).toContain('sr-only')
      expect(region.getAttribute('data-voice-phase')).toBe(phase)
      expect(region.textContent).toBe(label)
    }
    await mount({ voice: { availability: READY, mode: voiceMode() } })
    expect(q('[aria-live="polite"]')!.textContent).toBe('')
  })

  it('while the reply generates: only voice mode’s end (no Stop generating beside it); once it ends, Stop generating', async () => {
    const mode = on({ phase: 'thinking' })
    await mount({ voice: { availability: READY, mode }, isLoading: true })
    expect(document.body.querySelectorAll('svg.lucide-square')).toHaveLength(0)
    expect(waveform()!.querySelector('svg.lucide-x')).not.toBeNull()
    expect(waveform()!.getAttribute('aria-label')).toBe('End voice mode')
    expect(stopGenerating()).toBeNull()
    await act(async () => waveform()!.click())
    expect(mode.end).toHaveBeenCalledTimes(1)
    // Ending voice mode leaves the reply alone: the reply's own Stop is back.
    expect(stops).toBe(0)

    await mount({ voice: { availability: READY, mode: voiceMode() }, isLoading: true })
    expect(waveform()).toBeNull()
    expect(document.body.querySelectorAll('svg.lucide-square')).toHaveLength(1)
    expect(stopGenerating()!.querySelector('svg.lucide-square')).not.toBeNull()
    await act(async () => stopGenerating()!.click())
    expect(stops).toBe(1)
  })

  it.each(['converging', 'cancelling', 'headphones', 'half_duplex'] as const)(
    'echo %s while the agent speaks: a tap on the field interrupts (talking may not)',
    async (echo) => {
      // PromptInputTextarea drops its placeholder below 220 px; jsdom lays out nothing.
      const width = vi.spyOn(HTMLTextAreaElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
      const mode = on({ phase: 'speaking', echo, agentSpeaking: true })
      await mount({ voice: { availability: READY, mode } })
      expect(textarea().placeholder).toBe('Tap to interrupt')
      width.mockRestore()
      const tap = q<HTMLButtonElement>('button[aria-label="Interrupt"]')!
      expect(tap.getAttribute('data-voice-control')).toBe('interrupt')
      // It covers the field.
      expect(tap.parentElement!.contains(textarea())).toBe(true)
      expect(tap.className).toContain('inset-0')
      await act(async () => tap.click())
      expect(mode.interrupt).toHaveBeenCalledTimes(1)
    },
  )
})

describe('the mic picker chevron', () => {
  const chevron = () => q<HTMLButtonElement>('[data-testid="mic-picker-chevron"]')
  const remount = async (setup: Setup) => {
    act(() => root.unmount())
    root = createRoot(container)
    await mount(setup)
  }

  it('hidden without the input-device list (desktop 0.2.45, the browser); shown beside the waveform with it', async () => {
    await mount({ voice: { availability: READY, mode: voiceMode() } })
    expect(waveform()).not.toBeNull()
    expect(chevron()).toBeNull()
    expect(q('[data-mic-picker]')).toBeNull()

    hoisted.inputDevicesStatus = 'ready'
    await remount({ voice: { availability: READY, mode: voiceMode() } })
    const group = q('[data-mic-picker]')!
    expect(group.contains(waveform())).toBe(true)
    expect(group.contains(chevron())).toBe(true)
    expect(hoisted.inputDevicesEnabled.at(-1)).toBe(true)
  })

  it('beside voice mode’s stop square (also while a reply generates), and beside send while read aloud downloads', async () => {
    hoisted.inputDevicesStatus = 'ready'
    await mount({ voice: { availability: READY, mode: voiceMode({ active: true }) } })
    expect(waveform()!.getAttribute('aria-label')).toBe('End voice mode')
    expect(q('[data-mic-picker]')!.contains(chevron())).toBe(true)

    await remount({ voice: { availability: READY, mode: voiceMode({ active: true, phase: 'thinking' }) }, isLoading: true })
    expect(q('[data-mic-picker]')!.contains(waveform())).toBe(true)
    expect(chevron()).not.toBeNull()

    // Dictation ready, voice mode not yet: no waveform, the mic still picks.
    await remount({
      voice: { availability: { ...READY, conversation: false }, mode: voiceMode() },
    })
    expect(waveform()).toBeNull()
    expect(q('[data-mic-picker]')!.contains(send())).toBe(true)
    expect(chevron()).not.toBeNull()
  })

  it('also beside send and Stop generating; gone with no voice at all (the list is not even asked for)', async () => {
    hoisted.inputDevicesStatus = 'ready'
    await mount({ voice: { availability: READY, mode: voiceMode() }, value: 'hello' })
    expect(q('[data-mic-picker]')!.contains(send())).toBe(true)
    expect(q('[data-mic-picker]')!.contains(chevron())).toBe(true)

    await remount({ voice: { availability: READY, mode: voiceMode() }, isLoading: true })
    expect(q('[data-mic-picker]')!.contains(stopGenerating())).toBe(true)
    expect(chevron()).not.toBeNull()

    hoisted.inputDevicesEnabled = []
    await remount({ voice: { availability: { ...READY, hasVoice: false, visible: false }, mode: voiceMode() } })
    expect(chevron()).toBeNull()
    expect(q('[data-mic-picker]')).toBeNull()
    expect(send()).not.toBeNull()
    expect(hoisted.inputDevicesEnabled.every((e) => e === false)).toBe(true)
  })
})

describe('the action row holds still (Liam, 2026-09-26: dictating made it jump)', () => {
  const chevron = () => q<HTMLButtonElement>('[data-testid="mic-picker-chevron"]')
  const slot = () => q<HTMLElement>('[data-testid="mic-picker-slot"]')
  const group = () => q<HTMLElement>('[data-mic-picker]')

  /** Types into the field the way a keystroke does (React's onChange). */
  async function type(text: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(textarea(), text)
      textarea().dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
  }

  /** The row's elements and classes now: the group, its slot and chevron
   *  (the same nodes, never remounted), and each of the row's children. */
  function snapshot() {
    const g = group()!
    const row = g.parentElement!.parentElement! // group → PromptInputActions → the row
    return {
      group: g,
      slot: slot()!,
      chevron: chevron()!,
      classes: [g.className, slot()!.className, chevron()!.className],
      row: [...row.children],
    }
  }

  /** `micSpot`: the dictation mic's spot may hold a new node (voice mode's
   *  mute, or the mic again once voice mode ends), the same size. */
  function expectStill(before: ReturnType<typeof snapshot>, { micSpot }: { micSpot?: 'mute' | 'dictation' } = {}) {
    const now = snapshot()
    expect(now.group).toBe(before.group)
    expect(now.slot).toBe(before.slot)
    expect(now.chevron).toBe(before.chevron)
    expect(before.group.isConnected).toBe(true)
    expect(now.classes).toEqual(before.classes)
    // The slot is a fixed square, and whatever it shows is the same size.
    expect(now.slot.className).toMatch(/\bh-8\b/)
    expect(now.slot.className).toMatch(/\bw-8\b/)
    expect(now.slot.className).toContain('shrink-0')
    const button = now.slot.querySelector('button')!
    expect(button.className).toMatch(/\bh-8\b/)
    expect(button.className).toMatch(/\bw-8\b/)
    // The row: the same children in the same places (voice mode swaps the
    // dictation mic for mute, an h-8 w-8 button in the same spot).
    expect(now.row).toHaveLength(before.row.length)
    now.row.forEach((el, i) => {
      if (micSpot && before.row[i].matches('[data-voice-control="dictation"]')) {
        expect(el.matches(`[data-voice-control="${micSpot}"]`)).toBe(true)
        expect(el.className).toMatch(/\bh-8\b/)
        expect(el.className).toMatch(/\bw-8\b/)
      } else {
        expect(el).toBe(before.row[i])
      }
    })
  }

  beforeEach(() => {
    hoisted.inputDevicesStatus = 'ready'
  })

  it('idle → dictating → words → idle: the chevron stays beside the slot, usable', async () => {
    await mount({ voice: { availability: READY, mode: voiceMode() } })
    const before = snapshot()
    expect(before.slot.contains(waveform())).toBe(true)

    await press(mic()!, 'Enter')
    expect(mic()!.getAttribute('aria-pressed')).toBe('true')
    expectStill(before)
    expect(before.slot.contains(send())).toBe(true)
    expect(chevron()!.disabled).toBe(false)

    await emit({ type: 'transcript', turnId: 't', text: 'hello', final: false })
    expectStill(before)

    await press(mic()!, 'Enter')
    await emit({ type: 'ended', reason: 'stopped', text: 'hello' })
    expect(textarea().value).toBe('hello')
    expectStill(before)
    expect(before.slot.contains(send())).toBe(true)

    // Cancelled with an empty field: back to the waveform, still in place.
    await type('')
    await press(mic()!, 'Enter')
    await press(textarea(), 'Escape')
    expectStill(before)
    expect(before.slot.contains(waveform())).toBe(true)
  })

  it('typing (send) ↔ empty (the waveform)', async () => {
    await mount({ voice: { availability: READY, mode: voiceMode() } })
    const before = snapshot()
    await type('Hi')
    expectStill(before)
    expect(before.slot.contains(send())).toBe(true)
    await type('')
    expectStill(before)
    expect(before.slot.contains(waveform())).toBe(true)
  })

  it('a reply generating: Stop generating in the slot, nothing else moves', async () => {
    await mount({ agent: true, voice: { availability: READY, mode: voiceMode() } })
    const before = snapshot()

    await mount({ agent: true, voice: { availability: READY, mode: voiceMode() }, isLoading: true })
    expectStill(before)
    expect(before.slot.contains(stopGenerating())).toBe(true)

    await mount({ agent: true, voice: { availability: READY, mode: voiceMode() } })
    expectStill(before)
    expect(before.slot.contains(waveform())).toBe(true)
  })

  it('idle → voice mode (and a reply generating in it) → idle', async () => {
    await mount({ voice: { availability: READY, mode: voiceMode() } })
    const before = snapshot()

    await mount({ voice: { availability: READY, mode: voiceMode({ active: true }) } })
    expectStill(before, { micSpot: 'mute' })
    expect(waveform()!.getAttribute('aria-label')).toBe('End voice mode')

    await mount({ voice: { availability: READY, mode: voiceMode({ active: true, phase: 'thinking' }) }, isLoading: true })
    expectStill(before, { micSpot: 'mute' })
    expect(waveform()!.getAttribute('aria-label')).toBe('End voice mode')

    await mount({ voice: { availability: READY, mode: voiceMode() } })
    expectStill(before, { micSpot: 'dictation' })
    expect(waveform()!.getAttribute('aria-label')).toBe('Start voice mode')
  })
})

describe('the box holds only "+", the mic and send’s slot (Liam, 2026-10-09: Claude’s composer)', () => {
  const controls = () => q<HTMLElement>('[data-composer-controls]')!
  /** The controls row's buttons, by what they say. */
  const labels = () => [...controls().querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))

  /** A fresh composer (its draft is its own state, read once at mount). */
  async function fresh(setup: Setup) {
    act(() => root.unmount())
    root = createRoot(container)
    await mount(setup)
  }

  it('inside the box: "+" at the left, the mic then voice mode at the right; no model control anywhere', async () => {
    await mount({ voice: { availability: READY, mode: voiceMode() } })
    const box = q<HTMLElement>('[data-bot-chat-box]')!
    expect(box.contains(controls())).toBe(true)
    expect(labels()).toEqual(['Add', mic()!.getAttribute('aria-label'), 'Start voice mode'])
    expect(controls().firstElementChild!.matches('button[aria-label="Add"]')).toBe(true)
    // The mic sits just before send's slot.
    expect(mic()!.compareDocumentPosition(waveform()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(controls().querySelector('[data-model-picker], [data-agent-toggle]')).toBeNull()
    // The server picks the model per turn: no picker, and with nothing else
    // to show under the box, no row under it either.
    expect(q('[data-model-picker]')).toBeNull()
    expect(q('[data-composer-under-row]')).toBeNull()
  })

  it('a host that names a control it can’t honour gets the row under the box, outside it', async () => {
    await mount({ agent: true, voice: { availability: READY, mode: voiceMode() } })
    const box = q<HTMLElement>('[data-bot-chat-box]')!
    const under = q<HTMLElement>('[data-composer-under-row]')!
    expect(box.contains(under)).toBe(false)
    expect(under.querySelector('[data-composer-unavailable="agent"]')).not.toBeNull()
  })

  it('empty and idle: voice mode; words: send in its place; a reply running: stop (send again once there are words)', async () => {
    await fresh({ voice: { availability: READY, mode: voiceMode() } })
    expect(waveform()).not.toBeNull()
    expect(send()).toBeNull()

    await fresh({ voice: { availability: READY, mode: voiceMode() }, value: 'Hi' })
    expect(send()).not.toBeNull()
    expect(send()!.disabled).toBe(false)
    expect(waveform()).toBeNull()
    expect(labels().at(-1)).toBe('Send message')
    await act(async () => send()!.click())
    expect(submits).toEqual(['Hi'])

    await fresh({ voice: { availability: READY, mode: voiceMode() }, files: 1 })
    expect(send()).not.toBeNull()
    expect(waveform()).toBeNull()

    await fresh({ voice: { availability: READY, mode: voiceMode() }, isLoading: true })
    expect(stopGenerating()).not.toBeNull()
    expect(waveform()).toBeNull()
    expect(send()).toBeNull()
    await act(async () => stopGenerating()!.click())
    expect(stops).toBe(1)

    // Words while a reply runs: send queues them for when it finishes.
    await fresh({ voice: { availability: READY, mode: voiceMode() }, isLoading: true, value: 'Next' })
    expect(q('button[aria-label="Send when this reply finishes"]')).not.toBeNull()
    expect(stopGenerating()).toBeNull()
  })

  it('the row under the box lines up with the box’s controls: one inset for both', async () => {
    await mount({ agent: true, voice: { availability: READY, mode: voiceMode() } })
    const box = q<HTMLElement>('[data-bot-chat-box]')!
    const under = q<HTMLElement>('[data-composer-under-row]')!
    // The box adds its border and p-2 (9px) before the controls row's 4px;
    // the row under it sits outside the box, so it carries all 13px on the
    // right and 13px less its buttons' 6px label padding on the left
    // ("Agent" under "+").
    expect(box.className).toMatch(/(^|\s)border(\s|$)/)
    expect(box.className).toMatch(/(^|\s)p-2(\s|$)/)
    expect(controls().style.paddingRight).toBe('4px')
    expect(controls().style.paddingLeft).toBe('4px')
    expect(under.style.paddingRight).toBe('13px')
    expect(under.style.paddingLeft).toBe('7px')
    expect(q('[data-composer-unavailable="agent"]')!.className).toContain('px-1.5')
  })

  it('idle voice mode is a plain glyph with a hover outline on the pair; send and stop keep the filled circle', async () => {
    hoisted.inputDevicesStatus = 'ready'
    await fresh({ voice: { availability: READY, mode: voiceMode() } })
    const group = q<HTMLElement>('[data-mic-picker]')!
    expect(waveform()!.className).not.toContain('bg-primary')
    expect(waveform()!.className).toContain('shadow-none')
    expect(waveform()!.className).toContain('group-hover/mic:bg-muted')
    // At rest no border; a hover draws the outline (a ring: nothing moves).
    expect(group.className).not.toMatch(/(^|\s)ring-1(\s|$)/)
    expect(group.hasAttribute('data-quiet')).toBe(true)
    expect(group.className).toContain('data-[quiet]:hover:ring-1')
    expect(group.className).toContain('data-[quiet]:hover:ring-border')
    expect(group.className).toContain('motion-reduce:transition-none')
    expect(q('[data-testid="mic-picker-chevron"]')!.className).toContain('hover:bg-muted')

    await fresh({ voice: { availability: READY, mode: voiceMode() }, value: 'Hi' })
    expect(send()!.className).toContain('bg-primary')
    expect(q<HTMLElement>('[data-mic-picker]')!.hasAttribute('data-quiet')).toBe(false)

    await fresh({ voice: { availability: READY, mode: voiceMode() }, isLoading: true })
    expect(stopGenerating()!.className).toContain('bg-primary')
    expect(q<HTMLElement>('[data-mic-picker]')!.hasAttribute('data-quiet')).toBe(false)
  })

  it('voice mode: muted, the mic is a soft red circle (Unmute, pressed); unmuted, its plain glyph', async () => {
    await fresh({ voice: { availability: READY, mode: voiceMode({ active: true, muted: true, phase: 'muted' }) } })
    const muted = q<HTMLButtonElement>('[data-voice-control="mute"]')!
    expect(muted.getAttribute('aria-pressed')).toBe('true')
    expect(muted.getAttribute('aria-label')).toBe('Unmute microphone')
    expect(muted.className).toContain('bg-red-500/15')
    expect(muted.className).toContain('text-red-600')
    expect(muted.className).toContain('dark:bg-red-500/20')
    expect(muted.className).toContain('dark:text-red-400')
    expect(muted.querySelector('svg.lucide-mic-off')).not.toBeNull()

    await fresh({ voice: { availability: READY, mode: voiceMode({ active: true }) } })
    const live = q<HTMLButtonElement>('[data-voice-control="mute"]')!
    expect(live.getAttribute('aria-pressed')).toBe('false')
    expect(live.getAttribute('aria-label')).toBe('Mute microphone')
    expect(live.className).not.toContain('bg-red')
    // End voice mode: the mute button's size and glyph, a neutral fill, an X.
    const end = q<HTMLButtonElement>('button[aria-label="End voice mode"]')!
    expect(end.className).toMatch(/\bh-8\b/)
    expect(end.className).toMatch(/\bw-8\b/)
    expect(end.className).toContain('rounded-full')
    expect(end.className).toContain('bg-muted')
    expect(end.className).toContain('hover:bg-foreground/10')
    expect(end.className).not.toContain('bg-primary')
    expect(end.querySelector('svg.lucide-x')!.getAttribute('class')).toContain('h-4 w-4')
    expect(live.querySelector('svg')!.getAttribute('class')).toContain('h-4 w-4')
  })

  it('no voice: just "+" and send in the box', async () => {
    await mount({})
    expect(labels()).toEqual(['Add', 'Send message'])
    expect(send()!.disabled).toBe(true)
  })
})

describe('the voice bird: five quick presses on the main composer', () => {
  let birdEvents: string[]
  const host = (e: Event) => {
    const d = parseVoiceBirdDetail((e as CustomEvent).detail)
    if (!d) return
    birdEvents.push(d.action)
    if (d.action === 'start') {
      d.take()
      reportMainVoice(true, 'listening')
      d.onResult(true)
    }
  }
  beforeEach(() => {
    __resetVoiceBirdForTests()
    birdEvents = []
    window.addEventListener(VOICE_BIRD_EVENT, host)
  })
  afterEach(() => {
    window.removeEventListener(VOICE_BIRD_EVENT, host)
    vi.useRealTimers()
  })

  /** Presses on the field, `gapMs` apart; each a real mousedown (detail counts up, as a browser's). */
  async function presses(n: number, gapMs = 100) {
    for (let i = 1; i <= n; i++) {
      await act(async () => {
        textarea().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: i }))
      })
      vi.advanceTimersByTime(gapMs)
    }
  }

  it('five quick presses call the bird (voice mode, desktop), and the field keeps focus and selection', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await mount({ voice: { availability: READY, mode: voiceMode() } })
    const prevented: boolean[] = []
    textarea().addEventListener('mousedown', (e) => prevented.push(e.defaultPrevented))
    await presses(5)
    expect(birdEvents).toEqual(['start'])
    expect(isVoiceBirdHere()).toBe(true)
    // Nothing of the click was taken: no preventDefault, the field focused.
    expect(prevented.every((p) => !p)).toBe(true)
    expect(document.activeElement).toBe(textarea())
  })

  it('five presses again send it away', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await mount({ voice: { availability: READY, mode: voiceMode() } })
    await presses(5)
    await presses(5)
    expect(birdEvents).toEqual(['start', 'end'])
    expect(isVoiceBirdHere()).toBe(false)
  })

  it('a triple-click, four presses, or five slow ones call nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await mount({ voice: { availability: READY, mode: voiceMode() } })
    await presses(3)
    vi.advanceTimersByTime(5000)
    await presses(4)
    vi.advanceTimersByTime(5000)
    await presses(5, 600)
    expect(birdEvents).toEqual([])
  })

  it('not the main composer (a teammate’s or a run’s chat): nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await mount({ voice: { availability: READY, mode: voiceMode() }, mainComposer: false })
    await presses(5)
    expect(birdEvents).toEqual([])
  })

  it('the web (no voice), or the mic taken: nothing hatches', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await mount({})
    await presses(5)
    expect(birdEvents).toEqual([])
    act(() => root.unmount())
    root = createRoot(container)
    await mount({ voice: { availability: { ...READY, blocked: 'recording' }, mode: voiceMode() } })
    await presses(5)
    expect(birdEvents).toEqual([])
  })

  it('a double-click then a triple-click (selecting text) calls nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await mount({ voice: { availability: READY, mode: voiceMode() } })
    for (const detail of [1, 2, 1, 2, 3]) {
      await act(async () => {
        textarea().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail }))
      })
      vi.advanceTimersByTime(100)
    }
    expect(birdEvents).toEqual([])
  })

  it('only the primary button counts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await mount({ voice: { availability: READY, mode: voiceMode() } })
    for (let detail = 1; detail <= 5; detail++) {
      await act(async () => {
        textarea().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail, button: 2 }))
      })
    }
    expect(birdEvents).toEqual([])
  })

  it('presses on the composer’s buttons don’t count', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await mount({ voice: { availability: READY, mode: voiceMode() } })
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        waveform()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      })
    }
    expect(birdEvents).toEqual([])
  })
})
