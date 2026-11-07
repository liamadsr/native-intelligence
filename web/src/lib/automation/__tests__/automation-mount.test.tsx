// @vitest-environment jsdom
/**
 * window.__dial8Automation exists only in the desktop app launched with the
 * automation bridge (its flag, version 1): absent in a browser, absent in the
 * desktop app launched normally, and its code is never even fetched there.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useEffect } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { loads } = vi.hoisted(() => ({ loads: { n: 0 } }))
// The real bridge needs the dashboard's providers: a stand-in that registers
// the way it does, counting how often its module is fetched.
vi.mock('../automation-bridge', () => {
  loads.n += 1
  return {
    AutomationBridge: function AutomationBridge() {
      useEffect(() => {
        window.__dial8Automation = { version: 1 } as typeof window.__dial8Automation
        return () => {
          delete window.__dial8Automation
        }
      }, [])
      return null
    },
  }
})

import { AutomationMount } from '../automation-mount'
import { automationFlagged } from '../flag'

let root: Root | null = null

async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(h(AutomationMount)))
  // Room for the module fetch and the re-render it brings.
  for (let i = 0; i < 5; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  delete window.__DIAL8_AUTOMATION__
  delete window.__TAURI_INTERNALS__
  delete window.__dial8Automation
})

describe('the automation API', () => {
  it('is absent without the bridge flag, in the desktop app', async () => {
    window.__TAURI_INTERNALS__ = {}
    expect(automationFlagged()).toBe(false)
    await mount()
    expect(window.__dial8Automation).toBeUndefined()
    expect(loads.n).toBe(0)
  })

  it('is absent outside the desktop app, flag or not', async () => {
    window.__DIAL8_AUTOMATION__ = Object.freeze({ version: 1 })
    expect(automationFlagged()).toBe(false)
    await mount()
    expect(window.__dial8Automation).toBeUndefined()
    expect(loads.n).toBe(0)
  })

  it('is absent for another protocol version', async () => {
    window.__TAURI_INTERNALS__ = {}
    window.__DIAL8_AUTOMATION__ = Object.freeze({ version: 2 })
    expect(automationFlagged()).toBe(false)
    await mount()
    expect(window.__dial8Automation).toBeUndefined()
  })

  it('is registered in the desktop app launched with the bridge, and goes with its mount', async () => {
    window.__TAURI_INTERNALS__ = {}
    window.__DIAL8_AUTOMATION__ = Object.freeze({ version: 1 })
    expect(automationFlagged()).toBe(true)
    await mount()
    expect(window.__dial8Automation?.version).toBe(1)
    expect(loads.n).toBe(1)
    act(() => root?.unmount())
    root = null
    expect(window.__dial8Automation).toBeUndefined()
  })
})
