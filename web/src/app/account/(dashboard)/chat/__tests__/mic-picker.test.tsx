// @vitest-environment jsdom
/**
 * The composer's mic picker (chat/mic-picker.tsx): the REAL MicPicker and
 * useInputDevices against an in-memory input-devices bridge, with the
 * webview's getUserMedia and AudioContext faked.
 *
 * Contract pinned here:
 *  - The chevron renders only once list() resolves (not on 0.2.45 / the
 *    browser); send's slot renders either way.
 *  - The popover is the only place the priority list is managed: every known
 *    mic in the snapshot's order, inside a scrolling list; unplugged ones
 *    greyed in their slot, "Unavailable", with Forget (the X, or Delete on
 *    the row); a check on the active one (pulsing while live).
 *  - One short header line, "Drag to set priority · click to use now",
 *    customised or not; there is no reset button (the order is only dragged).
 *  - Only a move changes the order: Alt+ArrowUp/Down move the focused row one
 *    place, unplugged ones too, each one setPriority with the full order.
 *  - A click (or Enter) on a connected row uses it FOR NOW: one setOverride,
 *    the check moves to it, the order stays. The header then says "Using
 *    <name> for now" with "Back to your order"; that, or clicking the row the
 *    order picks, clears it (setOverride(null)). An unplugged row does
 *    nothing. On a desktop without set_input_override a click moves the row
 *    to #1 (setPriority), and the command isn't asked again. Changes are
 *    announced.
 *  - The one-time Bluetooth note, the first time a Bluetooth mic comes into
 *    use: chosen for now, or moved to #1.
 *  - The level bar opens the webview mic on the active device (matched by
 *    label) and stops every track and closes the context when the popover
 *    closes; it opens nothing while a voice session or capture has the mic.
 *  - The body below the bar (mic-picker-panel.tsx, framer-motion's) is
 *    fetched on demand: hovering or focusing the chevron fetches it; opened
 *    before it arrives, a placeholder with a row per mic stands in, and a
 *    keyboard open still lands focus in the list.
 *
 * Pointer drag through framer-motion's Reorder isn't reliable under jsdom;
 * it commits through the same helper as the keyboard path (checked live).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { InputDevice, InputDevicesSnapshot } from '@/lib/tauri-bridge'
import type { VoiceLiveStore } from '@/hooks/use-voice-mode'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const env = vi.hoisted(() => {
  const listeners = new Set<(s: unknown) => void>()
  return {
    listeners,
    emit: (s: unknown) => {
      for (const cb of [...listeners]) cb(s)
    },
    list: vi.fn(),
    setPriority: vi.fn(),
    setOverride: vi.fn(),
    reset: vi.fn(),
    forget: vi.fn(),
    toastError: vi.fn(),
    CommandMissing: class extends Error {
      readonly command: string
      constructor(command: string) {
        super(`Command ${command} not found`)
        this.command = command
      }
    },
  }
})

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => true }))
vi.mock('sonner', () => ({ toast: { error: env.toastError, info: vi.fn(), success: vi.fn() } }))
vi.mock('@/lib/tauri-bridge', () => ({
  InputDevicesCommandMissingError: env.CommandMissing,
  tauriBridge: {
    inputDevices: {
      list: () => env.list(),
      setPriority: (ids: string[]) => env.setPriority(ids),
      setOverride: (id: string | null) => env.setOverride(id),
      reset: () => env.reset(),
      forget: (id: string) => env.forget(id),
      onChanged: (cb: (s: unknown) => void) => {
        env.listeners.add(cb)
        return () => {
          env.listeners.delete(cb)
        }
      },
    },
  },
}))

const { MicPicker, preloadMicPickerPanel, __resetMicPickerPanelForTests, __micPickerPanelRequestedForTests } =
  await import('../mic-picker')
const { levelFromRms } = await import('../mic-level-meter')
const { useInputDevices, __resetInputOverrideSupportForTests } = await import('@/hooks/use-input-devices')

const dev = (id: string, over: Partial<InputDevice> = {}): InputDevice => ({
  id,
  name: id,
  transport: 'usb',
  available: true,
  isDefault: false,
  active: false,
  live: false,
  firstSeenAt: '2026-09-26T01:00:00.000Z',
  lastSeenAt: '2026-09-26T01:00:00.000Z',
  ...over,
})

const BUILT_IN = dev('MacBook Pro Microphone', { transport: 'builtIn', isDefault: true, active: true })
const BRIO = dev('BRIO', { transport: 'usb', available: false })
const AIRPODS = dev('AirPods Pro', { transport: 'bluetooth' })
const TEAMS = dev('Microsoft Teams Audio', { transport: 'virtual' })

const base = (): InputDevicesSnapshot => ({ customised: false, overrideId: null, devices: [BUILT_IN, BRIO, AIRPODS, TEAMS] })
/** base() as the desktop reports it with `id` in use for now. */
const overridden = (id: string, from: () => InputDevicesSnapshot = base): InputDevicesSnapshot => {
  const s = from()
  return { ...s, overrideId: id, devices: s.devices.map((d) => ({ ...d, active: d.id === id })) }
}

// ── The webview mic, faked ────────────────────────────────────────────────────

