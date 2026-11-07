// @vitest-environment jsdom
/**
 * The action panel's Cloud-run view follows its runs WITHOUT polling
 * (docs/plans/agent-orchestration-product.md §1.2, Sequence row 4): one
 * `agent_run action_id=eq.<action>` channel. A pushed row for a run the view
 * holds, at the same status, patches in place (log tail, parked question); a
 * run it does not hold yet, or a status transition, refetches the action's
 * agent-runs route for its joins. It used to re-read that route every 3 s.
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

const rowChannels = vi.hoisted(
  () =>
    [] as Array<{
      table: string
      filter: string | null
      onRow: (row: Record<string, unknown>) => void
      onResync?: () => void
    }>,
)
vi.mock('@/hooks/use-row-changes', () => ({
  useRowChanges: (opts: (typeof rowChannels)[number]) => {
    rowChannels.push(opts)
  },
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/app/account/(dashboard)/main-chat/main-chat-context', () => ({
  buildEntryForDetail: () => ({}),
}))
vi.mock('@/components/agent-run/run-chat', () => ({ RunChat: () => h('div', { 'data-run-chat': '' }) }))
vi.mock('@/components/agent-run/run-question-section', () => ({
  RunQuestionSection: () => h('div', { 'data-question': '' }),
}))

import { CloudRunView } from '../cloud-run-view'

const RUNS_URL = '/api/account/actions/act-1/agent-runs'

function codingRun(over: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    kind: 'coding',
    status: 'running',
    sandbox_id: 'sbx-1',
    repo_full_name: 'acme/app',
    pr_url: null,
    branch: 'fix-login',
    error_message: null,
    log_tail: 'cloning\n',
    created_at: '2026-09-26T10:00:00.000Z',
    started_at: '2026-09-26T10:00:01.000Z',
    finished_at: null,
    agent: null,
    ...over,
  }
}

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>
let served: unknown[]

const channel = () => [...rowChannels].reverse().find((c) => c.table === 'agent_run')!
const runFetches = () => fetchMock.mock.calls.filter(([u]) => u === RUNS_URL).length

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  rowChannels.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  served = [codingRun()]
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ runs: served }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

async function mount() {
  act(() => {
    root.render(h(CloudRunView, { actionId: 'act-1' }))
  })
  await flush()
  expect(runFetches()).toBe(1)
}

describe('CloudRunView — live without polling', () => {
  it('binds agent_run by action, and never re-reads on a timer', async () => {
    vi.useFakeTimers()
    try {
      await mount()
      expect(channel().filter).toBe('action_id=eq.act-1')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(runFetches()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('patches a held run at the same status in place (the log tail), with no refetch', async () => {
    await mount()
    await act(async () => {
      channel().onRow({ id: 'run-1', action_id: 'act-1', status: 'running', log_tail: 'cloning\nrunning tests\n' })
    })
    await flush()
    expect(container.textContent).toContain('running tests')
    expect(runFetches()).toBe(1)
  })

  it('refetches for a status transition and for a run it does not hold yet', async () => {
    await mount()
    await act(async () => {
      channel().onRow({ id: 'run-1', action_id: 'act-1', status: 'pr_open' })
    })
    await flush()
    expect(runFetches()).toBe(2)
    await act(async () => {
      channel().onRow({ id: 'run-2', action_id: 'act-1', status: 'queued' })
    })
    await flush()
    expect(runFetches()).toBe(3)
  })

  it('a restored channel refetches', async () => {
    await mount()
    await act(async () => {
      channel().onResync?.()
    })
    await flush()
    expect(runFetches()).toBe(2)
  })
})
