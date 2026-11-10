// @vitest-environment jsdom
/**
 * PushToTrackerMenu — the single "Push to…" surface that replaced the action
 * panel's per-provider Asana section.
 *
 * What's actually load-bearing here (and invisible from the component's own
 * state) is the REQUEST SEQUENCE and the honesty of the toast that follows it:
 *
 *  - A destination row is data, not a branch: routes are derived from
 *    `destination.provider`, so the push/unlink URLs are asserted literally.
 *  - "Connected but unconfigured" must stay VISIBLE and disabled — collapsing it
 *    into the zero-state would tell a workspace with Asana wired up to go
 *    connect Asana.
 *  - A suggested row's push is TWO calls (confirm, then push). Each of the three
 *    outcomes tells a different, true story: both worked / the confirm failed
 *    (never claim a push) / the confirm worked and the push didn't (never claim
 *    the action wasn't created).
 *
 * PICKING A DESTINATION OPENS INLINE COMPOSE, and Create is what pushes.
 * `pushTo()` below performs both halves of the gesture, and every assertion
 * downstream of it — the routes, the toasts, the confirm-then-push ordering, the
 * 409 adoption — is unchanged, because everything after Create is the same code
 * it always was. The tests that assert a push does NOT happen are the
 * interesting ones: they prove the click composes instead.
 *
 * RE-TARGETED FROM THE DIALOG (the inline-compose rework). The menu no longer
 * DRAWS the compose form — only the surface knows where its own property view
 * is, so the menu hands the form up through `renderCompose` and the surface
 * places it. Mechanically that means two things here: the harness supplies a
 * `renderCompose` host, and every `[data-dialog]` probe became `composeIsOpen()`
 * against that host. No claim in this file changed.
 *
 * Radix's DropdownMenu can't be driven in jsdom (pointer-capture APIs it doesn't
 * implement), so it's replaced with plain elements that preserve the contract
 * the component relies on: controlled open state, `onSelect`, and `disabled`.
 * The compose form's Selects get the same treatment for the same reason.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-1' }))

// The real cachedJson is a module-level SWR cache — the first test's
// destinations would be served to every later test in this file.
vi.mock('@/lib/cached-fetch', () => ({
  cachedJson: async (url: string) => {
    const res = await fetch(url)
    return res.ok ? res.json() : null
  },
}))

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

// The compose form's Selects. Radix's needs ResizeObserver, which jsdom has no
// implementation of. (There is no Dialog mock any more — the compose Dialog is
// gone; the form renders inline into whatever the surface gives it.)
vi.mock('@/components/ui/select', async () => {
  const { createElement: e } = await import('react')
  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value?: string
      onValueChange?: (v: string) => void
      children?: React.ReactNode
    }) =>
      e(
        'select',
        {
          value: value ?? '',
          onChange: (ev: { target: { value: string } }) => onValueChange?.(ev.target.value),
        },
        children,
      ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children?: React.ReactNode }) => e('optgroup', {}, children),
    SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) =>
      e('option', { value }, children),
  }
})

import { PushToTrackerMenu, type ExternalTaskLink } from '../push-to-tracker-menu'

// ---- fixtures --------------------------------------------------------------

const ASANA_CONFIGURED = {
  provider: 'asana',
  name: 'Asana',
  configured: true,
  destinationLabel: 'Engineering',
}
const ASANA_UNCONFIGURED = {
  provider: 'asana',
  name: 'Asana',
  configured: false,
  destinationLabel: null,
}

const JIRA_CONFIGURED = {
  provider: 'jira',
  name: 'Jira',
  configured: true,
  destinationLabel: 'Engineering',
}
const JIRA_UNCONFIGURED = {
  provider: 'jira',
  name: 'Jira',
  configured: false,
  destinationLabel: null,
}

const LINK: ExternalTaskLink = {
  id: 'link-1',
  provider: 'asana',
  external_id: 'gid-1',
  external_url: 'https://app.asana.com/0/1/2',
  external_title: 'Ship the thing',
  completed: false,
}

const JIRA_LINK: ExternalTaskLink = {
  id: 'link-2',
  provider: 'jira',
  external_id: '99001',
  external_url: 'https://acme.atlassian.net/browse/ENG-7',
  external_title: 'Ship the thing',
  completed: false,
}

const LINEAR_CONFIGURED = {
  provider: 'linear',
  name: 'Linear',
  configured: true,
  destinationLabel: 'Engineering',
}

const LINEAR_LINK: ExternalTaskLink = {
  id: 'link-3',
  provider: 'linear',
  // A UUID, not a sequence: Linear's `issue.id` is what the link row stores,
  // because the display `identifier` (ENG-7) changes when an issue moves teams.
  external_id: '3f1c0f1e-0b1a-4a0e-9c2f-2a5f7b8d1234',
  external_url: 'https://linear.app/acme/issue/ENG-7',
  external_title: 'Ship the thing',
  completed: false,
}

interface FetchConfig {
  destinations?: unknown[]
  links?: ExternalTaskLink[]
  /** Response for POST /api/account/actions/:id/:provider */
  push?: { ok: boolean; status: number; body: Record<string, unknown> }
  unlinkOk?: boolean
}

let calls: Array<{ url: string; method: string }> = []

/**
 * The compose panel's own reads, answered generically.
 *
 * Deliberately minimal: this file is about the MENU, and the panel has its own
 * suite next door (push-compose-panel.test.tsx) that pins which fields it draws
 * and what it sends. All that matters here is that the panel can open on a
 * complete config, so Create is available and the push underneath it can be
 * asserted.
 */
const COMPOSE_CONFIG: Record<string, Record<string, unknown>> = {
  asana: { asana_workspace_gid: 'ws-gid', project_gid: 'proj-1' },
  jira: { cloud_id: 'cloud-1', project_id: '10001', project_key: 'ENG', issue_type_id: '10100' },
  linear: { team_id: 'team-1' },
}