interface FakeTrack {
  stop: ReturnType<typeof vi.fn>
  getSettings: () => { deviceId: string }
}
let tracks: FakeTrack[]
let contexts: Array<{ close: ReturnType<typeof vi.fn> }>
const getUserMedia = vi.fn()
const enumerateDevices = vi.fn()

const INPUTS = [
  { kind: 'audioinput', deviceId: 'default', label: 'Default - MacBook Pro Microphone' },
  { kind: 'audioinput', deviceId: 'wk-builtin', label: 'MacBook Pro Microphone' },
  { kind: 'audioinput', deviceId: 'wk-airpods', label: 'AirPods Pro' },
]

class FakeAudioContext {
  close = vi.fn(async () => {})
  resume = vi.fn(async () => {})
  constructor() {
    contexts.push(this)
  }
  createAnalyser() {
    return { fftSize: 1024, getFloatTimeDomainData: (buf: Float32Array) => buf.fill(0.05) }
  }
  createMediaStreamSource() {
    return { connect: () => {} }
  }
}

// ── Mounting ─────────────────────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root

interface HarnessProps {
  busy?: boolean
  voiceLive?: VoiceLiveStore | null
  isActive?: boolean
}

function Harness({ busy = false, voiceLive = null, isActive = true }: HarnessProps) {
  const devices = useInputDevices()
  return h(MicPicker, {
    devices,
    isActive,
    busy,
    voiceLive,
    children: h('button', { type: 'button', 'data-testid': 'slot' }, 'waveform'),
  })
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

async function mount(props: HarnessProps = {}) {
  await act(async () => root.render(h(Harness, props)))
  await flush()
}

const q = <T extends Element = HTMLElement>(sel: string) => document.body.querySelector(sel) as T | null
const qa = <T extends Element = HTMLElement>(sel: string) => [...document.body.querySelectorAll<T & Element>(sel)] as T[]
const chevron = () => q<HTMLButtonElement>('[data-testid="mic-picker-chevron"]')
const popover = () => q('[data-testid="mic-picker"]')
const rows = () => qa<HTMLElement>('[data-testid="mic-picker-row"]')
const rowIds = () => rows().map((r) => r.dataset.deviceId)
const pickButton = (id: string) =>
  rows().find((r) => r.dataset.deviceId === id)!.querySelector<HTMLButtonElement>('[data-testid="mic-picker-pick"]')!
const announcer = () => q('[data-testid="mic-picker-announcer"]')!.textContent
const row = (id: string) => rows().find((r) => r.dataset.deviceId === id)!
const forgetButton = (id: string) => row(id).querySelector<HTMLButtonElement>('[data-testid="mic-picker-forget"]')
const header = () => q('[data-testid="mic-picker-header"]')!
const HEADER = 'Drag to set priority · click to use now'
const overrideLine = () => q('[data-testid="mic-picker-override"]')
const backToOrder = () => q<HTMLButtonElement>('[data-testid="mic-picker-back-to-order"]')
/** The rows carrying the check. */
const checked = () => rows().filter((r) => r.querySelector('[data-testid="mic-picker-check"]')).map((r) => r.dataset.deviceId)
const ORDER = ['MacBook Pro Microphone', 'BRIO', 'AirPods Pro', 'Microsoft Teams Audio']

async function click(el: HTMLElement) {
  await act(async () => el.click())
  await flush()
}

const loading = () => q('[data-testid="mic-picker-loading"]')

/** Open the popover and wait for its body (fetched on first use). */
async function openPicker() {
  await click(chevron()!)
  expect(popover()).not.toBeNull()
  await act(async () => {
    await preloadMicPickerPanel()
  })
  await flush()
  expect(loading()).toBeNull()
}

async function press(el: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
  await flush()
}

/** The desktop's answer to set_input_priority: that order, customised. */
function answerSetPriority() {
  env.setPriority.mockImplementation(async (ids: string[]) => {
    const all = base().devices
    return { customised: true, overrideId: null, devices: ids.map((id) => all.find((d) => d.id === id)!) }
  })
}

/** The desktop's answer to set_input_override over base(): that mic in use
 *  (null: the Mac default, base() not being customised). */
function answerSetOverride() {
  env.setOverride.mockImplementation(async (id: string | null) =>
    id ? overridden(id) : base(),
  )
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  env.listeners.clear()
  env.list.mockReset().mockResolvedValue(base())
  env.setPriority.mockReset()
  env.setOverride.mockReset()
  env.reset.mockReset()
  env.forget.mockReset()
  env.toastError.mockReset()
  __resetInputOverrideSupportForTests()
  try {
    window.localStorage.clear()
  } catch {
    /* ignore */
  }

  tracks = []
  contexts = []
  getUserMedia.mockReset().mockImplementation(async (constraints: { audio: { deviceId?: { exact: string } } }) => {
    const deviceId = constraints.audio.deviceId?.exact ?? 'wk-builtin'
    const track: FakeTrack = { stop: vi.fn(), getSettings: () => ({ deviceId }) }
    tracks.push(track)
    return { getTracks: () => [track], getAudioTracks: () => [track] }
  })
  enumerateDevices.mockReset().mockResolvedValue(INPUTS)
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia, enumerateDevices },
  })
  vi.stubGlobal('AudioContext', FakeAudioContext)
  // Frames never run on their own here: the loop is started, not driven.
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── The chevron ──────────────────────────────────────────────────────────────

