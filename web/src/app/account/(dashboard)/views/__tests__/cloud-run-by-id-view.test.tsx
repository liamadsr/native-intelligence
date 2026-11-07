// @vitest-environment jsdom
/**
 * One run's view keyed by the run (CloudRunByIdView, bots-v2.md "Items
 * continue their run's chat"): what Open on an item a work run produced shows
 * in a tab. Read from the by-id route in the run's own workspace (the
 * x-workspace-id header: the bubble spans workspaces), live on its own
 * `agent_run id=eq.<run>` channel; settled and chattable, its follow-up chat
 * (RunChat, the same conversation the bubble replies into) fills the rest;
 * waiting on an answer, its question; a status transition reads it again.
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

const rowChannels = vi.hoisted(() => [] as Array<{ table: string; filter: string | null; onRow: (row: Record<string, unknown>) => void }>)
vi.mock('@/hooks/use-row-changes', () => ({
  useRowChanges: (opts: (typeof rowChannels)[number]) => {
    rowChannels.push(opts)
  },
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/app/account/(dashboard)/main-chat/main-chat-context', () => ({
  buildEntryForDetail: () => ({}),
}))
vi.mock('@/components/agent-run/run-chat', () => ({ RunChat: ({ runId }: { runId: string }) => h('div', { 'data-run-chat': runId }) }))
vi.mock('@/components/agent-run/run-question-section', () => ({
  RunQuestionSection: () => h('div', { 'data-question': '' }),
}))

import { CloudRunByIdView } from '../cloud-run-view'

function workRun(over: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    kind: 'workspace',
    status: 'completed',
    sandbox_id: 'eve:s1',
    repo_full_name: null,
    pr_url: null,
    branch: null,
    error_message: null,
    log_tail: '',
    created_at: '2026-10-01T10:00:00.000Z',
    started_at: '2026-10-01T10:00:01.000Z',
    finished_at: '2026-10-01T10:02:00.000Z',
    task_prompt: 'Draft a reply to Acme',
    result_summary: 'Here is an email I put together.',
    deliverables: [],
    resources: [],
    pending_input: null,
    can_chat: true,
    agent: { id: 'tm-1', name: 'Writer', avatar_url: null },
    action: null,
    ...over,
  }
}

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>
let served: Record<string, unknown>
const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })

beforeEach(() => {
  rowChannels.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  served = workRun()
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ run: served }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('CloudRunByIdView', () => {
  it('reads the run in its own workspace, shows what it did, and its follow-up chat once settled', async () => {
    act(() => root.render(h(CloudRunByIdView, { runId: 'run-1', workspaceId: 'ws-2' })))
    await flush()
    expect(fetchMock).toHaveBeenCalledWith('/api/account/agent-runs/run-1', expect.objectContaining({ headers: { 'x-workspace-id': 'ws-2' } }))
    expect(container.textContent).toContain('Here is an email I put together.')
    expect(container.querySelector('[data-run-chat]')!.getAttribute('data-run-chat')).toBe('run-1')
    expect(rowChannels.at(-1)!.filter).toBe('id=eq.run-1')
  })

  it('waiting on an answer: its question, no chat; a status transition reads it again', async () => {
    served = workRun({ status: 'needs_input', can_chat: false, pending_input: { questions: [] } })
    act(() => root.render(h(CloudRunByIdView, { runId: 'run-1', workspaceId: null })))
    await flush()
    expect(container.querySelector('[data-question]')).not.toBeNull()
    expect(container.querySelector('[data-run-chat]')).toBeNull()
    served = workRun()
    await act(async () => rowChannels.at(-1)!.onRow({ id: 'run-1', status: 'completed' }))
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[data-run-chat]')).not.toBeNull()
  })

  it('a run it can’t read says so, with a Retry', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Agent run not found' }), { status: 404 }))
    act(() => root.render(h(CloudRunByIdView, { runId: 'run-x', workspaceId: null })))
    await flush()
    expect(container.querySelector('[data-run-view-error]')!.textContent).toContain('Agent run not found')
  })

  it('Stop on a live run asks in the run’s own workspace (a run from another workspace than the current one stops too)', async () => {
    served = workRun({ status: 'running', can_chat: false, finished_at: null })
    act(() => root.render(h(CloudRunByIdView, { runId: 'run-1', workspaceId: 'ws-2' })))
    await flush()
    const stop = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Stop'))!
    await act(async () => stop.click())
    await flush()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/account/agent-runs/run-1/cancel',
      expect.objectContaining({ method: 'POST', headers: { 'x-workspace-id': 'ws-2' } }),
    )
  })
})