function composeResponse(url: string): Record<string, unknown> | null {
  const settings = url.match(/\/workspace\/(\w+)-settings/)
  if (settings) return { connected: true, config: COMPOSE_CONFIG[settings[1]] ?? {} }
  if (url.includes('/jira/projects')) {
    return { projects: [{ id: '10001', key: 'ENG', name: 'Engineering' }] }
  }
  if (url.includes('/jira/issue-types')) return { issueTypes: [{ id: '10100', name: 'Task' }] }
  if (url.includes('/jira/compose-meta')) {
    return {
      meta: {
        has_due_date: false,
        due_date_required: false,
        has_labels: false,
        labels_required: false,
        has_assignee: false,
        assignee_required: false,
        has_priority: false,
        priority_required: false,
        priorities: [],
        custom_fields: [],
        blocking_fields: [],
      },
      native_create_url: null,
      cached: false,
    }
  }
  if (url.includes('/jira/assignable-users')) return { users: [] }
  if (url.includes('/asana/projects')) return { projects: [{ gid: 'proj-1', name: 'Engineering' }] }
  if (url.includes('/asana/sections')) return { sections: [] }
  if (url.includes('/asana/users')) return { users: [] }
  if (url.includes('/linear/teams')) {
    return { teams: [{ id: 'team-1', key: 'ENG', name: 'Engineering' }] }
  }
  if (url.includes('/linear/projects')) return { projects: [] }
  if (url.includes('/linear/members')) return { members: [] }
  if (url.includes('/linear/labels')) return { labels: [] }
  return null
}

function installFetch(cfg: FetchConfig = {}) {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method })

      if (url.startsWith('/api/account/task-destinations')) {
        return { ok: true, status: 200, json: async () => ({ destinations: cfg.destinations ?? [] }) }
      }
      const compose = method === 'GET' ? composeResponse(url) : null
      if (compose) return { ok: true, status: 200, json: async () => compose }
      if (method === 'POST') {
        const push = cfg.push ?? { ok: true, status: 201, body: { task: LINK } }
        return { ok: push.ok, status: push.status, json: async () => push.body }
      }
      if (method === 'DELETE') {
        const ok = cfg.unlinkOk ?? true
        return { ok, status: ok ? 200 : 500, json: async () => ({ success: ok }) }
      }
      // GET links — one request PER link provider, so answer each with only the
      // rows belonging to that provider (the component flattens them together,
      // and a fake that echoed every row to every provider would hide a
      // cross-provider mix-up rather than expose it).
      const provider = url.split('/').pop()
      return {
        ok: true,
        status: 200,
        json: async () => ({ tasks: (cfg.links ?? []).filter((l) => l.provider === provider) }),
      }
    }),
  )
}

let container: HTMLDivElement
let root: Root

/** Every rendered menu item (the menu must be open). */
function items(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('[data-menu-content] [data-menu-item]'))
}

function itemByText(text: string): HTMLButtonElement | undefined {
  return items().find((b) => b.textContent?.includes(text))
}

/** The menu's trigger button (the only button outside the menu content). */
function trigger(): HTMLButtonElement {
  return container.querySelector('button') as HTMLButtonElement
}

async function openMenu() {
  await act(async () => {
    trigger().dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/**
 * Mount the menu the way a SURFACE does — with a `renderCompose` that draws the
 * form inline.
 *
 * RE-TARGET NOTE (the inline-compose rework): the menu used to render the
 * compose Dialog itself, so a bare mount was enough. It no longer draws the form
 * at all — the surface does, because only the surface knows where its own
 * property view is (see the menu's `renderCompose` doc). A default that returned
 * the node is what keeps every push assertion below unchanged; the tests that
 * care WHERE it lands pass their own.
 */
async function render(props: Parameters<typeof PushToTrackerMenu>[0] = {}) {
  await act(async () => {
    // Every mount gets a title by default: the compose form refuses to Create
    // without one (an untitled issue is not a thing anyone wants), and these
    // tests are about what happens AFTER Create.
    root.render(
      h(PushToTrackerMenu, {
        actionTitle: 'Ship the thing',
        renderCompose: (node: React.ReactNode) => h('div', { 'data-compose-host': '' }, node),
        ...props,
      }),
    )
  })
}

/**
 * The compose form's Create button, once a destination has been picked.
 *
 * RE-TARGETED: scoped to the surface's compose host rather than `[data-dialog]`,
 * which no longer exists. Same button, same meaning.
 */
function createButton(): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('[data-compose-host] button')).find((b) =>
    b.textContent?.trim().startsWith('Create in'),
  ) as HTMLButtonElement | undefined
}

/** Is the compose form up? Replaces the old `[data-dialog]` presence check. */
function composeIsOpen(): boolean {
  return !!container.querySelector('[data-compose-host] [data-compose-surface]')
}

/**
 * The whole gesture: pick a destination, then Create in the form that opens.
 *
 * Both halves, because a push is now both halves. Callers that want to prove
 * only the FIRST half happened (the click composes rather than pushes) do the
 * menu-item click inline instead.
 */
async function pushTo(destinationName: string) {
  await act(async () => {
    itemByText(`Push to ${destinationName}`)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    createButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
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

// ---- destinations ----------------------------------------------------------

describe('PushToTrackerMenu — destinations', () => {
  it('renders a configured destination with its project as the subtitle', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED] })
    await render({ actionId: 'act-1' })
    await openMenu()

    const push = itemByText('Push to Asana')
    expect(push).toBeTruthy()
    expect(push!.textContent).toContain('Engineering')
    expect(push!.getAttribute('data-disabled')).toBeNull()
  })

  it('renders a CONNECTED-but-unconfigured destination disabled, pointing at Settings', async () => {
    // Not the zero-state: Asana IS connected, it just has nowhere to push.
    installFetch({ destinations: [ASANA_UNCONFIGURED] })
    await render({ actionId: 'act-1' })
    await openMenu()

    const push = itemByText('Push to Asana')
    expect(push!.getAttribute('data-disabled')).toBe('true')
    expect(push!.textContent).toContain('Pick a project in Settings')
  })

  it('a disabled destination cannot even be composed for', async () => {
    // Stronger than it used to be: the click doesn't push AND doesn't open the
    // panel, so there is no form to fill in for a destination that has nowhere
    // to land.
    installFetch({ destinations: [ASANA_UNCONFIGURED] })
    await render({ actionId: 'act-1' })
    await openMenu()
    await act(async () => {
      itemByText('Push to Asana')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(composeIsOpen()).toBe(false)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('offers a Connect CTA when NOTHING is connected', async () => {
    installFetch({ destinations: [] })
    const onOpenSettings = vi.fn()
    await render({ actionId: 'act-1', onOpenSettings })
    await openMenu()

    expect(itemByText('Push to Asana')).toBeUndefined()
    const connect = itemByText('Connect a task app…')
    expect(connect).toBeTruthy()

    await act(async () => {
      connect!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onOpenSettings).toHaveBeenCalledWith('connectors')
  })

  it('fetches destinations only when the menu is opened', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED] })
    await render({ actionId: 'act-1' })
    expect(calls.some((c) => c.url.includes('task-destinations'))).toBe(false)
    await openMenu()
    expect(calls.some((c) => c.url.includes('task-destinations'))).toBe(true)
  })
})

// ---- already-linked --------------------------------------------------------

describe('PushToTrackerMenu — already linked', () => {
  it('swaps Push for Open + Unlink', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED], links: [LINK] })
    await render({ actionId: 'act-1' })
    await openMenu()

    expect(itemByText('Push to Asana')).toBeUndefined()
    expect(itemByText('Open in Asana')).toBeTruthy()
    expect(itemByText('Open in Asana')!.textContent).toContain('Ship the thing')
    expect(itemByText('Unlink')).toBeTruthy()
  })

  it('loads links on mount (so the button shows the linked state unopened)', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED], links: [LINK] })
    await render({ actionId: 'act-1' })
    expect(calls).toContainEqual({ url: '/api/account/actions/act-1/asana', method: 'GET' })
    expect(trigger().getAttribute('aria-label')).toBe('Linked to a task app')
  })

  it('DEFERS the link fetch to first open in compact mode', async () => {
    // A capture can render dozens of item rows; one request each on mount is a
    // burst that buys nothing (compact rows have no unopened linked tint).
    installFetch({ destinations: [ASANA_CONFIGURED], links: [LINK] })
    await render({ actionId: 'act-1', compact: true })
    expect(calls).toHaveLength(0)
    await openMenu()
    expect(calls.some((c) => c.url === '/api/account/actions/act-1/asana')).toBe(true)
  })

  it('unlinks NI-side only and says so', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED], links: [LINK] })
    const onUnlinked = vi.fn()
    await render({ actionId: 'act-1', onUnlinked })
    await openMenu()
    await act(async () => {
      itemByText('Unlink')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(calls).toContainEqual({
      url: '/api/account/actions/act-1/asana/link-1',
      method: 'DELETE',
    })
    // The provider rides along: the row surfaces know an action by its
    // PROVIDERS (a view payload's external_links carries nothing else), so
    // re-deriving it would mean keeping a second copy of the menu's rows.
    expect(onUnlinked).toHaveBeenCalledWith('link-1', { provider: 'asana' })
    expect(toastMock.success).toHaveBeenCalledWith(
      'Unlinked from Asana',
      expect.objectContaining({ description: expect.stringContaining('not deleted') }),
    )
  })

  it('restores the link when the unlink fails', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED], links: [LINK], unlinkOk: false })
    await render({ actionId: 'act-1' })
    await openMenu()
    await act(async () => {
      itemByText('Unlink')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(toastMock.error).toHaveBeenCalledWith('Failed to unlink from Asana')
    expect(itemByText('Open in Asana')).toBeTruthy()
  })
})

