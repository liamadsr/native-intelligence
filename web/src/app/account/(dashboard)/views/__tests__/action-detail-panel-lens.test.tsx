// @vitest-environment jsdom
/**
 * THE PROPERTY LENS IN THE ACTION DETAIL PANEL'S SIDEBAR.
 *
 * The sidebar is a column of `PropertyGroup`s — Properties, Labels, Project,
 * Links, Documents, GitHub, Attachments — and the lens replaces the contents of
 * exactly ONE of them. That containment is the whole claim of this file, because
 * the failure mode is silent: a lens that also swallowed the Labels or Project
 * group would look fine on a linked action and would have quietly removed
 * Dial8's own relationships from the only surface that edits them.
 *
 * The three rules pinned here:
 *
 *  - THE SWITCHER IS ABSENT WITHOUT LINKS. An action that was never pushed gets
 *    the sidebar it always had — this is the requirement that keeps the feature
 *    invisible to actions it does not apply to.
 *  - A PROVIDER LENS REPLACES THE PROPERTIES GROUP'S CONTENTS, AND ONLY THOSE.
 *    Every other group is still there, and Dial8's status/priority controls are
 *    gone from the column (they are what the lens stands in for).
 *  - COMPOSE WINS. While a push form is up the sidebar is committed to a
 *    create-in-progress; swapping the group under it to a provider's live fields
 *    would put two provider forms in one column.
 *
 * WHAT JSDOM CANNOT PIN, restated from the compose-routing suite next door:
 * nothing here proves anything about LAYOUT. Structure is testable in this
 * environment; whether the user can see the thing is not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
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
      children?: ReactNode
    }) =>
      e(
        MenuCtx.Provider,
        { value: { open: !!open, setOpen: (v: boolean) => onOpenChange?.(v) } },
        children,
      ),
    DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => {
      const ctx = useContext(MenuCtx)
      return e('span', { onClick: () => ctx.setOpen(!ctx.open) }, children)
    },
    DropdownMenuContent: ({ children }: { children?: ReactNode }) => {
      const ctx = useContext(MenuCtx)
      return ctx.open ? e('div', { 'data-menu-content': '' }, children) : null
    },
    DropdownMenuItem: ({
      children,
      disabled,
      onSelect,
    }: {
      children?: ReactNode
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
    DropdownMenuGroup: ({ children }: { children?: ReactNode }) => e('div', {}, children),
  }
})

vi.mock('@/components/ui/select', async () => {
  const { createElement: e } = await import('react')
  return {
    Select: ({
      value,
      onValueChange,
      disabled,
      children,
    }: {
      value?: string
      onValueChange?: (v: string) => void
      disabled?: boolean
      children?: ReactNode
    }) =>
      e(
        'select',
        {
          value: value ?? '',
          disabled,
          onChange: (ev: { target: { value: string } }) => onValueChange?.(ev.target.value),
        },
        children,
      ),
    SelectTrigger: ({
      'aria-label': ariaLabel,
      className,
      children,
    }: {
      'aria-label'?: string
      className?: string
      children?: ReactNode
    }) => e('span', { 'data-select-label': ariaLabel, className }, children),
    SelectValue: () => null,
    SelectContent: ({ children }: { children?: ReactNode }) => e('optgroup', {}, children),
    SelectItem: ({ value, children }: { value: string; children?: ReactNode }) =>
      e('option', { value }, children),
  }
})

/**
 * The compose FORM is a marker, as in the compose-routing suite: what is under
 * test is the lens's relationship to compose, not the Jira cascade. The marker
 * doubles as a Create button (wired straight to `onCreate` with no overrides —
 * the old one-click push) so the cache-freshening tests below can complete a
 * real push through the panel without the Jira field cascade.
 */
vi.mock('@/components/tasks/push-compose-panel', () => ({
  PushComposePanel: ({
    provider,
    onCreate,
  }: {
    provider: string
    onCreate: (overrides: Record<string, unknown>) => Promise<boolean>
  }) =>
    h(
      'button',
      { type: 'button', 'data-compose-form': provider, onClick: () => void onCreate({}) },
      `Create in ${provider}`,
    ),
}))

