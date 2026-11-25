// @vitest-environment jsdom
/**
 * The floating recording control with a script and checklist, checked without a Mac: the desktop's events
 * (`studio-recorder://status`, `://live-words`, `://stopped`) and its size command are stand-ins, and the Studio
 * page's handoff goes through a stand-in of Tauri's event bus. A build that can grow the control opens the panel and
 * follows the simulated words; an older build keeps the pill; the copy the page left is removed when the take ends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { LiveWordsEvent } from '@/lib/studio/prompter/live-words'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION = '11111111-2222-4333-8444-555555555555'

// Tauri's event bus between windows (the page's handoff).
const bus = vi.hoisted(() => {
  const listeners = new Map<string, Set<(e: { payload: unknown }) => void>>()
  return {
    listeners,
    emit: async (event: string, payload: unknown) => { for (const cb of [...(listeners.get(event) ?? [])]) cb({ payload }) },
    listen: async (event: string, cb: (e: { payload: unknown }) => void) => {
      const set = listeners.get(event) ?? new Set(); set.add(cb); listeners.set(event, set)
      return () => { set.delete(cb) }
    },
  }
})
vi.mock('@tauri-apps/api/event', () => ({ emit: bus.emit, listen: bus.listen }))
vi.mock('@/lib/hud-theme', () => ({ useHudTheme: () => {} }))

// The desktop's side of the control.
const desktop = vi.hoisted(() => ({
  words: new Set<(e: LiveWordsEvent) => void>(),
  stopped: new Set<(e: { sessionId: string }) => void>(),
  controlSize: vi.fn(async (width: number, height: number) => ({ width, height })),
  stop: vi.fn(async () => ({})),
  hideControl: vi.fn(async () => {}),
}))
vi.mock('@/lib/tauri-bridge', () => {
  class StudioRecorderError extends Error { constructor(readonly code: string, message: string) { super(message) } }
  const sub = <T,>(set: Set<T>) => (cb: T) => { set.add(cb); return () => { set.delete(cb) } }
  return {
    StudioRecorderError,
    studioRecorder: {
      onStatus: () => () => {},
      onError: () => () => {},
      onLiveWords: sub(desktop.words),
      onStopped: sub(desktop.stopped),
      controlSize: desktop.controlSize,
      stop: desktop.stop,
      cancel: vi.fn(async () => ({})),
      hideControl: desktop.hideControl,
    },
  }
})

import Page from '../page'
import { CONTENT_EVENT, handoffKey, HELLO_EVENT, writeHandoff, type PrompterHandoff } from '@/lib/studio/prompter/channel'

const HANDOFF: PrompterHandoff = {
  sessionId: SESSION, following: 'on',
  lines: ['First, open the deals board from the sidebar.', 'Every column is a stage, and you can drag a deal between stages.', 'When you drop a deal into Won, the forecast updates on its own.'].map((text) => ({ text })),
  items: [{ id: 'a', text: 'Drag a deal between stages' }, { id: 'b', text: 'Explain how the forecast updates' }],
}

let root: Root | null = null, host: HTMLElement | null = null, seq = 0
beforeEach(() => {
  localStorage.clear(); bus.listeners.clear(); desktop.words.clear(); desktop.stopped.clear(); seq = 0
  desktop.controlSize.mockReset().mockImplementation(async (width: number, height: number) => ({ width, height }))
  window.history.replaceState(null, '', `/hud/studio-recorder?session=${SESSION}`)
})
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null })

async function mount() {
  host = document.createElement('div'); document.body.appendChild(host)
  await act(async () => { root = createRoot(host!); root.render(<Page />) })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
async function speak(text: string, sessionId = SESSION) {
  const words = text.split(' ').map((t, i) => ({ text: t, startMs: i * 300, endMs: i * 300 + 250 }))
  await act(async () => { for (const cb of desktop.words) { cb({ sessionId, seq: seq++, final: false, words: words.slice(0, 2) }); cb({ sessionId, seq: seq++, final: true, words }) } })
}
const current = () => document.querySelector('[aria-current="true"]')?.textContent ?? ''
const checked = (text: string) => [...document.querySelectorAll('[role="checkbox"]')].find((b) => b.textContent?.includes(text))?.getAttribute('aria-checked')

describe('the control’s prompter', () => {
  it('opens into the panel with the copy the page left, and follows the words heard', async () => {
    writeHandoff(HANDOFF)
    await mount()
    expect(desktop.controlSize).toHaveBeenCalledWith(420, 480)
    expect(document.querySelector('[data-testid="prompter-panel"]')).not.toBeNull()
    expect(current()).toContain('open the deals board')
    await speak('every column is a stage')
    await speak('and you can drag a deal')
    expect(current()).toContain('Every column is a stage')
    expect(checked('Drag a deal')).toBe('true')
    // Words for another take change nothing.
    await speak('when you drop a deal into won the forecast updates', '99999999-2222-4333-8444-555555555555')
    expect(current()).toContain('Every column is a stage')
  })

  it('asks the Studio page for the content when no copy was left', async () => {
    // The page's side: answer each hello for this take.
    await bus.listen(HELLO_EVENT, ({ payload }) => { if ((payload as { sessionId: string }).sessionId === SESSION) void bus.emit(CONTENT_EVENT, HANDOFF) })
    await mount()
    await flush()
    expect(document.querySelector('[data-testid="prompter-panel"]')).not.toBeNull()
    // A changed checklist from the page during the take replaces it.
    await act(async () => { await bus.emit(CONTENT_EVENT, { ...HANDOFF, items: [{ id: 'c', text: 'Say thanks for watching' }] }) })
    expect(document.body.textContent).toContain('Say thanks for watching')
  })

  it('keeps the pill on a desktop build that can’t grow the control', async () => {
    desktop.controlSize.mockRejectedValue(Object.assign(new Error('The Studio recorder runs only…'), { code: 'unavailable' }))
    writeHandoff(HANDOFF)
    await mount()
    expect(document.querySelector('[data-testid="prompter-panel"]')).toBeNull()
    expect(document.querySelector('[aria-label="Show the script and checklist"]')).toBeNull()
    expect(document.querySelector('[aria-label="Stop recording"]')).not.toBeNull()
  })

  it('folds back to the pill and opens again', async () => {
    writeHandoff(HANDOFF)
    await mount()
    await act(async () => { (document.querySelector('[aria-label="Hide the script and checklist"]') as HTMLButtonElement).click() })
    expect(desktop.controlSize).toHaveBeenLastCalledWith(300, 56)
    expect(document.querySelector('[data-testid="prompter-panel"]')).toBeNull()
    await act(async () => { (document.querySelector('[aria-label="Show the script and checklist"]') as HTMLButtonElement).click() })
    expect(document.querySelector('[data-testid="prompter-panel"]')).not.toBeNull()
  })

  it('stays a plain pill with nothing to show', async () => {
    await mount()
    expect(desktop.controlSize).not.toHaveBeenCalled()
    expect(document.querySelector('[aria-label="Show the script and checklist"]')).toBeNull()
  })

  it('removes the page’s copy when the take stops, from the control or elsewhere', async () => {
    writeHandoff(HANDOFF)
    await mount()
    expect(localStorage.getItem(handoffKey(SESSION))).not.toBeNull()
    await act(async () => { for (const cb of desktop.stopped) cb({ sessionId: SESSION }) })
    expect(localStorage.getItem(handoffKey(SESSION))).toBeNull()
    act(() => root!.unmount()); root = null
    writeHandoff(HANDOFF)
    await mount()
    await act(async () => { (document.querySelector('[aria-label="Stop recording"]') as HTMLButtonElement).click() })
    await flush()
    expect(desktop.stop).toHaveBeenCalledWith(SESSION)
    expect(localStorage.getItem(handoffKey(SESSION))).toBeNull()
  })
})
