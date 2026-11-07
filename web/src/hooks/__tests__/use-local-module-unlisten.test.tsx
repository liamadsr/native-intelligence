// @vitest-environment jsdom
/**
 * useLocalModule — teardown of the `module://status` listener.
 *
 * Regression: unmounting before `listen()` resolved (React StrictMode does it
 * on every dev mount) unlistened straight away, and Tauri's unlisten threw
 * `undefined is not an object (evaluating 'listeners[eventId].handlerId')`
 * because the webview's listener entry hadn't landed yet. The rejection went
 * unhandled (Next's dev overlay) and the Rust-side unlisten never ran.
 *
 * The bridge is mocked with an unlisten that behaves like Tauri's `_unlisten`:
 * it rejects with that error until the entry "lands", then unlistens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, StrictMode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bridge = vi.hoisted(() => ({
  /** Pending onModuleStatus subscriptions, resolved by the test. */
  pending: [] as Array<() => void>,
  /** Whether the webview's listener entry has landed. */
  entryLanded: false,
  unlisten: vi.fn<() => Promise<void>>(),
  rustUnlisten: vi.fn<() => void>(),
  listeners: new Set<(info: unknown) => void>(),
}))

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => true }))
vi.mock('@/lib/local-modules', () => ({ listLocalModules: () => Promise.resolve([]) }))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    onModuleStatus: (cb: (info: unknown) => void) =>
      new Promise<() => Promise<void>>((resolve) => {
        bridge.pending.push(() => {
          bridge.listeners.add(cb)
          // Like @tauri-apps/api's `async () => _unlisten(event, id)`: the
          // webview-side unregister throws until the entry lands.
          const un = async () => {
            await bridge.unlisten()
            if (!bridge.entryLanded) {
              throw new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')")
            }
            bridge.listeners.delete(cb)
            bridge.rustUnlisten()
          }
          resolve(un)
        })
      }),
  },
}))

import { useLocalModule } from '@/hooks/use-local-module'

function Probe() {
  useLocalModule('local-stt')
  return null
}

let container: HTMLDivElement
let root: Root
const unhandled: unknown[] = []
const onUnhandled = (reason: unknown) => unhandled.push(reason)

beforeEach(() => {
  bridge.pending.length = 0
  bridge.entryLanded = false
  bridge.unlisten.mockReset().mockResolvedValue(undefined)
  bridge.rustUnlisten.mockReset()
  bridge.listeners.clear()
  unhandled.length = 0
  process.on('unhandledRejection', onUnhandled)
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  process.off('unhandledRejection', onUnhandled)
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe('useLocalModule listener teardown', () => {
  it('unmount before listen resolves: no unhandled rejection, and the unlisten still runs', async () => {
    vi.useFakeTimers()
    await act(async () => {
      root.render(h(Probe))
    })
    expect(bridge.pending).toHaveLength(1)
    await act(async () => {
      root.unmount()
    })
    // listen() resolves after the unmount; the registration script hasn't landed.
    await act(async () => {
      bridge.pending[0]()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(bridge.unlisten).toHaveBeenCalledTimes(1)
    expect(bridge.rustUnlisten).not.toHaveBeenCalled()
    // The entry lands; the retry finishes the unlisten (Rust side included).
    bridge.entryLanded = true
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(bridge.unlisten).toHaveBeenCalledTimes(2)
    expect(bridge.rustUnlisten).toHaveBeenCalledTimes(1)
    expect(bridge.listeners.size).toBe(0)
    vi.useRealTimers()
    await flush()
    expect(unhandled).toEqual([])
  })

  it('StrictMode double mount leaves exactly one live listener and no unhandled rejection', async () => {
    bridge.entryLanded = true
    await act(async () => {
      root.render(h(StrictMode, null, h(Probe)))
    })
    // StrictMode: mount → cleanup → mount, both before either listen resolved.
    expect(bridge.pending).toHaveLength(2)
    await act(async () => {
      for (const resolve of bridge.pending) resolve()
      await flush()
    })
    // The first mount's unlisten is deferred a macrotask and then async, so
    // wait for it rather than a fixed tick (a single tick is flaky under load).
    await vi.waitFor(() => expect(bridge.rustUnlisten).toHaveBeenCalledTimes(1))
    expect(bridge.listeners.size).toBe(1)
    await act(async () => {
      root.unmount()
      await flush()
    })
    await vi.waitFor(() => expect(bridge.rustUnlisten).toHaveBeenCalledTimes(2))
    expect(bridge.listeners.size).toBe(0)
    expect(unhandled).toEqual([])
  })
})