import { ActionDetailPanel, trustedCachedLinks } from '../action-detail-panel'
import { clearActionComposeRequest, requestActionCompose } from '@/lib/tasks/compose-request-events'
import { writeActionCache, type ActionDetail } from '@/lib/action-cache'
import type { ExternalTaskLink } from '@/components/tasks/push-to-tracker-menu'

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

const DESTINATIONS = [
  { provider: 'jira', name: 'Jira', configured: true, destinationLabel: 'KAN board' },
]

function jiraDetails() {
  return {
    ok: true,
    provider: 'jira',
    link_id: 'link-1',
    url: 'https://acme.atlassian.net/browse/KAN-3',
    title: 'Ship the thing',
    status_name: 'In Progress',
    fields: {
      project: { id: '10001', name: 'Kanban' },
      issue_type: { id: '10002', name: 'Task' },
      team: null,
      section: null,
      assignee: { id: 'acc-1', name: 'Ada Lovelace' },
      priority: { id: '3', name: 'Medium' },
      due_date: '2026-03-14',
      labels: [],
    },
    editable: { assignee: true, priority: true, due_date: true, labels: true },
    option_scope: {
      cloud_id: 'cloud-1',
      project_id: '10001',
      project_key: 'KAN',
      issue_type_id: '10002',
    },
  }
}

/** Every URL the stub was asked for, in order — the F4 window is a timing claim. */
let calls: string[] = []
/**
 * Detail reads that have STARTED but not answered — the link rows ride on the
 * action detail response, so holding it open holds the panel in its refresh
 * window so a test can look at what the toolbar claims there. Installed only by
 * `installFetch({ deferLinks: true })`.
 */
let releaseLinks: (() => void) | null = null

function installFetch({
  linkedProviders = [] as string[],
  deferLinks = false,
  /** Merged into the action the detail GET answers with. The panel refetches
   *  over any seeded cache, so this is the way to vary a field under test. */
  actionOverrides = {} as Record<string, unknown>,
} = {}) {
  calls = []
  releaseLinks = null
  const gate = deferLinks
    ? new Promise<void>((resolve) => {
        releaseLinks = resolve
      })
    : null

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

      // A push POST answers with the full link row the server would mint —
      // distinct from the GET detail read below and from the unlink DELETE
      // (which carries a trailing link-id segment).
      const pushMatch = /^\/api\/account\/actions\/(act-[^/?]+)\/(asana|jira|linear)$/.exec(url)
      if (pushMatch && init?.method === 'POST') {
        return ok({
          task: {
            id: `link-${pushMatch[2]}-pushed`,
            provider: pushMatch[2],
            external_id: 'x-9',
            external_url: 'https://acme.atlassian.net/browse/KAN-9',
            external_title: 'Ship the thing',
            completed: false,
          },
        })
      }

      // Any action id, so a test can switch the panel from one to another. The
      // external-task link rows are EMBEDDED here — this response is the
      // panel's single link source (the per-provider probes are gone).
      const actionMatch = /^\/api\/account\/actions\/(act-[^/?]+)$/.exec(url)
      if (actionMatch) {
        // The refresh window, held open on demand.
        if (gate) await gate
        return ok({
          action: {
            ...ACTION,
            id: actionMatch[1],
            external_links: linkedProviders.map((provider) => ({
              id: `link-${provider}`,
              provider,
              external_id: 'x',
              external_url: null,
              external_title: null,
              completed: false,
            })),
            ...actionOverrides,
          },
        })
      }
      if (url.startsWith('/api/account/task-destinations')) return ok({ destinations: DESTINATIONS })
      if (url.includes('/task-details')) return ok(jiraDetails())
      // Unlink DELETEs still hit the per-provider link routes.
      if (/\/(asana|jira|linear)\/[^/]+$/.test(url)) return ok({ ok: true })
      if (url.includes('/jira/assignable-users')) return ok({ users: [] })
      if (url.includes('/jira/compose-meta'))
        return ok({ meta: { priorities: [] }, native_create_url: null, cached: false })

      return ok({
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
      })
    }),
  )
}

