// @vitest-environment jsdom
/**
 * The two ways compose gets ARMED in the action detail panel, both of which
 * were dead ends before this suite existed.
 *
 * D1 — THE BOARD HAND-OFF, end to end. A board card has no room for the compose
 * strip, so picking a provider on a card is supposed to open this panel with the
 * form already up. The two halves of that (the card dispatches; a panel that is
 * already mounted listens) were each tested in isolation and both passed, while
 * the actual gesture did nothing: the card's click is what MOUNTS the panel, so
 * the event fired before any listener for that action existed and was delivered
 * to nobody. The fix latches the request at module scope and drains it on mount;
 * these tests exercise the ORDER that broke it — publish, then mount — which is
 * the only order the real board produces.
 *
 * D3 — THE TOOLBAR WITH THE SIDEBAR COLLAPSED. The panel's own push menu could
 * arm compose while the properties sidebar was shut. The form's only host is
 * that sidebar, so nothing mounted, and the toggle that would have opened it is
 * disabled while composing with "Finish or cancel the push first" — an
 * instruction with no form to finish or cancel. Arming now opens the sidebar,
 * which is what makes the disable coherent.
 *
 * WHAT JSDOM CANNOT PIN HERE. Nothing in this file proves anything about
 * LAYOUT. jsdom has no layout engine: every element reports a zero-size box,
 * `overflow` clips nothing, and a popover cropped to a two-pixel sliver in a
 * real browser is fully "visible" to these queries. The sibling assertion in
 * push-compose-panel.test.tsx pins the project popover's PORTAL STRUCTURE (it
 * must not be a descendant of the scroller) precisely because the clipping it
 * prevents is invisible to this environment. Structure is testable here;
 * whether the user can see the thing is not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
/**
 * Controllable ResizeObserver: the properties sidebar is width-driven now
 * (usePropertiesVisible), so hiding it in a test means reporting a narrow
 * panel, not clicking a toggle.
 */
const resizeCallbacks = new Set<() => void>()
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  cb: () => void
  constructor(cb: () => void) {
    this.cb = cb
    resizeCallbacks.add(cb)
  }
  observe() {}
  unobserve() {}
  disconnect() {
    resizeCallbacks.delete(this.cb)
  }
}

/** Width every measured element reports. Wide enough for the sidebar by default. */
let panelWidth = 1200
const realGetRect = window.HTMLElement.prototype.getBoundingClientRect
window.HTMLElement.prototype.getBoundingClientRect = function () {
  const rect = realGetRect.call(this) as DOMRect
  // Only the panel body row is measured by the hook; giving every element the
  // same width is harmless here and avoids threading a ref into the test.
  return { ...rect, width: panelWidth, height: 600 } as DOMRect
}

// Row 4: the panel binds an `action_github_pr` channel. Keep the suite hermetic —
// unmocked, it opens a REAL Realtime socket to whatever Supabase URL the env
// carries (on a Vercel build, prod; src/test/setup.ts fences fetch, not sockets).
vi.mock('@/hooks/use-row-changes', () => ({ useRowChanges: () => {} }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// The entity actions menu has its own suite; this one mocks the dropdown primitives it is built from.
vi.mock('@/components/entities/entity-actions-menu', () => ({ EntityActionsMenu: () => null, PANEL_OMIT: [] }))
vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceId: () => 'ws-1',
  useCurrentMemberId: () => 'm-1',
  // Single-workspace user — the move-to-workspace button renders nothing.
  useWorkspaces: () => ({ workspaces: [], currentId: 'ws-1', refresh: vi.fn() }),
  useSwitchWorkspace: () => vi.fn(),
}))
vi.mock('../../settings-overlay', () => ({ useSettingsOverlay: () => ({ openSettings: vi.fn() }) }))
vi.mock('../note-editor', () => ({ NoteEditor: () => h('div', { 'data-note-editor': '' }) }))
vi.mock('../cloud-run-view', () => ({ CloudRunView: () => h('div', { 'data-cloud-run': '' }) }))
vi.mock('../../components/comments', () => ({ Comments: () => h('div', { 'data-comments': '' }) }))
vi.mock('@/components/capture/attachments-carousel', () => ({
  AttachmentsCarousel: () => h('div', { 'data-attachments': '' }),
}))
vi.mock('@/components/celebration/celebrate', () => ({ celebrateFromElement: vi.fn() }))
vi.mock('@/lib/labels/use-scoped-labels', () => ({
  useScopedLabels: () => ({ labels: [], grouped: [] }),
}))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => false }))
vi.mock('@/lib/cached-fetch', () => ({
  cachedJson: async (url: string) => {
    const res = await fetch(url)
    return res.ok ? res.json() : null
  },
}))

