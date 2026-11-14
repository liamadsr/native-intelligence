// @vitest-environment jsdom
/**
 * The action detail panel and the person's own job for the action on their
 * Mac (migration 658): GET …/mac-job finds it, the "working" affordance and
 * a Mac tab (named for the coding agent doing the work) open its
 * LocalAgentPanel instead of the cloud-run view, and a Start that lands on
 * the Mac opens that panel rather than ending in a toast. The harness is the
 * agent-live suite's: the editor, run views and pickers stubbed to markers.
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
vi.mock('@/components/local-agent/local-agent-panel', () => ({
  LocalAgentPanel: (p: { sessionId: string }) => h('div', { 'data-local-agent-panel': p.sessionId }),
}))
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

import { ActionDetailPanel, parseActionMacJob } from '../action-detail-panel'

const DETAIL_URL = '/api/account/actions/act-1'
const SID = '5e1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7'

let runStatus = 'working'
let job: Record<string, unknown> | null = null
let startAnswer: Record<string, unknown> = {}
const action = () => ({
  id: 'act-1', identifier: 'ENG-42', title: 'Ship the thing', description: null, status_id: 'st-1', status_name: 'Todo',
  status_category: 'unstarted', status_color: '#888888', priority: 'none', team_id: 'team-1', project_id: null,
  assignee_ai_member_id: 'ai-1', assignee_ai_member_name: 'Builder', assignee_ai_member_avatar: null,
  agent_run_status: runStatus, labels: [], external_links: [],
})

let calls: Array<{ url: string; init?: RequestInit }> = []

function installFetch() {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url === DETAIL_URL) return { ok: true, status: 200, json: async () => ({ action: action() }) }
      if (url === `${DETAIL_URL}/mac-job`) return { ok: true, status: 200, json: async () => ({ job }) }
      if (url === `${DETAIL_URL}/start-agent`) return { ok: true, status: 200, json: async () => startAnswer }
      if (url.startsWith('/api/account/task-destinations')) return { ok: true, status: 200, json: async () => ({ destinations: [] }) }
      return {
        ok: true,
        status: 200,
        json: async () => ({ states: [], projects: [], documents: [], members: [], aiMembers: [], actions: [], relations: [], prs: [], runs: [], cycles: [], milestones: [] }),
      }
    }),
  )
}

let container: HTMLDivElement
let root: Root

async function render() {
  await act(async () => {
    root.render(h(ActionDetailPanel, { actionId: 'act-1', onClose: vi.fn() }))
  })
  for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(20) })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  rowChannels.length = 0
  runStatus = 'working'
  job = null
  startAnswer = {}
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

const q = (sel: string) => container.querySelector(sel) as HTMLElement | null

describe('ActionDetailPanel — the job on the person’s Mac', () => {
  it('parses the route’s job, and nothing else as one', () => {
    expect(parseActionMacJob({ job: { sessionId: SID, status: 'running', worker: 'claude-code', deviceName: 'Studio Mac', folderLabel: 'site', live: true } })).toEqual({
      sessionId: SID, status: 'running', worker: 'claude-code', deviceName: 'Studio Mac', folderLabel: 'site', live: true,
    })
    expect(parseActionMacJob({ job: { sessionId: SID, status: 'waiting', worker: '' } })).toMatchObject({ worker: null, live: false })
    for (const bad of [null, {}, { job: null }, { job: { status: 'running' } }]) expect(parseActionMacJob(bad)).toBeNull()
  })

  it('a live Mac job on the person’s own agent: the working affordance and its tab open the job’s panel, named for the agent', async () => {
    job = { sessionId: SID, status: 'running', worker: 'claude-code', deviceName: 'Studio Mac', folderLabel: 'site', live: true }
    await render()
    expect(calls.some((c) => c.url === `${DETAIL_URL}/mac-job`)).toBe(true)
    const tab = q('[data-action-mac-tab]')!
    expect(tab.textContent).toContain('Claude Code')
    const working = container.querySelector('[aria-label="View the job on your Mac"]') as HTMLButtonElement
    expect(working).toBeTruthy()
    await act(async () => working.click())
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(q('[data-local-agent-panel]')?.getAttribute('data-local-agent-panel')).toBe(SID)
    expect(q('[data-cloud-run]')).toBeNull()
  })

  it('the Mac tab spins only while the job starts or runs; idle for a message, it doesn’t', async () => {
    job = { sessionId: SID, status: 'running', worker: 'claude-code', deviceName: 'Studio Mac', folderLabel: 'site', live: true }
    await render()
    expect(q('[data-action-mac-tab-working]')).not.toBeNull()
    act(() => root.unmount())
    root = createRoot(container)
    job = { sessionId: SID, status: 'waiting', worker: 'claude-code', deviceName: 'Studio Mac', folderLabel: 'site', live: false }
    runStatus = 'idle'
    await render()
    expect(q('[data-action-mac-tab]')!.textContent).toContain('Claude Code')
    expect(q('[data-action-mac-tab-working]')).toBeNull()
  })

  it('no Mac job: no Mac tab, and the working affordance opens the cloud run as before', async () => {
    await render()
    expect(q('[data-action-mac-tab]')).toBeNull()
    expect(container.querySelector('[aria-label="View the running cloud job"]')).toBeTruthy()
  })

  it('a Start that lands on the Mac opens that job’s panel, not just a toast', async () => {
    runStatus = 'idle'
    startAnswer = { mode: 'mac', worker: 'local_agent', sessionId: SID, mac: 'Studio Mac', folder: 'site', agent: 'codex' }
    await render()
    const play = container.querySelector('[aria-label="Launch Builder to work on this task"]') as HTMLButtonElement
    await act(async () => play.click())
    for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    const post = calls.find((c) => c.url === `${DETAIL_URL}/start-agent`)!
    // Nothing to choose (no "Run my work here" read): no body, the Mac's saved choice applies.
    expect(post.init?.body).toBeUndefined()
    expect(q('[data-local-agent-panel]')?.getAttribute('data-local-agent-panel')).toBe(SID)
    expect(q('[data-action-mac-tab]')!.textContent).toContain('Codex')
  })
})
