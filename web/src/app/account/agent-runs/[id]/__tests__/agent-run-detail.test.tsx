// @vitest-environment jsdom
/**
 * AgentRunDetail (the notification deep-link surface, /account/agent-runs/[id]).
 * Phase-3 fixes pinned here:
 *   - a terminal deep-linked run fetches the by-id route ONCE on mount (the
 *     server page's initialRun omits can_chat/pending_input), so the follow-up
 *     chat appears even though the run is not live and the poll never starts;
 *   - the needs_input status icon pulses (STATUS_META.pulse), matching the
 *     drill-in surface.
 *
 * Mounted standalone with createRoot (mirrors run-question-section.test).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no ResizeObserver; the follow-up chat's composer is built on the
// main chat's PromptInputTextarea, which observes the field's width.
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// Row 4: the page is live over its own agent_run channel instead of a 2.5 s
// poll. Captured so a test can push a row through it.
const rowChannels = vi.hoisted(
  () => [] as Array<{ table: string; filter: string | null; onRow: (row: Record<string, unknown>) => void; onResync?: () => void }>,
)
vi.mock('@/hooks/use-row-changes', () => ({
  useRowChanges: (opts: (typeof rowChannels)[number]) => {
    rowChannels.push(opts)
  },
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { AgentRunDetail } from '../agent-run-detail'

let container: HTMLDivElement
let root: Root

/** A terminal work run as the server page would hydrate it — WITHOUT the
 *  API-only derived fields (can_chat, pending_input). */
function terminalInitialRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    kind: 'workspace',
    status: 'completed',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    result_summary: 'Drafted the follow-up email.',
    task_prompt: 'Draft a follow-up email',
    deliverables: [],
    resources: [],
    log_tail: '',
    sandbox_id: 'eve:sess-1',
    action_id: null,
    flow_id: null,
    agent_recipe: null,
    flow: null,
    action: null,
    ...overrides,
  }
}

function ndjsonResponse(lines: string[]): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l))
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

describe('AgentRunDetail — mount fetch reveals follow-up chat on terminal runs', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    // by-id route returns can_chat: true; the nested RunFollowUpChat GET /chat
    // returns an empty replay.
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.endsWith('/chat') && (!init || !init.method)) {
        return ndjsonResponse([])
      }
      return new Response(
        JSON.stringify({ run: { ...terminalInitialRun(), can_chat: true } }),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('fetches the by-id route on mount for a terminal run (poll would never start)', async () => {
    await act(async () => {
      root.render(h(AgentRunDetail, { runId: 'run-1', initialRun: terminalInitialRun() as never }))
      await flush()
    })
    const byId = fetchMock.mock.calls.filter(
      ([url]) => url === '/api/account/agent-runs/run-1',
    )
    expect(byId.length).toBeGreaterThanOrEqual(1)
  })

  it('renders the follow-up chat section once can_chat arrives from the mount fetch', async () => {
    await act(async () => {
      root.render(h(AgentRunDetail, { runId: 'run-1', initialRun: terminalInitialRun() as never }))
      await flush()
    })
    expect(container.textContent || '').toContain('Ask about this run')
  })

  it('pulses the needs_input status icon (STATUS_META.pulse parity with the drill-in)', async () => {
    // by-id returns a parked run this time.
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.endsWith('/chat') && (!init || !init.method)) {
        return ndjsonResponse([])
      }
      return new Response(
        JSON.stringify({
          run: {
            ...terminalInitialRun({ status: 'needs_input', finished_at: null, can_chat: false }),
          },
        }),
        { status: 200 },
      )
    })
    await act(async () => {
      root.render(
        h(AgentRunDetail, {
          runId: 'run-1',
          initialRun: terminalInitialRun({ status: 'needs_input', finished_at: null }) as never,
        }),
      )
      await flush()
    })
    // The header status icon carries animate-pulse for needs_input.
    const pulsing = container.querySelector('.animate-pulse')
    expect(pulsing).toBeTruthy()
  })
})

describe('AgentRunDetail — live over its own channel, with Stop (row 4)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let served: Record<string, unknown>
  const channel = () => [...rowChannels].reverse().find((c) => c.table === 'agent_run')!
  const byIdFetches = () => fetchMock.mock.calls.filter(([u, init]) => u === '/api/account/agent-runs/run-1' && !(init as RequestInit | undefined)?.method).length

  beforeEach(() => {
    rowChannels.length = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    served = terminalInitialRun({ status: 'running', finished_at: null, result_summary: null, log_tail: 'Reading the brief\n' })
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/cancel') && init?.method === 'POST') return new Response(JSON.stringify({ ok: true, status: 'canceling' }), { status: 200 })
      return new Response(JSON.stringify({ run: served }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  async function mount() {
    await act(async () => {
      root.render(h(AgentRunDetail, { runId: 'run-1', initialRun: served as never }))
      await flush()
    })
  }

  it('binds agent_run by id and patches the log tail in place, with no refetch', async () => {
    await mount()
    expect(channel().filter).toBe('id=eq.run-1')
    const before = byIdFetches()
    await act(async () => {
      channel().onRow({ id: 'run-1', status: 'running', log_tail: 'Reading the brief\n[tool] search\n' })
      await flush()
    })
    expect(container.textContent).toContain('[tool] search')
    expect(byIdFetches()).toBe(before)
  })

  it('a status transition refetches (can_chat and the joins come from the route)', async () => {
    await mount()
    const before = byIdFetches()
    served = { ...served, status: 'completed' }
    await act(async () => {
      channel().onRow({ id: 'run-1', status: 'completed' })
      await flush()
    })
    expect(byIdFetches()).toBe(before + 1)
  })

  it('Stop posts the run-scoped cancel and flips to Stopping… at once', async () => {
    await mount()
    const stop = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Stop')
    expect(stop).toBeDefined()
    await act(async () => {
      stop!.click()
      await flush()
    })
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    expect(post?.[0]).toBe('/api/account/agent-runs/run-1/cancel')
    expect(container.textContent).toContain('Stopping…')
  })

  it('offers no Stop on a finished run', async () => {
    served = terminalInitialRun()
    await mount()
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'Stop')).toBe(false)
  })
})