describe('the chevron', () => {
  it('hidden without the capability (list() rejects: 0.2.45); send\'s slot still renders', async () => {
    env.list.mockRejectedValue(new Error('unknown command'))
    await mount()
    expect(chevron()).toBeNull()
    expect(q('[data-mic-picker]')).toBeNull()
    expect(q('[data-testid="slot"]')).not.toBeNull()
  })

  it('shown with it, grouped with send\'s slot', async () => {
    await mount()
    const group = q('[data-mic-picker]')!
    expect(group.getAttribute('role')).toBe('group')
    expect(group.contains(q('[data-testid="slot"]'))).toBe(true)
    expect(group.contains(chevron())).toBe(true)
    expect(popover()).toBeNull()
  })
})

// ── The popover's body, fetched on demand ───────────────────────────────────

describe('the popover body (mic-picker-panel.tsx), fetched on demand', () => {
  beforeEach(() => {
    __resetMicPickerPanelForTests()
  })

  /** Resolve the pending fetch inside act, then settle. */
  async function arrive() {
    await act(async () => {
      await preloadMicPickerPanel()
    })
    await flush()
  }

  it('opened before it arrives: the level bar and a placeholder with a row per mic, then the list', async () => {
    await mount()
    const c = chevron()!
    // Synchronous act: the fetch can't land inside it.
    act(() => {
      c.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      c.click()
    })
    expect(popover()).not.toBeNull()
    expect(loading()!.getAttribute('aria-busy')).toBe('true')
    expect(qa('[data-testid="mic-picker-loading-row"]')).toHaveLength(4)
    expect(rows()).toHaveLength(0)
    // The bar isn't part of the fetch.
    expect(q('[data-testid="mic-level"]')).not.toBeNull()

    await arrive()
    expect(loading()).toBeNull()
    expect(rowIds()).toEqual(ORDER)
    expect(header().textContent).toBe(HEADER)
    // The bar stayed mounted through the swap: the webview mic opened once.
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    // Opened with the pointer: focus stays out of the list.
    expect(rows().some((r) => r.contains(document.activeElement))).toBe(false)
  })

  it('opened from the keyboard before it arrives: focus moves into the list once it does', async () => {
    await mount()
    act(() => chevron()!.click())
    expect(loading()).not.toBeNull()
    await arrive()
    expect(document.activeElement).toBe(pickButton('MacBook Pro Microphone'))
  })

  it('the pointer reaching the chevron fetches it, so the open renders the list at once', async () => {
    await mount()
    expect(__micPickerPanelRequestedForTests()).toBe(false)
    await act(async () => {
      chevron()!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    })
    expect(__micPickerPanelRequestedForTests()).toBe(true)
    await arrive()
    act(() => chevron()!.click())
    expect(loading()).toBeNull()
    expect(rowIds()).toEqual(ORDER)
    await flush()
  })

  it('focus on the chevron fetches it too', async () => {
    await mount()
    expect(__micPickerPanelRequestedForTests()).toBe(false)
    await act(async () => chevron()!.focus())
    expect(__micPickerPanelRequestedForTests()).toBe(true)
    await arrive()
  })
})

// ── The list ─────────────────────────────────────────────────────────────────