let container: HTMLDivElement
let root: Root

/** Mount with arbitrary panel props (e.g. an onOpenEntity spy). */
async function mountPanelWith(props: Record<string, unknown>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(h(ActionDetailPanel, { onClose: vi.fn(), ...props } as never))
  })
  // Let the link lookup and the lens read settle.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mountPanel(actionId = 'act-1') {
  await mountPanelWith({ actionId })
}

/**
 * Every PropertyGroup's title, in column order.
 *
 * `PropertyGroup` (src/components/views/property-group.tsx) renders its title
 * as the FIRST CHILD div of `.rounded-lg` — there is no heading element and no
 * data attribute, so the group's own structure is the only handle. Matched on
 * the card rather than on the title's classes so a restyle of the caption does
 * not silently empty this list and make the containment assertion below
 * vacuously pass.
 */
function groupTitles(): string[] {
  return Array.from(container.querySelectorAll('div.rounded-lg'))
    .map((card) => card.firstElementChild?.textContent?.trim() ?? '')
    .filter((title) => title.length > 0)
}

beforeEach(() => {
  vi.clearAllMocks()
  clearActionComposeRequest()
  installFetch()
})

afterEach(() => {
  if (root) act(() => root.unmount())
  if (container) container.remove()
  clearActionComposeRequest()
})