// ---- what the trigger claims before anything has been read -----------------

describe('PushToTrackerMenu — unresolved link state', () => {
  it('makes NO link claim on a compact row until the links have resolved', async () => {
    // Deferring the fetch means an empty `links` is "never asked", not "not
    // linked" — and this row IS linked. Saying "Push to…" here would be a
    // confident answer to a question nothing has put yet.
    installFetch({ destinations: [ASANA_CONFIGURED], links: [LINK] })
    await render({ actionId: 'act-1', compact: true })
    expect(trigger().getAttribute('aria-label')).toBe('Task app options')

    await openMenu()
    expect(trigger().getAttribute('aria-label')).toBe('Linked to a task app')
  })

  it('a row with no action yet IS honestly unlinked', async () => {
    // Nothing to be linked to — a suggestion has no action row. That's
    // knowledge, not a guess, so the push affordance names itself.
    installFetch({ destinations: [ASANA_CONFIGURED] })
    await render({ compact: true, onResolveAction: async () => 'new-act-9' })
    expect(trigger().getAttribute('aria-label')).toBe('Push to…')
  })

  it('a controlled caller owns the answer, so there is nothing to resolve', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED] })
    await render({ actionId: 'act-1', links: [] })
    expect(trigger().getAttribute('aria-label')).toBe('Push to…')
    expect(calls.some((c) => c.url === '/api/account/actions/act-1/asana')).toBe(false)
  })

  it('a push resolves the state first-hand — no re-hedge when the id arrives', async () => {
    // The confirm-then-push flow: the row had no actionId, pushed, and only then
    // re-renders with the id the confirm created. We KNOW that action's link —
    // we just made it — so the trigger must not fall back to "unknown".
    installFetch({ destinations: [ASANA_CONFIGURED] })
    await render({ compact: true, onResolveAction: async () => 'new-act-9' })
    await openMenu()
    await pushTo('Asana')

    await render({ compact: true, actionId: 'new-act-9' })
    expect(trigger().getAttribute('aria-label')).toBe('Linked to a task app')
  })
})

// ---- the caller's row is busy ----------------------------------------------

describe('PushToTrackerMenu — disabled', () => {
  it('cannot be opened while the caller has work in flight', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED] })
    await render({ actionId: 'act-1', compact: true, disabled: true })

    expect(trigger().disabled).toBe(true)
    await openMenu()
    expect(items()).toHaveLength(0)
    // Not even the destination list — there is nothing to pick yet.
    expect(calls).toHaveLength(0)
  })
})

// ---- pushing an existing action -------------------------------------------

