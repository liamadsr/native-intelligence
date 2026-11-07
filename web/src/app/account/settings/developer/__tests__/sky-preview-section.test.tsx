// @vitest-environment jsdom
/**
 * Developer settings → Sky preview: every weather preset plus "Real weather",
 * a time-of-day slider with a readable label and "Now", the place presets
 * plus "Real location", the floating-controls switch and "Reset to real sky",
 * all writing the dev store (sky-dev-store.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = new Date(2026, 9, 10, 15, 0, 0)

let root: Root
let host: HTMLDivElement

async function mount() {
  vi.resetModules()
  const store = await import('@/lib/sky/sky-dev-store')
  const { SkyPreviewSection } = await import('../sky-preview-section')
  act(() => root.render(h(SkyPreviewSection)))
  return store
}

const button = (name: string) => {
  const b = [...host.querySelectorAll('button')].find((el) => el.textContent?.trim() === name)
  if (!b) throw new Error(`no button "${name}"`)
  return b as HTMLButtonElement
}
const pressed = (name: string) => button(name).getAttribute('aria-pressed') === 'true'
const slider = () => host.querySelector<HTMLInputElement>('input[type="range"][aria-label="Time of day"]')!
const timeLabel = () => host.querySelector('[data-testid="sky-dev-time-label"]')!.textContent

function slide(value: number) {
  const input = slider()
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(input, String(value))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Sky preview section', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    window.localStorage.clear()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  it('renders every weather preset, the places, the slider, and the dev-only note', async () => {
    await mount()
    for (const name of ['Real weather', 'Clear', 'Cirrus', 'Fair', 'Cloudy', 'Overcast', 'Rain', 'Snow', 'Sleet', 'Storm', 'Fog']) {
      expect(button(name)).toBeTruthy()
    }
    for (const name of ['Real location', 'New York', 'London', 'Tokyo', 'Sydney', 'Reykjavik']) expect(button(name)).toBeTruthy()
    expect(pressed('Real weather')).toBe(true)
    expect(pressed('Real location')).toBe(true)
    expect(pressed('Now')).toBe(true)
    expect(timeLabel()).toBe('Now (3:00 PM)')
    expect(slider().min).toBe('0')
    expect(slider().step).toBe('5')
    expect(host.textContent).toContain('Dev only, and remembered on this device.')
    expect(button('Reset to real sky').disabled).toBe(true)
  })

  it('writes the store: rain at 6:40 PM in New York, live in the controls', async () => {
    const store = await mount()
    act(() => button('Rain').click())
    slide(18 * 60 + 40)
    act(() => button('New York').click())
    expect(store.getSkyDevSettings()).toMatchObject({ weather: 'rain', minuteOfDay: 1120, place: 'new-york' })
    expect(pressed('Rain')).toBe(true)
    expect(pressed('Real weather')).toBe(false)
    expect(pressed('Now')).toBe(false)
    expect(timeLabel()).toMatch(/^6:40 PM · \d{1,2}:\d{2} [AP]M in New York$/)
    expect(JSON.parse(window.localStorage.getItem(store.SKY_DEV_STORAGE_KEY)!)).toMatchObject({ weather: 'rain', minuteOfDay: 1120 })

    // "Now" and "Real weather" put the real values back.
    act(() => button('Now').click())
    act(() => button('Real weather').click())
    expect(store.getSkyDevSettings()).toMatchObject({ weather: null, minuteOfDay: null, place: 'new-york' })
  })

  it('the floating switch and the reset', async () => {
    const store = await mount()
    const toggle = host.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Show floating controls"]')!
    act(() => toggle.click())
    expect(store.getSkyDevSettings().floating).toBe(true)
    act(() => button('Snow').click())
    act(() => button('Tokyo').click())
    expect(button('Reset to real sky').disabled).toBe(false)
    act(() => button('Reset to real sky').click())
    expect(store.getSkyDevSettings()).toEqual({ weather: null, minuteOfDay: null, place: null, floating: true })
    expect(pressed('Real weather')).toBe(true)
  })
})
