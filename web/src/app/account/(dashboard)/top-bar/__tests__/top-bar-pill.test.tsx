// @vitest-environment jsdom
/**
 * The top bar's lead cluster is For you's toggle, then Search, on a phone only (md:hidden). The Inbox bell
 * and its unread badge that followed them went 2026-10-20 (Liam): every notice
 * reaches the agent, which tells the person in the chat
 * (docs/plans/retire-notifications-page.md). The Agents button that stood in
 * the pill, with its menu of every agent, went 2026-10-18 (Liam: "We don't need
 * that drop down"): the agents are in the Library (Agents & skills) and the
 * side panel's Agents row. The Create button went 2026-10-20 (Liam): the agent
 * creates things on request, and the create dialog stays for Mail's New email.
 *
 * A real render of the TopBar, its heavy neighbours (Listen, Capture, the
 * workspace pill, the side panel toggles) stubbed out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/desktop-titlebar', () => ({
  useIsDesktop: () => false,
  useHasTrafficLights: () => false,
  subscribeMounted: () => () => {},
  getMountedSnapshot: () => true,
  getMountedServerSnapshot: () => false,
}))
vi.mock('@/hooks/recording-context', () => ({ useRecordingStable: () => ({ isRecording: false, startRecording: () => {} }) }))
vi.mock('../../settings-overlay', () => ({ useOptionalSettingsOverlay: () => null }))
vi.mock('@/lib/hotkeys', () => ({ useHotkeys: () => {}, useModKeyLabel: (key = '') => `⌘${key}` }))
vi.mock('../../../workspace-switcher', () => ({ useWorkspaceId: () => 'ws-1', WorkspaceSwitcher: () => null }))
vi.mock('@/lib/chat-cards/open-card', () => ({ openTarget: vi.fn() }))
vi.mock('@/components/read-aloud/listen-mode-toggle', () => ({ ListenModeToggle: () => null }))
vi.mock('../capture-bar-button', () => ({ CaptureBarButton: () => null }))
vi.mock('../../side-panels/side-panel-toggles', async () => {
  const { createElement } = await import('react')
  return {
    ForYouToggle: () => createElement('button', { 'data-for-you-toggle': '', 'aria-label': 'For you' }),
    SidePanelToggle: () => null,
  }
})

import { TopBar } from '../top-bar'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
})

function render() {
  act(() => {
    root = createRoot(container)
    root.render(h(TopBar))
  })
}

/** The lead cluster: For you's toggle, then Search. */
const lead = () => container.querySelector<HTMLElement>('[data-tab-bar-lead]')!

describe('the top bar’s lead cluster', () => {
  it('is For you’s toggle, then Search, and nothing else: no Inbox bell, no badge', () => {
    render()
    expect(lead()).not.toBeNull()
    const buttons = [...lead().querySelectorAll('button')]
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['For you', 'Search'])
    expect(container.querySelector('button[aria-label="Inbox"]')).toBeNull()
    // The bell's own round pill (and the badge inside it) went with it.
    expect(lead().querySelector('div.rounded-full.border')).toBeNull()
    expect(lead().querySelector('.bg-primary')).toBeNull()
  })

  it('has no Agents button and no agent menu anywhere in the bar', () => {
    render()
    expect(container.querySelector('[data-bots-button],[data-bots-menu],[data-bot-entry]')).toBeNull()
    expect(container.querySelector('button[aria-label^="Agents"]')).toBeNull()
    expect(container.querySelector('[aria-haspopup="menu"]')).toBeNull()
  })

  it('has no Create button anywhere in the bar', () => {
    render()
    expect(container.querySelector('button[aria-label="Create"]')).toBeNull()
    expect(container.querySelector('[data-onboarding-target="create"]')).toBeNull()
  })

  it('has Search as its own round pill, after For you’s toggle', () => {
    render()
    const search = lead().querySelector<HTMLElement>('[data-search-button]')
    expect(search?.getAttribute('aria-label')).toBe('Search')
    const forYou = lead().querySelector<HTMLElement>('[data-for-you-toggle]')!
    expect(forYou.compareDocumentPosition(search!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps Search for a phone only (from md up the app rail has it); For you’s toggle decides for itself', () => {
    render()
    const phoneOnly = lead().querySelector<HTMLElement>('[data-tab-bar-phone-only]')!
    expect(phoneOnly.className).toContain('md:hidden')
    expect(phoneOnly.querySelector('[data-search-button]')).not.toBeNull()
    expect(phoneOnly.querySelector('[data-for-you-toggle]')).toBeNull()
    expect(lead().querySelector('[data-for-you-toggle]')).not.toBeNull()
  })

  it('renders nothing of the cluster on the server (the mount gate holds)', () => {
    const html = renderToString(h(TopBar))
    expect(html).not.toContain('data-tab-bar-lead')
    expect(html).not.toContain('aria-label="Inbox"')
  })

  it('its component is gone', () => {
    expect(existsSync(join(process.cwd(), 'src/components/bots/bots-button.tsx'))).toBe(false)
    expect(existsSync(join(process.cwd(), 'src/lib/bots/bots-list.ts'))).toBe(false)
  })
})