/**
 * The dropdown, reduced to plain DOM.
 *
 * Radix's real menu portals, traps focus and opens on pointer events jsdom does
 * not synthesise faithfully; the same stand-in the menu's own suite uses keeps
 * D3 about "does arming open the sidebar" rather than about driving Radix.
 */
vi.mock('@/components/ui/dropdown-menu', async () => {
  const { createContext, useContext, createElement: e } = await import('react')
  type Ctx = { open: boolean; setOpen: (v: boolean) => void }
  const MenuCtx = createContext<Ctx>({ open: false, setOpen: () => {} })
  return {
    DropdownMenu: ({
      open,
      onOpenChange,
      children,
    }: {
      open?: boolean
      onOpenChange?: (v: boolean) => void
      children?: React.ReactNode
    }) =>
      e(
        MenuCtx.Provider,
        { value: { open: !!open, setOpen: (v: boolean) => onOpenChange?.(v) } },
        children,
      ),
    DropdownMenuTrigger: ({ children }: { children?: React.ReactNode }) => {
      const ctx = useContext(MenuCtx)
      return e('span', { onClick: () => ctx.setOpen(!ctx.open) }, children)
    },
    DropdownMenuContent: ({ children }: { children?: React.ReactNode }) => {
      const ctx = useContext(MenuCtx)
      return ctx.open ? e('div', { 'data-menu-content': '' }, children) : null
    },
    DropdownMenuItem: ({
      children,
      disabled,
      onSelect,
    }: {
      children?: React.ReactNode
      disabled?: boolean
      onSelect?: (event: { preventDefault: () => void }) => void
    }) =>
      e(
        'button',
        {
          type: 'button',
          'data-menu-item': '',
          'data-disabled': disabled ? 'true' : undefined,
          onClick: () => {
            if (!disabled) onSelect?.({ preventDefault: () => {} })
          },
        },
        children,
      ),
    DropdownMenuSeparator: () => e('hr'),
    DropdownMenuGroup: ({ children }: { children?: React.ReactNode }) => e('div', {}, children),
  }
})

/**
 * The compose FORM is stubbed to a marker.
 *
 * What is under test is whether the form gets mounted at all and for which
 * provider — not the Jira cascade, which push-compose-panel.test.tsx owns. The
 * real panel would fire its own option loads on mount and drag this suite into
 * territory it is not asserting.
 */
vi.mock('@/components/tasks/push-compose-panel', () => ({
  PushComposePanel: ({ provider, providerName }: { provider: string; providerName: string }) =>
    h('div', { 'data-compose-form': provider, 'data-compose-name': providerName }, h('input', { 'aria-label': 'Compose draft', defaultValue: '' })),
}))

import { ActionDetailPanel } from '../action-detail-panel'
import {
  requestActionCompose,
  clearActionComposeRequest,
  COMPOSE_REQUEST_TTL_MS,
} from '@/lib/tasks/compose-request-events'

const ACTION = {
  id: 'act-1',
  identifier: 'ENG-42',
  title: 'Ship the thing',
  description: null,
  status_id: 'st-1',
  status_name: 'Todo',
  status_category: 'unstarted',
  status_color: '#888888',
  priority: 'none',
  team_id: 'team-1',
  project_id: null,
  assignee_ai_member_id: null,
  agent_run_status: null,
  labels: [],
}