describe('PushToTrackerMenu — pushing an existing action', () => {
  it('POSTs the provider route and reports success with a View link', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED] })
    const onPushed = vi.fn()
    await render({ actionId: 'act-1', onPushed })
    await openMenu()
    await pushTo('Asana')

    expect(calls).toContainEqual({ url: '/api/account/actions/act-1/asana', method: 'POST' })
    expect(onPushed).toHaveBeenCalledWith(LINK, { created: false })
    expect(toastMock.success).toHaveBeenCalledWith(
      'Pushed to Asana',
      expect.objectContaining({ action: expect.objectContaining({ label: 'View in Asana' }) }),
    )
  })

  it('adopts a 409 already_linked as success rather than an error', async () => {
    // The action IS in Asana, which is what the click asked for.
    installFetch({
      destinations: [ASANA_CONFIGURED],
      push: { ok: false, status: 409, body: { error: 'already linked', code: 'already_linked', task: LINK } },
    })
    await render({ actionId: 'act-1' })
    await openMenu()
    await pushTo('Asana')

    expect(toastMock.error).not.toHaveBeenCalled()
    expect(toastMock.success).toHaveBeenCalledWith('Already linked to Asana', expect.anything())
    // A landed push CLOSES the menu along with the panel, so the adopted link
    // is proved on the re-open rather than in place.
    await openMenu()
    expect(itemByText('Open in Asana')).toBeTruthy()
  })

  it('offers a Settings CTA on a setup-shaped failure', async () => {
    installFetch({
      destinations: [ASANA_CONFIGURED],
      push: { ok: false, status: 400, body: { error: 'Pick an Asana project first', code: 'not_configured' } },
    })
    const onOpenSettings = vi.fn()
    await render({ actionId: 'act-1', onOpenSettings })
    await openMenu()
    await pushTo('Asana')

    expect(toastMock.error).toHaveBeenCalledWith(
      'Pick an Asana project first',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Open settings' }) }),
    )
    toastMock.error.mock.calls[0][1].action.onClick()
    expect(onOpenSettings).toHaveBeenCalledWith('connectors/asana/tasks')
  })

  it('surfaces a plain failure without a Settings CTA', async () => {
    installFetch({
      destinations: [ASANA_CONFIGURED],
      push: { ok: false, status: 500, body: { error: 'Asana is down' } },
    })
    await render({ actionId: 'act-1' })
    await openMenu()
    await pushTo('Asana')
    expect(toastMock.error).toHaveBeenCalledWith('Asana is down', {})
  })
})

// ---- confirm-then-push (a still-suggested row) -----------------------------

describe('PushToTrackerMenu — confirm-then-push', () => {
  it('confirms first, then pushes the action that confirm created', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED] })
    const onResolveAction = vi.fn(async () => 'new-act-9')
    await render({ compact: true, onResolveAction })
    await openMenu()
    await pushTo('Asana')

    expect(onResolveAction).toHaveBeenCalledTimes(1)
    // The push targets the id the confirm returned — never one found by search.
    expect(calls).toContainEqual({ url: '/api/account/actions/new-act-9/asana', method: 'POST' })
    expect(toastMock.success).toHaveBeenCalledWith(
      'Action created and pushed to Asana',
      expect.objectContaining({ action: expect.objectContaining({ label: 'View task' }) }),
    )
  })

  it('does NOT push when the confirm fails', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED] })
    const onResolveAction = vi.fn(async () => null)
    await render({ compact: true, onResolveAction })
    await openMenu()
    await pushTo('Asana')

    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    // The confirm already reported itself; a second failure toast would be a
    // wrong story about the same click.
    expect(toastMock.error).not.toHaveBeenCalled()
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it('says the action WAS created when only the push failed', async () => {
    installFetch({
      destinations: [ASANA_CONFIGURED],
      push: { ok: false, status: 500, body: { error: 'Asana is down' } },
    })
    const onResolveAction = vi.fn(async () => 'new-act-9')
    await render({ compact: true, onResolveAction })
    await openMenu()
    await pushTo('Asana')

    expect(toastMock.success).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledWith(
      'Action created, but the push to Asana failed',
      expect.objectContaining({ description: 'Asana is down' }),
    )
  })

  /**
   * REGRESSION (review finding: "Resolve-succeeds-then-push-throws loses the
   * 'action created' half of the outcome").
   *
   * The honest split toast above only covered a push that came back NOT-OK. A
   * push that THREW — a dropped connection, which is exactly when this gesture
   * is most likely to half-succeed — landed in the outer catch, which toasted a
   * bare "Failed to push to X" and said nothing about the action that had just
   * been confirmed into existence. `created` was declared inside the try, so the
   * catch could not even see it. A user who believes the toast may re-create or
   * re-dismiss a row that is now a real action.
   */
  it('still says the action was created when the push REQUEST throws', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED] })
    // Only the push POST fails, and at the transport level.
    const realFetch = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<unknown>
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') throw new TypeError('Failed to fetch')
      return realFetch(url, init)
    })

    const onResolveAction = vi.fn(async () => 'new-act-9')
    await render({ compact: true, onResolveAction })
    await openMenu()
    await pushTo('Asana')

    expect(onResolveAction).toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledWith(
      'Action created, but the push to Asana failed',
    )
  })

  it('a throw BEFORE anything was created still reports only the push failure', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED] })
    const realFetch = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<unknown>
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') throw new TypeError('Failed to fetch')
      return realFetch(url, init)
    })

    // An action that already exists — nothing was created by this click.
    await render({ actionId: 'act-1' })
    await openMenu()
    await pushTo('Asana')

    expect(toastMock.error).toHaveBeenCalledWith('Failed to push to Asana')
  })
})

// ---- a SECOND provider -----------------------------------------------------

/**
 * The whole point of this component is that "a second tracker is a row in an
 * array, not another section". Jira is the first opportunity to prove that
 * claim rather than assert it — every expectation below is about the component
 * needing NO Jira-specific rendering, routing or copy branch.
 *
 * The two literals that DO name providers (LINK_PROVIDERS and ProviderIcon)
 * exist only to keep the service-role config modules out of the client bundle,
 * and LINK_PROVIDERS is the one that silently breaks if forgotten — a provider
 * missing from it never has its existing links fetched, so the menu offers to
 * push an action that is already linked. That is what the first test here
 * covers.
 */