describe('the list', () => {
  it('every known mic in the snapshot order, inside the scrolling list', async () => {
    await mount()
    await openPicker()
    expect(rowIds()).toEqual(['MacBook Pro Microphone', 'BRIO', 'AirPods Pro', 'Microsoft Teams Audio'])
    const scroll = q('[data-testid="mic-picker-scroll"]')!
    expect(scroll.className).toContain('overflow-y-auto')
    expect(scroll.className).toMatch(/max-h-/)
    expect(rows().every((r) => scroll.contains(r))).toBe(true)
    // "Manage microphones…" is gone: this is the only place.
    expect(document.body.textContent).not.toContain('Manage microphones')
  })

  it('unplugged mics: greyed in their slot, "Unavailable", Forget, never checked', async () => {
    await mount()
    await openPicker()
    expect(row('BRIO').dataset.available).toBe('false')
    expect(row('BRIO').querySelector('[data-testid="mic-picker-unavailable"]')!.textContent).toBe('Unavailable')
    expect(row('BRIO').querySelector('.opacity-50')).not.toBeNull()
    expect(forgetButton('BRIO')!.getAttribute('aria-label')).toBe('Forget BRIO')
    expect(qa('[data-testid="mic-picker-forget"]')).toHaveLength(1)
    expect(qa('[data-testid="mic-picker-unavailable"]')).toHaveLength(1)
    // Unplugged rows can be dragged too.
    expect(row('BRIO').querySelector('[data-testid="mic-picker-grip"]')).not.toBeNull()
  })

  it('a check on the active row only; suffixes; the Bluetooth hint on the Bluetooth row only', async () => {
    await mount()
    await openPicker()
    const checks = qa('[data-testid="mic-picker-check"]')
    expect(checks).toHaveLength(1)
    expect(row('MacBook Pro Microphone').contains(checks[0])).toBe(true)
    expect(checks[0].getAttribute('data-live')).toBeNull()
    expect(row('MacBook Pro Microphone').textContent).toContain('(Built-in)')
    expect(row('Microsoft Teams Audio').textContent).toContain('(Virtual)')
    expect(qa('[data-testid="mic-picker-bluetooth-hint"]')).toHaveLength(1)
    expect(row('AirPods Pro').querySelector('[data-testid="mic-picker-bluetooth-hint"]')).not.toBeNull()
  })

  it('the check pulses while the active mic is live, and follows a live event', async () => {
    await mount()
    await openPicker()
    await act(async () => {
      env.emit({
        customised: true,
        devices: [{ ...AIRPODS, active: true, live: true }, { ...BUILT_IN, active: false }, BRIO, TEAMS],
      })
    })
    await flush()
    expect(rowIds()).toEqual(['AirPods Pro', 'MacBook Pro Microphone', 'BRIO', 'Microsoft Teams Audio'])
    const check = q('[data-testid="mic-picker-check"]')!
    expect(row('AirPods Pro').contains(check)).toBe(true)
    expect(check.getAttribute('data-live')).toBe('true')
    expect(check.getAttribute('class')).toContain('animate-pulse')
  })

  it('the MacBook mic with the lid closed: greyed, "Unavailable · lid closed", not pickable, nothing to forget', async () => {
    env.list.mockResolvedValue({
      customised: true,
      overrideId: null,
      devices: [{ ...BUILT_IN, active: false, unavailableReason: 'lid_closed' }, BRIO, { ...AIRPODS, active: true }, TEAMS],
    })
    await mount()
    await openPicker()
    const lid = row('MacBook Pro Microphone')
    // Still connected: only the reason says it can't hear.
    expect(lid.dataset.available).toBe('true')
    expect(lid.dataset.unavailableReason).toBe('lid_closed')
    expect(lid.querySelector('[data-testid="mic-picker-unavailable"]')!.textContent).toBe('Unavailable · lid closed')
    expect(lid.querySelector('.opacity-50')).not.toBeNull()
    expect(pickButton('MacBook Pro Microphone').getAttribute('aria-disabled')).toBe('true')
    expect(forgetButton('MacBook Pro Microphone')).toBeNull()
    expect(lid.querySelector('[data-testid="mic-picker-check"]')).toBeNull()
    await click(pickButton('MacBook Pro Microphone'))
    expect(env.setOverride).not.toHaveBeenCalled()
    expect(env.setPriority).not.toHaveBeenCalled()
    // Delete doesn't forget it either (it is connected).
    pickButton('MacBook Pro Microphone').focus()
    await act(async () => {
      pickButton('MacBook Pro Microphone').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    })
    expect(env.forget).not.toHaveBeenCalled()
  })
})

// ── A click: this mic for now ────────────────────────────────────────────────

