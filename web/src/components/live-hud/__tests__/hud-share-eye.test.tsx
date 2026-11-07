// @vitest-environment jsdom
/**
 * The HUD header's screen-share eye (./hud-share-eye.tsx). Pinned:
 *   - on mount it reads the desktop's real state and shows it (closed =
 *     hidden from screen share, the default), nothing before it knows;
 *   - a click asks for the other state and shows what the desktop answers;
 *     a refused set leaves it as it was;
 *   - a desktop without the commands, or a page outside the desktop app:
 *     no eye, never a dead button;
 *   - the desktop HUD window puts it on the header's left; the web HUD
 *     renders none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const desk = vi.hoisted(() => ({
  desktop: true,
  visible: false as boolean,
  missing: false,
  refuse: false,
  calls: [] as Array<{ cmd: string; args: unknown }>,
}))
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  isDesktopApp: () => desk.desktop,
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    desk.calls.push({ cmd, args })
    if (cmd === 'get_agent_hud_capture_visible' || cmd === 'set_agent_hud_capture_visible') {
      if (desk.missing) throw `Command ${cmd} not found`
      if (cmd === 'get_agent_hud_capture_visible') return desk.visible
      if (desk.refuse) throw 'agent HUD window is not open'
      desk.visible = (args as { visible: boolean }).visible
      return desk.visible
    }
    return undefined
  },
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
  emit: async () => {},
}))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ listen: async () => () => {}, startDragging: async () => {} }),
}))
vi.mock('@/lib/workspace-fetch', () => ({ setClientWorkspaceId: vi.fn(), getClientWorkspaceId: () => 'ws-1' }))
vi.mock('@/components/live-chat/live-chat', () => ({ LiveChat: () => h('div', { 'data-chat-stub': '' }) }))
vi.mock('../use-live-agent-name', () => ({ useLiveAgentName: () => 'Sales Coach' }))
vi.mock('@/hooks/recording-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/recording-context')>()),
  useRecordingContext: () => ({
    liveModeEnabled: true,
    speakerNames: {},
    selfDemotedLabels: new Set<string>(),
    speakerContacts: {},
    postSessionReview: null,
    selfSuggestion: null,
  }),
  useDetectedSpeakers: () => [],
  useLiveActiveSpeaker: () => null,
  useOptionalRecordingStable: () => ({ isRecording: true, captureId: 'cap-1', flushTranscriptForAgent: async () => {} }),
}))

import { HudShareEye, SHARE_EYE_HIDDEN_LABEL, SHARE_EYE_VISIBLE_LABEL } from '../hud-share-eye'
import { AgentHud } from '@/app/hud/agent/agent-hud'
import { WebHud } from '../web-hud'
import { createHudFeedStore } from '../hud-feed'

let container: HTMLDivElement
let root: Root
const flush = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)) })
const eye = () => container.querySelector('[data-hud-share-eye]') as HTMLButtonElement | null

beforeEach(() => {
  desk.desktop = true
  desk.visible = false
  desk.missing = false
  desk.refuse = false
  desk.calls = []
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('the eye', () => {
  it('reads the real state on mount: closed, hidden from screen share', async () => {
    await act(async () => root.render(h(HudShareEye)))
    await flush()
    expect(desk.calls.map((c) => c.cmd)).toEqual(['get_agent_hud_capture_visible'])
    expect(eye()!.getAttribute('aria-label')).toBe(SHARE_EYE_HIDDEN_LABEL)
    expect(eye()!.title).toBe(SHARE_EYE_HIDDEN_LABEL)
    expect(eye()!.getAttribute('aria-pressed')).toBe('false')
    expect(eye()!.getAttribute('data-hud-share-eye')).toBe('hidden')
  })

  it('opens when the desktop says it already shows', async () => {
    desk.visible = true
    await act(async () => root.render(h(HudShareEye)))
    await flush()
    expect(eye()!.getAttribute('aria-label')).toBe(SHARE_EYE_VISIBLE_LABEL)
  })

  it('a click asks for the other state and shows what the desktop answers', async () => {
    await act(async () => root.render(h(HudShareEye)))
    await flush()
    await act(async () => eye()!.click())
    await flush()
    expect(desk.calls.at(-1)).toEqual({ cmd: 'set_agent_hud_capture_visible', args: { visible: true } })
    expect(eye()!.getAttribute('aria-label')).toBe(SHARE_EYE_VISIBLE_LABEL)
    expect(eye()!.getAttribute('aria-pressed')).toBe('true')
    await act(async () => eye()!.click())
    await flush()
    expect(desk.calls.at(-1)).toEqual({ cmd: 'set_agent_hud_capture_visible', args: { visible: false } })
    expect(eye()!.getAttribute('aria-label')).toBe(SHARE_EYE_HIDDEN_LABEL)
  })

  it('a refused set leaves it as it was', async () => {
    await act(async () => root.render(h(HudShareEye)))
    await flush()
    desk.refuse = true
    await act(async () => eye()!.click())
    await flush()
    expect(eye()!.getAttribute('aria-label')).toBe(SHARE_EYE_HIDDEN_LABEL)
  })

  it('an older desktop without the command: no eye', async () => {
    desk.missing = true
    await act(async () => root.render(h(HudShareEye)))
    await flush()
    expect(eye()).toBeNull()
  })

  it('outside the desktop app: no eye, and Tauri is never asked', async () => {
    desk.desktop = false
    await act(async () => root.render(h(HudShareEye)))
    await flush()
    expect(eye()).toBeNull()
    expect(desk.calls).toEqual([])
  })
})

describe('in the HUD', () => {
  it('the desktop window: on the header’s left, where the agent’s face was', async () => {
    await act(async () => root.render(h(AgentHud)))
    await flush()
    const header = container.querySelector('[data-hud-header]')!
    expect(header.firstElementChild).toBe(eye())
    // The old name tag is gone.
    expect(container.querySelector('[data-bot-bubble-tag], [data-desktop-bubble-tag], [data-desktop-bubble-name]')).toBeNull()
  })

  it('padding follows the eye as rendered: tight beside it, clear of the pill’s curve without it', async () => {
    const header = () => container.querySelector('[data-hud-header]') as HTMLElement
    const classes = () => header().className.split(/\s+/)
    await act(async () => root.render(h(AgentHud)))
    await flush()
    // The eye shows: the header's tight padding applies (has the eye).
    expect(header().querySelector('[data-hud-share-eye]')).not.toBeNull()
    expect(classes()).toEqual(expect.arrayContaining(['pl-3.5', 'has-[[data-hud-share-eye]]:pl-1']))
    expect(classes()).not.toContain('pl-1')

    // An older desktop without the commands: the window still passes the
    // eye, which renders nothing; the words keep their full padding.
    await act(async () => root.unmount())
    root = createRoot(container)
    desk.missing = true
    await act(async () => root.render(h(AgentHud)))
    await flush()
    expect(eye()).toBeNull()
    expect(header().querySelector('[data-hud-share-eye]')).toBeNull()
    expect(classes()).toContain('pl-3.5')
    expect(classes()).not.toContain('pl-1')
    expect(header().firstElementChild!.querySelector('[data-hud-state]')).not.toBeNull()
  })

  it('the web HUD: no eye (no screen-share control there)', async () => {
    desk.desktop = false
    await act(async () => root.render(h(WebHud, { captureId: 'cap-1', store: createHudFeedStore() })))
    await flush()
    expect(container.querySelector('[data-hud-header]')).not.toBeNull()
    expect(eye()).toBeNull()
    expect(desk.calls.filter((c) => c.cmd.includes('capture_visible'))).toEqual([])
  })
})
