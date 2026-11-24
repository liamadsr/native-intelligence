// @vitest-environment jsdom
/**
 * The shell's side of a Studio take (recording-notices.tsx): a notice becomes a toast with Open in Studio; another
 * account signing in on the page forgets the earlier one's take; and the shell never loads the Studio to do it (its
 * only way to the recording controller is a dynamic import, on a Mac with takes left to send).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
  openTarget: vi.fn(),
  auth: null as null | ((event: string, session: { user: { id: string } } | null) => void),
  reset: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: h.toast }))
vi.mock('@/lib/chat-cards/open-card', () => ({ openTarget: h.openTarget }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => false }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { onAuthStateChange: (cb: typeof h.auth) => { h.auth = cb; return { data: { subscription: { unsubscribe: () => {} } } } } } }) }))
vi.mock('@/lib/studio/recording-bus', async (orig) => ({ ...(await orig<typeof import('@/lib/studio/recording-bus')>()), resetRecording: h.reset }))

import { postRecordingNotice } from '@/lib/studio/recording-bus'
import { RecordingNotices } from '../recording-notices'

let root: Root | null = null, host: HTMLElement | null = null
beforeEach(async () => {
  h.toast.mockReset(); h.toast.error.mockReset(); h.openTarget.mockReset(); h.reset.mockReset()
  host = document.createElement('div'); document.body.appendChild(host)
  await act(async () => { root = createRoot(host!); root.render(<RecordingNotices />) })
})
afterEach(() => { act(() => root?.unmount()); host?.remove() })

const VIDEO = 'd1d1d1d1-1111-4222-8333-888888888888'

describe('RecordingNotices', () => {
  it('says a take is saved, with Open in Studio on the video', () => {
    act(() => postRecordingNotice({ id: 'n1', text: 'Recording saved', tone: 'ok', videoId: VIDEO }))
    const [text, opts] = h.toast.mock.calls[0]!
    expect(text).toBe('Recording saved')
    expect(opts.action.label).toBe('Open in Studio')
    opts.action.onClick()
    expect(h.openTarget).toHaveBeenCalledWith({ type: 'studio_video', id: VIDEO, title: 'Recording' }, { from: 'recording', reuse: true })
  })

  it('says what needs attention as an error', () => {
    act(() => postRecordingNotice({ id: 'n2', text: 'Recording needs attention: it started in another workspace.', tone: 'error' }))
    expect(h.toast.error).toHaveBeenCalledWith('Recording needs attention: it started in another workspace.', { id: 'n2' })
  })

  it('forgets the take when another account signs in on the page, or none', () => {
    act(() => h.auth!('INITIAL_SESSION', { user: { id: 'user-a' } }))
    act(() => h.auth!('TOKEN_REFRESHED', { user: { id: 'user-a' } }))
    expect(h.reset).not.toHaveBeenCalled()
    act(() => h.auth!('SIGNED_OUT', null))
    expect(h.reset).toHaveBeenCalledTimes(1)
    act(() => h.auth!('SIGNED_IN', { user: { id: 'user-b' } }))
    expect(h.reset).toHaveBeenCalledTimes(2)
  })
})

describe('the shell stays without the Studio', () => {
  const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8')
  const staticImports = (source: string) => [...source.matchAll(/^import[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!)

  it('imports nothing of the Studio statically: the controller only by a dynamic import', () => {
    const notices = read('src/app/account/(dashboard)/recording-notices.tsx')
    for (const from of staticImports(notices)) expect(from).not.toMatch(/components\/studio|lib\/studio\/(?!recording-bus)/)
    expect(notices).toContain("await import('@/components/studio/record/controller')")
    // The bus imports nothing at all.
    expect(staticImports(read('src/lib/studio/recording-bus.ts'))).toEqual([])
    // The workspace switcher reaches the take through the bus only.
    for (const from of staticImports(read('src/app/account/workspace-switcher.tsx'))) expect(from).not.toMatch(/components\/studio/)
  })
})