describe('a click uses the mic for now', () => {
  it('one setOverride; the check moves to it at once; the order stays', async () => {
    const answer = deferred<InputDevicesSnapshot>()
    env.setOverride.mockReturnValue(answer.promise)
    await mount()
    await openPicker()
    await click(pickButton('Microsoft Teams Audio'))
    expect(env.setOverride).toHaveBeenCalledTimes(1)
    expect(env.setOverride).toHaveBeenCalledWith('Microsoft Teams Audio')
    expect(env.setPriority).not.toHaveBeenCalled()
    // Optimistic: the check is on it before the desktop answers.
    expect(checked()).toEqual(['Microsoft Teams Audio'])
    expect(rowIds()).toEqual(ORDER)
    expect(announcer()).toBe('Using Microsoft Teams Audio for now')

    await act(async () => answer.resolve(overridden('Microsoft Teams Audio')))
    await flush()
    expect(checked()).toEqual(['Microsoft Teams Audio'])
    expect(rowIds()).toEqual(ORDER)
    // The popover stays open.
    expect(popover()).not.toBeNull()
  })

  it('the check follows `active` from the desktop', async () => {
    await mount()
    await openPicker()
    expect(checked()).toEqual(['MacBook Pro Microphone'])
    await act(async () => env.emit(overridden('AirPods Pro')))
    await flush()
    expect(checked()).toEqual(['AirPods Pro'])
    expect(rowIds()).toEqual(ORDER)
  })

  it('clicking an unplugged row, the row in use, or the order\'s pick with no override writes nothing', async () => {
    await mount()
    await openPicker()
    await click(pickButton('BRIO'))
    await click(pickButton('MacBook Pro Microphone'))
    expect(env.setOverride).not.toHaveBeenCalled()
    expect(env.setPriority).not.toHaveBeenCalled()
    expect(announcer()).toBe('Using MacBook Pro Microphone')

    // Already chosen for now: nothing to change either.
    env.list.mockResolvedValue(overridden('AirPods Pro'))
    await act(async () => root.unmount())
    root = createRoot(container)
    await mount()
    await openPicker()
    await click(pickButton('AirPods Pro'))
    expect(env.setOverride).not.toHaveBeenCalled()
  })

  it('clicking the row the order picks ends the override', async () => {
    env.list.mockResolvedValue(overridden('AirPods Pro'))
    answerSetOverride()
    await mount()
    await openPicker()
    expect(checked()).toEqual(['AirPods Pro'])
    await click(pickButton('MacBook Pro Microphone'))
    expect(env.setOverride).toHaveBeenCalledTimes(1)
    expect(env.setOverride).toHaveBeenCalledWith(null)
    expect(env.setPriority).not.toHaveBeenCalled()
    expect(checked()).toEqual(['MacBook Pro Microphone'])
    expect(overrideLine()).toBeNull()
    expect(announcer()).toBe('Back to your order: using MacBook Pro Microphone')
  })

  it('a click while another mic is chosen for now switches to it, still without reordering', async () => {
    env.list.mockResolvedValue(overridden('AirPods Pro'))
    answerSetOverride()
    await mount()
    await openPicker()
    await click(pickButton('Microsoft Teams Audio'))
    expect(env.setOverride).toHaveBeenCalledWith('Microsoft Teams Audio')
    expect(checked()).toEqual(['Microsoft Teams Audio'])
    expect(overrideLine()!.textContent).toBe('Using Microsoft Teams Audio for now')
    expect(rowIds()).toEqual(ORDER)
  })

  it('a refused override puts the check back and says so', async () => {
    env.setOverride.mockRejectedValue('device not found')
    await mount()
    await openPicker()
    await click(pickButton('AirPods Pro'))
    expect(checked()).toEqual(['MacBook Pro Microphone'])
    expect(overrideLine()).toBeNull()
    expect(rowIds()).toEqual(ORDER)
    expect(env.setPriority).not.toHaveBeenCalled()
    expect(env.toastError).toHaveBeenCalledWith("Couldn't switch to AirPods Pro")
  })

  it('a desktop without set_input_override: the click moves the row to #1, and the command isn\'t asked again', async () => {
    env.setOverride.mockRejectedValue(new env.CommandMissing('set_input_override'))
    answerSetPriority()
    await mount()
    await openPicker()
    await click(pickButton('Microsoft Teams Audio'))
    expect(env.setOverride).toHaveBeenCalledTimes(1)
    expect(env.setPriority).toHaveBeenCalledTimes(1)
    expect(env.setPriority).toHaveBeenCalledWith(['Microsoft Teams Audio', 'MacBook Pro Microphone', 'BRIO', 'AirPods Pro'])
    expect(rowIds()).toEqual(['Microsoft Teams Audio', 'MacBook Pro Microphone', 'BRIO', 'AirPods Pro'])
    expect(announcer()).toBe('Using Microsoft Teams Audio')
    expect(env.toastError).not.toHaveBeenCalled()

    // From the keyboard: focus follows it to the top; no second setOverride.
    const airpods = pickButton('AirPods Pro')
    airpods.focus()
    await click(airpods)
    expect(env.setOverride).toHaveBeenCalledTimes(1)
    expect(env.setPriority).toHaveBeenLastCalledWith(['AirPods Pro', 'Microsoft Teams Audio', 'MacBook Pro Microphone', 'BRIO'])
    expect(rowIds()).toEqual(['AirPods Pro', 'Microsoft Teams Audio', 'MacBook Pro Microphone', 'BRIO'])
    expect(document.activeElement).toBe(pickButton('AirPods Pro'))
  })
})

// ── The header line ──────────────────────────────────────────────────────────

describe('the header line', () => {
  // One mount per case. Both cases once shared a test that mounted and opened
  // the picker twice, and it hit the 5 s default under a loaded full-suite run.
  it('no override, not customised: one short line', async () => {
    await mount()
    await openPicker()
    expect(header().textContent).toBe(HEADER)
    expect(backToOrder()).toBeNull()
    expect(document.body.textContent).not.toContain("Following your Mac's default input")
  })

  it('no override, customised: the same short line', async () => {
    env.list.mockResolvedValue({ ...base(), customised: true })
    await mount()
    await openPicker()
    expect(header().textContent).toBe(HEADER)
    expect(backToOrder()).toBeNull()
    expect(document.body.textContent).not.toContain('highest connected mic')
  })

  it('a mic chosen for now: "Using <name> for now · Back to your order"', async () => {
    env.list.mockResolvedValue(overridden('AirPods Pro'))
    await mount()
    await openPicker()
    expect(header().textContent).toBe('Using AirPods Pro for now·Back to your order')
    expect(overrideLine()!.textContent).toBe('Using AirPods Pro for now')
    expect(backToOrder()!.textContent).toBe('Back to your order')
    expect(header().contains(backToOrder())).toBe(true)
  })

  it('"Back to your order" clears the override: the check returns, focus stays in the panel', async () => {
    env.list.mockResolvedValue(overridden('AirPods Pro'))
    answerSetOverride()
    await mount()
    await openPicker()
    const back = backToOrder()!
    back.focus()
    await click(back)
    expect(env.setOverride).toHaveBeenCalledTimes(1)
    expect(env.setOverride).toHaveBeenCalledWith(null)
    expect(env.setPriority).not.toHaveBeenCalled()
    expect(backToOrder()).toBeNull()
    expect(header().textContent).toBe(HEADER)
    expect(checked()).toEqual(['MacBook Pro Microphone'])
    expect(rowIds()).toEqual(ORDER)
    expect(document.activeElement).toBe(header())
    expect(announcer()).toBe('Back to your order: using MacBook Pro Microphone')
  })

  it('a refused "Back to your order" keeps the override and says so', async () => {
    env.list.mockResolvedValue(overridden('AirPods Pro'))
    env.setOverride.mockRejectedValue(new Error('nope'))
    await mount()
    await openPicker()
    await click(backToOrder()!)
    expect(overrideLine()!.textContent).toBe('Using AirPods Pro for now')
    expect(checked()).toEqual(['AirPods Pro'])
    expect(env.toastError).toHaveBeenCalledWith("Couldn't go back to your microphone order")
  })
})