/** A configured Jira destination — the thing arming needs before it can arm. */
const DESTINATIONS = [
  {
    provider: 'jira',
    name: 'Jira',
    configured: true,
    destinationLabel: 'KAN board',
  },
]

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input)
      if (url === '/api/account/actions/act-1') {
        return { ok: true, status: 200, json: async () => ({ action: ACTION }) }
      }
      if (url.startsWith('/api/account/task-destinations')) {
        return { ok: true, status: 200, json: async () => ({ destinations: DESTINATIONS }) }
      }
      // No existing links: the menu offers "Push to…" rather than Open/Unlink.
      if (url.includes('/external-links') || url.endsWith('/asana')) {
        return { ok: true, status: 200, json: async () => ({ links: [], tasks: [] }) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          links: [],
          states: [],
          projects: [],
          documents: [],
          members: [],
          aiMembers: [],
          actions: [],
          relations: [],
          prs: [],
          runs: [],
          cycles: [],
          milestones: [],
        }),
      }
    }),
  )
}

let container: HTMLDivElement
let root: Root

/** Mount the panel and let its mount fetches settle. */
async function mountPanel() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(h(ActionDetailPanel, { actionId: 'act-1', onClose: vi.fn() }))
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function composeForm(): HTMLElement | null {
  return document.querySelector('[data-compose-form]')
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })))
  vi.clearAllMocks()
  clearActionComposeRequest()
  installFetch()
  // Wide by default: a test that wants the sidebar hidden narrows it explicitly.
  panelWidth = 1200
  resizeCallbacks.clear()
})

afterEach(() => {
  if (root) act(() => root.unmount())
  if (container) container.remove()
  clearActionComposeRequest()
  vi.useRealTimers()
})

