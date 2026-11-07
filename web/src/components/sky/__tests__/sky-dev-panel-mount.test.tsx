// @vitest-environment jsdom
/**
 * The floating sky preview's mount: nothing until the dev settings turn it
 * on, then the panel (portalled to <body>), gone again with its close button;
 * and in production it never mounts, nor is its module ever loaded, whatever
 * the device has stored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const panelModule = vi.hoisted(() => ({ loads: 0 }))

vi.mock('../sky-dev-panel', async (importOriginal) => {
  panelModule.loads++
  return importOriginal()
})

const KEY = 'dial8.sky.devOverride.v1'

let root: Root
let host: HTMLDivElement

async function mount() {
  vi.resetModules()
  const store = await import('@/lib/sky/sky-dev-store')
  const { SkyDevPanelMount } = await import('../sky-dev-panel-mount')
  act(() => root.render(h(SkyDevPanelMount)))
  return store
}

/** Let the panel's dynamic import and the re-render after it settle. */
async function settle() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

const panel = () => document.querySelector('[data-sky-dev-panel]')

describe('SkyDevPanelMount', () => {
  beforeEach(() => {
    panelModule.loads = 0
    window.localStorage.clear()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllEnvs()
  })

  it('dev: nothing until turned on, then the panel over the page, and its close button removes it', async () => {
    const store = await mount()
    await settle()
    expect(panel()).toBeNull()
    expect(panelModule.loads).toBe(0)

    // Warm the module cache, so the mount's own dynamic import resolves in a few microtasks.
    await import('../sky-dev-panel')
    act(() => store.setSkyDevSettings({ floating: true }))
    await settle()
    expect(panel()).not.toBeNull()
    expect(panel()!.parentElement).toBe(document.body)
    expect(panel()!.querySelector('input[type="range"]')).not.toBeNull()

    act(() => panel()!.querySelector<HTMLButtonElement>('button[aria-label="Close sky preview"]')!.click())
    expect(panel()).toBeNull()
    expect(store.getSkyDevSettings().floating).toBe(false)
  })

  it('production: never mounts and never loads the panel, even with it turned on in storage', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ weather: 'rain', minuteOfDay: 600, place: null, floating: true }))
    vi.stubEnv('NODE_ENV', 'production')
    await mount()
    await settle()
    expect(panel()).toBeNull()
    expect(host.innerHTML).toBe('')
    expect(panelModule.loads).toBe(0)
  })
})