describe('PushToTrackerMenu — two providers', () => {
  it('FETCHES links for every link provider, not just the first', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED, JIRA_CONFIGURED] })
    await render({ actionId: 'act-1' })

    expect(calls).toContainEqual({ url: '/api/account/actions/act-1/asana', method: 'GET' })
    expect(calls).toContainEqual({ url: '/api/account/actions/act-1/jira', method: 'GET' })
  })

  it('renders both destinations as ordinary rows', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED, JIRA_CONFIGURED] })
    await render({ actionId: 'act-1' })
    await openMenu()

    expect(itemByText('Push to Asana')).toBeTruthy()
    const jira = itemByText('Push to Jira')
    expect(jira).toBeTruthy()
    expect(jira!.textContent).toContain('Engineering')
    expect(jira!.getAttribute('data-disabled')).toBeNull()
  })

  it('derives the Jira push route from the destination row', async () => {
    installFetch({
      destinations: [JIRA_CONFIGURED],
      push: { ok: true, status: 201, body: { task: JIRA_LINK } },
    })
    const onPushed = vi.fn()
    await render({ actionId: 'act-1', onPushed })
    await openMenu()
    await pushTo('Jira')

    expect(calls).toContainEqual({ url: '/api/account/actions/act-1/jira', method: 'POST' })
    // `created` is about the ACTION (the confirm-then-push half), not the link —
    // this action already existed.
    expect(onPushed).toHaveBeenCalledWith(JIRA_LINK, { created: false })
    expect(toastMock.success).toHaveBeenCalledWith(
      'Pushed to Jira',
      expect.objectContaining({ action: expect.objectContaining({ label: 'View in Jira' }) }),
    )
  })

  it('keeps the two providers INDEPENDENT: linked in Jira, still pushable to Asana', async () => {
    // One action legitimately holds one link per provider — UNIQUE is
    // (action_id, provider), not (action_id).
    installFetch({ destinations: [ASANA_CONFIGURED, JIRA_CONFIGURED], links: [JIRA_LINK] })
    await render({ actionId: 'act-1' })
    await openMenu()

    expect(itemByText('Open in Jira')).toBeTruthy()
    expect(itemByText('Push to Jira')).toBeUndefined()
    expect(itemByText('Push to Asana')).toBeTruthy()
    expect(itemByText('Open in Asana')).toBeUndefined()
  })

  it('unlinks the Jira link through the Jira route only', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED, JIRA_CONFIGURED], links: [LINK, JIRA_LINK] })
    await render({ actionId: 'act-1' })
    await openMenu()

    const unlinks = items().filter((b) => b.textContent?.includes('Unlink'))
    expect(unlinks).toHaveLength(2)
    await act(async () => {
      unlinks[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(calls).toContainEqual({
      url: '/api/account/actions/act-1/jira/link-2',
      method: 'DELETE',
    })
    expect(toastMock.success).toHaveBeenCalledWith('Unlinked from Jira', expect.anything())
  })

  it('routes a Jira setup failure to the JIRA settings page', async () => {
    installFetch({
      destinations: [JIRA_CONFIGURED],
      push: {
        ok: false,
        status: 400,
        body: { error: 'Pick a Jira project and issue type first', code: 'not_configured' },
      },
    })
    const onOpenSettings = vi.fn()
    await render({ actionId: 'act-1', onOpenSettings })
    await openMenu()
    await pushTo('Jira')

    toastMock.error.mock.calls[0][1].action.onClick()
    expect(onOpenSettings).toHaveBeenCalledWith('connectors/jira/tasks')
  })

  it('renders a connected-but-unconfigured Jira disabled, exactly like Asana', async () => {
    installFetch({ destinations: [JIRA_UNCONFIGURED] })
    await render({ actionId: 'act-1' })
    await openMenu()

    const push = itemByText('Push to Jira')
    expect(push!.getAttribute('data-disabled')).toBe('true')
    expect(push!.textContent).toContain('Pick a project in Settings')
  })
})

// ---- a THIRD provider ------------------------------------------------------

/**
 * Linear, added with no rendering, routing or copy branch of its own — which is
 * what "a second tracker is a row in an array" was supposed to mean, now tested
 * at three.
 *
 * The one thing that CAN silently break is LINK_PROVIDERS: a provider missing
 * from it never has its existing links fetched, so the menu offers to push an
 * action that is already in Linear — minting a duplicate issue. That is the
 * first test below, and it is the reason the literal is worth a test at all.
 */
describe('PushToTrackerMenu — three providers', () => {
  it('FETCHES links for Linear too (the LINK_PROVIDERS tripwire)', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED, JIRA_CONFIGURED, LINEAR_CONFIGURED] })
    await render({ actionId: 'act-1' })

    expect(calls).toContainEqual({ url: '/api/account/actions/act-1/linear', method: 'GET' })
  })

  it('renders Linear as an ordinary row', async () => {
    installFetch({ destinations: [LINEAR_CONFIGURED] })
    await render({ actionId: 'act-1' })
    await openMenu()

    const linear = itemByText('Push to Linear')
    expect(linear).toBeTruthy()
    expect(linear!.textContent).toContain('Engineering')
    expect(linear!.getAttribute('data-disabled')).toBeNull()
  })

  it('derives the Linear push route from the destination row', async () => {
    installFetch({
      destinations: [LINEAR_CONFIGURED],
      push: { ok: true, status: 201, body: { task: LINEAR_LINK } },
    })
    const onPushed = vi.fn()
    await render({ actionId: 'act-1', onPushed })
    await openMenu()
    await pushTo('Linear')

    expect(calls).toContainEqual({ url: '/api/account/actions/act-1/linear', method: 'POST' })
    expect(onPushed).toHaveBeenCalledWith(LINEAR_LINK, { created: false })
    expect(toastMock.success).toHaveBeenCalledWith(
      'Pushed to Linear',
      expect.objectContaining({ action: expect.objectContaining({ label: 'View in Linear' }) }),
    )
  })

  it('unlinks the Linear link through the Linear route only', async () => {
    installFetch({ destinations: [LINEAR_CONFIGURED], links: [LINEAR_LINK] })
    await render({ actionId: 'act-1' })
    await openMenu()

    const unlink = items().find((b) => b.textContent?.includes('Unlink'))!
    await act(async () => {
      unlink.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(calls).toContainEqual({
      url: '/api/account/actions/act-1/linear/link-3',
      method: 'DELETE',
    })
    expect(toastMock.success).toHaveBeenCalledWith('Unlinked from Linear', expect.anything())
  })

  it('routes a Linear setup failure to the LINEAR settings page', async () => {
    installFetch({
      destinations: [LINEAR_CONFIGURED],
      push: {
        ok: false,
        status: 400,
        body: { error: 'Pick a Linear team first', code: 'not_configured' },
      },
    })
    const onOpenSettings = vi.fn()
    await render({ actionId: 'act-1', onOpenSettings })
    await openMenu()
    await pushTo('Linear')

    toastMock.error.mock.calls[0][1].action.onClick()
    expect(onOpenSettings).toHaveBeenCalledWith('connectors/linear/tasks')
  })

  it('keeps all THREE independent: linked in Linear, still pushable to the others', async () => {
    installFetch({
      destinations: [ASANA_CONFIGURED, JIRA_CONFIGURED, LINEAR_CONFIGURED],
      links: [LINEAR_LINK],
    })
    await render({ actionId: 'act-1' })
    await openMenu()

    expect(itemByText('Open in Linear')).toBeTruthy()
    expect(itemByText('Push to Linear')).toBeUndefined()
    expect(itemByText('Push to Asana')).toBeTruthy()
    expect(itemByText('Push to Jira')).toBeTruthy()
  })
})