describe('D1 — board card → detail panel compose hand-off', () => {
  it('arms compose on a panel that mounts AFTER the request (the board order)', async () => {
    // THE REGRESSION, exactly as the board produces it: the request is published
    // by a click on a card, and the panel that will host the form does not exist
    // until that same click routes to it. Before the latch, this mounted a panel
    // with no compose form at all.
    requestActionCompose({ actionId: 'act-1', title: 'Ship the thing', provider: 'jira' })
    await mountPanel()

    const form = composeForm()
    expect(form).toBeTruthy()
    expect(form?.getAttribute('data-compose-form')).toBe('jira')
  })

  it('mounts the form for the provider the card picked, not merely some form', async () => {
    // Arming the wrong provider would be a form over the wrong tracker — worse
    // than no form, because it looks like it worked.
    requestActionCompose({ actionId: 'act-1', title: 'Ship the thing', provider: 'jira' })
    await mountPanel()

    expect(composeForm()?.getAttribute('data-compose-name')).toBe('Jira')
  })

  it('opens the properties sidebar, which is the only host the form has', async () => {
    // The latch arms compose; if it did not also open the sidebar the form would
    // have nowhere to portal into and the click would still be dead.
    requestActionCompose({ actionId: 'act-1', title: 'Ship the thing', provider: 'jira' })
    await mountPanel()

    // The form is INSIDE the sidebar's compose host, not loose in the toolbar.
    const form = composeForm()
    expect(form).toBeTruthy()
    expect(form?.closest('[data-compose-sidebar-host]')).toBeTruthy()
  })

  it('IGNORES a request latched for a different action', async () => {
    // Every panel drains the same module-level latch. One left by a card for
    // another action must not arm a form over this one.
    requestActionCompose({ actionId: 'act-OTHER', title: 'Something else', provider: 'jira' })
    await mountPanel()

    expect(composeForm()).toBeNull()
  })

  it('IGNORES a request older than the TTL', async () => {
    // A request the user abandoned — picked a provider, never arrived — must not
    // ambush them with a form when they open that action by hand much later.
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    requestActionCompose({ actionId: 'act-1', title: 'Ship the thing', provider: 'jira' })
    vi.spyOn(Date, 'now').mockReturnValue(now + COMPOSE_REQUEST_TTL_MS + 1)

    await mountPanel()
    expect(composeForm()).toBeNull()
  })

  it('CONSUMES the request, so a remount does not re-arm it', async () => {
    // Leaving the latch in place would re-arm on every remount of this panel —
    // including the one after a cancel, making the form impossible to dismiss.
    requestActionCompose({ actionId: 'act-1', title: 'Ship the thing', provider: 'jira' })
    await mountPanel()
    expect(composeForm()).toBeTruthy()

    act(() => root.unmount())
    container.remove()

    await mountPanel()
    expect(composeForm()).toBeNull()
  })

  it('still serves an ALREADY-MOUNTED panel over the live event', async () => {
    // The latch does not replace the event: a panel that is already open must
    // react to a card click on the same action without remounting.
    await mountPanel()
    expect(composeForm()).toBeNull()

    await act(async () => {
      requestActionCompose({ actionId: 'act-1', title: 'Ship the thing', provider: 'jira' })
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(composeForm()?.getAttribute('data-compose-form')).toBe('jira')
  })
})

describe('D3 — arming compose opens the properties sidebar', () => {
  /**
   * The sidebar toggle, found by the icon it carries.
   *
   * It has no accessible name to query by — its only text is a
   * `PanelLeftClose` glyph and its `title` is present only while composing
   * (that is the disabled explanation, not a label). The lucide class name is
   * the stable handle.
   */
  /** Report a narrow panel, so the width-driven sidebar steps aside. */
  async function narrowThePanel() {
    panelWidth = 500
    await act(async () => {
      resizeCallbacks.forEach((cb) => cb())
    })
  }

  /**
   * The toolbar's own push menu trigger.
   *
   * The click has to land on the mock's wrapping `<span>` (that is where the
   * open handler is), so this returns the button's parent rather than the
   * button — dispatching on the button alone would bubble, but starting there
   * keeps the intent explicit.
   */
  function pushTrigger(): HTMLElement | undefined {
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Push to…',
    )
    return (button?.parentElement ?? undefined) as HTMLElement | undefined
  }

  /**
   * Hide the sidebar by NARROWING the panel, then arm compose FROM THE TOOLBAR
   * MENU.
   *
   * Deliberately not `requestActionCompose` — that is the board's channel, and
   * its listener has always forced the sidebar available, so driving D3 through
   * the event bus would test the path that already worked and pass against the
   * bug. The toolbar menu is the path that had no such guarantee.
   *
   * The sidebar used to be collapsed with a toggle button; it's width-driven
   * now, so a too-narrow panel is what produces the hidden state this defect is
   * about.
   */
  async function collapseThenPickJira() {
    await narrowThePanel()
    expect(container.querySelector('[data-compose-sidebar-host]')).toBeNull()

    await act(async () => {
      pushTrigger()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    const item = Array.from(
      container.querySelectorAll('[data-menu-content] [data-menu-item]'),
    ).find((b) => b.textContent?.includes('Push to Jira'))
    expect(item).toBeTruthy()
    await act(async () => {
      item!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  it('opens the collapsed sidebar when the TOOLBAR menu arms compose', async () => {
    await mountPanel()
    await collapseThenPickJira()

    // The dead end: compose armed, sidebar shut, so `composeHost` was null and
    // `renderCompose` drew nothing — no form anywhere on the page.
    const form = composeForm()
    expect(form).toBeTruthy()
    expect(form?.closest('[data-compose-sidebar-host]')).toBeTruthy()
  })

  it('keeps the armed form on screen even as the panel keeps shrinking', async () => {
    // The sidebar is width-driven, so without the compose lock a further
    // resize would unmount the form mid-edit and silently discard whatever had
    // been typed into it. Armed means pinned, whatever the width says.
    await mountPanel()
    await collapseThenPickJira()
    expect(composeForm()).toBeTruthy()

    panelWidth = 320
    await act(async () => {
      resizeCallbacks.forEach((cb) => cb())
    })

    expect(composeForm()).toBeTruthy()
    expect(container.querySelector('[data-compose-sidebar-host]')).toBeTruthy()
  })
})
