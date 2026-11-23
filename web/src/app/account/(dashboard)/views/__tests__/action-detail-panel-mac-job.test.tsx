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
import { resetEnvironmentStore } from '@/lib/local-agent/environment-client'
import { CardHeaderSlotsProvider } from '@/components/chat-cards/card-header-slot'
import { WindowPropertiesProvider } from '@/components/views/window-properties'

const DETAIL_URL = '/api/account/actions/act-1'
const SID = '5e1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7'

let runStatus = 'working'
let job: Record<string, unknown> | null = null
let startAnswer: Record<string, unknown> = {}
let placeAnswer: Record<string, unknown> = { onMac: null, coding: null }
let environments: unknown[] = []
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
      if (url === `${DETAIL_URL}/start-agent`) {
        // GET: where this person's Start runs; POST: the Start itself.
        if ((init?.method ?? 'GET') === 'GET') return { ok: true, status: 200, json: async () => placeAnswer }
        return { ok: true, status: 200, json: async () => startAnswer }
      }
      if (url === '/api/account/environments') return { ok: true, status: 200, json: async () => ({ environments: environments, defaultEnvironmentId: null }) }
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
  placeAnswer = { onMac: null, coding: null }
  environments = []
  // Each test reads its own Macs (the store caches the list).
  resetEnvironmentStore()
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
    const play = container.querySelector('[data-start-agent-place]') as HTMLButtonElement
    expect(play.getAttribute('aria-label')).toBe('Run agent in cloud: launch Builder to work on this task')
    await act(async () => play.click())
    for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    const post = calls.find((c) => c.url === `${DETAIL_URL}/start-agent`)!
    // Nothing to choose (no "Run my work here" read): no body, the Mac's saved choice applies.
    expect(post.init?.body).toBeUndefined()
    expect(q('[data-local-agent-panel]')?.getAttribute('data-local-agent-panel')).toBe(SID)
    expect(q('[data-action-mac-tab]')!.textContent).toContain('Codex')
  })

  it('the Start says where it runs: the cloud, or the Mac “Run my work here” names', async () => {
    runStatus = 'idle'
    environments = [
      {
        kind: 'mac', id: 'env-mac', name: 'Studio Mac', deviceId: 'dev-1', deviceName: 'Studio Mac', appVersion: '0.3.0',
        lastSeenAt: '2026-10-22T10:00:00Z', online: true, supportsBaseBranch: true, folders: [],
        createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
      },
    ]
    placeAnswer = { onMac: { environmentId: 'env-mac' }, coding: { projectId: 'proj-1', repo: 'acme/core' } }
    await render()
    const play = container.querySelector('[data-start-agent-place]') as HTMLButtonElement
    expect(play.getAttribute('data-start-agent-place')).toBe('mac')
    expect(play.getAttribute('aria-label')).toBe('Run on Studio Mac: launch Builder to work on this task')
    // Where it runs, beside it: the Mac (no folder linked to acme/core is flagged).
    const where = q('[data-start-agent-where]')!
    expect(where.textContent).toContain('on Studio Mac')
    expect(where.getAttribute('title')).toBe('No folder on Studio Mac is linked to acme/core.')
    // No git folder on that Mac at all: the Start says to add one, and sends nothing.
    await act(async () => play.click())
    for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(document.querySelector('[data-start-folder-choice-none]')!.textContent).toContain('Add the folder in the Native Intelligence app on your Mac')
    expect(calls.some((c) => c.url === `${DETAIL_URL}/start-agent` && c.init?.method === 'POST')).toBe(false)
  })

  it('a task that last ran in the cloud opens there, over the project default, and its Start sends the cloud', async () => {
    runStatus = 'idle'
    placeAnswer = { onMac: { environmentId: 'env-mac' }, coding: { projectId: 'proj-1', repo: 'acme/core' }, last: { environmentId: null, worker: null } }
    await render()
    const play = container.querySelector('[data-start-agent-place]') as HTMLButtonElement
    expect(play.getAttribute('aria-label')).toBe('Run agent in cloud: launch Builder to work on this task')
    await act(async () => play.click())
    for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    const post = calls.find((c) => c.url === `${DETAIL_URL}/start-agent` && c.init?.method === 'POST')!
    expect(JSON.parse(String(post.init?.body))).toEqual({ environmentId: null })
  })

  it('a picked Mac with no folder holding the repo: Start asks which folder, and the pick goes with the Start', async () => {
    runStatus = 'idle'
    environments = [
      {
        kind: 'mac', id: 'env-mac', name: 'Studio Mac', deviceId: 'dev-1', deviceName: 'Studio Mac', appVersion: '0.3.0',
        lastSeenAt: '2026-10-22T10:00:00Z', online: true, supportsBaseBranch: true,
        folders: [{ id: 'f-core', label: 'core', mode: 'edit', isGit: true, baseBranch: 'main', repoFullName: null }],
        createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
      },
    ]
    placeAnswer = { onMac: { environmentId: 'env-mac' }, coding: { projectId: 'proj-1', repo: 'acme/core' }, last: null }
    startAnswer = { mode: 'mac', worker: 'local_agent', sessionId: SID, mac: 'Studio Mac', folder: 'core', agent: null }
    await render()
    const play = container.querySelector('[data-start-agent-place]') as HTMLButtonElement
    await act(async () => play.click())
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    // Asked, not refused: nothing was sent yet.
    expect(calls.some((c) => c.url === `${DETAIL_URL}/start-agent` && c.init?.method === 'POST')).toBe(false)
    const choice = document.querySelector('[data-start-folder-choice]') as HTMLElement
    expect(choice.textContent).toContain('Which folder on Studio Mac holds acme/core?')
    // `core` matches the repo's name: preselected, but only the person's press starts it.
    expect(document.querySelector('[data-start-folder-option="f-core"]')!.getAttribute('aria-checked')).toBe('true')
    await act(async () => (document.querySelector('[data-start-folder-confirm]') as HTMLButtonElement).click())
    for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    const post = calls.find((c) => c.url === `${DETAIL_URL}/start-agent` && c.init?.method === 'POST')!
    expect(JSON.parse(String(post.init?.body))).toEqual({ environmentId: 'env-mac', folderId: 'f-core' })
  })
})

