// @vitest-environment jsdom
/**
 * THE WORKSPACE CACHE EXPOSES THE CURRENT MEMBER'S DISPLAY IDENTITY.
 *
 * WorkspaceCacheProvider's fetchData always had the current member's
 * display_name / avatar_url in hand (the /api/account/workspace members array)
 * and discarded them. useCurrentMemberProfile now surfaces them so surfaces
 * that need an authoring identity — the capture panel builds its inline-comment
 * identity from exactly this — do it synchronously from context instead of
 * refetching the workspace endpoint per mount (the fetch that used to gate the
 * capture panel's entire body).
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
// The switch runs behind the wipe curtain: beginTransition(target, commit)
// invokes commit once the curtain covers the panel. Run it synchronously so
// the test drives the real commit path (interceptor update → setCurrentId →
// refresh).
vi.mock('../workspace-transition', () => ({
  useWorkspaceTransition: () => ({
    beginTransition: (_target: unknown, commit: () => void) => commit(),
  }),
}))
vi.mock('../(dashboard)/settings-overlay', () => ({ useOptionalSettingsOverlay: () => null }))
vi.mock('../create-workspace-wizard', () => ({ CreateWorkspaceWizard: () => null }))

import {
  WorkspaceCacheProvider,
  useCurrentMemberProfile,
  useCurrentMemberId,
  useSwitchWorkspace,
} from '../workspace-switcher'
import { setClientWorkspaceId } from '@/lib/workspace-fetch'

function jsonRes(body: unknown) {
  return { ok: true, json: async () => body } as Response
}

describe('useCurrentMemberProfile', () => {
  let container: HTMLDivElement
  let root: Root
  let profile: ReturnType<typeof useCurrentMemberProfile> | null = null
  let memberId: string | null = null

  function Probe() {
    profile = useCurrentMemberProfile()
    memberId = useCurrentMemberId()
    return null
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    profile = null
    memberId = null
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('exposes the current member display_name/avatar_url from the workspace fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/account/workspace/list') {
          return jsonRes({ workspaces: [{ id: 'ws-1', name: 'Native Intelligence', slug: 'dial8', logo_url: null, plan: 'pro', role: 'owner' }] })
        }
        if (url === '/api/account/workspace') {
          return jsonRes({
            workspace: { id: 'ws-1' },
            currentMemberId: 'm-1',
            members: [
              { id: 'm-0', user_id: 'u-0', email: 'other@dial8.ai', display_name: 'Other', avatar_url: null },
              { id: 'm-1', user_id: 'u-1', email: 'liam@dial8.ai', display_name: 'Liam', avatar_url: 'https://cdn/avatar.png' },
            ],
          })
        }
        if (url === '/api/account/profile') return jsonRes({ avatar_url: null })
        return jsonRes({})
      }),
    )

    await act(async () => {
      root.render(h(WorkspaceCacheProvider, null, h(Probe)))
    })

    expect(memberId).toBe('m-1')
    expect(profile).toEqual({
      memberId: 'm-1',
      displayName: 'Liam',
      avatarUrl: 'https://cdn/avatar.png',
    })
  })

  it('reports nulls until the cache resolves (the caller falls back to a disabled/guest identity)', async () => {
    // A workspace fetch that never resolves during the assertion window.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )

    await act(async () => {
      root.render(h(WorkspaceCacheProvider, null, h(Probe)))
    })

    expect(memberId).toBeNull()
    expect(profile).toEqual({ memberId: null, displayName: null, avatarUrl: null })
  })

  it('refetches on an SPA workspace switch — the member identity follows the NEW workspace', async () => {
    // Member rows are workspace-scoped. The cache is fetched once at startup;
    // useSwitchWorkspace's commit fn must refresh() it (mirroring
    // handleWorkspaceCreated) or the panel keeps building comment identities
    // from workspace A's member row after switching to B.
    let switchTo: ReturnType<typeof useSwitchWorkspace> | null = null
    function SwitchProbe() {
      profile = useCurrentMemberProfile()
      memberId = useCurrentMemberId()
      switchTo = useSwitchWorkspace()
      return null
    }

    const workspaceList = {
      workspaces: [
        { id: 'ws-1', name: 'Native Intelligence', slug: 'dial8', logo_url: null, plan: 'pro', role: 'owner' },
        { id: 'ws-2', name: 'Side', slug: 'side', logo_url: null, plan: 'free', role: 'member' },
      ],
    }
    // Which workspace the "server" answers for. In production the interceptor
    // resolves this from the x-workspace-id header; the interceptor module is
    // mocked here, so the stub flips on the setClientWorkspaceId(ws-2) call the
    // commit fn makes BEFORE refresh() — asserting that ordering is exactly
    // what proves refresh() fetches AS the switched workspace.
    const workspaceById: Record<string, unknown> = {
      'ws-1': {
        workspace: { id: 'ws-1' },
        currentMemberId: 'mA',
        members: [{ id: 'mA', user_id: 'u-1', email: 'liam@dial8.ai', display_name: 'Liam @ Native Intelligence', avatar_url: 'https://cdn/a.png' }],
      },
      'ws-2': {
        workspace: { id: 'ws-2' },
        currentMemberId: 'mB',
        members: [{ id: 'mB', user_id: 'u-1', email: 'liam@dial8.ai', display_name: 'Liam @ Side', avatar_url: 'https://cdn/b.png' }],
      },
    }
    let activeWorkspace = 'ws-1'
    vi.mocked(setClientWorkspaceId).mockImplementation((id: string | null) => {
      if (id) activeWorkspace = id
    })
    const workspaceFetches: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/account/workspace/list') return jsonRes(workspaceList)
        if (url === '/api/account/workspace') {
          workspaceFetches.push(activeWorkspace)
          return jsonRes(workspaceById[activeWorkspace])
        }
        if (url === '/api/account/profile') return jsonRes({ avatar_url: null })
        if (url === '/api/account/workspace/switch') return jsonRes({ ok: true })
        return jsonRes({})
      }),
    )

    await act(async () => {
      root.render(h(WorkspaceCacheProvider, null, h(SwitchProbe)))
    })
    expect(memberId).toBe('mA')
    expect(profile!.displayName).toBe('Liam @ Native Intelligence')
    expect(workspaceFetches).toEqual(['ws-1'])

    await act(async () => {
      switchTo!('ws-2')
    })

    // The switch triggered a second workspace fetch, sent AS ws-2 (interceptor
    // updated before refresh), and the member identity now reflects ws-2's row.
    expect(workspaceFetches).toEqual(['ws-1', 'ws-2'])
    expect(memberId).toBe('mB')
    expect(profile).toEqual({
      memberId: 'mB',
      displayName: 'Liam @ Side',
      avatarUrl: 'https://cdn/b.png',
    })
  })
})
