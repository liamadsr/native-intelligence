// @vitest-environment jsdom
/**
 * ActionPlatformCell — the platform mark AS MOUNTED IN A ROW, which is where
 * the two things that could go quietly wrong actually live.
 *
 * 1. NO FETCH FAN-OUT. A view mounts hundreds of these. The mark draws from
 *    `external_links` on the row payload (one embedded join in the view query),
 *    and the menu underneath is COMPACT — it defers its own link read to the
 *    first open. A cell that asked anything on mount would turn a 500-row board
 *    into 1,500 requests, and nothing about the rendered output would say so.
 *
 * 2. THE ROW REDRAWS AFTER A PUSH. `external_links` is a JOIN rather than a
 *    column, so no Supabase Realtime channel will ever announce it — the entity
 *    bus is the only thing that carries a fresh link from the menu that made it
 *    to the row that draws it.
 *
 * 3. THE CELL DOES NOT DRAW COMPOSE. It is a 30px slot; the form is a full-width
 *    strip. So the cell forwards it to whoever mounted it and lets the SURFACE
 *    decide — which is the whole reason the board card can refuse it.
 *
 * Radix's DropdownMenu can't be driven in jsdom, so it is replaced with plain
 * elements preserving the contracts the components rely on. (The compose Dialog
 * mock is gone with the Dialog itself.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-1' }))
vi.mock('@/lib/cached-fetch', () => ({
  cachedJson: async (url: string) => {
    const res = await fetch(url)
    return res.ok ? res.json() : null
  },
}))

const emitMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/entity-events', () => ({ emitEntityUpdated: emitMock }))

vi.mock('@/components/ui/dropdown-menu', async () => {
  const { createContext, useContext, createElement: e, cloneElement, isValidElement } =
    await import('react')
  const MenuCtx = createContext<{ open: boolean; setOpen: (v: boolean) => void }>({
    open: false,
    setOpen: () => {},
  })
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
    // `asChild` semantics: the real trigger merges onto the child, and the child
    // stops propagation so the row underneath doesn't act on the same click.
    DropdownMenuTrigger: ({ children }: { children?: React.ReactNode }) => {
      const ctx = useContext(MenuCtx)
      if (isValidElement(children)) {
        const child = children as React.ReactElement<{ onClick?: (e: unknown) => void }>
        return cloneElement(child, {
          onClick: (event: unknown) => {
            child.props.onClick?.(event)
            ctx.setOpen(!ctx.open)
          },
        })
      }
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

vi.mock('@/components/ui/select', async () => {
  const { createElement: e } = await import('react')
  return {
    Select: ({ children }: { children?: React.ReactNode }) => e('select', {}, children),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children?: React.ReactNode }) => e('optgroup', {}, children),
    SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) =>
      e('option', { value }, children),
  }
})

import { ActionPlatformCell } from '../action-platform-cell'

const ASANA = { provider: 'asana', name: 'Asana', configured: true, destinationLabel: 'Engineering' }
const ASANA_LINK = {
  id: 'link-1',
  provider: 'asana',
  external_id: 'gid-1',
  external_url: 'https://app.asana.com/0/1/2',
  external_title: 'Ship the thing',
  completed: false,
}

let calls: Array<{ url: string; method: string }> = []

function installFetch(opts: { links?: unknown[] } = {}) {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      if (url.includes('task-destinations')) {
        return { ok: true, status: 200, json: async () => ({ destinations: [ASANA] }) }
      }
      if (url.includes('/workspace/asana-settings')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            connected: true,
            config: { asana_workspace_gid: 'ws-gid', project_gid: 'proj-1' },
          }),
        }
      }
      if (url.includes('/asana/projects')) {
        return { ok: true, status: 200, json: async () => ({ projects: [{ gid: 'proj-1', name: 'Engineering' }] }) }
      }
      if (url.includes('/asana/sections')) return { ok: true, status: 200, json: async () => ({ sections: [] }) }
      if (url.includes('/asana/users')) return { ok: true, status: 200, json: async () => ({ users: [] }) }
      if (method === 'POST') return { ok: true, status: 201, json: async () => ({ task: ASANA_LINK }) }
      if (method === 'DELETE') return { ok: true, status: 200, json: async () => ({ success: true }) }
      const provider = url.split('/').pop()
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tasks: (opts.links ?? []).filter((l) => (l as { provider: string }).provider === provider),
        }),
      }
    }),
  )
}

let container: HTMLDivElement
let root: Root

/**
 * Mount the cell the way the LIST ROW does — with an `onCompose` that draws the
 * form inline.
 *
 * RE-TARGET NOTE (the inline-compose rework): the cell used to need nothing,
 * because the menu underneath rendered its own compose Dialog. It now forwards
 * the form to the surface (`onCompose`), because a 30px cell cannot hold a
 * full-width strip — the list row places it, the board card refuses it and
 * routes to the detail panel instead.
 */