// ── Keyboard ─────────────────────────────────────────────────────────────────

describe('keyboard', () => {
  it('Alt+ArrowUp / Alt+ArrowDown move the focused row one place, announced, focus kept', async () => {
    answerSetPriority()
    await mount()
    await openPicker()
    const teams = pickButton('Microsoft Teams Audio')
    teams.focus()
    await press(teams, 'ArrowUp', { altKey: true })
    expect(env.setPriority).toHaveBeenLastCalledWith(['MacBook Pro Microphone', 'BRIO', 'Microsoft Teams Audio', 'AirPods Pro'])
    expect(rowIds()).toEqual(['MacBook Pro Microphone', 'BRIO', 'Microsoft Teams Audio', 'AirPods Pro'])
    expect(announcer()).toBe('Microsoft Teams Audio moved to 3 of 4')
    expect(document.activeElement).toBe(pickButton('Microsoft Teams Audio'))

    await press(pickButton('MacBook Pro Microphone'), 'ArrowDown', { altKey: true })
    expect(env.setPriority).toHaveBeenLastCalledWith(['BRIO', 'MacBook Pro Microphone', 'Microsoft Teams Audio', 'AirPods Pro'])
    expect(env.setPriority).toHaveBeenCalledTimes(2)
  })

  it('an unplugged row moves too', async () => {
    answerSetPriority()
    await mount()
    await openPicker()
    await press(pickButton('BRIO'), 'ArrowDown', { altKey: true })
    expect(env.setPriority).toHaveBeenCalledWith(['MacBook Pro Microphone', 'AirPods Pro', 'BRIO', 'Microsoft Teams Audio'])
    expect(announcer()).toBe('BRIO moved to 3 of 4')
  })

  it('a refused move reverts the order and says so', async () => {
    env.setPriority.mockRejectedValue(new Error('nope'))
    await mount()
    await openPicker()
    await press(pickButton('AirPods Pro'), 'ArrowUp', { altKey: true })
    expect(env.setPriority).toHaveBeenCalledTimes(1)
    expect(rowIds()).toEqual(ORDER)
    expect(env.toastError).toHaveBeenCalledWith("Couldn't save the microphone order")
  })

  it('Alt+Arrow keeps a mic chosen for now', async () => {
    env.list.mockResolvedValue(overridden('Microsoft Teams Audio'))
    env.setPriority.mockReturnValue(new Promise(() => {}))
    await mount()
    await openPicker()
    await press(pickButton('AirPods Pro'), 'ArrowUp', { altKey: true })
    expect(rowIds()).toEqual(['MacBook Pro Microphone', 'AirPods Pro', 'BRIO', 'Microsoft Teams Audio'])
    expect(env.setOverride).not.toHaveBeenCalled()
    expect(checked()).toEqual(['Microsoft Teams Audio'])
    expect(overrideLine()!.textContent).toBe('Using Microsoft Teams Audio for now')
  })

  it('Alt+Arrow past either end writes nothing', async () => {
    await mount()
    await openPicker()
    await press(pickButton('MacBook Pro Microphone'), 'ArrowUp', { altKey: true })
    await press(pickButton('Microsoft Teams Audio'), 'ArrowDown', { altKey: true })
    expect(env.setPriority).not.toHaveBeenCalled()
  })

  it('Enter (or Space) uses a connected row for now; it stays in place, focus kept', async () => {
    answerSetOverride()
    await mount()
    await openPicker()
    const airpods = pickButton('AirPods Pro')
    airpods.focus()
    // A focused button's Enter or Space is its click.
    await click(airpods)
    expect(env.setOverride).toHaveBeenCalledWith('AirPods Pro')
    expect(env.setPriority).not.toHaveBeenCalled()
    expect(rowIds()).toEqual(ORDER)
    expect(checked()).toEqual(['AirPods Pro'])
    expect(document.activeElement).toBe(pickButton('AirPods Pro'))
  })

  it('plain arrows, Home and End move focus without reordering', async () => {
    await mount()
    await openPicker()
    const first = pickButton('MacBook Pro Microphone')
    first.focus()
    await press(first, 'ArrowDown')
    expect(document.activeElement).toBe(pickButton('BRIO'))
    await press(pickButton('BRIO'), 'End')
    expect(document.activeElement).toBe(pickButton('Microsoft Teams Audio'))
    await press(pickButton('Microsoft Teams Audio'), 'Home')
    expect(document.activeElement).toBe(first)
    expect(env.setPriority).not.toHaveBeenCalled()
  })
})

// ── Forget ───────────────────────────────────────────────────────────────────

