// @vitest-environment jsdom
/**
 * AppUpdater never restarts (binary update) or reloads (web update) the app
 * while a recording is live. On 2026-09-28 "Restart now" mid-recording cut a
 * 21-minute capture off, and tearing it down while the new process started
 * helped wedge macOS's audio daemon. While recording, the action keeps its
 * toast up and says why; once the recording stops, it works again.
 *
 * The bridge, sonner and the recording context are mocked; the real
 * component drives them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Action = { label: string; onClick: (event: { preventDefault(): void }) => void }

const m = vi.hoisted(() => ({
  recording: { isRecording: false, isStarting: false },
  relaunch: vi.fn(),
  applyUpdate: vi.fn(),
  checkForUpdate: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
}))

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => true }))
vi.mock('@/hooks/recording-context', () => ({ useRecordingStable: () => m.recording }))
vi.mock('@/lib/tauri-bridge', () => ({
  getThisWebviewLabel: async () => 'main',
  tauriBridge: {
    checkForUpdate: () => m.checkForUpdate(),
    relaunch: () => m.relaunch(),
    applyUpdate: () => m.applyUpdate(),
    onCheckForUpdates: async () => () => {},
  },
}))
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => m.success(...args),
    info: (...args: unknown[]) => m.info(...args),
    loading: vi.fn(),
    error: vi.fn(),
  },
}))

import { AppUpdater } from '../app-updater'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  vi.useFakeTimers()
  m.recording = { isRecording: false, isStarting: false }
  for (const fn of [m.relaunch, m.applyUpdate, m.checkForUpdate, m.success, m.info]) fn.mockReset()
  m.checkForUpdate.mockResolvedValue({ available: true, version: '9.9.9', install: async () => {}, via: 'rust' })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ buildId: 'b1' }) })))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** Mount, run the launch check (5s after mount), and return the "Restart
 *  now" action from the update-ready toast. */
async function restartAction(): Promise<Action> {
  await act(async () => root.render(h(AppUpdater)))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  const call = m.success.mock.calls.find(([title]) => String(title).includes('9.9.9'))
  expect(call, 'the update-ready toast').toBeDefined()
  return (call![1] as { action: Action }).action
}

describe('AppUpdater restart while recording', () => {
  it('applies the update through Rust when nothing is recording', async () => {
    const action = await restartAction()
    const event = { preventDefault: vi.fn() }
    action.onClick(event)
    // Rust's app_update_apply: a restart on macOS, the staged installer on
    // Windows.
    expect(m.applyUpdate).toHaveBeenCalledTimes(1)
    expect(m.relaunch).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it("restarts through the plugin on an older build's plugin path", async () => {
    m.checkForUpdate.mockResolvedValue({ available: true, version: '9.9.9', install: async () => {}, via: 'plugin' })
    const action = await restartAction()
    action.onClick({ preventDefault: vi.fn() })
    expect(m.relaunch).toHaveBeenCalledTimes(1)
    expect(m.applyUpdate).not.toHaveBeenCalled()
  })

  it('holds the restart while recording, keeps the toast and says why', async () => {
    m.recording = { isRecording: true, isStarting: false }
    const action = await restartAction()
    const event = { preventDefault: vi.fn() }
    action.onClick(event)
    expect(m.applyUpdate).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalled()
    expect(m.info).toHaveBeenCalledWith('Finish your recording first', expect.anything())
  })

  it('holds it while a recording is starting too', async () => {
    m.recording = { isRecording: false, isStarting: true }
    const action = await restartAction()
    action.onClick({ preventDefault: vi.fn() })
    expect(m.applyUpdate).not.toHaveBeenCalled()
  })

  it('restarts once the recording has stopped', async () => {
    m.recording = { isRecording: true, isStarting: false }
    const action = await restartAction()
    action.onClick({ preventDefault: vi.fn() })
    expect(m.applyUpdate).not.toHaveBeenCalled()

    m.recording = { isRecording: false, isStarting: false }
    await act(async () => root.render(h(AppUpdater)))
    action.onClick({ preventDefault: vi.fn() })
    expect(m.applyUpdate).toHaveBeenCalledTimes(1)
  })
})