async function render(item: Record<string, unknown>) {
  await act(async () => {
    root.render(
      h(ActionPlatformCell, {
        item,
        onCompose: (node: React.ReactNode) => h('div', { 'data-compose-host': '' }, node),
      }),
    )
  })
}

function mark(): HTMLButtonElement {
  return container.querySelector('[data-platform-icon]') as HTMLButtonElement
}

function menuItem(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('[data-menu-content] [data-menu-item]')).find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined
}

async function openMenu() {
  await act(async () => {
    mark().dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ActionPlatformCell — the row payload is the source', () => {
  it('FETCHES NOTHING on mount', async () => {
    // The claim that makes this mountable on every row of a 500-row board.
    installFetch()
    await render({ id: 'act-1', title: 'Ship it', external_links: [{ provider: 'jira' }] })
    expect(calls).toHaveLength(0)
  })

  /**
   * CHANGED by the review finding "Multi-provider icon stack order is
   * nondeterministic across surfaces and refreshes": the expected string is now
   * CANONICAL order rather than payload order. The payload's embedded join has
   * no ORDER BY, so the order asserted here was never a guarantee in the first
   * place — pinning pass-through was pinning heap order. ActionPlatformIcon now
   * sorts, which is what makes the same action look the same on every surface.
   * The SET of providers — the actual claim this test makes — is unchanged.
   */
  it('draws the providers the row payload carries', async () => {
    installFetch()
    await render({
      id: 'act-1',
      title: 'Ship it',
      external_links: [{ provider: 'jira' }, { provider: 'asana' }],
    })
    expect(mark().getAttribute('data-platform-icon')).toBe('asana,jira')
  })

  it('a row with no links is a Dial8 action', async () => {
    installFetch()
    await render({ id: 'act-1', title: 'Ship it', external_links: [] })
    expect(mark().getAttribute('data-platform-icon')).toBe('dial8')
  })

  it('tolerates a payload with no external_links at all', async () => {
    // An older cached view row, or an entity type whose select predates the
    // join — neither should render a broken icon.
    installFetch()
    await render({ id: 'act-1', title: 'Ship it' })
    expect(mark().getAttribute('data-platform-icon')).toBe('dial8')
  })

  it('defers the FULL link read to the first menu open', async () => {
    installFetch({ links: [ASANA_LINK] })
    await render({ id: 'act-1', title: 'Ship it', external_links: [{ provider: 'asana' }] })
    expect(calls.some((c) => c.url === '/api/account/actions/act-1/asana')).toBe(false)

    await openMenu()
    // NOW it reads them — because Open-in and Unlink need urls and ids the row
    // payload deliberately doesn't carry.
    expect(calls.some((c) => c.url === '/api/account/actions/act-1/asana')).toBe(true)
    expect(menuItem('Open in Asana')).toBeTruthy()
  })
})

/**
 * CHANGED by the review finding "Pushes/unlinks from the detail panel and
 * capture proposal rows never update the row icons".
 *
 * The republish MOVED into PushToTrackerMenu — the only mount-independent place
 * that holds the full post-mutation link set — so the detail-panel toolbar and
 * the proposal card get it too, not just this cell. Every behavioural assertion
 * below is unchanged (same event, same id, same duplicate-folding); what
 * changed is that the cell no longer passes onPushed/onUnlinked, and the emit
 * now carries `skipSelfMark` because no write to the `actions` row ever
 * happened. The payload is the FULL link rows (not `{ provider }` stubs) —
 * this cell reads only `.provider`, but the detail panel's listener writes the
 * same payload into the shared action cache, where a stub would later seed a
 * menu with rows missing `id`/`external_url` (see the push-menu suite). These
 * stay here because this is the surface whose ICON depends on the event.
 */
describe('ActionPlatformCell — keeping the row in step', () => {
  it('republishes the links after a push, so every surface redraws', async () => {
    installFetch()
    await render({ id: 'act-1', title: 'Ship it', external_links: [] })
    await openMenu()
    await act(async () => {
      menuItem('Push to Asana')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      const create = Array.from(container.querySelectorAll('[data-compose-host] button')).find((b) =>
        b.textContent?.trim().startsWith('Create in'),
      )!
      create.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(emitMock).toHaveBeenCalledWith(
      {
        entityType: 'action',
        id: 'act-1',
        fields: { external_links: [ASANA_LINK] },
      },
      { skipSelfMark: true },
    )
  })

  it('republishes after an unlink too', async () => {
    installFetch({ links: [ASANA_LINK] })
    await render({ id: 'act-1', title: 'Ship it', external_links: [{ provider: 'asana' }] })
    await openMenu()
    await act(async () => {
      menuItem('Unlink')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(emitMock).toHaveBeenCalledWith(
      {
        entityType: 'action',
        id: 'act-1',
        fields: { external_links: [] },
      },
      { skipSelfMark: true },
    )
  })

  it('never republishes a DUPLICATE provider', async () => {
    // UNIQUE is (action_id, provider), so a push against an action the row
    // payload already lists — the 409-adopt path, and the race two open tabs
    // produce — must republish the SAME one provider rather than two Asanas.
    //
    // The row payload says asana; the fetched rows (empty here) say otherwise,
    // which is precisely the disagreement this guards: the menu offers the push
    // from what it read, and the republish folds into what the row already has.
    installFetch({ links: [] })
    await render({ id: 'act-1', title: 'Ship it', external_links: [{ provider: 'asana' }] })
    await openMenu()
    await act(async () => {
      menuItem('Push to Asana')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      const create = Array.from(container.querySelectorAll('[data-compose-host] button')).find((b) =>
        b.textContent?.trim().startsWith('Create in'),
      )!
      create.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(emitMock).toHaveBeenCalledWith(
      {
        entityType: 'action',
        id: 'act-1',
        fields: { external_links: [ASANA_LINK] },
      },
      { skipSelfMark: true },
    )
  })
})

/**
 * NEW (the inline-compose rework): the cell hands the form to the SURFACE.
 *
 * This is what makes one component serve a list row (which has a property strip
 * to swap) and a board card (which has no room and routes to the detail panel
 * instead) without either behaviour being hard-coded into the cell.
 */
describe('ActionPlatformCell — who draws the compose form', () => {
  async function renderWith(props: Record<string, unknown>) {
    await act(async () => {
      root.render(
        h(ActionPlatformCell, {
          item: { id: 'act-1', title: 'Ship it', external_links: [] },
          ...props,
        }),
      )
    })
  }

  it('hands the form UP rather than drawing it in its own 30px slot', async () => {
    installFetch()
    const seen: unknown[] = []
    await renderWith({
      onCompose: (node: React.ReactNode) => {
        seen.push(node)
        return h('div', { 'data-surface-host': '' }, node)
      },
    })
    await openMenu()
    await act(async () => {
      menuItem('Push to Asana')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(seen.length).toBeGreaterThan(0)
    // It landed in the SURFACE's box, which is the only place it can be
    // full-width.
    expect(container.querySelector('[data-surface-host] [data-compose-surface]')).toBeTruthy()
  })

  it('tells the surface which provider, so a board card can route elsewhere', async () => {
    installFetch()
    const starts: (string | null)[] = []
    // NO `onCompose` — exactly how the board card mounts it, because a card
    // cannot host a strip (see compose-request-events.ts).
    await renderWith({ onComposeStart: (p: string | null) => starts.push(p) })
    await openMenu()
    await act(async () => {
      menuItem('Push to Asana')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(starts).toEqual(['asana'])
    // And nothing was drawn: the card's own line is untouched.
    expect(container.querySelector('[data-compose-surface]')).toBeNull()
  })

  it('draws NOTHING for a surface that offers no host at all', async () => {
    // The honest degradation. A form dropped at the end of a dropdown would be
    // the pop-up this rework removed, wearing a different hat.
    installFetch()
    await renderWith({})
    await openMenu()
    await act(async () => {
      menuItem('Push to Asana')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[data-compose-surface]')).toBeNull()
  })

  it('reports the END of compose mode too, so the row can restore its chips', async () => {
    installFetch()
    const starts: (string | null)[] = []
    await renderWith({
      onCompose: (node: React.ReactNode) => node,
      onComposeStart: (p: string | null) => starts.push(p),
    })
    await openMenu()
    await act(async () => {
      menuItem('Push to Asana')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const cancel = container.querySelector(
      '[aria-label="Cancel push to Asana"]',
    ) as HTMLButtonElement
    await act(async () => {
      cancel.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(starts).toEqual(['asana', null])
    expect(container.querySelector('[data-compose-surface]')).toBeNull()
  })
})
