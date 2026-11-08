// @vitest-environment jsdom
/**
 * THE WORKSPACE CACHE IS INVALIDATABLE BY SURFACES THAT CHANGE THE WORKSPACE.
 *
 * The `/` page list, the page cards and the first-run starters all read the
 * workspace cache via `useWorkspaceEdition` — NOT the settings view that
 * edits it. So a features/edition PATCH that does not invalidate the cache
 * saves correctly and changes nothing on screen until a full page reload, which
 * is exactly the bug this hook exists to prevent (verified live: PATCH stored
 * {email:'on'}, Mail appeared only after a reload).
 *
 * `useWorkspaceCacheRefresh` is the seam. What matters and is pinned here:
 *  - calling it REFETCHES, and the newly-fetched edition/overrides reach
 *    `useWorkspaceEdition` — the composed views actually change;
 *  - its identity is STABLE across renders, so it is safe in a dep array;
 *  - a refresh that changes nothing leaves the composed surface equal;
 *  - OUTSIDE the provider it is a harmless async no-op, because the standalone
 *    /account/settings/* routes get SettingsShell without the cache provider.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => false }))
// The provider patches window.fetch on mount (workspace header injection) —
// stub the interceptor so the test's own fetch stub stays in charge.
vi.mock('@/lib/workspace-fetch', () => ({
  setClientWorkspaceId: vi.fn(),
  // Reads as "already seeded" so the provider's dev-only header-less warning
  // stays out of this suite's output. The seed itself is covered by
  // workspace-cache-boot-seed.test.tsx, against the real interceptor.
  getClientWorkspaceId: vi.fn(() => 'ws-1'),
  patchFetch: vi.fn(),
}))
vi.mock('@/hooks/recording-context', () => ({ useOptionalRecordingStable: () => null }))
vi.mock('../workspace-transition', () => ({
  useWorkspaceTransition: () => ({
    beginTransition: (_target: unknown, commit: () => void) => commit(),
  }),
}))
vi.mock('../(dashboard)/settings-overlay', () => ({ useOptionalSettingsOverlay: () => null }))
vi.mock('../create-workspace-wizard', () => ({ CreateWorkspaceWizard: () => null }))

import {
  WorkspaceCacheProvider,
  useResolvedWorkspaceEdition,
  useSwitchWorkspace,
  useWorkspaceCacheRefresh,
  useWorkspaceEdition,
} from '../workspace-switcher'
import type { EditionDefinition } from '@/lib/editions'

function jsonRes(body: unknown) {
  return { ok: true, json: async () => body } as Response
}

/** A workspace GET whose settings blob carries `edition` + `feature_overrides`,
 *  which is what the cache lifts the effective surface out of. */
function workspacePayload(settings: Record<string, unknown>) {
  return {
    workspace: { id: 'ws-1', settings },
    currentMemberId: 'm-1',
    members: [{ id: 'm-1', user_id: 'u-1', email: 'liam@dial8.ai', display_name: 'Liam', avatar_url: null }],
  }
}

