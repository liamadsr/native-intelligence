// @vitest-environment jsdom
/**
 * The right side panel and the row's space plan (side-panels.tsx):
 *
 *   • one way in: its toggle, ⌘\ (from the composer too), Esc inside closes
 *     it and puts the focus back on the toggle;
 *   • mounted on its first open, then kept mounted (inert, off-screen) so
 *     what was typed in it survives closing it;
 *   • sections, each only with something: Agents while anything runs, Plan
 *     when the chat has one, Environment while the main chat has one (told
 *     whether the panel is open, and the chat's conversation), Connections
 *     always, so the last run settling never empties the open panel;
 *   • each card one row while closed (closed until opened, remembered, a
 *     legacy list of folded cards read as all closed): its title, a chevron and a
 *     one-line summary; the whole row opens it;
 *   • the row's ⋮⋮ handle takes the summary's place on hover or focus with
 *     no shift; ⌥↑ / ⌥↓ on it, or a drag, moves the card among those
 *     showing, remembered, a hidden card keeping its slot;
 *   • the toggle's badges: the running count and the amber connections dot;
 *   • the row: room beside the content with no move where it fits, a move of
 *     just the shortfall where it doesn't, float where the chat would drop
 *     under 640px; re-planned on resize and when the notepad docks, the
 *     move written on the row, re-rendered only when a mode changes;
 *   • no flap: a click-through column of floating cards, each card the
 *     pointer's and its own occluder for the in-app browser's hole.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const shared = vi.hoisted(() => ({ rows: [] as unknown[] }))
vi.mock('@/components/work/agent-work-provider', () => ({
  useOptionalAgentWork: () => ({ work: { rows: shared.rows, stop: vi.fn(), stopping: new Set() }, counts: new Map() }),
  useOptionalAgentWorkShared: () => null,
}))
vi.mock('@/hooks/use-open-teammate', () => ({ useOpenWorkItem: () => vi.fn() }))
const connections = vi.hoisted(() => ({
  state: { needsAttention: false, loading: false, refresh: () => {}, groups: { connected: [], attention: [], available: [] } } as Record<string, unknown>,
  calls: [] as Array<{ active: boolean }>,
}))
vi.mock('@/lib/integrations/use-connections', () => ({
  useConnections: (opts: { active: boolean }) => {
    connections.calls.push(opts)
    return connections.state
  },
}))
const connectors = vi.hoisted(() => ({ summary: null as null | { text: string; tone: 'muted' | 'attention' } }))
vi.mock('../connections-section', () => ({
  ConnectionsSection: () => h('div', { 'data-connections-section-stub': '' }, 'connections'),
  connectionsSummary: () => connectors.summary,
}))
vi.mock('@/hooks/recording-context', () => ({ useOptionalRecordingStable: () => null }))
// The computer card's bot: watched exactly while its surface is (the panel open); jsdom has no canvas.
vi.mock('@/hooks/use-watched', () => ({ useWatched: (active = true) => active }))
vi.mock('bot-avatars', async () => {
  const { createElement } = await import('react')
  return {
    BotAvatar: (p: Record<string, unknown>) =>
      createElement('canvas', { 'data-stub-bot': p.type, 'data-state': p.state, 'data-paused': String(!!p.paused) }),
  }
})
const environment = vi.hoisted(() => ({
  card: null as null | { summary: string },
  calls: [] as Array<{ open: boolean; conversationId: string | null }>,
}))
vi.mock('../environment-section', () => ({
  useEnvironmentCard: (opts: { open: boolean; conversationId: string | null }) => {
    environment.calls.push(opts)
    return environment.card
  },
  EnvironmentSection: () => h('div', { 'data-environment-section-stub': '' }, 'environment'),
}))

const { INSET_RIGHT_VAR, RightSidePanel, SLIDE_CLASS, useSidePanelPlan, useSidePanelState } = await import('../side-panels')
const { SidePanelToggle } = await import('../side-panel-toggles')
const store = await import('../side-panel-store')
const feed = await import('../chat-feed')
const { TooltipProvider } = await import('@/components/ui/tooltip')
const { FLOATING_CARD_CLASS } = await import('@/components/attention/card-skin')

function row(over: Record<string, unknown>) {
  return {
    id: 'r',
    workspace_id: 'ws-1',
    kind: 'work_run',
    status: 'running',
    created_at: '2026-10-14T10:00:00.000Z',
    source: {},
    agent_run_id: 'run-1',
    ai_team_member_id: 'tm-1',
    teammate: { name: 'Researcher' },
    plan: null,
    ...over,
  }
}
const PLAN = { callId: 'c', stale: false, steps: [{ text: 'Find', status: 'done' }, { text: 'Draft', status: 'in_progress' }] } as never

let container: HTMLDivElement
let root: Root
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null
const key = (init: KeyboardEventInit, target: EventTarget = document.body) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
  })

// Re-rendered on store changes, as the row does.
const Host = () => h(RightSidePanel, { mode: useSidePanelState().rightOpen ? 'float' : 'off' })
function renderPanel() {
  act(() => root.render(h(TooltipProvider, null, h(SidePanelToggle), h(Host))))
}
function rerender() {
  renderPanel()
}

beforeEach(() => {
  window.localStorage.clear()
  store.resetSidePanelStore()
  feed.resetChatFeed()
  shared.rows = []
  connections.calls = []
  connections.state = { ...connections.state, needsAttention: false }
  connectors.summary = null
  environment.card = null
  environment.calls = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('the right side panel', () => {
  it('its toggle wears the side panel icon: a rounded rectangle with two dot-and-line rows (not lucide’s panel-right)', () => {
    renderPanel()
    const icon = q('[data-side-panel-toggle] [data-side-panel-icon]')!
    expect(icon.getAttribute('class')).toContain('lucide-side-panel')
    expect([...icon.children].map((c) => c.tagName.toLowerCase())).toEqual(['rect', 'path', 'path', 'path', 'path'])
    expect(q('[data-side-panel-toggle] .lucide-panel-right')).toBeNull()
  })

  it('mounts on its first open, then stays mounted, inert and off-screen, when closed', () => {
    renderPanel()
    expect(q('[data-side-panel]')).toBeNull()
    act(() => q('[data-side-panel-toggle]')!.click())
    rerender()
    const panel = q('[data-side-panel]')!
    expect(panel.getAttribute('data-side-panel')).toBe('float')
    expect(panel.hasAttribute('inert')).toBe(false)
    expect(q('[data-side-panel-toggle]')!.getAttribute('aria-expanded')).toBe('true')

    act(() => q('[data-side-panel-toggle]')!.click())
    rerender()
    const closed = q('[data-side-panel]')!
    expect(closed).toBe(panel)
    expect(closed.hasAttribute('inert')).toBe(true)
    expect(closed.getAttribute('aria-hidden')).toBe('true')
    expect(closed.className).toContain('translate-x-[calc(100%+1rem)]')
    expect(closed.className).toContain('motion-reduce:transition-none')
  })

  it('the slide transitions the property that actually moves: Tailwind 4’s translate-x-* sets `translate`, not `transform`', () => {
    store.setRightPanelOpen(true)
    renderPanel()
    const panel = q('[data-side-panel]')!
    expect(panel.className).toMatch(/(^|\s)translate-x-0(\s|$)/)
    expect(panel.className).toContain('transition-[translate,visibility]')
    expect(panel.className).not.toContain('transition-[transform')
    expect(panel.style.transitionDuration).toBe('180ms')
    expect(SLIDE_CLASS).toContain('ease-out')
    expect(SLIDE_CLASS).toContain('motion-reduce:transition-none')
  })

  it('floating, it ends above the composer, following its height; making room, at the window’s bottom', () => {
    const strip = document.createElement('div')
    strip.id = 'dial8-chat-strip-slot'
    const dock = document.createElement('div')
    dock.setAttribute('data-chat-composer-dock', '')
    let height = 120
    Object.defineProperty(dock, 'offsetHeight', { configurable: true, get: () => height })
    strip.appendChild(dock)
    document.body.appendChild(strip)
    let resize: (() => void) | null = null
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          resize = cb
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    try {
      act(() => root.render(h(RightSidePanel, { mode: 'float' })))
      expect(q('[data-side-panel]')!.style.bottom).toBe('132px')
      // The composer grows (a longer message): the panel follows, no polling.
      height = 180
      act(() => resize!())
      expect(q('[data-side-panel]')!.style.bottom).toBe('192px')
      act(() => root.render(h(RightSidePanel, { mode: 'room' })))
      expect(q('[data-side-panel]')!.style.bottom).toBe('12px')
    } finally {
      vi.unstubAllGlobals()
      strip.remove()
    }
  })

  it('no flap: an invisible, click-through column of floating cards, each the pointer’s and its own hole occluder', () => {
    shared.rows = [row({ id: 'run', title: 'Research fintech' })]
    act(() => feed.publishChatFeed({ plan: PLAN, quick: null, conversationId: 'c-1', busy: false }))
    store.setRightPanelOpen(true)
    renderPanel()
    const panel = q('[data-side-panel]')!
    // The column draws nothing and takes no pointer: the chat behind its gaps stays clickable.
    expect(panel.className).toMatch(/(^|\s)pointer-events-none(\s|$)/)
    for (const cls of panel.className.split(/\s+/)) expect(cls).not.toMatch(/^(dark:)?(bg-|border|ring|shadow|backdrop-|rounded)/)
    const list = q('[data-side-panel-cards]')!
    expect(list.className).toMatch(/(^|\s)pointer-events-none(\s|$)/)
    expect(list.className).toContain('gap-2.5')
    expect(list.className).not.toMatch(/(^|\s)bg-/)

    // Each section its own card, on the For you cards' surface: the pages' glass (translucent, blurred).
    const cards = [...container.querySelectorAll<HTMLElement>('[data-side-panel-card]')]
    expect(cards.map((c) => c.getAttribute('data-side-panel-section'))).toEqual(['agents', 'plan', 'connections'])
    for (const card of cards) {
      expect(card.className).toMatch(/(^|\s)pointer-events-auto(\s|$)/)
      for (const cls of FLOATING_CARD_CLASS.split(' ')) expect(card.className).toContain(cls)
      expect(card.className).toMatch(/(^|\s)backdrop-blur-md(\s|$)/)
      expect(card.className).toMatch(/(^|\s)bg-background\/70(\s|$)/)
      expect(card.className).toMatch(/(^|\s)relative(\s|$)/)
    }
  })

  it('closed by default, each card one row: the title, a chevron right after it, then its summary on the far right, muted', () => {
    shared.rows = [row({ id: 'run', title: 'Research fintech' })]
    act(() => feed.publishChatFeed({ plan: PLAN, quick: null, conversationId: 'c-1', busy: false }))
    connectors.summary = { text: '3 connected', tone: 'muted' }
    store.setRightPanelOpen(true)
    renderPanel()
    for (const [id, title, summary] of [
      ['agents', 'Agents', '1 running'],
      ['plan', 'Plan', '1 of 2'],
      ['connections', 'Connectors', '3 connected'],
    ] as const) {
      const toggle = q(`[data-side-panel-section-toggle="${id}"]`)!
      expect(toggle.tagName).toBe('BUTTON')
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(toggle.getAttribute('aria-controls')).toBe(`side-panel-${id}`)
      expect(q(`#side-panel-${id}`)!.hidden).toBe(true)
      expect(toggle.className).toContain('text-[13px]')
      expect(toggle.className).toMatch(/(^|\s)text-foreground(\s|$)/)
      expect(toggle.className).toContain('px-3')
      expect(toggle.className).toContain('py-2.5')
      expect(toggle.className).toContain('focus-visible:ring-2')
      // Title, chevron (right, unturned), summary: in that order, the summary pushed to the far edge.
      const [titleEl, chevron, summaryEl] = [...toggle.children]
      expect(titleEl.getAttribute('data-side-panel-section-title')).toBe('')
      expect(titleEl.textContent).toBe(title)
      expect(chevron.tagName.toLowerCase()).toBe('svg')
      expect(chevron.getAttribute('class')).toContain('lucide-chevron-right')
      expect(chevron.getAttribute('class')).not.toContain('rotate-90')
      expect(summaryEl.getAttribute('data-side-panel-section-summary')).toBe('')
      expect(summaryEl.textContent).toBe(summary)
      expect(summaryEl.className).toContain('ml-auto')
      expect(summaryEl.className).toContain('tabular-nums')
      expect(summaryEl.className).toContain('text-muted-foreground')
    }
  })

  it('Connectors needing a reconnect: its summary in amber, the one hue that means "needs you"; nothing while it has nothing to say', () => {
    store.setRightPanelOpen(true)
    renderPanel()
    const summary = () => q('[data-side-panel-section-toggle="connections"] [data-side-panel-section-summary]')!
    expect(summary().textContent).toBe('')
    // The connections read again (new groups): the summary follows.
    connectors.summary = { text: '2 to reconnect', tone: 'attention' }
    connections.state = { ...connections.state, groups: { connected: [], attention: [], available: [] } }
    rerender()
    expect(summary().textContent).toBe('2 to reconnect')
    expect(summary().className).toContain('text-amber-700')
    expect(summary().className).not.toContain('text-muted-foreground')
  })

  it('the whole row opens and closes its card, the chevron turning down, remembered per device', () => {
    store.setRightPanelOpen(true)
    act(() => feed.publishChatFeed({ plan: PLAN, quick: null, conversationId: 'c-1', busy: false }))
    renderPanel()
    act(() => q('[data-side-panel-section-toggle="plan"]')!.click())
    rerender()
    const toggle = q('[data-side-panel-section-toggle="plan"]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(q('#side-panel-plan')!.hidden).toBe(false)
    expect(toggle.querySelector('svg')!.getAttribute('class')).toContain('rotate-90')
    expect(store.getSidePanelState().sectionOpen.plan).toBe(true)
    expect(JSON.parse(window.localStorage.getItem(store.SECTIONS_KEY)!)).toEqual({ open: ['computer', 'plan'], known: store.SECTION_IDS })
    // Read back on the next load.
    store.resetSidePanelStore()
    rerender()
    expect(q('[data-side-panel-section-toggle="plan"]')!.getAttribute('aria-expanded')).toBe('true')
    act(() => q('[data-side-panel-section-toggle="plan"]')!.click())
    rerender()
    expect(q('#side-panel-plan')!.hidden).toBe(true)
    expect(JSON.parse(window.localStorage.getItem(store.SECTIONS_KEY)!)).toEqual({ open: ['computer'], known: store.SECTION_IDS })
  })

  it('a device’s saved state from before (the cards it FOLDED) reads as every card closed: the high-level view for everyone', () => {
    window.localStorage.setItem(store.SECTIONS_KEY, '["plan"]')
    store.setRightPanelOpen(true)
    shared.rows = [row({ id: 'run' })]
    act(() => feed.publishChatFeed({ plan: PLAN, quick: null, conversationId: 'c-1', busy: false }))
    renderPanel()
    const expanded = (id: string) => q(`[data-side-panel-section-toggle="${id}"]`)!.getAttribute('aria-expanded')
    expect([expanded('agents'), expanded('plan'), expanded('connections')]).toEqual(['false', 'false', 'false'])
  })

  it('the ⋮⋮ handle takes the summary’s place on hover or focus within the row, and nothing shifts', () => {
    act(() => feed.publishChatFeed({ plan: PLAN, quick: null, conversationId: 'c-1', busy: false }))
    store.setRightPanelOpen(true)
    renderPanel()
    const rowEl = q('[data-side-panel-row="plan"]')!
    expect(rowEl.className).toContain('group/row')
    expect(rowEl.className).toMatch(/(^|\s)relative(\s|$)/)
    // The summary only fades: still laid out at its width (never hidden, display none or invisible).
    const summary = rowEl.querySelector('[data-side-panel-section-summary]')!
    expect(summary.className).toContain('group-hover/row:opacity-0')
    expect(summary.className).toContain('group-has-[:focus-visible]/row:opacity-0')
    expect(summary.className).not.toMatch(/(^|\s)(hidden|invisible)(\s|$)|group-hover\/row:(hidden|invisible)/)
    // The handle: out of the flow, over the summary's spot, outside the row's toggle (a button of its own), shown on hover/focus.
    const handle = rowEl.querySelector<HTMLElement>('[data-side-panel-drag-handle="plan"]')!
    expect(handle.tagName).toBe('BUTTON')
    expect(handle.closest('[data-side-panel-section-toggle]')).toBeNull()
    expect(handle.className).toMatch(/(^|\s)absolute(\s|$)/)
    expect(handle.className).toMatch(/(^|\s)right-1\.5(\s|$)/)
    expect(handle.className).toMatch(/(^|\s)opacity-0(\s|$)/)
    expect(handle.className).toMatch(/(^|\s)pointer-events-none(\s|$)/)
    expect(handle.className).toContain('group-hover/row:opacity-100')
    expect(handle.className).toContain('group-has-[:focus-visible]/row:opacity-100')
    expect(handle.className).toContain('group-hover/row:pointer-events-auto')
    expect(handle.className).toContain('touch-none')
    expect(handle.querySelector('svg')!.getAttribute('class')).toContain('lucide-grip-vertical')
    expect(handle.getAttribute('aria-label')).toBe('Move Plan, 1 of 2')
    // A lone card has nothing to swap with: no handle.
    act(() => feed.publishChatFeed({ plan: null, quick: null, conversationId: 'c-1', busy: false }))
    rerender()
    expect(q('[data-side-panel-drag-handle]')).toBeNull()
  })

  it('⌥↑ / ⌥↓ on a card’s handle moves it among the cards showing, remembered, the focus kept and the move announced; a hidden card keeps its slot', () => {
    shared.rows = [row({ id: 'run' })]
    act(() => feed.publishChatFeed({ plan: PLAN, quick: null, conversationId: 'c-1', busy: false }))
    store.setRightPanelOpen(true)
    renderPanel()
    const ids = () => [...container.querySelectorAll('[data-side-panel-card]')].map((el) => el.getAttribute('data-side-panel-section'))
    const handle = (id: string) => q(`[data-side-panel-drag-handle="${id}"]`)!
    expect(ids()).toEqual(['agents', 'plan', 'connections'])
    const planBody = q('#side-panel-plan')

    handle('connections').focus()
    key({ key: 'ArrowUp', altKey: true }, handle('connections'))
    expect(ids()).toEqual(['agents', 'connections', 'plan'])
    expect(document.activeElement).toBe(handle('connections'))
    expect(q('[data-side-panel-announce]')!.textContent).toBe('Connectors moved to 2 of 3')
    expect(q('[data-side-panel-announce]')!.getAttribute('aria-live')).toBe('polite')
    // The hidden Context and Environment cards keep their slots.
    expect(JSON.parse(window.localStorage.getItem(store.ORDER_KEY)!)).toEqual(['computer', 'agents', 'connections', 'context', 'environment', 'plan'])
    // Moved, not remounted.
    expect(q('#side-panel-plan')).toBe(planBody)
    // Plain arrows, or past the end, move nothing.
    key({ key: 'ArrowUp' }, handle('connections'))
    key({ key: 'ArrowDown', altKey: true }, handle('plan'))
    expect(ids()).toEqual(['agents', 'connections', 'plan'])

    // Plan goes: Connections moves up past Agents among the two showing...
    act(() => feed.publishChatFeed({ plan: null, quick: null, conversationId: 'c-1', busy: false }))
    rerender()
    handle('connections').focus()
    key({ key: 'ArrowUp', altKey: true }, handle('connections'))
    expect(ids()).toEqual(['connections', 'agents'])
    // ...and Plan, back, is where it was: last.
    act(() => feed.publishChatFeed({ plan: PLAN, quick: null, conversationId: 'c-1', busy: false }))
    rerender()
    expect(ids()).toEqual(['connections', 'agents', 'plan'])
    store.resetSidePanelStore()
    expect(store.getSidePanelState().order).toEqual(['computer', 'connections', 'agents', 'context', 'environment', 'plan'])
  })

  it('dragging a card by its handle moves it where it is dropped; nothing re-renders while it moves', () => {
    shared.rows = [row({ id: 'run' })]
    act(() => feed.publishChatFeed({ plan: PLAN, quick: null, conversationId: 'c-1', busy: false }))
    store.setRightPanelOpen(true)
    renderPanel()
    const cards = [...container.querySelectorAll<HTMLElement>('[data-side-panel-card]')]
    // Three 40px cards, 10px apart.
    cards.forEach((card, i) => {
      card.getBoundingClientRect = () => ({ top: i * 50, bottom: i * 50 + 40, height: 40, left: 0, right: 360, width: 360, x: 0, y: i * 50, toJSON() {} }) as DOMRect
    })
    const pointer = (type: string, clientY: number) => {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientY, button: 0 })
      Object.defineProperty(e, 'pointerId', { value: 1 })
      return e
    }
    const handle = q('[data-side-panel-drag-handle="agents"]')!
    const heard = vi.fn()
    const off = store.subscribeSidePanels(heard)
    act(() => {
      handle.dispatchEvent(pointer('pointerdown', 20))
    })
    // A press that barely moves is no drag.
    act(() => {
      window.dispatchEvent(pointer('pointermove', 22))
    })
    expect(cards[0].hasAttribute('data-dragging')).toBe(false)
    act(() => {
      window.dispatchEvent(pointer('pointermove', 60))
      window.dispatchEvent(pointer('pointermove', 100))
      window.dispatchEvent(pointer('pointermove', 125))
    })
    expect(cards[0].hasAttribute('data-dragging')).toBe(true)
    expect(heard).not.toHaveBeenCalled()
    act(() => {
      window.dispatchEvent(pointer('pointerup', 125))
    })
    off()
    expect(cards[0].hasAttribute('data-dragging')).toBe(false)
    expect([...container.querySelectorAll('[data-side-panel-card]')].map((el) => el.getAttribute('data-side-panel-section'))).toEqual([
      'plan',
      'connections',
      'agents',
    ])
    expect(JSON.parse(window.localStorage.getItem(store.ORDER_KEY)!)).toEqual(['computer', 'plan', 'connections', 'context', 'environment', 'agents'])
    // A drag is no click on the row: the card stays closed.
    expect(store.getSidePanelState().sectionOpen.agents).toBe(false)
  })

  it('a plain click on the handle (a press that never became a drag) opens or closes its card, as the row does', () => {
    shared.rows = [row({ id: 'run' })]
    act(() => feed.publishChatFeed({ plan: PLAN, quick: null, conversationId: 'c-1', busy: false }))
    store.setRightPanelOpen(true)
    renderPanel()
    const pointer = (type: string, clientY: number) => {
      const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientY, button: 0 })
      Object.defineProperty(e, 'pointerId', { value: 1 })
      return e
    }
    const press = (moveTo: number) => {
      act(() => {
        q('[data-side-panel-drag-handle="plan"]')!.dispatchEvent(pointer('pointerdown', 20))
      })
      act(() => {
        window.dispatchEvent(pointer('pointermove', moveTo))
        window.dispatchEvent(pointer('pointerup', moveTo))
      })
      rerender()
    }
    press(22)
    expect(store.getSidePanelState().sectionOpen.plan).toBe(true)
    expect(q('[data-side-panel-section-toggle="plan"]')!.getAttribute('aria-expanded')).toBe('true')
    press(20)
    expect(store.getSidePanelState().sectionOpen.plan).toBe(false)
    // A press let go by a cancel is neither.
    act(() => {
      q('[data-side-panel-drag-handle="plan"]')!.dispatchEvent(pointer('pointerdown', 20))
    })
    act(() => {
      window.dispatchEvent(pointer('pointercancel', 20))
    })
    expect(store.getSidePanelState().sectionOpen.plan).toBe(false)
  })

  it('⌘\\ toggles it, from a text field too', () => {
    renderPanel()
    const input = document.createElement('textarea')
    document.body.appendChild(input)
    key({ key: '\\', metaKey: true }, input)
    expect(store.getSidePanelState().rightOpen).toBe(true)
    key({ key: '\\', ctrlKey: true })
    expect(store.getSidePanelState().rightOpen).toBe(false)
    input.remove()
  })

  it('Esc inside closes it and gives the focus back to its toggle', () => {
    store.setRightPanelOpen(true)
    renderPanel()
    const panel = q('[data-side-panel]')!
    panel.focus()
    key({ key: 'Escape' }, panel)
    expect(store.getSidePanelState().rightOpen).toBe(false)
    expect(document.activeElement).toBe(q('[data-side-panel-toggle]'))
  })

  it('sections in order: the agent’s card always first (no computer needed), then each only with something: Agents while anything runs, Plan with a plan, Connections always', () => {
    store.setRightPanelOpen(true)
    renderPanel()
    const ids = () => [...container.querySelectorAll('[data-side-panel-section]')].map((el) => el.getAttribute('data-side-panel-section'))
    expect(ids()).toEqual(['computer', 'connections'])

    shared.rows = [row({ id: 'run', title: 'Research fintech' })]
    act(() => feed.publishChatFeed({ plan: PLAN, quick: null, conversationId: 'c-1', busy: false }))
    rerender()
    expect(ids()).toEqual(['computer', 'agents', 'plan', 'connections'])
    expect(q('[data-side-panel-section="agents"]')!.textContent).toContain('1 running')
    expect(q('[data-side-panel-section="plan"]')!.textContent).toContain('1 of 2')

    // The last run settles: Agents goes, the panel stays open with the rest.
    shared.rows = [row({ id: 'run', status: 'done' })]
    rerender()
    expect(ids()).toEqual(['computer', 'plan', 'connections'])
    expect(store.getSidePanelState().rightOpen).toBe(true)
  })

  it('Environment: only while the main chat has one, after the agent’s card and before Connectors, its summary the name; told the chat and whether the panel is open', () => {
    act(() => feed.publishChatFeed({ plan: null, quick: null, conversationId: 'c-1', busy: false }))
    renderPanel()
    store.setRightPanelOpen(true)
    rerender()
    const ids = () => [...container.querySelectorAll('[data-side-panel-section]')].map((el) => el.getAttribute('data-side-panel-section'))
    expect(ids()).toEqual(['computer', 'connections'])
    expect(environment.calls.at(-1)).toEqual({ open: true, conversationId: 'c-1' })
    environment.card = { summary: "Liam's MacBook Pro" }
    rerender()
    expect(ids()).toEqual(['computer', 'environment', 'connections'])
    expect(q('[data-side-panel-section-toggle="environment"] [data-side-panel-section-title]')!.textContent).toBe('Environment')
    expect(q('[data-side-panel-section-toggle="environment"] [data-side-panel-section-summary]')!.textContent).toBe("Liam's MacBook Pro")
    act(() => store.setRightPanelOpen(false))
    rerender()
    expect(environment.calls.at(-1)).toEqual({ open: false, conversationId: 'c-1' })
  })

  it('Computer: the agent’s own card, pinned first and never moved; its bot and name with the agent’s status under it; the bot paused while the panel is closed', async () => {
    let live = { exists: true, status: 'running', driver: 'agent', busy: true, liveView: false }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(live))))
    const client = await import('@/lib/cloud-browser/computer-client')
    const editor = await import('@/components/bots/agent-editor')
    try {
      act(() => feed.publishChatFeed({ plan: PLAN, quick: null, conversationId: 'c-1', busy: false }))
      store.setRightPanelOpen(true)
      renderPanel()
      await act(() => client.refreshComputer())
      // The bot's renderer, fetched on its first mount.
      for (let i = 0; i < 200 && !q('[data-side-panel-row="computer"] canvas[data-stub-bot]'); i++) await act(async () => void (await Promise.resolve()))
      const sections = () => [...container.querySelectorAll('[data-side-panel-section]')].map((el) => el.getAttribute('data-side-panel-section'))
      const movable = () => [...container.querySelectorAll('[data-side-panel-card]')].map((el) => el.getAttribute('data-side-panel-section'))
      expect(sections()).toEqual(['computer', 'plan', 'connections'])
      // Pinned: not one of the cards a drag moves among, and no handle of its own.
      expect(movable()).toEqual(['plan', 'connections'])
      expect(q('[data-side-panel-section="computer"]')!.hasAttribute('data-side-panel-pinned')).toBe(true)
      expect(q('[data-side-panel-drag-handle="computer"]')).toBeNull()

      const toggle = q('[data-side-panel-section-toggle="computer"]')!
      const name = (await import('@/lib/voice/assistant-name-store')).getAssistantName()
      expect(toggle.querySelector('[data-side-panel-section-title]')!.textContent).toBe(name)
      // The bot stands beside the toggle, a button of its own (it opens its look's editor).
      const row = q('[data-side-panel-row="computer"]')!
      expect(toggle.querySelector('[data-agent-bot]')).toBeNull()
      const lookButton = row.querySelector<HTMLButtonElement>('button[data-agent-look-open]')!
      expect(lookButton.getAttribute('aria-label')).toBe(`Change how ${name} looks`)
      // And the settings icon at the row's far right, where a handle would be.
      expect(row.querySelector('[data-agent-edit]')!.getAttribute('aria-label')).toBe(`Edit ${name}`)
      expect(lookButton.querySelector('[data-agent-bot]')!.getAttribute('data-agent-bot')).toBe('working')
      // A click on the bot is the editor's, not the card's toggle (the editor is closed again here: its bot rests behind it).
      const expanded = toggle.getAttribute('aria-expanded')
      act(() => lookButton.click())
      expect(toggle.getAttribute('aria-expanded')).toBe(expanded)
      act(() => editor.closeAgentEditor())
      const bot = () => row.querySelector('canvas[data-stub-bot]')!
      expect(bot().getAttribute('data-stub-bot')).toBe('flower')
      expect(bot().getAttribute('data-paused')).toBe('false')
      // The agent's status under the name, not on the far right: the title's column holds it.
      const summary = toggle.querySelector('[data-side-panel-section-summary]')!
      expect(summary.textContent).toBe('Working')
      expect(summary.parentElement!.contains(toggle.querySelector('[data-side-panel-section-title]'))).toBe(true)
      expect(q('[data-side-panel-section="computer"]')!.getAttribute('aria-label')).toBe(name)

      // The other cards move among themselves, beneath it: ⌥↑ on the first of them goes nowhere.
      const planHandle = q('[data-side-panel-drag-handle="plan"]')!
      expect(planHandle.getAttribute('aria-label')).toBe('Move Plan, 1 of 2')
      planHandle.focus()
      key({ key: 'ArrowUp', altKey: true }, planHandle)
      expect(sections()).toEqual(['computer', 'plan', 'connections'])
      key({ key: 'ArrowDown', altKey: true }, planHandle)
      expect(sections()).toEqual(['computer', 'connections', 'plan'])
      expect(q('[data-side-panel-announce]')!.textContent).toBe('Plan moved to 2 of 2')

      // Its computer asleep: the agent is still Active and awake; only the computer's row sleeps.
      live = { ...live, status: 'stopped', busy: false }
      await act(() => client.refreshComputer())
      expect(summary.textContent).toBe('Active')
      expect(row.querySelector('[data-agent-bot]')!.getAttribute('data-agent-bot')).toBe('default')
      expect(q('[data-computer-state]')!.textContent).toBe('Asleep')

      // Closed, the panel stays mounted off screen: its bot stops.
      act(() => store.setRightPanelOpen(false))
      rerender()
      expect(q('[data-side-panel-row="computer"] canvas[data-stub-bot]')!.getAttribute('data-paused')).toBe('true')
    } finally {
      vi.unstubAllGlobals()
      client.__resetComputerForTests()
      editor.__resetAgentEditorForTests()
    }
  })

  it('the toggle: the running count, and an amber dot while a connection needs the person', () => {
    shared.rows = [row({ id: 'a' }), row({ id: 'b' })]
    connections.state = { ...connections.state, needsAttention: true }
    renderPanel()
    // The connections are read even before the panel first opens (the dot), inactive.
    expect(connections.calls.at(-1)).toEqual({ active: false })
    rerender()
    const toggle = q('[data-side-panel-toggle]')!
    expect(toggle.querySelector('[data-side-panel-running]')?.textContent).toBe('2')
    expect(toggle.querySelector('[data-side-panel-attention]')).not.toBeNull()
    expect(toggle.getAttribute('aria-label')).toBe('Side panel, 2 running, a connection needs you')
  })

  it('the connections read live while open (refresh on open and focus is theirs)', () => {
    store.setRightPanelOpen(true)
    renderPanel()
    expect(connections.calls.at(-1)).toEqual({ active: true })
  })
})

describe('the row’s space plan', () => {
  let width = 1600
  let renders = 0
  function Row() {
    renders++
    const ref = useRef<HTMLDivElement>(null)
    const plan = useSidePanelPlan(ref)
    return h('div', { ref, 'data-plan': `${plan.left}:${plan.right}` })
  }
  let observe: (() => void) | null = null
  beforeEach(() => {
    renders = 0
    width = 1600
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observe = cb
        }
        observe() {}
        disconnect() {}
      },
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
  })
  const planNow = () => q('[data-plan]')!.getAttribute('data-plan')
  const insetRight = () => q('[data-plan]')!.style.getPropertyValue(INSET_RIGHT_VAR)

  it('makes room beside the content without moving it, moves it only by the shortfall, floats where the chat would drop under 640px; a render only when a mode changes', () => {
    act(() => root.render(h(Row)))
    expect(planNow()).toBe('off:off')
    act(() => store.setRightPanelOpen(true))
    act(() => root.render(h(Row)))
    // 1600: the panel fits beside the column, the chat does not move.
    expect(planNow()).toBe('off:room')
    expect(insetRight()).toBe('0px')

    // A resize inside the same mode: no render.
    const before = renders
    width = 1500
    act(() => observe!())
    expect(renders).toBe(before)
    expect(insetRight()).toBe('0px')

    // Short of room now: the content moves by just the shortfall (5px at
    // 1400: the strip gives up 10 on the right), written on the row, still
    // no render.
    width = 1400
    act(() => observe!())
    expect(renders).toBe(before)
    expect(insetRight()).toBe('10px')
    // 1300: short 55, the strip gives up 110.
    width = 1300
    act(() => observe!())
    expect(insetRight()).toBe('110px')

    // Across the line: it floats, the chat untouched.
    width = 938
    act(() => observe!())
    expect(planNow()).toBe('off:float')
    expect(insetRight()).toBe('0px')
  })

  it('the capture’s notepad docking re-plans: the right panel clears the pushed content', () => {
    act(() => store.setRightPanelOpen(true))
    width = 1500
    act(() => root.render(h(Row)))
    expect(insetRight()).toBe('0px')
    act(() => store.setCaptureDockOpen(true))
    expect(planNow()).toBe('off:room')
    expect(parseFloat(insetRight())).toBeGreaterThan(0)
    act(() => store.setCaptureDockOpen(false))
    expect(insetRight()).toBe('0px')
  })

  it('For you as the device left it shows only where it makes room; opened by hand it may float', () => {
    width = 900
    act(() => store.setForYouContent(true))
    act(() => root.render(h(Row)))
    expect(planNow()).toBe('off:off')
    expect(store.getSidePanelState().leftShown).toBe(false)
    act(() => store.toggleForYou(false))
    act(() => root.render(h(Row)))
    expect(planNow()).toBe('float:off')
    expect(store.getSidePanelState().leftShown).toBe(true)
  })
})
