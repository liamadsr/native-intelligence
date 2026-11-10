// @vitest-environment jsdom
/**
 * The workspaces veil sends the app into the background and shows every
 * workspace; picking a card brings the app forward again.
 *
 * Pinned here:
 *  - "View all workspaces" (the open event) and W (the toggle event) put it up.
 *    The app is held — inert, above the veil, hidden once it has landed — and
 *    focus moves to the card marked "You're here", which is listed first.
 *  - Picking that card brings the app back and hands it back untouched.
 *  - Picking another switches with NO curtain, says "Opening…", and comes
 *    forward once the new workspace's teams have loaded — never sooner than the
 *    minimum, never later than the ceiling. A refused switch leaves it up.
 *  - Escape, W, Back and empty space all go back, and keys never reach the
 *    app's shortcuts behind it.
 *  - A workspace made from the veil opens as soon as the list has it.
 *  - Going away mid-flight never leaves the app held.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Ws = { id: string; name: string; slug: string; logo_url: null; plan: string; role: string; member_count: number }

const state = vi.hoisted(() => ({
  workspaces: [] as Ws[],
  currentId: null as string | null,
  teamsLoading: false,
  recording: false,
  switchTo: null as unknown as ReturnType<typeof vi.fn>,
  refresh: null as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock('../../workspace-switcher', () => ({
  useWorkspaces: () => ({ workspaces: state.workspaces, currentId: state.currentId, refresh: state.refresh }),
  useSwitchWorkspace: () => state.switchTo,
}))
vi.mock('../../teams-context', () => ({ useTeams: () => ({ teams: [], loading: state.teamsLoading }) }))
// Stands in for the wizard's last step: "Finish" reports the new workspace.
vi.mock('../../create-workspace-wizard', () => ({
  CreateWorkspaceWizard: ({ onCreated }: { onCreated: (id: string) => void }) => (
    <button data-wizard-finish onClick={() => onCreated('ws-d')}>
      Finish
    </button>
  ),
}))
vi.mock('@/components/desktop-titlebar', () => ({ useIsDesktop: () => false, useHasTrafficLights: () => false }))
vi.mock('@/hooks/recording-context', () => ({ useOptionalRecordingStable: () => ({ isRecording: state.recording }) }))
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => null }))

import { WorkspacesVeil } from '../workspaces-veil'
import { OPEN_WORKSPACES_EVENT } from '../../workspaces-veil-events'

const ws = (id: string, name: string): Ws => ({ id, name, slug: id, logo_url: null, plan: 'pro', role: 'owner', member_count: 1 })

let container: HTMLDivElement
let root: Root
let shell: HTMLDivElement

const veil = () => document.querySelector<HTMLElement>('[data-workspaces-veil]')
const phase = () => veil()?.getAttribute('data-workspaces-veil') ?? 'closed'
const card = (id: string) => document.querySelector<HTMLButtonElement>(`[data-veil-card="${id}"]`)!
const cardIds = () => Array.from(document.querySelectorAll('[data-veil-card]')).map((c) => c.getAttribute('data-veil-card'))
const held = () => shell.hasAttribute('inert')

function render() {
  act(() => root.render(<WorkspacesVeil />))
}
function fire(type: string) {
  act(() => {
    window.dispatchEvent(new CustomEvent(type))
  })
}
function press(target: Element, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}
/** Let the frame that raises the cards and the end of a flight run. */
async function settle(ms = 0) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
  await act(async () => {
    vi.advanceTimersByTime(20)
  })
}
async function openVeil() {
  fire(OPEN_WORKSPACES_EVENT)
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] })
  state.workspaces = [ws('ws-a', 'Alpha'), ws('ws-b', 'Beta'), ws('ws-c', 'Gamma')]
  state.currentId = 'ws-b'
  state.teamsLoading = false
  state.recording = false
  state.switchTo = vi.fn(() => true)
  state.refresh = vi.fn(async () => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ briefs: { 'ws-a': { content: '# Alpha\n\n## Overview\nAlpha sells rugs.' } } }),
    })),
  )
  shell = document.createElement('div')
  shell.id = 'ni-shell-root'
  document.body.appendChild(shell)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  render()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  shell.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the workspaces veil', () => {
  it('sends the app into the background and shows every workspace, the one you are in first', async () => {
    const resized = vi.fn()
    window.addEventListener('resize', resized)
    expect(veil()).toBeNull()
    await openVeil()

    expect(phase()).toBe('open')
    expect(held()).toBe(true)
    expect(shell.style.zIndex).toBe('47')
    // Landed, it's parked hidden at its real size — no transform left on it —
    // so anything that measures itself behind the veil measures true, and
    // whatever measured mid-flight is asked to measure again.
    expect(shell.style.visibility).toBe('hidden')
    expect(shell.style.opacity).toBe('0')
    expect(resized).toHaveBeenCalledTimes(1)
    window.removeEventListener('resize', resized)
    expect(cardIds()).toEqual(['ws-b', 'ws-a', 'ws-c', 'new'])
    expect(card('ws-b').textContent).toContain("You're here")
    expect(card('ws-a').textContent).not.toContain("You're here")
    expect(document.activeElement).toBe(card('ws-b'))
    // Each card carries its workspace's one-line brief.
    expect(card('ws-a').textContent).toContain('Alpha sells rugs.')
  })

  it('brings the app back out of the card marked "You\'re here", untouched', async () => {
    await openVeil()
    const resized = vi.fn()
    window.addEventListener('resize', resized)
    act(() => card('ws-b').click())
    await settle()

    expect(veil()).toBeNull()
    expect(held()).toBe(false)
    expect(shell.getAttribute('style') ?? '').toBe('')
    expect(state.switchTo).not.toHaveBeenCalled()
    // Home again: one more measurement for anything that measured mid-flight.
    expect(resized).toHaveBeenCalledTimes(1)
    window.removeEventListener('resize', resized)
  })

  it('says "Opening…" first, then switches without a curtain, and comes forward once the workspace has loaded', async () => {
    await openVeil()
    act(() => card('ws-a').click())

    // The click only says so. The switch — one long re-render of the whole
    // app — waits until "Opening…" is on screen, or the click looks frozen.
    expect(phase()).toBe('switching')
    expect(card('ws-a').getAttribute('aria-busy')).toBe('true')
    expect(card('ws-a').textContent).toContain('Opening')
    expect(card('ws-c').disabled).toBe(true)
    // Focus rides with the pick, off the card that's now disabled.
    expect(document.activeElement).toBe(card('ws-a'))
    expect(held()).toBe(true)
    expect(state.switchTo).not.toHaveBeenCalled()

    await settle()
    expect(state.switchTo).toHaveBeenCalledWith('ws-a', { curtain: false })
    expect(phase()).toBe('switching')

    // The switch lands and the new workspace's teams start loading…
    state.currentId = 'ws-a'
    state.teamsLoading = true
    render()
    await settle(1000)
    expect(phase()).toBe('switching')

    // …and finish: the app comes forward.
    state.teamsLoading = false
    render()
    await settle()
    expect(veil()).toBeNull()
    expect(held()).toBe(false)
  })

  it('holds a switch for the minimum when the data is already there, and never past the ceiling', async () => {
    await openVeil()
    act(() => card('ws-a').click())
    state.currentId = 'ws-a'
    render()
    await settle(400)
    expect(phase()).toBe('switching')
    await settle(60)
    expect(veil()).toBeNull()

    // Teams that never finish loading can't hold the app back.
    await openVeil()
    act(() => card('ws-c').click())
    state.currentId = 'ws-c'
    state.teamsLoading = true
    render()
    await settle(2900)
    expect(phase()).toBe('switching')
    await settle(120)
    expect(veil()).toBeNull()
  })

  it('stays up when the switch is refused', async () => {
    state.switchTo = vi.fn(() => false)
    render()
    await openVeil()
    act(() => card('ws-a').click())
    await settle()

    expect(state.switchTo).toHaveBeenCalledWith('ws-a', { curtain: false })
    expect(phase()).toBe('open')
    expect(card('ws-a').hasAttribute('aria-busy')).toBe(false)
  })

  it('lets a recording refuse the switch at once, without a moment of "Opening…"', async () => {
    state.recording = true
    state.switchTo = vi.fn(() => false)
    render()
    await openVeil()
    act(() => card('ws-a').click())

    // Asked straight away, so the switch says why it won't.
    expect(state.switchTo).toHaveBeenCalledWith('ws-a', { curtain: false })
    expect(phase()).toBe('open')
    expect(card('ws-a').hasAttribute('aria-busy')).toBe(false)
  })

  it('goes back on Escape, Back and empty space — and keys never reach the app behind it', async () => {
    const appShortcut = vi.fn()
    document.addEventListener('keydown', appShortcut)
    try {
      await openVeil()
      press(card('ws-b'), 'n')
      expect(appShortcut).not.toHaveBeenCalled()
      expect(phase()).toBe('open')

      press(card('ws-b'), 'Escape')
      await settle()
      expect(veil()).toBeNull()

      // W is not a key of the veil's (there are no page hotkeys).
      await openVeil()
      press(card('ws-b'), 'w')
      await settle()
      expect(phase()).toBe('open')
      press(card('ws-b'), 'Escape')
      await settle()
      expect(veil()).toBeNull()

      await openVeil()
      act(() => Array.from(veil()!.querySelectorAll('button')).find((b) => b.textContent?.includes('Back'))!.click())
      await settle()
      expect(veil()).toBeNull()

      await openVeil()
      act(() => veil()!.querySelector<HTMLElement>('.overflow-y-auto')!.click())
      await settle()
      expect(veil()).toBeNull()
      expect(appShortcut).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', appShortcut)
    }
  })

  it('opens a workspace made from the veil as soon as the list has it', async () => {
    await openVeil()
    act(() => card('new').click())
    act(() => document.querySelector<HTMLButtonElement>('[data-wizard-finish]')!.click())
    expect(state.refresh).toHaveBeenCalled()
    expect(state.switchTo).not.toHaveBeenCalled()

    state.workspaces = [...state.workspaces, ws('ws-d', 'Delta')]
    render()
    expect(phase()).toBe('switching')
    await settle()
    expect(state.switchTo).toHaveBeenCalledWith('ws-d', { curtain: false })
  })

  it('searches once there are enough workspaces, and Escape clears the search first', async () => {
    expect(document.querySelector('[aria-label="Search workspaces"]')).toBeNull()
    state.workspaces = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta'].map((name) => ws(`ws-${name.toLowerCase()}`, name))
    state.currentId = 'ws-beta'
    render()
    await openVeil()

    const search = document.querySelector<HTMLInputElement>('[aria-label="Search workspaces"]')!
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(search, 'eta')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(cardIds()).toEqual(['ws-beta', 'ws-eta', 'ws-zeta'])

    press(search, 'Escape')
    expect(phase()).toBe('open')
    expect(search.value).toBe('')
    press(search, 'Escape')
    await settle()
    expect(veil()).toBeNull()
  })

  it('never leaves the app held when it goes away mid-flight', () => {
    fire(OPEN_WORKSPACES_EVENT)
    expect(held()).toBe(true)
    act(() => root.unmount())
    expect(held()).toBe(false)
    expect(shell.style.zIndex).toBe('')
    root = createRoot(container)
  })

  it('never leaves the app hidden when it goes away while the app is parked', async () => {
    await openVeil()
    expect(shell.style.opacity).toBe('0')
    act(() => root.unmount())
    expect(held()).toBe(false)
    expect(shell.getAttribute('style') ?? '').toBe('')
    root = createRoot(container)
  })
})