describe('useWorkspaceCacheRefresh', () => {
  let container: HTMLDivElement
  let root: Root
  let refresh: (() => Promise<void>) | null = null
  let edition: EditionDefinition | null = null
  let refreshIdentities: (() => Promise<void>)[] = []
  let overridesIdentities: unknown[] = []
  let renders = 0

  function Probe() {
    refresh = useWorkspaceCacheRefresh()
    edition = useWorkspaceEdition()
    refreshIdentities.push(refresh)
    // The composed edition object is rebuilt only when its memo inputs change,
    // so its identity is a proxy for "did currentFeatureOverrides churn".
    overridesIdentities.push(edition)
    renders++
    return null
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    refresh = null
    edition = null
    refreshIdentities = []
    overridesIdentities = []
    renders = 0
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  /** Serves whatever settings blob `current.value` holds, so a test can change
   *  the server's answer between refreshes the way a PATCH would. */
  function stubFetch(current: { value: Record<string, unknown> }) {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/account/workspace/list') {
        return jsonRes({
          workspaces: [
            {
              id: 'ws-1',
              name: 'Native Intelligence',
              slug: 'dial8',
              logo_url: null,
              plan: 'pro',
              role: 'owner',
              settings: current.value,
            },
          ],
        })
      }
      if (url === '/api/account/workspace') return jsonRes(workspacePayload(current.value))
      if (url === '/api/account/profile') return jsonRes({ avatar_url: null })
      return jsonRes({})
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('refetches, and the new feature overrides reach the composed nav surface', async () => {
    // The bug in one test: a notes workspace with Email switched off, then
    // Email turned back on server-side (as the features PATCH does: the `on`
    // collapses, so the stored `off` is simply gone), then refresh().
    const current = {
      value: { edition: 'notes', feature_overrides: { email: 'off' } } as Record<string, unknown>,
    }
    stubFetch(current)

    await act(async () => {
      root.render(h(WorkspaceCacheProvider, null, h(Probe)))
    })

    expect(edition!.views).not.toContain('mail')

    // The PATCH the settings card just made.
    current.value = { edition: 'notes', feature_overrides: {} }
    await act(async () => {
      await refresh!()
    })

    // Mail is allowed WITHOUT a page reload — the whole point.
    expect(edition!.views).toContain('mail')
  })

  it('picks up an edition switch too', async () => {
    const current = { value: { edition: 'notes' } as Record<string, unknown> }
    stubFetch(current)

    await act(async () => {
      root.render(h(WorkspaceCacheProvider, null, h(Probe)))
    })
    expect(edition!.id).toBe('notes')

    // Every edition presets every feature, so the switch shows in the edition
    // itself (its persona) rather than in the views.
    current.value = { edition: 'sales' }
    await act(async () => {
      await refresh!()
    })
    expect(edition!.id).toBe('sales')
    expect(edition!.views).toContain('contacts')
  })

  it('is referentially stable across renders — safe in a dependency array', async () => {
    const current = { value: { edition: 'notes' } as Record<string, unknown> }
    stubFetch(current)

    await act(async () => {
      root.render(h(WorkspaceCacheProvider, null, h(Probe)))
    })
    await act(async () => {
      await refresh!()
    })

    expect(renders).toBeGreaterThan(1)
    expect(new Set(refreshIdentities).size).toBe(1)
  })

  it('a refresh that changes nothing leaves the composed surface equal', async () => {
    // The identity-stability guard on `currentFeatureOverrides` (d25bf95b) is
    // pinned by the Phase B suite and is deliberately NOT re-asserted here: the
    // composed edition also memoizes on `workspaces`, whose list refetch
    // legitimately yields a new array, so the edition object is not a valid
    // proxy for it and no public hook exposes the raw overrides. What this
    // change owns is that refreshing does not perturb the surface — asserted by
    // value.
    const current = {
      value: { edition: 'notes', feature_overrides: { email: 'off' } } as Record<string, unknown>,
    }
    stubFetch(current)

    await act(async () => {
      root.render(h(WorkspaceCacheProvider, null, h(Probe)))
    })
    const before = edition!.views

    await act(async () => {
      await refresh!()
    })

    expect(edition!.views).toEqual(before)
    expect(edition!.views).not.toContain('mail')
  })

  it('is a harmless no-op outside the provider (standalone settings routes)', async () => {
    vi.stubGlobal('fetch', vi.fn())

    let outside: (() => Promise<void>) | null = null
    function Bare() {
      outside = useWorkspaceCacheRefresh()
      return null
    }
    await act(async () => {
      root.render(h(Bare))
    })

    // Resolves rather than throwing — the standalone /account/settings/* routes
    // mount without WorkspaceCacheProvider and must not crash on save.
    await expect(outside!()).resolves.toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })
})

/**
 * FRESHNESS IS IDENTITY-BASED, NOT VALUE-BASED.
 *
 * The old heuristic — trust the fetched edition unless it LOOKS like the
 * pre-fetch default (`full`, no overrides) — conflates "genuinely full" with
 * "not loaded yet". During an SPA workspace switch that is not a one-frame
 * blip: `setCurrentId` is synchronous while `refresh()` is fire-and-forget with
 * a bare catch, so the OLD workspace's edition governed the NEW one until the
 * refetch landed — and INDEFINITELY if it failed. A stale list row could also
 * mask a switch back to `full`.
 *
 * The provider now records WHICH workspace the edition/overrides were fetched
 * for, and the hook trusts them only while that matches the active workspace.
 */
describe('useWorkspaceEdition — identity-based freshness', () => {
  let container: HTMLDivElement
  let root: Root
  let edition: EditionDefinition | null = null
  let authoritative = false
  let switchTo: ((id: string) => void) | null = null

  function Probe() {
    const resolved = useResolvedWorkspaceEdition()
    edition = resolved.edition
    authoritative = resolved.authoritative
    switchTo = useSwitchWorkspace()
    return null
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    edition = null
    authoritative = false
    switchTo = null
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  /** Two workspaces: A is `sales` with Projects switched off (every edition
   *  presets every feature, so an override is what tells the two surfaces
   *  apart), B is a pristine `full`. `workspaceGet` decides which one (if any)
   *  the /api/account/workspace GET answers for, and `failWorkspaceGet` makes it
   *  fail the way a dropped request would. */
  function stubTwoWorkspaces(control: {
    activeId: string
    failWorkspaceGet?: boolean
    failList?: boolean
  }) {
    const settingsFor = (id: string) =>
      id === 'ws-a'
        ? { edition: 'sales', feature_overrides: { projects: 'off' } }
        : { edition: 'full' }
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/account/workspace/list') {
        if (control.failList) return { ok: false, json: async () => ({}) } as Response
        return jsonRes({
          workspaces: ['ws-a', 'ws-b'].map((id) => ({
            id,
            name: id,
            slug: id,
            logo_url: null,
            plan: 'pro',
            role: 'owner',
            settings: settingsFor(id),
          })),
        })
      }
      if (url === '/api/account/workspace') {
        if (control.failWorkspaceGet) return { ok: false, json: async () => ({}) } as Response
        return jsonRes({
          workspace: { id: control.activeId, settings: settingsFor(control.activeId) },
          currentMemberId: 'm-1',
          members: [{ id: 'm-1', user_id: 'u-1', email: 'liam@dial8.ai', display_name: 'Liam', avatar_url: null }],
        })
      }
      if (url === '/api/account/profile') return jsonRes({ avatar_url: null })
      if (url === '/api/account/workspace/switch') return jsonRes({ ok: true })
      return jsonRes({})
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  async function mount() {
    await act(async () => {
      root.render(h(WorkspaceCacheProvider, null, h(Probe)))
    })
  }

  it('a genuinely full workspace is authoritative — not mistaken for "still loading"', async () => {
    stubTwoWorkspaces({ activeId: 'ws-b' })
    await mount()

    expect(authoritative).toBe(true)
    expect(edition!.id).toBe('full')
    expect(edition!.views).toContain('projects')
  })

  it('the switch to a full workspace is NOT masked by the previous edition', async () => {
    // The core bug. Start on the sales workspace, then switch to the full one
    // while its GET has not landed: the value heuristic kept `sales` (it is not
    // the default, so it "looked fresh"), which is workspace A's answer applied
    // to workspace B.
    const control = { activeId: 'ws-a' }
    stubTwoWorkspaces(control)
    await mount()
    expect(edition!.id).toBe('sales')
    expect(edition!.views).not.toContain('projects')

    // Switch to B. `setCurrentId` is synchronous; the refetch is not — freeze
    // it mid-flight by making the workspace GET fail, which is also the
    // indefinite case.
    Object.assign(control, { activeId: 'ws-b' })
    ;(control as { failWorkspaceGet?: boolean }).failWorkspaceGet = true
    await act(async () => {
      switchTo!('ws-b')
    })

    // B's list row governs — NOT A's edition. Projects is back.
    expect(authoritative).toBe(false)
    expect(edition!.id).toBe('full')
    expect(edition!.views).toContain('projects')
  })

  it('a successful switch lands on the new workspace’s own authoritative row', async () => {
    const control = { activeId: 'ws-b' }
    stubTwoWorkspaces(control)
    await mount()
    expect(edition!.id).toBe('full')

    control.activeId = 'ws-a'
    await act(async () => {
      switchTo!('ws-a')
    })

    expect(authoritative).toBe(true)
    expect(edition!.id).toBe('sales')
  })

  it('falls back to the full default when neither the row nor a list row exists', async () => {
    // Both fetches down: nothing is known about the active workspace, so the
    // app must render today's behavior rather than some other workspace's.
    stubTwoWorkspaces({ activeId: 'ws-a', failWorkspaceGet: true, failList: true })
    await mount()

    expect(authoritative).toBe(false)
    expect(edition!.id).toBe('full')
    expect(edition!.views).toContain('projects')
  })

  it('the switch path retries a failed refetch', async () => {
    // The identity check caps the harm at "shows the list row"; the retry is
    // the cheap second half. Fail once, then succeed.
    const control: { activeId: string; failWorkspaceGet?: boolean } = { activeId: 'ws-b' }
    const fetchMock = stubTwoWorkspaces(control)
    await mount()

    const before = fetchMock.mock.calls.filter((c) => c[0] === '/api/account/workspace').length
    control.activeId = 'ws-a'
    control.failWorkspaceGet = true
    await act(async () => {
      switchTo!('ws-a')
      // First attempt fails; let the retry go out with the GET healthy again.
      control.failWorkspaceGet = false
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })

    const after = fetchMock.mock.calls.filter((c) => c[0] === '/api/account/workspace').length
    expect(after).toBeGreaterThan(before + 1)
  })
})