// ---- the compose step ------------------------------------------------------

/**
 * The behaviour this menu gained: a destination is COMPOSED for, not pushed to.
 *
 * The claim worth defending is compatibility. The old gesture went to whatever
 * Settings said, and the new one must still do exactly that when nobody touches
 * a field — same route, same NO BODY AT ALL, same everything downstream. What
 * the second click buys is the option to differ, and an override body appears
 * only when the user actually did.
 *
 * The LINKED half of the menu is deliberately not part of this: Open-in and
 * Unlink have nothing to compose and still act on the click.
 */
describe('PushToTrackerMenu — compose before push', () => {
  it('picking a destination OPENS INLINE COMPOSE rather than pushing', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED] })
    await render({ actionId: 'act-1' })
    await openMenu()
    await act(async () => {
      itemByText('Push to Asana')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(composeIsOpen()).toBe(true)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('a ROUTING surface is told, but never enters compose mode itself', async () => {
    // The board card: no `renderCompose`, because it has nowhere to draw the
    // form (it hands the pick to the detail panel instead).
    //
    // Entering the mode anyway left this menu holding `composing` it could never
    // show OR clear — there is no rendered form, so no cancel and no create can
    // ever end it. The user is looking at the detail panel; the card's menu is
    // stuck. Worse, the next pick of the SAME provider is a no-op setState, so
    // the surface never hears the transition and the second click does nothing.
    const onComposeChange = vi.fn()
    installFetch({ destinations: [ASANA_CONFIGURED] })
    // NO `renderCompose` — that absence is what makes this a routing surface.
    await render({ actionId: 'act-1', onComposeChange, renderCompose: undefined })
    await openMenu()
    await act(async () => {
      itemByText('Push to Asana')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Announced — that is the hand-off, and the only thing this surface needs.
    expect(onComposeChange).toHaveBeenCalledTimes(1)
    expect(onComposeChange.mock.calls[0][0]).toMatchObject({ provider: 'asana' })
    // …and nothing was drawn, here or anywhere.
    expect(composeIsOpen()).toBe(false)
  })

  it('a routing surface can pick the SAME provider TWICE', async () => {
    // A board card that routes to the detail panel and comes back is the
    // ordinary flow, and re-picking the same destination must route again.
    //
    // HONEST SCOPE: `onComposeChange` fires on every pick regardless of the
    // guard (the announcement is unconditional in `changeCompose`), so this
    // does NOT discriminate the stuck-state fix on its own — it pins the
    // repeat-pick contract that the fix must not break. What the guard actually
    // prevents is dead internal STATE, asserted directly below.
    const onComposeChange = vi.fn()
    installFetch({ destinations: [ASANA_CONFIGURED] })
    await render({ actionId: 'act-1', onComposeChange, renderCompose: undefined })

    for (const _ of [0, 1]) {
      // `openMenu` TOGGLES, and a routing surface's pick does not close the
      // menu — so reopen only when the items are actually gone.
      if (!itemByText('Push to Asana')) await openMenu()
      await act(async () => {
        itemByText('Push to Asana')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    }

    expect(onComposeChange).toHaveBeenCalledTimes(2)
    expect(onComposeChange.mock.calls[1][0]).toMatchObject({ provider: 'asana' })
  })

  it('a routing surface never LATCHES into compose mode', async () => {
    // The stuck state itself, read through the one place `composing` is
    // externally observable on a surface that draws nothing: `renderCompose` is
    // consulted only while the menu believes it is composing.
    //
    // Nothing can ever clear that belief here — there is no rendered form, so
    // no cancel and no Create exist to call `changeCompose(null)`. Passing a
    // spy that RECORDS but returns null separates "the menu tried to place a
    // form" from "a form appeared", which is what the guard is about.
    const renderCompose = vi.fn(() => null)
    installFetch({ destinations: [ASANA_CONFIGURED] })
    await render({ actionId: 'act-1', renderCompose })
    await openMenu()
    await act(async () => {
      itemByText('Push to Asana')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // A DRAWING surface (one that supplies renderCompose) does enter the mode —
    // the control case, proving the probe below detects entry when it happens.
    expect(renderCompose).toHaveBeenCalled()

    // Now the ROUTING surface: same gesture, no renderCompose at mount. Re-mount
    // rather than re-render, because `composing` is what we are asserting about
    // and a re-render would carry it over.
    const laterRenderCompose = vi.fn(() => null)
    await act(async () => {
      root.unmount()
    })
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    installFetch({ destinations: [ASANA_CONFIGURED] })
    await render({ actionId: 'act-1', renderCompose: undefined })
    await openMenu()
    await act(async () => {
      itemByText('Push to Asana')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Hand it a placer AFTER the pick. If the menu had latched into compose
    // mode, this re-render would immediately try to place the form it has been
    // holding — the stuck state, made visible. It must not.
    await act(async () => {
      root.render(
        h(PushToTrackerMenu, {
          actionId: 'act-1',
          actionTitle: 'Ship the thing',
          renderCompose: laterRenderCompose,
        }),
      )
    })
    expect(laterRenderCompose).not.toHaveBeenCalled()
  })

  it('the form is named for the destination that opened it', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED, JIRA_CONFIGURED] })
    await render({ actionId: 'act-1' })
    await openMenu()
    await act(async () => {
      itemByText('Push to Jira')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[data-compose-host]')!.textContent).toContain('Create in Jira')
  })

  it('CREATE WITH NOTHING CHANGED SENDS NO BODY — the old one-click push exactly', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED] })
    await render({ actionId: 'act-1' })
    await openMenu()
    await pushTo('Asana')

    const post = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock
      .calls.find(([, init]) => init?.method === 'POST')
    expect(post![0]).toBe('/api/account/actions/act-1/asana')
    // Not `{}`, not `{ overrides: {} }` — ABSENT. The route folds all three to
    // the same behaviour, but only absence is byte-identical to the request the
    // one-click push used to make.
    expect(post![1]!.body).toBeUndefined()
  })

  /**
   * RE-TARGETED: driven through the DUE DATE instead of the title.
   *
   * This test's claim is about the MENU — that a form with a real change sends
   * an `overrides` body, the counterpart to the "nothing changed sends no body"
   * test above it. It happened to demonstrate that with the strip's title
   * input, which no longer exists: the card renders the title, so compose
   * stopped offering a second editable copy of it and `buildOverrides` never
   * produces `overrides.title` from this form.
   *
   * The due date is the equivalent free choice that needs no option list (the
   * fixture returns empty sections and users), so it can carry the same claim
   * unchanged. The date is picked through Native Intelligence's own calendar, which is what
   * the strip now renders in place of an `<input type="date">`.
   */
  it('sends an override body once a field is actually changed', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED] })
    await render({ actionId: 'act-1' })
    await openMenu()
    await act(async () => {
      itemByText('Push to Asana')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Open the date chip's calendar and take whatever day it lands on, then
    // assert the body carries exactly that day — the point is that A change
    // travels, not which one.
    const dateTrigger = container
      .querySelector('[data-compose-date="Due date"]')!
      .querySelector('button')!
    await act(async () => {
      dateTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const cell = Array.from(document.querySelectorAll('button')).find((b) =>
      /^(Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day, /.test(b.getAttribute('aria-label') ?? ''),
    )!
    const picked = cell.getAttribute('aria-label')!
    await act(async () => {
      cell.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await act(async () => {
      createButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const post = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock
      .calls.find(([, init]) => init?.method === 'POST')
    const body = JSON.parse(post![1]!.body as string)
    expect(Object.keys(body)).toEqual(['overrides'])
    expect(Object.keys(body.overrides)).toEqual(['due_on'])
    // The wire value is the LOCAL calendar date the user clicked — the same
    // `YYYY-MM-DD` bytes the native input used to produce.
    const [, monthName, day, year] = /(\w+) (\d+)(?:st|nd|rd|th), (\d{4})/.exec(picked)!
    const month = new Date(`${monthName} 1, ${year}`).getMonth() + 1
    expect(body.overrides.due_on).toBe(
      `${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`,
    )
  })

  it('an ALREADY-LINKED provider still acts on the click — nothing to compose', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED], links: [LINK] })
    await render({ actionId: 'act-1' })
    await openMenu()
    await act(async () => {
      itemByText('Unlink')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(composeIsOpen()).toBe(false)
    expect(calls).toContainEqual({
      url: '/api/account/actions/act-1/asana/link-1',
      method: 'DELETE',
    })
  })

  it('a SUGGESTED row still confirms first — compose does not change the ordering', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED] })
    const onResolveAction = vi.fn(async () => 'new-act-9')
    await render({ compact: true, onResolveAction })
    await openMenu()

    // Entering compose must NOT confirm anything: a user who opens the form and
    // changes their mind has not accepted the suggestion.
    await act(async () => {
      itemByText('Push to Asana')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onResolveAction).not.toHaveBeenCalled()

    await act(async () => {
      createButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onResolveAction).toHaveBeenCalledTimes(1)
    expect(calls).toContainEqual({ url: '/api/account/actions/new-act-9/asana', method: 'POST' })
  })

  it('a failed push leaves compose UP so one field can be fixed', async () => {
    installFetch({
      destinations: [ASANA_CONFIGURED],
      push: { ok: false, status: 500, body: { error: 'Asana is down' } },
    })
    await render({ actionId: 'act-1' })
    await openMenu()
    await pushTo('Asana')

    expect(toastMock.error).toHaveBeenCalledWith('Asana is down', {})
    expect(composeIsOpen()).toBe(true)
  })

  it('a landed push ends compose mode AND closes the menu', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED] })
    await render({ actionId: 'act-1' })
    await openMenu()
    await pushTo('Asana')

    expect(composeIsOpen()).toBe(false)
    expect(container.querySelector('[data-menu-content]')).toBeNull()
  })
})

