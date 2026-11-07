// @vitest-environment jsdom
/**
 * The web HUD: the live agent's HUD as a floating panel during a call.
 *   - LiveHudMount shows it only while a live capture records, and never in
 *     the desktop app (which has its own HUD window);
 *   - where it sits is remembered per device and kept on screen: dragged
 *     past an edge it stops at the gutter, a saved spot off screen comes back
 *     on, broken or blocked storage starts from the default corner;
 *   - Escape collapses the chat while it's expanded;
 *   - the glow's level is the recording's own level store.
 * AgentHudView is stubbed to its props (its own tests pin the view).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const view = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }))
vi.mock('../agent-hud-view', () => ({
  AgentHudView: (props: Record<string, unknown>) => {
    view.last = props
    return h('div', { 'data-view-stub': props.host as string })
  },
}))

const rec = vi.hoisted(() => ({
  stable: null as null | Record<string, unknown>,
  ctx: { liveModeEnabled: true, speakerNames: {}, selfDemotedLabels: new Set<string>(), speakerContacts: {}, postSessionReview: null, selfSuggestion: null } as Record<string, unknown>,
}))
vi.mock('@/hooks/recording-context', () => ({
  useOptionalRecordingStable: () => rec.stable,
  useRecordingContext: () => rec.ctx,
  useDetectedSpeakers: () => [],
  useLiveActiveSpeaker: () => null,
}))

import { LiveHudMount } from '../web-hud'
import { CAPTURE_LEVEL_GAIN } from '@/app/account/(dashboard)/chat/composer-voice-glow'
import {
  HUD_GUTTER,
  HUD_HEIGHT,
  HUD_POSITION_KEY,
  HUD_WIDTH,
  clampHudPosition,
  defaultHudPosition,
  hudSizeIn,
  readHudPosition,
} from '../web-hud-position'

let container: HTMLDivElement
let root: Root

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
}

beforeEach(() => {
  view.last = null
  rec.stable = { isRecording: true, captureId: 'cap-1', flushTranscriptForAgent: vi.fn(async () => {}) }
  rec.ctx = { ...rec.ctx, liveModeEnabled: true }
  setViewport(1440, 900)
  localStorage.clear()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  localStorage.clear()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  vi.restoreAllMocks()
})

const panel = () => container.querySelector('[data-web-hud]') as HTMLElement | null
const mount = () => act(async () => root.render(h(LiveHudMount)))

describe('when it shows', () => {
  it('during a live capture, on web', async () => {
    await mount()
    expect(panel()).not.toBeNull()
    expect(panel()!.getAttribute('data-capture-id')).toBe('cap-1')
    expect(container.querySelector('[data-view-stub="page"]')).not.toBeNull()
    expect(panel()!.className).toContain('z-[45]')
    // No screen-share eye on web: the header starts with its words.
    expect(view.last!.headerStart).toBeUndefined()
  })

  it('not while nothing records', async () => {
    rec.stable = { isRecording: false, captureId: null }
    await mount()
    expect(panel()).toBeNull()
  })

  it('not for a capture that is not live', async () => {
    rec.ctx = { ...rec.ctx, liveModeEnabled: false }
    await mount()
    expect(panel()).toBeNull()
  })

  it('never in the desktop app (its HUD is a window of its own)', async () => {
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {}
    await mount()
    expect(panel()).toBeNull()
  })

  it("hands the view the recording's flush as beforeSend", async () => {
    await mount()
    await act(async () => {
      await (view.last!.actions as { beforeSend: () => Promise<void> }).beforeSend()
    })
    expect(rec.stable!.flushTranscriptForAgent).toHaveBeenCalledWith('cap-1')
  })

  it("hands the view the recording's own level store for the glow, gained like the composer's", async () => {
    const subscribeLevels = vi.fn(() => () => {})
    rec.stable = { ...rec.stable, getLevels: () => ({ micLevel: 0.01, systemLevel: 0, timestamp: 1 }), subscribeLevels }
    await mount()
    const levels = view.last!.audioLevels as { get: () => number; subscribe: (cb: () => void) => () => void }
    expect(levels.get()).toBeCloseTo(0.01 * CAPTURE_LEVEL_GAIN)
    const cb = () => {}
    levels.subscribe(cb)
    expect(subscribeLevels).toHaveBeenCalledWith(cb)
  })
})

describe('where it sits', () => {
  const at = () => panel()!.style.transform

  it('starts in the bottom-right corner', async () => {
    await mount()
    const size = hudSizeIn({ width: 1440, height: 900 })
    const p = defaultHudPosition(size, { width: 1440, height: 900 })
    expect(at()).toBe(`translate3d(${p.x}px, ${p.y}px, 0)`)
    expect(panel()!.style.width).toBe(`${HUD_WIDTH}px`)
    expect(panel()!.style.height).toBe(`${HUD_HEIGHT}px`)
  })

  it('is dragged from its empty room, stops at the gutter, and is remembered', async () => {
    localStorage.setItem(HUD_POSITION_KEY, JSON.stringify({ x: 200, y: 100 }))
    await mount()
    expect(at()).toBe('translate3d(200px, 100px, 0)')
    const fire = (type: string, x: number, y: number) =>
      act(async () => panel()!.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })))
    await fire('pointerdown', 210, 110)
    await fire('pointermove', -500, -500)
    expect(at()).toBe(`translate3d(${HUD_GUTTER}px, ${HUD_GUTTER}px, 0)`)
    await fire('pointerup', -500, -500)
    expect(readHudPosition()).toEqual({ x: HUD_GUTTER, y: HUD_GUTTER })
  })

  it('brings a remembered spot back on screen, and follows the window as it shrinks', async () => {
    localStorage.setItem(HUD_POSITION_KEY, JSON.stringify({ x: 5000, y: 5000 }))
    await mount()
    expect(at()).toBe(`translate3d(${1440 - HUD_WIDTH - HUD_GUTTER}px, ${900 - HUD_HEIGHT - HUD_GUTTER}px, 0)`)
    setViewport(800, 600)
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(at()).toBe(`translate3d(${800 - HUD_WIDTH - HUD_GUTTER}px, ${600 - HUD_HEIGHT - HUD_GUTTER}px, 0)`)
  })

  it('starts from the default when storage is broken or blocked', async () => {
    localStorage.setItem(HUD_POSITION_KEY, '{nope')
    expect(readHudPosition()).toBeNull()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readHudPosition()).toBeNull()
    await mount()
    expect(panel()).not.toBeNull()
  })

  it('clamps inside the gutters, and fits a phone-sized window', () => {
    const vp = { width: 375, height: 700 }
    const size = hudSizeIn(vp)
    expect(size).toEqual({ width: 375 - HUD_GUTTER * 2, height: HUD_HEIGHT })
    expect(clampHudPosition({ x: 300, y: -20 }, size, vp)).toEqual({ x: HUD_GUTTER, y: HUD_GUTTER })
  })
})

it('Escape collapses the chat while it is expanded', async () => {
  await mount()
  const props = () => view.last as { collapseRequest: number; onChatExpandedChange: (v: boolean) => void }
  const before = props().collapseRequest
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(props().collapseRequest).toBe(before)
  await act(async () => props().onChatExpandedChange(true))
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(props().collapseRequest).toBe(before + 1)
})
