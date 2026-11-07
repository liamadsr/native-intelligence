// @vitest-environment jsdom
/**
 * PushToTrackerMenu — destination FRESHNESS, the reported bug.
 *
 * Repro: connect a tracker and pick a project in Settings, then immediately open
 * the push menu on a capture's action row. It said "Pick a project in Settings"
 * — from on top of the settings that had just been configured — and kept saying
 * it for up to a minute-plus.
 *
 * The cause was the cache, not the menu: `cachedJson` is a module-level SWR
 * layer with a 60s TTL, so within the TTL the menu re-served a pre-configuration
 * answer with no request at all, and after it the FIRST open still got the stale
 * answer (SWR revalidates behind the caller), so the truth needed a second open.
 *
 * Which is why these tests use the REAL cached-fetch module — the sibling
 * push-to-tracker-menu.test.tsx mocks it out to isolate the menu's own logic,
 * and that mock is exactly what would hide this bug. Everything here is about
 * the seam between the two:
 *   - a settings mutation invalidates, so the very next open is correct;
 *   - the menu also force-revalidates on open, so it converges even if no
 *     mutation ever announced itself (another tab, a stale entry, a code path
 *     nobody hooked);
 *   - a menu that is ALREADY open reacts to the event without being reopened.
 *
 * Radix's DropdownMenu can't be driven in jsdom, so it's replaced with plain
 * elements preserving the contract the component relies on (controlled open,
 * `onSelect`, `disabled`) — same substitution as the sibling file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-fresh' }))

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

import { PushToTrackerMenu } from '../push-to-tracker-menu'
import { invalidateCached } from '@/lib/cached-fetch'
import {
  notifyTaskDestinationsChanged,
  TASK_DESTINATIONS_URL,
} from '@/lib/tasks/destinations-events'

const UNCONFIGURED = {
  provider: 'asana',
  name: 'Asana',
  configured: false,
  destinationLabel: null,
}
const CONFIGURED = {
  provider: 'asana',
  name: 'Asana',
  configured: true,
  destinationLabel: 'Engineering',
}

/** What the server currently answers with — reassign to "change settings". */
let serverDestinations: unknown[] = []
let destinationCalls = 0
/**
 * While true, destination responses park until `releaseDestinations()` — the
 * seam that separates "answered from cache" from "answered by the server",
 * which otherwise both settle inside the same microtask drain.
 */
let holdDestinations = false
const parked: Array<() => void> = []

function releaseDestinations() {
  while (parked.length) parked.pop()!()
}

function installFetch() {
  destinationCalls = 0
  holdDestinations = false
  parked.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input)
      if (url.startsWith(TASK_DESTINATIONS_URL)) {
        destinationCalls += 1
        if (holdDestinations) {
          await new Promise<void>((resolve) => parked.push(resolve))
        }
        return { ok: true, status: 200, json: async () => ({ destinations: serverDestinations }) }
      }
      return { ok: true, status: 200, json: async () => ({ tasks: [] }) }
    }),
  )
}

let container: HTMLDivElement
let root: Root

function items(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('[data-menu-content] [data-menu-item]'))
}

function itemByText(text: string): HTMLButtonElement | undefined {
  return items().find((b) => b.textContent?.includes(text))
}

function trigger(): HTMLButtonElement {
  return container.querySelector('button') as HTMLButtonElement
}