// ---- the caller's own trigger ----------------------------------------------

/**
 * `renderTrigger` is how the row surfaces mount their far-left platform mark as
 * the thing that opens this menu. It is a render PROP rather than `children`
 * because the trigger needs state only the menu has — `linksKnown` above all,
 * which is the difference between "this action is in nothing" and "nobody has
 * looked yet".
 */
describe('PushToTrackerMenu — a caller-supplied trigger', () => {
  it('replaces the default button and is handed the menu’s own link state', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED], links: [LINK] })
    const seen: Array<{ linksKnown: boolean; count: number }> = []
    await render({
      actionId: 'act-1',
      renderTrigger: ({ links, linksKnown }) => {
        seen.push({ linksKnown, count: links.length })
        return h('button', { type: 'button', 'data-custom-trigger': '' }, 'mark')
      },
    })

    expect(container.querySelector('[data-custom-trigger]')).toBeTruthy()
    // The default trigger is gone, not merely hidden.
    expect(trigger().getAttribute('aria-label')).toBeNull()
    expect(seen[seen.length - 1]).toEqual({ linksKnown: true, count: 1 })
  })

  it('reports linksKnown=false on a compact row that has never asked', async () => {
    // The row payload said nothing and the menu has not opened — an icon that
    // drew "Native Intelligence only" here would be answering a question nobody put.
    installFetch({ destinations: [ASANA_CONFIGURED], links: [LINK] })
    const seen: boolean[] = []
    await render({
      actionId: 'act-1',
      compact: true,
      renderTrigger: ({ linksKnown }) => {
        seen.push(linksKnown)
        return h('button', { type: 'button', 'data-custom-trigger': '' }, 'mark')
      },
    })
    expect(seen[0]).toBe(false)

    await openMenu()
    expect(seen[seen.length - 1]).toBe(true)
  })
})

/**
 * REGRESSION (review finding: "Jira: explicitly overridden due_date/labels can
 * be silently stripped … with success reported").
 *
 * The push keeps the issue rather than failing over a field the create screen
 * refuses — a deliberate trade. But a clean success chip over an issue missing
 * the due date the user typed is the toast telling a second, wrong story, which
 * is exactly what this component's confirm-then-push copy is careful never to
 * do. The server now reports what it gave up; this is where the user reads it.
 */