describe('ActionDetailPanel — the property lens', () => {
  /** THE INVISIBILITY REQUIREMENT, on the panel side. */
  it('an unlinked action gets no switcher and keeps its Dial8 property controls', async () => {
    installFetch({ linkedProviders: [] })
    await mountPanel()

    expect(container.querySelector('[data-lens-switcher]')).toBeNull()
    expect(container.querySelector('[data-lens-surface]')).toBeNull()
    // Dial8's own status control is still in the column.
    expect(container.textContent).toContain('Todo')
  })

  it('a linked action gets the switcher, defaulting to the linked provider', async () => {
    installFetch({ linkedProviders: ['jira'] })
    await mountPanel()

    const switcher = container.querySelector('[data-lens-switcher]')!
    expect(
      Array.from(switcher.querySelectorAll('[data-lens-tab]')).map((t) =>
        t.getAttribute('data-lens-tab'),
      ),
    ).toEqual(['dial8', 'jira'])
    expect(switcher.querySelector('[data-lens-tab="jira"]')!.getAttribute('aria-pressed')).toBe('true')
  })

  it('renders the lens in STACK layout — the sidebar is a vertical column', async () => {
    installFetch({ linkedProviders: ['jira'] })
    await mountPanel()

    expect(container.querySelector('[data-lens-surface="stack"]')).toBeTruthy()
    // No horizontal scroller: there is nothing to scroll sideways in a narrow column.
    expect(container.querySelector('[data-lens-scroller]')).toBeNull()
  })

  /**
   * THE CONTAINMENT CLAIM, and the one that would catch the worst silent bug: a
   * lens that swallowed the sidebar's other groups would remove Dial8's own
   * labels/project/links editing from the only surface that does it.
   */
  it('replaces ONLY the Properties group — every other group survives', async () => {
    installFetch({ linkedProviders: ['jira'] })
    await mountPanel()

    const titles = groupTitles()
    expect(titles).toContain('Properties')
    // The sidebar's other groups have all become rows INSIDE Properties, so
    // the containment claim is now about the controls, not group titles: a
    // lens that swallowed them would take Dial8's own editing with it.
    expect(container.textContent).toContain('Add label')
    expect(container.textContent).toContain('Set project')
    expect(container.textContent).toContain('Add link')
    expect(container.textContent).toContain('Link document')
    expect(container.textContent).toContain('Link pull request')
    // And the lens is INSIDE the Properties group, not loose in the column.
    const lens = container.querySelector('[data-lens-surface="stack"]')!
    expect(lens.closest('div')).toBeTruthy()
    expect(container.querySelector('[data-lens-field="project"]')!.textContent).toContain('Kanban')
  })

  it('switching to Dial8 restores the native property controls', async () => {
    installFetch({ linkedProviders: ['jira'] })
    await mountPanel()
    expect(container.querySelector('[data-lens-surface]')).toBeTruthy()

    await act(async () => {
      container
        .querySelector('[data-lens-tab="dial8"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelector('[data-lens-surface]')).toBeNull()
    expect(container.querySelector('[data-lens-switcher]')).toBeTruthy()
    expect(container.textContent).toContain('Todo')
  })

  /**
   * COMPOSE WINS. A create-in-progress owns the sidebar; a lens must stand down
   * rather than put a second provider form in the same column.
   */
  it('stands down while a push is being composed', async () => {
    installFetch({ linkedProviders: ['jira'] })
    // The board hand-off arms compose as the panel mounts — the same order the
    // real board produces.
    requestActionCompose({ actionId: 'act-1', title: 'Ship the thing', provider: 'jira' })
    await mountPanel()

    expect(document.querySelector('[data-compose-form]')).toBeTruthy()
    // No lens, and no switcher to start one.
    expect(container.querySelector('[data-lens-surface]')).toBeNull()
    expect(container.querySelector('[data-lens-switcher]')).toBeNull()
  })

  /**
   * THE STICKY LENS SURVIVES A RE-RENDER BUT NOT AN UNLINK.
   *
   * `activeLens` is deliberately sticky — a user who switched back to Dial8 must
   * not be flipped to Jira when the links resolve — and the trap is that the links
   * it names can be removed underneath it FROM THIS PANEL, through the toolbar
   * menu's Unlink. That empties the link rows, so the switcher unmounts (it reads
   * the same list) while an unvalidated `activeLens` still says 'jira': the
   * Properties group becomes a `link_not_found` banner whose Retry can never
   * succeed, with no switcher left to escape through. A dead end, in the one place
   * that edits an action's properties.
   *
   * The suite's existing tests all pin links that never change after mount
   * (linked-at-mount, unlinked-at-mount) — this is the transition, which is where
   * the bug lived.
   *
   * THE JIRA TAB IS CLICKED, not merely defaulted onto, and that is load-bearing:
   * the default lens is DERIVED (`activeLens` stays null and the derivation reads
   * the live provider list, so it self-corrects), while a clicked lens is STORED.
   * Only the stored one can outlive the link it names — a version of this test
   * that relied on the default passed against the unguarded code.
   */
  it('falls back to Dial8 when the active lens is unlinked from under it', async () => {
    installFetch({ linkedProviders: ['jira'] })
    await mountPanel()

    // Precondition: the Jira lens is up and Dial8's own status control is NOT in
    // the column (the lens stands in for it). Clicked, so `activeLens` is set.
    await act(async () => {
      container
        .querySelector('[data-lens-tab="jira"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[data-lens-surface="stack"]')).toBeTruthy()
    expect(container.querySelector('[data-lens-tab="jira"]')!.getAttribute('aria-pressed')).toBe(
      'true',
    )

    // Unlink through the toolbar menu — the real in-place path. The mocked
    // dropdown renders items as buttons only while open, so open it first.
    await act(async () => {
      container
        .querySelector('[aria-label="Linked to a task app"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const unlink = Array.from(container.querySelectorAll('[data-menu-item]')).find((item) =>
      item.textContent?.includes('Unlink'),
    )
    expect(unlink).toBeTruthy()
    await act(async () => {
      unlink!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // The lens surface is GONE — not replaced by a banner it cannot leave.
    expect(container.querySelector('[data-lens-surface]')).toBeNull()
    expect(container.querySelector('[data-lens-failure]')).toBeNull()
    // No switcher either: an action with no links is one the feature does not
    // apply to, exactly as if it had never been pushed.
    expect(container.querySelector('[data-lens-switcher]')).toBeNull()
    // And Dial8's own properties are back in the column.
    expect(container.textContent).toContain('Todo')
  })

  /**
   * ONE ACTION'S LINKS MUST NEVER BE DRAWN ON ANOTHER'S.
   *
   * The panel holds the link rows itself and hands them to both readers, so a
   * switch of `actionId` without a remount leaves A's rows in state for as long as
   * B's read takes: B wears A's Jira tab, and clicking it mounts the lens against
   * a link B does not have. (In today's app the panel remounts on navigation —
   * `key={dp.id}` in tab-content — so this is the belt to that braces; it costs
   * one ref and stops the whole class of bug if that key ever goes away.)
   *
   * The reset happens during RENDER, not in an effect: an effect runs after paint,
   * and that paint is the frame that shows the wrong tab.
   *
   * The toolbar's claim across the same window is pinned by the refresh test
   * below; the panel disclaims knowledge with `linksKnown={false}` while a read is
   * outstanding, so neither the swap nor the first load promises "unlinked".
   */
  it('does not carry one action\'s links onto the next', async () => {
    installFetch({ linkedProviders: ['jira'] })
    await mountPanel()
    expect(container.querySelector('[data-lens-tab="jira"]')).toBeTruthy()

    // Now B, whose reads HANG. Same root, no remount — the panel must drop A's
    // rows on the spot rather than lending them to B.
    installFetch({ linkedProviders: ['jira'], deferLinks: true })
    await act(async () => {
      root.render(h(ActionDetailPanel, { actionId: 'act-2', onClose: vi.fn() }))
    })

    expect(container.querySelector('[data-lens-switcher]')).toBeNull()
    expect(container.querySelector('[data-lens-surface]')).toBeNull()

    // And B's own answer still lands when it arrives.
    await act(async () => {
      releaseLinks!()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('[data-lens-tab="jira"]')).toBeTruthy()
  })

  /**
   * THE REFRESH WINDOW MUST NOT CLAIM "IN NO TRACKER".
   *
   * The panel drives the menu in CONTROLLED mode, where the array it passes IS the
   * truth — `linksKnown` short-circuits, so there is no hedge to fall back on. The
   * refresh effect used to `setExternalLinks([])` before awaiting the three reads,
   * and for the whole width of that fetch the toolbar drew the upload arrow and
   * named itself "Push to…": an affirmative "this action is in no tracker" about an
   * action sitting in Jira. That is exactly the claim `known=false` exists to
   * prevent, made by the one caller that cannot express it.
   *
   * The fix is replace-on-resolve — old rows stand until new rows land — so the
   * aria-label is the observable: it may say "Linked to a task app" (the previous,
   * still-true answer) or hedge, but it must never pass through "Push to…" for an
   * action whose links have resolved at least once.
   *
   * A→B→A is how a same-action refresh is reached: the effect keys on `actionId`,
   * and coming back to A re-runs it while A's rows are already known. This is the
   * live case (the KNOWN GAP above is the never-yet-resolved FIRST load, which
   * hedging cannot fix from a controlled caller).
   */
  it('never claims the action is unlinked while its links are being refreshed', async () => {
    installFetch({ linkedProviders: ['jira'] })
    await mountPanel()

    const label = () =>
      container.querySelector('[aria-label="Push to…"], [aria-label="Linked to a task app"], [aria-label="Task app options"]')
        ?.getAttribute('aria-label') ?? null

    // A is resolved and linked — the toolbar says so.
    expect(label()).toBe('Linked to a task app')

    // Away to B and back to A, with A's re-read HELD OPEN. The panel is now in the
    // refresh window for an action it has already resolved once.
    installFetch({ linkedProviders: ['jira'] })
    await act(async () => {
      root.render(h(ActionDetailPanel, { actionId: 'act-2', onClose: vi.fn() }))
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    installFetch({ linkedProviders: ['jira'], deferLinks: true })
    await act(async () => {
      root.render(h(ActionDetailPanel, { actionId: 'act-1', onClose: vi.fn() }))
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // THE ASSERTION: mid-refresh, the toolbar does not claim "unlinked".
    expect(label()).not.toBe('Push to…')

    // And the fresh answer still lands.
    await act(async () => {
      releaseLinks!()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(label()).toBe('Linked to a task app')
    expect(container.querySelector('[data-lens-tab="jira"]')).toBeTruthy()
  })

  /**
   * ONE RESOLVER, still — the lens hook must not ask alongside the panel.
   *
   * The panel owns the link rows — they arrive embedded on the ONE action
   * detail read — and hands them to both readers (the menu in controlled mode,
   * the hook via `links`). The pre-resolve state is `undefined` internally, and
   * `undefined` is ALSO how a caller tells the hook "I have no rows, go ask" —
   * so the two call sites convert it explicitly. Getting that wrong
   * reintroduces the per-provider probe requests
   * `action-detail-panel-push-menu.test.tsx` forbids, from the other side, and
   * only during the fetch window that test never looks at.
   */
  it('never lets the lens hook fetch links beside the panel', async () => {
    installFetch({ linkedProviders: ['jira'], deferLinks: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(h(ActionDetailPanel, { actionId: 'act-1', onClose: vi.fn() }))
    })
    // Mid-flight: the panel's one detail read is out, and nothing else may pile on.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls.filter((u) => u === '/api/account/actions/act-1')).toHaveLength(1)
    for (const provider of ['asana', 'jira', 'linear']) {
      expect(calls.filter((u) => u === `/api/account/actions/act-1/${provider}`)).toHaveLength(0)
    }

    // Same after it lands, with the lens up and reading its details.
    await act(async () => {
      releaseLinks!()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('[data-lens-surface="stack"]')).toBeTruthy()
    expect(calls.filter((u) => u === '/api/account/actions/act-1')).toHaveLength(1)
    for (const provider of ['asana', 'jira', 'linear']) {
      expect(calls.filter((u) => u === `/api/account/actions/act-1/${provider}`)).toHaveLength(0)
    }
  })
})

/**
 * THE CACHE-SEEDING SEAM: the panel seeds `externalLinks` from the shared
 * action cache on mount and on action swap, hands them to the toolbar menu in
 * CONTROLLED mode, and the menu takes them as the truth. Two things must hold
 * across that seam:
 *
 *  - A PUSH/UNLINK FRESHENS THE CACHE. The menu's entity-bus republish carries
 *    the FULL post-mutation rows, and the panel's own listener spreads them
 *    into the cache — so stepping away and back seeds the post-push truth,
 *    not the rows the pre-push detail fetch cached. (The old republish wrote
 *    provider-only `{ provider }` stubs, which is the corruption the second
 *    suite below is about.)
 *
 *  - STUB ROWS NEVER REACH CONTROLLED MODE. A cache entry whose link rows are
 *    missing a string `id` (legacy stubs, or any thin projection another
 *    emitter writes) is untrusted WHOLE: the seed hedges (`undefined` →
 *    `linksKnown={false}`) instead of drawing a disabled "Open in …" and an
 *    Unlink whose DELETE goes to `/{provider}/undefined`.
 *
 * Distinct action ids per test — the action cache is module-level and the
 * earlier suites in this file have already written act-1/act-2 entries.
 */
describe('ActionDetailPanel — link rows across the action cache', () => {
  const toolbar = () =>
    container.querySelector(
      '[aria-label="Push to…"], [aria-label="Linked to a task app"], [aria-label="Task app options"]',
    )
  const menuItem = (text: string) =>
    Array.from(container.querySelectorAll('[data-menu-item]')).find((b) =>
      b.textContent?.includes(text),
    )

  it('a push freshens the cache: step away and back seeds the REAL row, and Unlink hits its real id', async () => {
    installFetch({ linkedProviders: [] })
    await mountPanel('act-31')

    // Unlinked, affirmatively — the detail read answered [].
    expect(toolbar()!.getAttribute('aria-label')).toBe('Push to…')

    // Push to Jira through the toolbar menu: pick the destination, then Create
    // in the (mocked) compose form the panel portals into its sidebar.
    await act(async () => {
      toolbar()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      menuItem('Push to Jira')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      container
        .querySelector('[data-compose-form="jira"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(toolbar()!.getAttribute('aria-label')).toBe('Linked to a task app')

    // Step away to another action, then BACK with the re-read HELD OPEN — the
    // seed is all the toolbar has for the whole width of this window.
    installFetch({ linkedProviders: ['jira'] })
    await act(async () => {
      root.render(h(ActionDetailPanel, { actionId: 'act-32', onClose: vi.fn() }))
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    installFetch({ linkedProviders: ['jira'], deferLinks: true })
    await act(async () => {
      root.render(h(ActionDetailPanel, { actionId: 'act-31', onClose: vi.fn() }))
    })

    // Seeded from the cache the republish freshened: LINKED — not the
    // pre-push [] the detail fetch originally cached (the stale-affirmative
    // window the review flagged), and not a hedge.
    expect(toolbar()!.getAttribute('aria-label')).toBe('Linked to a task app')

    // And the seeded row is COMPLETE: Unlink targets the id the push minted.
    await act(async () => {
      toolbar()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      menuItem('Unlink')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(calls).toContain('/api/account/actions/act-31/jira/link-jira-pushed')
    expect(calls.some((u) => u.includes('/undefined'))).toBe(false)
  })

  it('a cache entry carrying provider-only stub rows HEDGES instead of trusting them', async () => {
    // A stub entry: `{ provider }` and nothing else — the shape the entity-bus
    // republish used to write through the panel's own listener.
    writeActionCache('act-41', {
      ...ACTION,
      id: 'act-41',
      external_links: [{ provider: 'jira' }],
    } as unknown as ActionDetail)

    installFetch({ linkedProviders: ['jira'], deferLinks: true })
    await mountPanel('act-41')

    // The whole array is untrusted → the hedge, not CONTROLLED-mode claims.
    expect(toolbar()!.getAttribute('aria-label')).toBe('Task app options')

    // No Unlink is even offered — the DELETE to /jira/undefined is unreachable.
    await act(async () => {
      toolbar()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(menuItem('Unlink')).toBeUndefined()
    expect(menuItem('Push to Jira')).toBeTruthy()

    // The real rows land and the toolbar recovers the truth.
    await act(async () => {
      releaseLinks!()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(toolbar()!.getAttribute('aria-label')).toBe('Linked to a task app')
    expect(calls.some((u) => u.includes('/undefined'))).toBe(false)
  })
})

/** The trust gate itself, pinned directly. */
describe('trustedCachedLinks', () => {
  const FULL: ExternalTaskLink = {
    id: 'link-1',
    provider: 'jira',
    external_id: 'x',
    external_url: null,
    external_title: null,
    completed: false,
  }

  it('passes full rows through by reference', () => {
    const rows = [FULL]
    expect(trustedCachedLinks(rows)).toBe(rows)
  })

  it('keeps an empty array — "resolved, in no tracker" is an answer, not a stub', () => {
    const rows: ExternalTaskLink[] = []
    expect(trustedCachedLinks(rows)).toBe(rows)
  })

  it('ONE stub poisons the whole array', () => {
    expect(
      trustedCachedLinks([FULL, { provider: 'asana' } as unknown as ExternalTaskLink]),
    ).toBeUndefined()
  })

  it('hedges on absent input', () => {
    expect(trustedCachedLinks(undefined)).toBeUndefined()
  })
})

/**
 * Auto-acceptance reads as Activity, not a badge.
 *
 * An "Auto-accepted" badge used to sit above the title. It describes how the
 * action came to exist — which is what the timeline is for — and it stopped
 * being news the moment you opened the action, so it moved onto the Created
 * row. Folded INTO that row rather than added as its own: it happened at
 * creation, so a separate entry would duplicate the timestamp and imply a
 * second thing had happened.
 *
 * The confidence figure rides along because the badge's tooltip carried it;
 * dropping it would have quietly lost information in a move that was only
 * meant to relocate it.
 */
describe('ActionDetailPanel — auto-accepted provenance', () => {
  const activityText = () => {
    const heading = [...container.querySelectorAll('p')].find(
      (p) => p.textContent?.trim() === 'Activity',
    )
    return heading?.parentElement?.textContent ?? ''
  }

  const CREATED = '2026-08-01T10:00:00.000Z'

  it('reports an auto-accepted action on the Created row, with no badge', async () => {
    installFetch({
      actionOverrides: { auto_accepted: true, ai_confidence: 0.9, created_at: CREATED },
    })
    await mountPanel('act-auto')

    expect(activityText()).toContain('Created by the live agent')
    // The tooltip's confidence figure survives the move.
    expect(activityText()).toContain('90% confident')
    // And the badge itself is gone from the header.
    expect(container.textContent).not.toContain('Auto-accepted')
  })

  it('leaves a manually created action reading plainly', async () => {
    installFetch({ actionOverrides: { auto_accepted: false, created_at: CREATED } })
    await mountPanel('act-manual')

    expect(activityText()).toContain('Created')
    expect(activityText()).not.toContain('live agent')
    expect(activityText()).not.toContain('confident')
  })

  it('omits the confidence clause when the score is unknown', async () => {
    installFetch({
      actionOverrides: { auto_accepted: true, ai_confidence: null, created_at: CREATED },
    })
    await mountPanel('act-noconf')

    // Still attributed, but no "null% confident" nonsense.
    expect(activityText()).toContain('Created by the live agent')
    expect(activityText()).not.toContain('confident')
  })
})

/**
 * Where an action came from.
 *
 * Roughly half of all actions are extracted from a meeting rather than typed
 * by hand, and that capture is the only place the surrounding discussion
 * lives — so Activity links back to it. It rides on the Created row for the
 * same reason auto-acceptance does: the extraction IS the creation, so a row
 * of its own would duplicate the timestamp.
 *
 * The other half have no source capture at all, which is why the absent case
 * matters as much as the present one.
 */
describe('ActionDetailPanel — source capture provenance', () => {
  const CREATED = '2026-08-01T10:00:00.000Z'

  const activityText = () => {
    const heading = [...container.querySelectorAll('p')].find(
      (p) => p.textContent?.trim() === 'Activity',
    )
    return heading?.parentElement?.textContent ?? ''
  }

  it('links back to the capture an action was extracted from', async () => {
    const onOpenEntity = vi.fn()
    installFetch({
      actionOverrides: {
        created_at: CREATED,
        source_capture_id: 'cap-9',
        source_capture_title: 'Weekly product sync',
      },
    })
    await mountPanelWith({ actionId: 'act-src', onOpenEntity })

    expect(activityText()).toContain('from')
    expect(activityText()).toContain('Weekly product sync')

    const link = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Weekly product sync',
    )
    expect(link).toBeTruthy()

    await act(async () => {
      link!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // Navigation goes through the host, like every other cross-entity open.
    expect(onOpenEntity).toHaveBeenCalledWith(
      'capture',
      'cap-9',
      'Weekly product sync',
      expect.anything(),
    )
  })

  it('says nothing when the action has no source capture', async () => {
    installFetch({ actionOverrides: { created_at: CREATED, source_capture_id: null } })
    await mountPanel('act-nosrc')

    // Half of all actions are created directly — no dangling "from".
    expect(activityText()).toContain('Created')
    expect(activityText()).not.toContain('from')
  })

  it('still shows the origin when the host wires no navigation', async () => {
    installFetch({
      actionOverrides: {
        created_at: CREATED,
        source_capture_id: 'cap-9',
        source_capture_title: 'Weekly product sync',
      },
    })
    // No onOpenEntity: some mount sites don't wire one. The provenance is still
    // worth reading even when it can't be clicked.
    await mountPanel('act-src-nonav')

    expect(activityText()).toContain('Weekly product sync')
    const link = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Weekly product sync',
    )
    expect(link).toBeUndefined()
  })
})