// Liam, 11-23: "these details view pages … that show the different pages at
// the top … feel out of place": in a card, the action's views are a capsule
// in the card's header, the Mac tab among them; the page's row is left empty.
describe('ActionDetailPanel — its views in a card’s header', () => {
  it('a capsule in the right slot (Details, Cloud run, the Mac, Agents); a press opens the Mac job; no row of pills in the page', async () => {
    job = { sessionId: SID, status: 'running', worker: 'claude-code', deviceName: 'Studio Mac', folderLabel: 'site', live: true }
    const right = document.createElement('div')
    document.body.appendChild(right)
    try {
      await act(async () => {
        root.render(
          h(CardHeaderSlotsProvider, { value: { left: null, right } }, h(WindowPropertiesProvider, null, h(ActionDetailPanel, { actionId: 'act-1', onClose: vi.fn() }))),
        )
      })
      for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(20) })
      const capsule = right.querySelector<HTMLElement>('[data-detail-tabs="header"]')!
      expect(capsule).not.toBeNull()
      expect(Array.from(capsule.querySelectorAll('[data-detail-tab]')).map((b) => b.getAttribute('data-detail-tab'))).toEqual(['details', 'cloud', 'mac', 'agents'])
      expect(capsule.querySelector('[data-detail-tab="details"]')!.getAttribute('aria-selected')).toBe('true')
      const mac = capsule.querySelector<HTMLButtonElement>('[data-action-mac-tab]')!
      expect(mac.textContent).toContain('Claude Code')
      expect(mac.querySelector('[data-action-mac-tab-working]')).not.toBeNull()
      // The page's own row holds nothing now (its actions are in the Properties popover).
      expect(q('[data-action-toolbar]')!.childNodes.length).toBe(0)
      expect(container.querySelector('[data-action-mac-tab]')).toBeNull()
      await act(async () => mac.click())
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      expect(mac.getAttribute('aria-selected')).toBe('true')
      expect(q('[data-local-agent-panel]')?.getAttribute('data-local-agent-panel')).toBe(SID)
    } finally {
      act(() => root.unmount())
      root = createRoot(container)
      right.remove()
    }
  })
})