async function toggleMenu() {
  await act(async () => {
    trigger().dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  // Drain the background revalidation the open kicks off.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function render() {
  await act(async () => {
    root.render(h(PushToTrackerMenu, { actionId: 'act-1', compact: true }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // The cache is module-level and outlives each test — this file's whole point
  // is that it does, so clear the one URL under test rather than the module.
  invalidateCached(TASK_DESTINATIONS_URL)
  serverDestinations = []
  installFetch()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('PushToTrackerMenu — destination freshness', () => {
  it('THE BUG: a settings save makes the very next open show the destination', async () => {
    // 1. The menu is opened before anything is configured — this is what warms
    //    the cache with "connected, but nowhere to push".
    serverDestinations = [UNCONFIGURED]
    await render()
    await toggleMenu()
    expect(itemByText('Push to Asana')!.textContent).toContain('Pick a project in Settings')
    await toggleMenu()

    // 2. The user picks a project in Settings. That component's PATCH succeeded,
    //    so it announces the change — the same call the settings view makes.
    serverDestinations = [CONFIGURED]
    await act(async () => {
      notifyTaskDestinationsChanged()
    })

    // 3. Reopening shows the destination. No remount, no refresh, no waiting out
    //    a TTL — and crucially not a SECOND open, which is what plain SWR
    //    would have required.
    await toggleMenu()
    const push = itemByText('Push to Asana')!
    expect(push.textContent).toContain('Engineering')
    expect(push.getAttribute('data-disabled')).toBeNull()
  })

  it('converges on ONE open even when no mutation announced itself', async () => {
    // Belt to the event's braces: another tab, or a write path nobody hooked.
    // The open serves the cached answer instantly, then corrects itself.
    serverDestinations = [UNCONFIGURED]
    await render()
    await toggleMenu()
    await toggleMenu()

    // Changed behind the app's back — the cache still holds the old answer and
    // is nowhere near its TTL.
    serverDestinations = [CONFIGURED]

    await toggleMenu()
    expect(itemByText('Push to Asana')!.textContent).toContain('Engineering')
  })

  it('updates a menu that is ALREADY open when the event fires', async () => {
    // The settings OVERLAY sits above the capture, so the menu underneath can be
    // open while the destination is being configured.
    serverDestinations = []
    await render()
    await toggleMenu()
    expect(itemByText('Connect a task app…')).toBeTruthy()

    serverDestinations = [CONFIGURED]
    await act(async () => {
      notifyTaskDestinationsChanged()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(itemByText('Connect a task app…')).toBeUndefined()
    expect(itemByText('Push to Asana')!.textContent).toContain('Engineering')
  })

  it('THE INVALIDATION ITSELF: the cache is dropped, not just the menus that heard the event', async () => {
    /**
     * Pins the layer every other test in this file is blind to.
     *
     * Delete `invalidateCached` from `notifyTaskDestinationsChanged` and the
     * three tests above stay GREEN, because the menu is redundantly correct
     * twice over: `revalidate: 'always'` repairs a stale open within the same
     * act() drain, and the event handler's `setDestinations(null)` clears
     * component state whether or not the cache entry survived. Neither one can
     * observe the cache.
     *
     * A menu that was NOT MOUNTED when the event fired can. It heard nothing,
     * so its state was never cleared and it has no version bump — its open is a
     * plain `cachedJson` read. If the entry is still there, that read is served
     * from memory with the pre-change answer; if the invalidation did its job,
     * the entry is gone and the read has to go to the network.
     *
     * Hence the assertion is a REQUEST COUNT, not a rendered string: the count
     * is the only thing that distinguishes "the cache was dropped" from "the
     * menu recovered anyway", and recovering anyway is precisely what makes the
     * missing invalidation invisible elsewhere.
     */
    // Warm the module-level cache from a menu that then goes away entirely.
    serverDestinations = [UNCONFIGURED]
    await render()
    await toggleMenu()
    expect(itemByText('Push to Asana')!.textContent).toContain('Pick a project in Settings')
    await act(() => root.unmount())

    // Settings saves. No menu is mounted, so nothing but the cache drop happens.
    serverDestinations = [CONFIGURED]
    await act(async () => {
      notifyTaskDestinationsChanged()
    })

    // From here the server is STALLED. `revalidate: 'always'` still issues its
    // request, but it cannot answer — so whatever the menu shows now came from
    // the cache, and showing nothing means the cache had nothing.
    holdDestinations = true

    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await render()
    await toggleMenu()

    // A surviving entry would have painted the pre-change answer from memory
    // while the network hangs. It was dropped, so there is nothing to paint.
    expect(itemByText('Pick a project in Settings')).toBeUndefined()

    // Let the (real, unavoidable) request finish: the truth arrives from the
    // server, which is the whole point of having missed.
    holdDestinations = false
    await act(async () => {
      releaseDestinations()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(itemByText('Push to Asana')!.textContent).toContain('Engineering')
  })

  it('still serves a CLOSED menu from cache — the event is not a fetch trigger', async () => {
    // Invalidation must not turn every settings save into a request per mounted
    // menu; a capture can render dozens of rows. The refetch belongs to the open.
    serverDestinations = [UNCONFIGURED]
    await render()
    await toggleMenu()
    await toggleMenu()
    const before = destinationCalls

    serverDestinations = [CONFIGURED]
    await act(async () => {
      notifyTaskDestinationsChanged()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(destinationCalls).toBe(before)
  })
})
