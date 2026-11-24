// @vitest-environment jsdom
/**
 * The Record dialog's script and checklist: set up before the take and kept on the Studio, shown in this window only
 * where it is not in the picture (a browser's tab or window share), and handed to the floating control for a desktop
 * take (the copy left for it removed when the take ends).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bridge = vi.hoisted(() => ({ hasControlPanel: vi.fn(async () => true) }))
vi.mock('@/lib/tauri-bridge', () => ({ studioRecorder: { hasControlPanel: bridge.hasControlPanel } }))
vi.mock('@tauri-apps/api/event', () => ({ emit: async () => {}, listen: async () => () => {} }))

import { prompterWhere, RecordDialog } from '../RecordDialog'
import { recordingController } from '../../record/controller'

const SESSION = '11111111-2222-4333-8444-555555555555'
const KEPT = { script: 'First, open the deals board from the sidebar.\nEvery column is a stage.', items: [{ id: 'a', text: 'Open the deals board' }] }
let calls: { url: string; method: string; body?: unknown }[] = []
let root: Root | null = null, host: HTMLElement | null = null
beforeEach(() => {
  calls = []
  localStorage.clear()
  localStorage.setItem('ni:studio:record-prefs-v1', JSON.stringify({ microphone: true, camera: false, shareSound: true }))
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    if (url.includes('/prompter/')) return Response.json({ prompter: init?.method === 'PUT' ? JSON.parse(String(init.body)) : KEPT })
    if (url.includes('/scripts')) return Response.json({ scripts: [{ id: 'v1', title: 'Launch video', beats: [{ text: 'Welcome to the launch.' }, { text: 'Here is what is new.' }], updatedAt: '' }] })
    return Response.json({ recordings: [] })
  }))
})
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.unstubAllGlobals(); vi.useRealTimers(); document.body.innerHTML = '' })

const noop = () => {}, anoop = async () => {}
const recording = (over: Record<string, unknown>) => ({ recorderState: { state: 'browser', desktopShell: false }, targets: null, permissions: null, browserDevices: { cameras: [], microphones: [] }, share: null, sessions: [], selected: null, active: null,
  loadingTargets: false, working: false, error: null, uploads: [], liveTracks: [], savedTakes: [], refreshTargets: anoop, chooseShare: anoop, clearShare: noop, stop: anoop, cancel: anoop, retry: anoop, mark: noop,
  recoverSaved: anoop, discardSaved: anoop, unlockDevices: anoop, requestPermissions: anoop, checkPermissions: anoop, takeLive: null, ...over }) as never
async function render(rec: unknown, punch?: unknown) {
  host = document.createElement('div'); document.body.appendChild(host)
  await act(async () => { root = createRoot(host!); root.render(<RecordDialog title="New recording" close={noop} recording={rec as never} start={anoop} open={noop} punch={punch as never} />) })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
const rerender = async (rec: unknown) => { await act(async () => { root!.render(<RecordDialog title="New recording" close={noop} recording={rec as never} start={anoop} open={noop} />) }) }
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement
const recordingNow = { id: 's', status: 'recording', createdAt: '', camera: false, microphone: true, elapsedMs: 3000 }
const tabShare = { surface: 'browser', label: 'Pipeline · Example CRM', hasAudio: false }

describe('setting up the script and checklist', () => {
  it('loads the person’s own, and keeps a change', async () => {
    await render(recording({}))
    expect(calls.some((c) => c.url.endsWith('/prompter/mine') && c.method === 'GET')).toBe(true)
    const text = dialog().querySelector('#rd-prompter-script') as HTMLTextAreaElement
    expect(text.value).toBe(KEPT.script)
    expect(dialog().textContent).toContain('Script & checklist')
    const add = dialog().querySelector('[aria-label="Add an item"]') as HTMLInputElement
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(add, 'Drag a deal to Won'); add.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { add.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(dialog().textContent).toContain('Checklist · 2')
    await act(async () => { await new Promise((r) => setTimeout(r, 900)) })
    const saved = calls.find((c) => c.method === 'PUT')
    expect(saved?.url).toMatch(/\/prompter\/mine$/)
    expect((saved?.body as { items: { text: string }[] }).items.map((i) => i.text)).toEqual(['Open the deals board', 'Drag a deal to Won'])
  })

  it('keeps a video’s own when recording into it', async () => {
    const video = 'd1d1d1d1-1111-4222-8333-888888888888'
    await render(recording({}), { projectId: video, fromFrame: 0, toFrame: 0, label: 'At 0:04' })
    expect(calls.some((c) => c.url.endsWith(`/prompter/${video}`))).toBe(true)
  })
})

describe('while a browser take records', () => {
  it('shows the script and checklist here when a tab is shared, and says to scroll by hand', async () => {
    await render(recording({ share: tabShare, active: recordingNow }))
    expect(document.querySelector('[data-testid="prompter-panel"]')).not.toBeNull()
    expect(dialog().textContent).toContain('Scroll by hand. Following works in the desktop app.')
    expect(dialog().textContent).toContain('Open the deals board')
  })

  it('shows nothing here when the whole screen is shared (this window would be in the picture)', async () => {
    await render(recording({ share: { surface: 'monitor', label: 'Screen 1', hasAudio: false }, active: recordingNow }))
    expect(document.querySelector('[data-testid="prompter-panel"]')).toBeNull()
  })
})

describe('while a desktop take records', () => {
  const desktop = (over: Record<string, unknown>) => recording({ recorderState: { state: 'desktop', desktopShell: true }, targets: { displays: [{ displayId: 1, name: 'Built-in', width: 1512, height: 982, scale: 2, isMain: true }], apps: [], cameras: [], microphones: [] }, permissions: null, ...over })

  it('hands the content to the page’s recording controller (which answers the floating control), and gets out of the way', async () => {
    const handOff = vi.spyOn(recordingController(), 'handOff').mockImplementation(() => {})
    const close = vi.fn()
    host = document.createElement('div'); document.body.appendChild(host)
    await act(async () => { root = createRoot(host!); root.render(<RecordDialog title="New recording" close={close} recording={desktop({ active: { ...recordingNow, id: 'desk-1' }, takeLive: { sessionId: SESSION, following: 'on' } }) as never} start={anoop} open={noop} />) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const handed = handOff.mock.calls.at(-1)![0]
    expect(handed).toMatchObject({ sessionId: SESSION, following: 'on', items: KEPT.items })
    expect(handed.lines.map((l) => l.text)).toEqual(KEPT.script.split('\n'))
    // Recording: the dialog closed itself (the whole app is free), once only: "Show" opens it again for good.
    expect(close).toHaveBeenCalledTimes(1)
    act(() => root!.unmount()); root = null
    await render(desktop({ active: { ...recordingNow, id: 'desk-1' }, takeLive: { sessionId: SESSION, following: 'on' } }))
    expect(dialog()).not.toBeNull()
    handOff.mockRestore()
  })

  it('stays open for a browser take that shows its script here', async () => {
    const close = vi.fn()
    host = document.createElement('div'); document.body.appendChild(host)
    await act(async () => { root = createRoot(host!); root.render(<RecordDialog title="New recording" close={close} recording={recording({ share: tabShare, active: recordingNow }) as never} start={anoop} open={noop} />) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(close).not.toHaveBeenCalled()
  })
})

describe('prompterWhere', () => {
  it('says where it will show', () => {
    expect(prompterWhere('desktop', true, false, true)).toBe('In the floating control while you record. Never in the picture.')
    expect(prompterWhere('desktop', false, true, true)).toBe('Shown here while you record.')
    expect(prompterWhere('desktop', false, false, true)).toBe('Update the app to see it while you record a display or this app.')
    expect(prompterWhere('browser', false, true, true)).toBe('Shown here while you record.')
    expect(prompterWhere('browser', false, false, true)).toBe('Shown here when you share a tab or a window, not your whole screen.')
    expect(prompterWhere('browser', false, false, false)).toContain('Optional')
  })
})
