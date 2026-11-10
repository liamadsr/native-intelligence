// @vitest-environment jsdom
/**
 * The action detail panel follows a server-side agent run WITHOUT polling
 * (docs/plans/agent-orchestration-product.md §1.2, Sequence row 4).
 *
 * It used to re-read the action every 5 s while a run was working/starting
 * (gated to a drawn window). Now:
 *  - the run status arrives as an `actions` row event on the entity bus, which
 *    the panel already patched (onEntityUpdated);
 *  - the linked PRs ride an `action_github_pr action_id=eq.<action>` channel
 *    (migration 283 added the table to the publication), and the working →
 *    pr_open transition refetches them too;
 *  - a dropped-and-restored channel re-reads the run fields and the PRs.
 *
 * useRowChanges is mocked to capture the binding, so the channel's callbacks
 * are driven directly. The panel's editor, run view and pickers are stubbed to
 * markers, as in the push-menu suite next door.
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

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceId: () => 'ws-1',
  useCurrentMemberId: () => 'm-1',
  useWorkspaces: () => ({ workspaces: [], currentId: 'ws-1', refresh: vi.fn() }),
  useSwitchWorkspace: () => vi.fn(),
}))
vi.mock('../../settings-overlay', () => ({ useSettingsOverlay: () => ({ openSettings: vi.fn() }) }))
vi.mock('../note-editor', () => ({ NoteEditor: () => h('div', { 'data-note-editor': '' }) }))
vi.mock('../cloud-run-view', () => ({ CloudRunView: () => h('div', { 'data-cloud-run': '' }) }))
vi.mock('@/components/work/entity-activity-tab', () => ({
  EntityActivitySection: (p: { entityType: string; entityId: string }) => h('div', { 'data-agents-tab': `${p.entityType}:${p.entityId}` }),
}))
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
const rowChannels = vi.hoisted(() => [] as Array<{
  table: string
  filter: string | null
  events?: readonly string[]
  onRow: (row: Record<string, unknown>) => void
  onResync?: () => void
}>)
vi.mock('@/hooks/use-row-changes', () => ({
  useRowChanges: (opts: (typeof rowChannels)[number]) => {
    rowChannels.push(opts)
  },
}))
vi.mock('@/lib/cached-fetch', () => ({
  cachedJson: async (url: string) => {
    const res = await fetch(url)
    return res.ok ? res.json() : null
  },
}))

import { ActionDetailPanel } from '../action-detail-panel'

const DETAIL_URL = '/api/account/actions/act-1'

let runStatus = 'working'
const action = () => ({
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
  assignee_ai_member_id: 'ai-1',
  assignee_ai_member_name: 'Builder',
  assignee_ai_member_avatar: null,
  agent_run_status: runStatus,
  labels: [],
  external_links: [],
})

let calls: string[] = []

function installFetch() {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input)
      calls.push(url)
      if (url === DETAIL_URL) {
        return { ok: true, status: 200, json: async () => ({ action: action() }) }
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

const detailCalls = () => calls.filter((u) => u === DETAIL_URL).length

let container: HTMLDivElement
let root: Root

/** The panel inside a card of the chat. */
async function render(_opts: Record<string, never> = {}) {
  await act(async () => {
    root.render(h(ActionDetailPanel, { actionId: 'act-1', onClose: vi.fn() }))
  })
  await act(async () => {
    await Promise.resolve()
  })
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  rowChannels.length = 0
  runStatus = 'working'
  installFetch()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const prsCalls = () => calls.filter((u) => u === `${DETAIL_URL}/prs`).length
/** The latest binding the panel holds for a table (re-renders re-register). */
const channel = (table: string) => [...rowChannels].reverse().find((c) => c.table === table)!

describe('ActionDetailPanel — a live agent run without polling', () => {
  it('never re-reads the action on a timer while the run is working', async () => {
    await render({})
    const mounted = detailCalls()
    expect(mounted).toBeGreaterThanOrEqual(1)
    await advance(60_000)
    expect(detailCalls()).toBe(mounted)
  })

  it('binds the linked PRs by action, including deletes', async () => {
    await render({})
    const prs = channel('action_github_pr')
    expect(prs.filter).toBe('action_id=eq.act-1')
    expect(prs.events).toEqual(['INSERT', 'UPDATE', 'DELETE'])
  })

  it('refetches the PR list when a PR row changes', async () => {
    await render({})
    const before = prsCalls()
    await act(async () => {
      channel('action_github_pr').onRow({ id: 'pr-1', action_id: 'act-1', status: 'open' })
    })
    expect(prsCalls()).toBe(before + 1)
  })

  it('refetches the PR list on the working → pr_open transition from the entity bus', async () => {
    await render({})
    const before = prsCalls()
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('ni:entity-updated', {
          detail: { entityType: 'action', id: 'act-1', fields: { agent_run_status: 'pr_open' } },
        }),
      )
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(prsCalls()).toBe(before + 1)
    // A second, unrelated update does not refetch again.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('ni:entity-updated', {
          detail: { entityType: 'action', id: 'act-1', fields: { title: 'Renamed' } },
        }),
      )
    })
    expect(prsCalls()).toBe(before + 1)
  })

  it('a restored channel re-reads the run fields and the PRs (what the poll used to cover)', async () => {
    await render({})
    const detailBefore = detailCalls()
    const prsBefore = prsCalls()
    await act(async () => {
      channel('action_github_pr').onResync?.()
    })
    expect(detailCalls()).toBe(detailBefore + 1)
    expect(prsCalls()).toBe(prsBefore + 1)
  })

  it('offers an Agents tab beside Details, which shows the agents that worked on the action (row 10)', async () => {
    await render({})
    const pill = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Agents') as HTMLButtonElement
    expect(pill).toBeTruthy()
    expect(container.querySelector('[data-agents-tab]')).toBeNull()
    await act(async () => pill.click())
    await advance(50)
    expect(container.querySelector('[data-agents-tab]')?.getAttribute('data-agents-tab')).toBe('action:act-1')
    expect(container.querySelector('[data-note-editor]')).toBeNull()
  })
})