describe('Forget', () => {
  const withTwoUnplugged = (): InputDevicesSnapshot => ({
    customised: true,
    overrideId: null,
    devices: [BUILT_IN, BRIO, AIRPODS, { ...TEAMS, available: false }],
  })

  it('the X forgets the row, announced; focus moves to the next row', async () => {
    env.forget.mockImplementation(async (id: string) => ({
      ...base(),
      devices: base().devices.filter((d) => d.id !== id),
    }))
    await mount()
    await openPicker()
    const x = forgetButton('BRIO')!
    x.focus()
    await click(x)
    expect(env.forget).toHaveBeenCalledWith('BRIO')
    expect(rowIds()).toEqual(['MacBook Pro Microphone', 'AirPods Pro', 'Microsoft Teams Audio'])
    expect(announcer()).toBe('BRIO forgotten')
    expect(document.activeElement).toBe(pickButton('AirPods Pro'))
  })

  it('Delete (or Backspace) on an unplugged row forgets it; the last row hands focus back', async () => {
    env.list.mockResolvedValue(withTwoUnplugged())
    env.forget.mockImplementation(async (id: string) => ({
      ...withTwoUnplugged(),
      devices: withTwoUnplugged().devices.filter((d) => d.id !== id),
    }))
    await mount()
    await openPicker()
    const teams = pickButton('Microsoft Teams Audio')
    teams.focus()
    await press(teams, 'Delete')
    expect(env.forget).toHaveBeenCalledWith('Microsoft Teams Audio')
    expect(announcer()).toBe('Microsoft Teams Audio forgotten')
    expect(document.activeElement).toBe(pickButton('AirPods Pro'))

    const brio = pickButton('BRIO')
    brio.focus()
    await press(brio, 'Backspace')
    expect(env.forget).toHaveBeenLastCalledWith('BRIO')
  })

  it('Delete on a connected row does nothing', async () => {
    await mount()
    await openPicker()
    await press(pickButton('AirPods Pro'), 'Delete')
    expect(env.forget).not.toHaveBeenCalled()
  })

  it('forgetting the only row moves focus to the header line', async () => {
    env.list.mockResolvedValue({ customised: true, devices: [BRIO] })
    env.forget.mockResolvedValue({ customised: true, devices: [] })
    await mount()
    await openPicker()
    await press(pickButton('BRIO'), 'Delete')
    expect(rows()).toHaveLength(0)
    expect(q('[data-testid="mic-picker-empty"]')).not.toBeNull()
    expect(document.activeElement).toBe(header())
  })

  it('a refused Forget brings the row back and says so', async () => {
    env.forget.mockRejectedValue(new Error('connected'))
    await mount()
    await openPicker()
    await click(forgetButton('BRIO')!)
    expect(rowIds()).toContain('BRIO')
    expect(env.toastError).toHaveBeenCalledWith("Couldn't forget BRIO")
  })
})

// ── Reset, the Bluetooth note, closing ───────────────────────────────────────

