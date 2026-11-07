// @vitest-environment jsdom
/**
 * useHudTelemetry (../use-hud-telemetry.ts): what the HUD itself reports, so a
 * nudge that went to a hidden HUD is visible in PostHog. Pins:
 *   - loaded once on mount, with the host, the capture and both visibilities;
 *   - shown / hidden only on a change, from the page's visibilitychange, the
 *     check after load (a window still hidden then says so) and, for a host
 *     with a window of its own, the poll after that;
 *   - the workspace named only by a host that passes one;
 *   - each nudge new to the feed arrives once, with whether the chat is open;
 *   - each heads-up the chat draws is displayed once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const telemetry = vi.hoisted(() => ({ track: vi.fn(), visibility: 'visible' as string | null }))
// trackHudEvent(event, properties, opts): the tests read the first two; the workspace test reads opts.
vi.mock('@/lib/hud-telemetry', () => ({
  trackHudEvent: telemetry.track,
  documentVisibility: () => telemetry.visibility,
}))

import { LOAD_CHECK_MS, VISIBILITY_POLL_MS, useHudTelemetry, type HudTelemetryOptions } from '../use-hud-telemetry'
import type { LiveChatSayShown } from '@/components/live-chat/live-chat'

let container: HTMLDivElement
let root: Root
let onSayShown: (say: LiveChatSayShown) => void

function Harness(props: HudTelemetryOptions) {
  onSayShown = useHudTelemetry(props)
  return null
}

const base: HudTelemetryOptions = { host: 'window', captureId: 'cap-1', nudges: [], hasConversation: true }

async function render(props: Partial<HudTelemetryOptions> = {}) {
  await act(async () => root.render(h(Harness, { ...base, ...props })))
  await act(async () => {})
}

const events = () => telemetry.track.mock.calls.map((c) => c[0] as string)
const last = (event: string) => {
  const call = [...telemetry.track.mock.calls].reverse().find((c) => c[0] === event)
  return call?.[1] as Record<string, unknown> | undefined
}

beforeEach(() => {
  vi.useFakeTimers()
  telemetry.track.mockReset()
  telemetry.visibility = 'visible'
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.useRealTimers()
})

describe('useHudTelemetry: loaded, shown and hidden', () => {
  it('reports loaded once, with the host, the capture and both visibilities', async () => {
    await render({ windowVisible: async () => true })
    expect(events()).toEqual(['live_hud_loaded'])
    expect(last('live_hud_loaded')).toEqual({ host: 'window', capture_id: 'cap-1', window_visible: true, document_visibility: 'visible' })
    await render({ windowVisible: async () => true })
    expect(events()).toEqual(['live_hud_loaded'])
  })

  it('a window hidden at load and showing at the check reports shown, after_load', async () => {
    let visible = false
    await render({ windowVisible: async () => visible })
    expect(last('live_hud_loaded')).toMatchObject({ window_visible: false })
    visible = true
    await act(async () => vi.advanceTimersByTime(LOAD_CHECK_MS))
    expect(events()).toEqual(['live_hud_loaded', 'live_hud_shown'])
    expect(last('live_hud_shown')).toMatchObject({ reason: 'after_load', window_visible: true })
  })

  it('a window still hidden at the check says it never showed', async () => {
    await render({ windowVisible: async () => false })
    await act(async () => vi.advanceTimersByTime(LOAD_CHECK_MS))
    expect(events()).toEqual(['live_hud_loaded', 'live_hud_hidden'])
    expect(last('live_hud_hidden')).toMatchObject({ reason: 'not_shown_after_load', window_visible: false })
  })

  it('a window showing at load reports nothing more at the check', async () => {
    await render({ windowVisible: async () => true })
    await act(async () => vi.advanceTimersByTime(LOAD_CHECK_MS))
    expect(events()).toEqual(['live_hud_loaded'])
  })

  it('polls a window of its own after the load check: a hide or a late first show is reported', async () => {
    let visible = false
    await render({ windowVisible: async () => visible })
    await act(async () => vi.advanceTimersByTime(LOAD_CHECK_MS))
    expect(last('live_hud_hidden')).toMatchObject({ reason: 'not_shown_after_load' })
    // Shown late, with no visibilitychange: the poll finds it.
    visible = true
    await act(async () => vi.advanceTimersByTime(VISIBILITY_POLL_MS))
    expect(last('live_hud_shown')).toMatchObject({ reason: 'poll', window_visible: true })
    // Unchanged: nothing.
    await act(async () => vi.advanceTimersByTime(VISIBILITY_POLL_MS))
    // Hidden mid-call (window.hide(): the page needn't hear it).
    visible = false
    await act(async () => vi.advanceTimersByTime(VISIBILITY_POLL_MS))
    expect(events()).toEqual(['live_hud_loaded', 'live_hud_hidden', 'live_hud_shown', 'live_hud_hidden'])
    expect(last('live_hud_hidden')).toMatchObject({ reason: 'poll' })
  })

  it("doesn't poll on the web's panel (no window of its own)", async () => {
    await render({ host: 'page', windowVisible: undefined })
    await act(async () => vi.advanceTimersByTime(LOAD_CHECK_MS + VISIBILITY_POLL_MS * 3))
    expect(events()).toEqual(['live_hud_loaded'])
  })

  it('names the workspace only when the host passes one (null until the window knows it)', async () => {
    await render({ windowVisible: async () => true, workspaceId: null })
    expect(telemetry.track.mock.calls.at(-1)?.[2]).toEqual({ workspaceId: null })
    await render({ windowVisible: async () => true, workspaceId: 'ws-1' })
    await act(async () => onSayShown({ id: 'n1', kind: 'insight', source: 'broadcast' }))
    expect(telemetry.track.mock.calls.at(-1)?.[2]).toEqual({ workspaceId: 'ws-1' })
    await act(async () => root.unmount())
    root = createRoot(container)
    telemetry.track.mockReset()
    await render({ host: 'page', windowVisible: undefined })
    expect(telemetry.track.mock.calls.at(-1)?.[2]).toEqual({})
  })

  it('reports hidden and shown on visibilitychange, only when it changes', async () => {
    let visible = true
    await render({ windowVisible: async () => visible })
    visible = false
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    visible = true
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(events()).toEqual(['live_hud_loaded', 'live_hud_hidden', 'live_hud_shown'])
    expect(last('live_hud_hidden')).toMatchObject({ reason: 'visibility_change' })
    expect(last('live_hud_shown')).toMatchObject({ reason: 'visibility_change' })
  })

  it("on the web's panel (no window of its own) goes by the page's visibility", async () => {
    await render({ host: 'page', windowVisible: undefined })
    expect(last('live_hud_loaded')).toEqual({ host: 'page', capture_id: 'cap-1', window_visible: null, document_visibility: 'visible' })
    telemetry.visibility = 'hidden'
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(last('live_hud_hidden')).toMatchObject({ host: 'page', window_visible: null, document_visibility: 'hidden' })
  })

  it("a window that can't say counts as unknown, not hidden", async () => {
    await render({
      windowVisible: async () => {
        throw new Error('gone')
      },
    })
    expect(last('live_hud_loaded')).toMatchObject({ window_visible: null })
  })

  it('stops listening once unmounted', async () => {
    let visible = true
    await render({ windowVisible: async () => visible })
    await act(async () => root.unmount())
    root = createRoot(container)
    visible = false
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await act(async () => vi.advanceTimersByTime(LOAD_CHECK_MS))
    expect(events()).toEqual(['live_hud_loaded'])
  })
})

describe('useHudTelemetry: nudges', () => {
  it('reports each nudge new to the feed once, with its capture and whether the chat is open', async () => {
    await render({ windowVisible: async () => false, captureId: null, hasConversation: false })
    const n1 = { id: 'n1', message: 'Ask about budget.', kind: 'suggestion', captureId: 'cap-9' }
    await render({ windowVisible: async () => false, captureId: null, hasConversation: false, nudges: [n1] })
    await render({ windowVisible: async () => false, captureId: null, hasConversation: true, nudges: [n1, { id: 'n2', message: 'Pricing.' }] })
    const arrived = telemetry.track.mock.calls.filter((c) => c[0] === 'live_hud_nudge_arrived').map((c) => c[1])
    expect(arrived).toEqual([
      { host: 'window', capture_id: 'cap-9', window_visible: false, document_visibility: 'visible', nudge_id: 'n1', nudge_kind: 'suggestion', has_conversation: false },
      { host: 'window', capture_id: null, window_visible: false, document_visibility: 'visible', nudge_id: 'n2', nudge_kind: null, has_conversation: true },
    ])
    // Never the words.
    expect(JSON.stringify(arrived)).not.toContain('budget')
  })

  it('reports each heads-up the chat draws once', async () => {
    await render({ windowVisible: async () => true })
    await act(async () => {
      onSayShown({ id: 'n1', kind: 'insight', source: 'broadcast' })
      onSayShown({ id: 'n1', kind: 'insight', source: 'conversation' })
      onSayShown({ id: 's2', kind: 'reminder', source: 'conversation' })
    })
    const displayed = telemetry.track.mock.calls.filter((c) => c[0] === 'live_hud_nudge_displayed').map((c) => c[1])
    expect(displayed).toEqual([
      { host: 'window', capture_id: 'cap-1', window_visible: true, document_visibility: 'visible', nudge_id: 'n1', nudge_kind: 'insight', source: 'broadcast' },
      { host: 'window', capture_id: 'cap-1', window_visible: true, document_visibility: 'visible', nudge_id: 's2', nudge_kind: 'reminder', source: 'conversation' },
    ])
  })
})
