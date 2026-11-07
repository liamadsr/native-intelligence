// @vitest-environment jsdom
/**
 * The action detail panel's external-task surface moved from a properties
 * SECTION to a toolbar MENU.
 *
 * The old "Asana" PropertyGroup had to render unconditionally to be
 * discoverable, so every workspace — including every workspace with no task
 * tracker at all — carried a permanent Asana block in the sidebar, and each new
 * provider would have added another one. These tests pin the replacement from
 * the outside:
 *
 *  - the toolbar carries a "Push to…" control,
 *  - there is NO Asana section left in the properties sidebar,
 *  - the link rows ride on the ONE action detail fetch — no per-provider probe
 *    requests (the panel used to fire three asana/jira/linear reads per open),
 *  - GitHub's section is untouched — this was a scoped removal, not a purge of
 *    the sidebar's integrations.
 *
 * The panel pulls in the editor, the run view and every picker, none of which
 * are under test here, so they're stubbed down to markers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

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
// Real cachedJson is a module-level SWR cache shared across tests.
vi.mock('@/lib/cached-fetch', () => ({
  cachedJson: async (url: string) => {
    const res = await fetch(url)
    return res.ok ? res.json() : null
  },
}))

import { ActionDetailPanel } from '../action-detail-panel'

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
  // The detail route embeds the external-task link rows — the panel's single
  // link source since the per-provider probes were removed.
  external_links: [],
}

let calls: string[] = []

function installFetch() {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input)
      calls.push(url)
      if (url === '/api/account/actions/act-1') {
        return { ok: true, status: 200, json: async () => ({ action: ACTION }) }
      }
      if (url.startsWith('/api/account/task-destinations')) {
        return { ok: true, status: 200, json: async () => ({ destinations: [] }) }
      }
      // Everything else the panel loads on mount — pickers, PRs, docs, runs.
      return {
        ok: true,
        status: 200,
        json: async () => ({
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

function buttonWithLabel(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === label,
  ) as HTMLButtonElement | undefined
}

beforeEach(async () => {
  vi.clearAllMocks()
  installFetch()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(h(ActionDetailPanel, { actionId: 'act-1', onClose: vi.fn() }))
  })
  // Let the mount fetches settle.
  await act(async () => {
    await Promise.resolve()
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ActionDetailPanel — external task surface', () => {
  it('renders the "Push to…" control in the toolbar', async () => {
    expect(buttonWithLabel('Push to…')).toBeTruthy()
  })

  it('has NO Asana properties section any more', async () => {
    // The section title lived in a PropertyGroup header; its push button read
    // "Push to Asana". Neither may survive in the sidebar.
    const headings = Array.from(container.querySelectorAll('div')).map((d) => d.textContent)
    expect(headings).not.toContain('Asana')
    const asanaButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Push to Asana'),
    )
    expect(asanaButton).toBeUndefined()
  })

  it('KEEPS the GitHub affordances', async () => {
    // The removal was scoped to Asana — GitHub's repo/PR affordances stay.
    // They no longer sit under a "GitHub" group header (the PR row moved into
    // Properties), so assert the affordance itself rather than the heading.
    expect(container.textContent).toContain('Link pull request')
  })

  it('resolves external-task links from the detail fetch — zero probe requests', async () => {
    // The panel used to fire three unconditional per-provider probe reads
    // (asana/jira/linear) on every open; the rows now ride on the one action
    // detail response. Any probe request here is a silent regression back to
    // three lambda invocations per next/back step.
    expect(
      calls.filter((u) => /\/api\/account\/actions\/act-1\/(asana|jira|linear)$/.test(u)),
    ).toHaveLength(0)
    expect(calls.filter((u) => u === '/api/account/actions/act-1')).toHaveLength(1)
  })
})