describe('PushToTrackerMenu — a push that lost something still says so', () => {
  it('describes the dropped fields under a success toast', async () => {
    installFetch({
      destinations: [JIRA_CONFIGURED],
      push: {
        ok: true,
        status: 201,
        body: { task: JIRA_LINK, dropped_fields: ['duedate'] },
      },
    })
    await render({ actionId: 'act-1' })
    await openMenu()
    await pushTo('Jira')

    expect(toastMock.success).toHaveBeenCalledWith(
      'Pushed to Jira',
      expect.objectContaining({
        description: expect.stringContaining('duedate'),
      }),
    )
  })

  it('describes an assignee that never landed', async () => {
    installFetch({
      destinations: [JIRA_CONFIGURED],
      push: { ok: true, status: 201, body: { task: JIRA_LINK, assignee_set: false } },
    })
    await render({ actionId: 'act-1' })
    await openMenu()
    await pushTo('Jira')

    expect(toastMock.success).toHaveBeenCalledWith(
      'Pushed to Jira',
      expect.objectContaining({
        description: expect.stringContaining('assignee'),
      }),
    )
  })

  it('an ordinary push carries NO description', async () => {
    installFetch({
      destinations: [JIRA_CONFIGURED],
      push: { ok: true, status: 201, body: { task: JIRA_LINK } },
    })
    await render({ actionId: 'act-1' })
    await openMenu()
    await pushTo('Jira')

    const [, options] = toastMock.success.mock.calls.at(-1)!
    expect(options).not.toHaveProperty('description')
  })
})

// ---- the entity-bus republish ----------------------------------------------

/**
 * REGRESSION (review finding: "Pushes/unlinks from the detail panel and capture
 * proposal rows never update the row icons").
 *
 * `external_links` is a JOIN with no realtime channel, so the ONLY thing that
 * repairs a row's platform icon is an entity-bus event. That event used to be
 * emitted by ActionPlatformCell's onPushed/onUnlinked wiring — which exists on
 * exactly one of the menu's four mount sites. The detail-panel toolbar (the
 * original, primary push surface) and the capture proposal card pass neither
 * callback, so a push made there left every list row and board card showing the
 * Native Intelligence mark for an action that is now in Jira.
 *
 * The emit therefore belongs to the MENU, the one place that holds the full
 * post-mutation link set: a caller-side callback cannot compute it (the detail
 * panel never holds the link rows at all, and emitting only the pushed provider
 * would clobber the action's others). These tests mount with NO callbacks —
 * the detail-panel/proposal-card shape — and assert on the real window event.
 *
 * THE PAYLOAD IS THE FULL LINK ROWS, asserted with toEqual so a re-thinning
 * cannot sneak back. The menu used to project `{ provider }` stubs, which was
 * fine while row icons were the only reader — but the detail panel's listener
 * spreads these fields into the shared ACTION CACHE, and the panel seeds its
 * controlled menu from that cache on mount/swap. A stub there is taken as the
 * truth while missing `id`/`external_url`: "Open in …" renders disabled and
 * Unlink fires DELETE `/{provider}/undefined`. Row surfaces read only
 * `.provider`, so the richer rows are backward compatible.
 */
describe('PushToTrackerMenu — republishes external_links on the entity bus', () => {
  type BusDetail = {
    entityType: string
    id: string
    fields: { external_links?: ExternalTaskLink[] }
  }

  let seen: BusDetail[]
  let listener: (e: Event) => void

  beforeEach(() => {
    seen = []
    listener = (e: Event) => seen.push((e as CustomEvent<BusDetail>).detail)
    window.addEventListener('ni:entity-updated', listener)
  })

  afterEach(() => {
    window.removeEventListener('ni:entity-updated', listener)
  })

  it('emits the FULL link row after a push from a callback-less mount', async () => {
    installFetch({
      destinations: [ASANA_CONFIGURED],
      push: { ok: true, status: 201, body: { task: LINK } },
    })
    // No onPushed: the detail-panel toolbar and the proposal card mount exactly
    // like this.
    await render({ actionId: 'act-1' })
    await openMenu()
    await pushTo('Asana')

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ entityType: 'action', id: 'act-1' })
    // The whole row the server returned — id, url, title and all — not a
    // `{ provider }` stub. The detail panel's listener writes this payload
    // into the shared action cache, and the panel later SEEDS its controlled
    // menu from that cache: a stub there draws a disabled "Open in …" and
    // aims Unlink at `/asana/undefined`.
    expect(seen[0].fields.external_links).toEqual([LINK])
  })

  it('emits the REMAINING full rows after an unlink, not an empty array', async () => {
    // Two links: unlinking one must not tell every surface the action is now
    // NI-only, which is what emitting a bare [] would do.
    installFetch({ destinations: [ASANA_CONFIGURED, JIRA_CONFIGURED], links: [LINK, JIRA_LINK] })
    await render({ actionId: 'act-1' })
    await openMenu()
    await act(async () => {
      itemByText('Unlink')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(seen).toHaveLength(1)
    // The surviving JIRA row, whole — same cache-seeding contract as the push.
    expect(seen[0].fields.external_links).toEqual([JIRA_LINK])
  })

  it('does NOT emit when the unlink fails and the link is restored', async () => {
    installFetch({ destinations: [ASANA_CONFIGURED], links: [LINK], unlinkOk: false })
    await render({ actionId: 'act-1' })
    await openMenu()
    await act(async () => {
      itemByText('Unlink')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(seen).toHaveLength(0)
  })

  /**
   * The republish announces a JOIN, not a row write: no UPDATE to `actions` ever
   * happened, so no realtime echo of our own is coming. Arming the 10s
   * self-echo window would therefore only suppress OTHER users' changes to this
   * action — a collaborative board silently freezing one card after a push.
   */
  it('does not arm the self-echo suppression window', async () => {
    const { wasRecentlyMutatedLocally } = await import('@/lib/entity-events')
    installFetch({
      destinations: [ASANA_CONFIGURED],
      push: { ok: true, status: 201, body: { task: LINK } },
    })
    await render({ actionId: 'act-1' })
    await openMenu()
    await pushTo('Asana')

    expect(seen).toHaveLength(1)
    expect(wasRecentlyMutatedLocally('action', 'act-1')).toBe(false)
  })
})