describe('no reset button', () => {
  it('shows no "Use system default", customised or not', async () => {
    env.list.mockResolvedValue({ ...base(), customised: true })
    await mount()
    await openPicker()
    expect(q('[data-testid="mic-picker-reset"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Use system default')
    expect(env.reset).not.toHaveBeenCalled()
  })
})

describe('the Bluetooth note', () => {
  const note = () => q('[data-testid="mic-picker-bluetooth-note"]')

  it('appears the first time a Bluetooth mic is chosen for now, is dismissible, and never again', async () => {
    answerSetOverride()
    answerSetPriority()
    await mount()
    await openPicker()
    expect(note()).toBeNull()
    await click(pickButton('AirPods Pro'))
    expect(env.setOverride).toHaveBeenCalledWith('AirPods Pro')
    expect(note()).not.toBeNull()
    await click(note()!.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!)
    expect(note()).toBeNull()

    // Back to the order, chosen again, then moved to #1: the note stays seen.
    await click(pickButton('MacBook Pro Microphone'))
    await click(pickButton('AirPods Pro'))
    await press(pickButton('AirPods Pro'), 'ArrowUp', { altKey: true })
    await press(pickButton('AirPods Pro'), 'ArrowUp', { altKey: true })
    expect(rowIds()[0]).toBe('AirPods Pro')
    expect(note()).toBeNull()
  })

  it('appears the first time a Bluetooth mic reaches #1 by a move', async () => {
    env.list.mockResolvedValue({ ...base(), customised: true, devices: [BUILT_IN, AIRPODS, BRIO, TEAMS] })
    answerSetPriority()
    await mount()
    await openPicker()
    await press(pickButton('AirPods Pro'), 'ArrowUp', { altKey: true })
    expect(env.setPriority).toHaveBeenCalledWith(['AirPods Pro', 'MacBook Pro Microphone', 'BRIO', 'Microsoft Teams Audio'])
    expect(env.setOverride).not.toHaveBeenCalled()
    expect(note()).not.toBeNull()
  })

  it('no note when a non-Bluetooth mic comes into use', async () => {
    answerSetOverride()
    answerSetPriority()
    await mount()
    await openPicker()
    await click(pickButton('Microsoft Teams Audio'))
    await press(pickButton('Microsoft Teams Audio'), 'ArrowUp', { altKey: true })
    await press(pickButton('Microsoft Teams Audio'), 'ArrowUp', { altKey: true })
    await press(pickButton('Microsoft Teams Audio'), 'ArrowUp', { altKey: true })
    expect(rowIds()[0]).toBe('Microsoft Teams Audio')
    expect(note()).toBeNull()
  })
})

describe('closing', () => {
  it('closes when the composer\'s tab goes inactive', async () => {
    await mount()
    await openPicker()
    await act(async () => root.render(h(Harness, { isActive: false })))
    await flush()
    expect(popover()).toBeNull()
  })
})

// ── The level bar ────────────────────────────────────────────────────────────

describe('the level bar', () => {
  it('maps RMS on a dB scale: silence empty, normal speech ~60–80%, loud full', () => {
    expect(levelFromRms(0)).toBe(0)
    expect(levelFromRms(0.001)).toBe(0)
    const speech = [0.03, 0.05, 0.08].map(levelFromRms)
    for (const v of speech) {
      expect(v).toBeGreaterThan(0.55)
      expect(v).toBeLessThan(0.85)
    }
    expect(levelFromRms(0.5)).toBe(1)
  })

  it('opens the webview mic on the active device, and stops it (and the context) on close', async () => {
    env.list.mockResolvedValue({
      customised: true,
      devices: [{ ...AIRPODS, active: true }, { ...BUILT_IN, active: false }, BRIO, TEAMS],
    })
    await mount()
    expect(getUserMedia).not.toHaveBeenCalled()
    await openPicker()
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(getUserMedia.mock.calls[0][0].audio.deviceId).toEqual({ exact: 'wk-airpods' })
    expect(q('[data-testid="mic-level"]')!.getAttribute('data-source')).toBe('webview')
    expect(q('[data-testid="mic-level-bar"]')).not.toBeNull()
    expect(contexts).toHaveLength(1)

    await click(chevron()!)
    expect(popover()).toBeNull()
    expect(tracks).toHaveLength(1)
    expect(tracks[0].stop).toHaveBeenCalled()
    expect(contexts[0].close).toHaveBeenCalled()
  })

  it('labels hidden at first (no grant yet): opens the default, then moves to the active device', async () => {
    env.list.mockResolvedValue({
      customised: true,
      devices: [{ ...AIRPODS, active: true }, { ...BUILT_IN, active: false }, BRIO, TEAMS],
    })
    enumerateDevices
      .mockResolvedValueOnce([{ kind: 'audioinput', deviceId: '', label: '' }])
      .mockResolvedValue(INPUTS)
    await mount()
    await openPicker()
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    expect(getUserMedia.mock.calls[0][0].audio.deviceId).toBeUndefined()
    expect(getUserMedia.mock.calls[1][0].audio.deviceId).toEqual({ exact: 'wk-airpods' })
    expect(tracks[0].stop).toHaveBeenCalled()
    expect(tracks[1].stop).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    expect(tracks[1].stop).toHaveBeenCalled()
    root = createRoot(container)
  })

  it('stops the tracks when the picker unmounts while open', async () => {
    await mount()
    await openPicker()
    expect(tracks).toHaveLength(1)
    await act(async () => root.unmount())
    expect(tracks[0].stop).toHaveBeenCalled()
    expect(contexts[0].close).toHaveBeenCalled()
    root = createRoot(container)
  })

  it('opens nothing while dictation or a capture has the mic (busy): the bar idles', async () => {
    await mount({ busy: true })
    await openPicker()
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(q('[data-testid="mic-level"]')!.getAttribute('data-source')).toBe('idle')
    expect(q('[data-testid="mic-level-bar"]')).not.toBeNull()
  })

  it('opens nothing while the desktop is capturing (a live device in the snapshot)', async () => {
    env.list.mockResolvedValue({ ...base(), devices: [{ ...BUILT_IN, live: true }, BRIO, AIRPODS, TEAMS] })
    await mount()
    await openPicker()
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(q('[data-testid="mic-level"]')!.getAttribute('data-source')).toBe('idle')
  })

  it('a capture starting while open stops the webview mic at once', async () => {
    await mount()
    await openPicker()
    expect(tracks).toHaveLength(1)
    await act(async () => {
      env.emit({ ...base(), devices: [{ ...BUILT_IN, live: true }, BRIO, AIRPODS, TEAMS] })
    })
    await flush()
    expect(tracks[0].stop).toHaveBeenCalled()
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('voice mode on in this panel: driven by its own mic level, no webview mic', async () => {
    const live: VoiceLiveStore = {
      subscribe: () => () => {},
      get: () => ({ mic: 0.05, agent: 0, transcript: null }),
    }
    await mount({ voiceLive: live })
    await openPicker()
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(q('[data-testid="mic-level"]')!.getAttribute('data-source')).toBe('voice')
  })

  it('getUserMedia refused: the bar hides quietly', async () => {
    getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    await mount()
    await openPicker()
    expect(q('[data-testid="mic-level-bar"]')).toBeNull()
    expect(q('[data-testid="mic-level"]')!.textContent).toContain('Microphone')
    expect(env.toastError).not.toHaveBeenCalled()
    // The list still works.
    expect(rows()).toHaveLength(4)
  })
})
