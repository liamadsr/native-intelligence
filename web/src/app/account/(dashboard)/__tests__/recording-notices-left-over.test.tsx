// @vitest-environment jsdom
/**
 * On the Mac, takes left from before (a quit, a crash, a main-window reload mid-take) are sent and filed by the
 * page's recording controller, which the shell loads a while after the page opens, and only when the app has some:
 * the controller then says "Recording saved" once each is filed, as a take stopped with no Studio on screen does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => ({ takes: [] as unknown[], open: vi.fn(async () => {}) }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => true }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) } }) }))
vi.mock('@/lib/tauri-bridge', () => ({ studioRecorder: { unfinishedTakes: async () => ({ takes: h.takes }) } }))
vi.mock('@/components/studio/record/controller', () => ({ recordingController: () => ({ open: h.open }) }))

import { LEFT_OVER_AFTER_MS, RecordingNotices } from '../recording-notices'

let root: Root | null = null, host: HTMLElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.useRealTimers(); h.open.mockReset() })
async function mountAndWait() {
  vi.useFakeTimers()
  host = document.createElement('div'); document.body.appendChild(host)
  await act(async () => { root = createRoot(host!); root.render(<RecordingNotices />) })
  await act(async () => { await vi.advanceTimersByTimeAsync(LEFT_OVER_AFTER_MS + 10) })
  vi.useRealTimers()
  await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
}

describe('a Mac’s left-over takes', () => {
  it('bring the recording controller up to send and file them', async () => {
    h.takes = [{ sessionId: 's1' }]
    await mountAndWait()
    expect(h.open).toHaveBeenCalledTimes(1)
  })

  it('leave it unloaded when there are none', async () => {
    h.takes = []
    await mountAndWait()
    expect(h.open).not.toHaveBeenCalled()
  })
})
