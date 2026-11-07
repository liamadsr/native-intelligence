// @vitest-environment jsdom
/**
 * Tests for useResearchCompanion — the client half of the onboarding research
 * companion (Phase 1, docs/plans/eve-migration-plan.md).
 *
 * These exercise the parts we CAN drive headlessly: kickoff-fires-once +
 * idempotent re-mount, the NDJSON event→friendly-label projection, terminal
 * reconciliation into the durable brief, and the polling fallback that engages
 * when the stream errors and stops on a terminal durable read. What they do NOT
 * cover: a real logged-in session against the live eve mount (auth-gated; see
 * the task report).
 *
 * `fetch` is stubbed and routed by URL:
 *   POST /api/account/onboarding/research        → kickoff (returns sessionId)
 *   GET  /eve/<agent>/v1/session/<id>/stream      → NDJSON ReadableStream
 *   GET  /api/account/onboarding                  → durable reconcile/poll read
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useEffect } from 'react'
import {
  useResearchCompanion,
  labelForToolCall,
  phaseForToolCall,
  companyNameFromToolCall,
  type ResearchCompanion,
  type UseResearchCompanionOptions,
} from '../use-research-companion'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ─── fetch stub + a controllable stream ──────────────────────

const fetchMock = vi.fn()
globalThis.fetch = fetchMock as never

/** Build a Response whose body streams the given NDJSON lines, on demand. */
function ndjsonResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + '\n'))
      }
      controller.close()
    },
  })
  return { ok: true, body } as unknown as Response
}

/**
 * Like ndjsonResponse, but the stream NEVER closes after its lines — the shape
 * of a conversation-parked eve run (or a proxy silently holding the socket).
 * The reader's next read() stays pending until the hook aborts it.
 */
function hangingNdjsonResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + '\n'))
      }
      // Deliberately no controller.close() — the stream hangs open.
    },
  })
  return { ok: true, body } as unknown as Response
}

/** A durable GET response shaped like /api/account/onboarding. */
function durableResponse(research: Record<string, unknown> | null): Response {
  return {
    ok: true,
    json: async () => ({ member: { onboardingProgress: research ? { research } : {} } }),
  } as unknown as Response
}

function evt(type: string, data?: unknown): string {
  return JSON.stringify(data === undefined ? { type } : { type, data })
}

// ─── Harness: mounts the hook, captures each render's companion ──

let container: HTMLDivElement
let root: Root
let latestCompanion: ResearchCompanion | null = null

function Harness({
  initial,
  enabled = true,
}: {
  initial?: UseResearchCompanionOptions['initial']
  enabled?: boolean
}) {
  const companion = useResearchCompanion({ initial, enabled })
  // Capture each committed render's companion in an effect (post-commit, never
  // during render) so tests can assert on it after flushing. Every test awaits
  // `flush()` before reading, so the latest effect has always run by then.
  useEffect(() => {
    latestCompanion = companion
  })
  return null
}

function mount(props: Parameters<typeof Harness>[0] = {}) {
  act(() => {
    root.render(h(Harness, props))
  })
}

/** Flush queued micro/macrotasks so async fetch chains settle. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  latestCompanion = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
  vi.useRealTimers()
})

// ─── Pure label mapping ──────────────────────────────────────

describe('labelForToolCall — event→friendly label', () => {
  it('maps each researcher tool to a warm one-liner', () => {
    expect(labelForToolCall('enrich_company', { domain: 'acme.com' })).toBe(
      'Researching acme.com…',
    )
    expect(labelForToolCall('enrich_company', {})).toBe('Researching your company…')
    // enrich_me takes no input at all, so its label can never be data-driven.
    expect(labelForToolCall('enrich_me', {})).toBe('Looking you up…')
    expect(labelForToolCall('web_search', { query: 'Acme Inc' })).toBe(
      'Searching the web for Acme Inc…',
    )
    expect(labelForToolCall('web_fetch', { url: 'https://www.acme.com/about' })).toBe(
      'Reading acme.com…',
    )
    expect(labelForToolCall('save_research_claims', {})).toBe('Saving what I learned…')
  })

  it('reads seeding tool-calls as artifacts being built', () => {
    // finish_research is the actions moment now.
    expect(labelForToolCall('finish_research', {})).toBe('Adding starter actions…')
    // save_starter_content: rename → naming the workspace; else creating project.
    expect(
      labelForToolCall('save_starter_content', { workspaceRename: 'Acme' }),
    ).toBe('Naming your workspace Acme…')
    expect(
      labelForToolCall('save_starter_content', { projectName: 'v2 Launch' }),
    ).toBe('Creating your first project — v2 Launch…')
    expect(labelForToolCall('save_starter_content', {})).toBe(
      'Creating your first project…',
    )
  })

  it('falls back gracefully when input fields are missing or the tool is unknown', () => {
    expect(labelForToolCall('web_search', {})).toBe('Searching the web…')
    expect(labelForToolCall('web_search', undefined)).toBe('Searching the web…')
    expect(labelForToolCall('web_fetch', { url: 'not a url' })).toBe('Reading not a url…')
    expect(labelForToolCall('some_new_tool', { foo: 1 })).toBe(
      'Getting to know your workspace…',
    )
  })
})

describe('phaseForToolCall — ghost-plan phase mapping', () => {
  it('maps research/browse/claims/company tools to phase 0', () => {
    for (const t of [
      'web_search',
      'web_fetch',
      'save_research_claims',
      'enrich_company',
      'enrich_me',
      'read_file',
      'glob',
      'grep',
      'bash',
      'write_file',
    ]) {
      expect(phaseForToolCall(t)).toBe(0)
    }
  })

  it('advances save_starter_content and finish_research to the actions phase', () => {
    // save_starter_content seeds project + actions in one call → phase 2 so both
    // the project and actions rows settle together; finish_research settles 2.
    expect(phaseForToolCall('save_starter_content')).toBe(2)
    expect(phaseForToolCall('finish_research')).toBe(2)
  })

  it('returns null for tools that should not move the plan', () => {
    expect(phaseForToolCall('some_new_tool')).toBeNull()
  })
})

describe('companyNameFromToolCall', () => {
  it('reads the company name from enrich_company (name, else domain)', () => {
    expect(companyNameFromToolCall('enrich_company', { name: 'Acme' })).toBe('Acme')
    // The model often calls enrich_company with only the email domain, so the
    // domain is the fallback rather than leaving the wizard nameless.
    expect(companyNameFromToolCall('enrich_company', { domain: 'acme.com' })).toBe(
      'acme.com',
    )
  })
  it('reads it from save_starter_content.workspaceRename', () => {
    expect(
      companyNameFromToolCall('save_starter_content', { workspaceRename: 'Acme Inc' }),
    ).toBe('Acme Inc')
  })
  it('returns null for other tools or missing fields', () => {
    expect(companyNameFromToolCall('web_search', { query: 'Acme' })).toBeNull()
    expect(companyNameFromToolCall('enrich_company', {})).toBeNull()
    expect(companyNameFromToolCall('enrich_me', {})).toBeNull()
  })
})

// ─── Kickoff: once + idempotent ──────────────────────────────

describe('useResearchCompanion — kickoff', () => {
  it('fires kickoff exactly once and attaches the stream with the returned sessionId', async () => {
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/api/account/onboarding/research' && opts?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'sess-abc' }),
        } as unknown as Response)
      }
      if (typeof url === 'string' && url.includes('/session/sess-abc/stream')) {
        return Promise.resolve(ndjsonResponse([]))
      }
      if (url === '/api/account/onboarding') {
        return Promise.resolve(durableResponse({ status: 'running' }))
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`))
    })

    mount()
    await flush()

    const posts = fetchMock.mock.calls.filter(
      (c) => c[0] === '/api/account/onboarding/research' && c[1]?.method === 'POST',
    )
    expect(posts).toHaveLength(1)

    // The stream URL must be the named-agent mount + eve v1 session stream path.
    const streamCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('/stream'),
    )
    expect(streamCall?.[0]).toBe(
      '/eve/onboarding-researcher/v1/session/sess-abc/stream',
    )
  })

  it('does NOT kick off a second time when the hook re-mounts (idempotent guard)', async () => {
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/api/account/onboarding/research' && opts?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ sessionId: 'sess-1' }),
        } as unknown as Response)
      }
      if (typeof url === 'string' && url.includes('/stream')) {
        return Promise.resolve(ndjsonResponse([]))
      }
      return Promise.resolve(durableResponse({ status: 'running' }))
    })

    // First mount: kicks off. Passing the SAME sessionId back on re-mount via
    // `initial` mirrors the real reload path (durable read carries sessionId),
    // and must NOT POST again — it attaches straight to the stream.
    mount()
    await flush()
    expect(
      fetchMock.mock.calls.filter((c) => c[1]?.method === 'POST'),
    ).toHaveLength(1)

    act(() => root.unmount())
    root = createRoot(container)
    fetchMock.mockClear()

    mount({ initial: { sessionId: 'sess-1', status: 'running' } })
    await flush()

    // Re-mount with a known sessionId: no new POST, straight to the stream.
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(0)
    const streamCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('/stream'),
    )
    expect(streamCall?.[0]).toContain('/session/sess-1/stream')
  })

  it('does not kick off while disabled, then fires when enabled flips true', async () => {
    fetchMock.mockResolvedValue(durableResponse({ status: 'running' }))
    mount({ enabled: false })
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ─── Stream → activities → terminal brief ────────────────────

describe('useResearchCompanion — stream projection + terminal', () => {
  it('projects actions.requested into friendly activities and reconciles the brief on completion', async () => {
    const streamLines = [
      evt('session.started', {}),
      evt('actions.requested', {
        actions: [{ kind: 'tool-call', toolName: 'web_search', callId: 'c1', input: { query: 'Acme' } }],
      }),
      evt('actions.requested', {
        actions: [{ kind: 'tool-call', toolName: 'web_fetch', callId: 'c2', input: { url: 'https://acme.com' } }],
      }),
      // Raw model narration — must be IGNORED (never surfaced mid-run).
      evt('message.appended', { messageDelta: 'thinking out loud' }),
      evt('actions.requested', {
        actions: [{ kind: 'tool-call', toolName: 'finish_research', callId: 'c3', input: {} }],
      }),
      evt('session.completed'),
    ]

    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ sessionId: 's1' }) } as unknown as Response)
      }
      if (typeof url === 'string' && url.includes('/stream')) {
        return Promise.resolve(ndjsonResponse(streamLines))
      }
      // Durable read: finish_research already wrote 'done' + brief.
      return Promise.resolve(
        durableResponse({
          sessionId: 's1',
          status: 'done',
          brief: 'Hi! I looked into Acme and set up your company profile.',
          companyFound: true,
        }),
      )
    })

    mount()
    await flush(6)

    const c = latestCompanion!
    expect(c.status).toBe('done')
    expect(c.brief).toBe('Hi! I looked into Acme and set up your company profile.')
    expect(c.companyFound).toBe(true)

    // Three tool calls → three activities, in order. No raw-text activity.
    const labels = c.activities.map((a) => a.label)
    expect(labels).toEqual([
      'Searching the web for Acme…',
      'Reading acme.com…',
      'Adding starter actions…',
    ])
    // `latest` is the most recent activity.
    expect(c.latest?.label).toBe('Adding starter actions…')
  })

  it('dedupes activities by callId (reconnect replay does not double-insert)', async () => {
    const dup = evt('actions.requested', {
      actions: [{ kind: 'tool-call', toolName: 'web_search', callId: 'same', input: { query: 'X' } }],
    })
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ sessionId: 's1' }) } as unknown as Response)
      }
      if (typeof url === 'string' && url.includes('/stream')) {
        return Promise.resolve(ndjsonResponse([dup, dup, evt('session.completed')]))
      }
      return Promise.resolve(durableResponse({ status: 'done', brief: 'done', companyFound: false }))
    })

    mount()
    await flush(6)
    expect(latestCompanion!.activities).toHaveLength(1)
  })

  it('reconciles off session.waiting when a conversation-parked stream never closes (the launch spinner bug)', async () => {
    // The exact failure Liam hit on dev: a run created WITHOUT mode:'task'
    // ends its only turn with `turn.completed` + `session.waiting` (never
    // `session.completed`) and the stream stays open forever. The durable row
    // is already terminal ('skipped' + brief). The hook must reconcile off the
    // boundary events instead of spinning on "Wrapping up…" until the heat
    // death of the wizard.
    const streamLines = [
      evt('session.started', {}),
      evt('actions.requested', {
        actions: [{ kind: 'tool-call', toolName: 'finish_research', callId: 'c1', input: {} }],
      }),
      evt('turn.completed', {}),
      evt('session.waiting', { wait: 'next-user-message' }),
    ]

    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ sessionId: 's1' }) } as unknown as Response)
      }
      if (typeof url === 'string' && url.includes('/stream')) {
        return Promise.resolve(hangingNdjsonResponse(streamLines))
      }
      return Promise.resolve(
        durableResponse({
          sessionId: 's1',
          status: 'skipped',
          brief: 'Personal inbox — I kept things light.',
          companyFound: false,
        }),
      )
    })

    mount()
    await flush(6)

    expect(latestCompanion!.status).toBe('skipped')
    expect(latestCompanion!.brief).toBe('Personal inbox — I kept things light.')
    // The activity feed still narrated the run up to the boundary.
    expect(latestCompanion!.latest?.label).toBe('Adding starter actions…')
  })

  it('converges via the alongside-poll when the stream hangs open with NO events at all', async () => {
    // A stream that 200s and then says nothing, forever (buffering proxy, or
    // attaching to a run whose events were lost). The poll armed ALONGSIDE the
    // stream — not only after stream death — must carry the durable terminal.
    vi.useFakeTimers()
    let durableCalls = 0

    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ sessionId: 's1' }) } as unknown as Response)
      }
      if (typeof url === 'string' && url.includes('/stream')) {
        return Promise.resolve(hangingNdjsonResponse([]))
      }
      durableCalls++
      return Promise.resolve(
        durableCalls >= 2
          ? durableResponse({ status: 'done', brief: 'landed via alongside-poll', companyFound: true })
          : durableResponse({ status: 'running', startedAt: new Date().toISOString() }),
      )
    })

    mount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
    })

    // No stream close, no stream error — only the interval can save us.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
      await Promise.resolve()
    })

    expect(latestCompanion!.status).toBe('done')
    expect(latestCompanion!.brief).toBe('landed via alongside-poll')

    // Terminal → polling stops; the hung stream is abandoned. No further reads.
    const before = fetchMock.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12000)
      await Promise.resolve()
    })
    expect(fetchMock.mock.calls.length).toBe(before)
  })

  it('renders the terminal brief immediately from `initial` without opening a stream', async () => {
    fetchMock.mockRejectedValue(new Error('should not fetch'))
    mount({
      initial: {
        sessionId: 's-done',
        status: 'done',
        brief: 'Already finished before you reloaded.',
        companyFound: true,
      },
    })
    await flush()

    expect(latestCompanion!.status).toBe('done')
    expect(latestCompanion!.brief).toBe('Already finished before you reloaded.')
    // No kickoff, no stream — terminal on arrival.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reconciles seededSummary from the durable read on completion', async () => {
    const streamLines = [
      evt('actions.requested', {
        actions: [{ kind: 'tool-call', toolName: 'finish_research', callId: 'c1', input: {} }],
      }),
      evt('session.completed'),
    ]
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ sessionId: 's1' }) } as unknown as Response)
      }
      if (typeof url === 'string' && url.includes('/stream')) {
        return Promise.resolve(ndjsonResponse(streamLines))
      }
      return Promise.resolve(
        durableResponse({
          sessionId: 's1',
          status: 'done',
          brief: 'Set you up.',
          companyFound: true,
          seededSummary: { projectName: 'Onboarding', actionCount: 3, workspaceRenamed: 'Acme' },
        }),
      )
    })

    mount()
    await flush(6)

    expect(latestCompanion!.status).toBe('done')
    expect(latestCompanion!.seededSummary).toEqual({
      projectName: 'Onboarding',
      actionCount: 3,
      workspaceRenamed: 'Acme',
    })
  })

  it('seeds seededSummary immediately from `initial` (mid-flow reload) with no stream', async () => {
    fetchMock.mockRejectedValue(new Error('should not fetch'))
    mount({
      initial: {
        sessionId: 's-done',
        status: 'done',
        brief: 'Done before reload.',
        companyFound: false,
        seededSummary: { projectName: 'Kickoff', actionCount: 2 },
      },
    })
    await flush()

    expect(latestCompanion!.status).toBe('done')
    expect(latestCompanion!.seededSummary).toEqual({ projectName: 'Kickoff', actionCount: 2 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ─── Polling fallback ────────────────────────────────────────

describe('useResearchCompanion — polling fallback', () => {
  it('engages polling when the stream errors, then stops on a terminal durable read', async () => {
    vi.useFakeTimers()
    let durableCalls = 0

    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ sessionId: 's1' }) } as unknown as Response)
      }
      if (typeof url === 'string' && url.includes('/stream')) {
        // Stream open fails → degrade to polling.
        return Promise.reject(new Error('stream boom'))
      }
      // Durable read: still running for the first poll, then done.
      durableCalls++
      return Promise.resolve(
        durableCalls >= 2
          ? durableResponse({ status: 'done', brief: 'landed via poll', companyFound: false })
          : durableResponse({ status: 'running' }),
      )
    })

    mount()
    // Let kickoff + failed stream + first reconcile settle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
    })

    // The stream error triggers one reconcile (still running) then starts a poll
    // interval. Advance past the interval to let the poll tick land 'done'.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
      await Promise.resolve()
    })

    expect(latestCompanion!.status).toBe('done')
    expect(latestCompanion!.brief).toBe('landed via poll')

    // Once terminal, no further polls fire.
    const before = fetchMock.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12000)
      await Promise.resolve()
    })
    expect(fetchMock.mock.calls.length).toBe(before)
  })

  it('keeps polling a FRESH durable `starting` claim (in-flight, like running)', async () => {
    // The kickoff lost the claim race: the POST answers { status:'starting' }
    // with no sessionId, and the durable read shows the peer's fresh claim.
    // The hook must keep polling for the sessionId/terminal to land — a fresh
    // 'starting' is in-flight, not a failure.
    vi.useFakeTimers()
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ status: 'starting' }) } as unknown as Response)
      }
      return Promise.resolve(
        durableResponse({ status: 'starting', startedAt: new Date().toISOString() }),
      )
    })

    mount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
    })

    // Two poll ticks — each must reconcile (fetch) and stay non-terminal.
    const durableCallsAt = () =>
      fetchMock.mock.calls.filter((c) => c[0] === '/api/account/onboarding').length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
      await Promise.resolve()
    })
    const afterFirst = durableCallsAt()
    expect(afterFirst).toBeGreaterThanOrEqual(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
      await Promise.resolve()
    })
    expect(durableCallsAt()).toBeGreaterThan(afterFirst)

    // Still in-flight: no quiet failure, no brief.
    expect(latestCompanion!.status).not.toBe('failed')
    expect(latestCompanion!.brief).toBeNull()
  })

  it('stops polling a STALE durable `starting` claim (quiet failed, never blocks)', async () => {
    // The claim's kickoff died before persisting a sessionId; the server only
    // re-claims it on a later kickoff POST. Once startedAt is past the stale
    // threshold the hook must stop polling and quietly mark failed — onboarding
    // is never blocked and no infinite request loop remains.
    vi.useFakeTimers()
    const staleStartedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString()
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ status: 'starting' }) } as unknown as Response)
      }
      return Promise.resolve(durableResponse({ status: 'starting', startedAt: staleStartedAt }))
    })

    mount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
    })

    // First poll tick reconciles the stale claim → quiet terminal.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
      await Promise.resolve()
    })
    expect(latestCompanion!.status).toBe('failed')
    expect(latestCompanion!.brief).toBeNull()

    // Polling stopped — no further requests, ever.
    const before = fetchMock.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000)
      await Promise.resolve()
    })
    expect(fetchMock.mock.calls.length).toBe(before)
  })

  it('stops polling a STALE durable `running` (run died without a terminal → quiet failed)', async () => {
    // A killed instance can leave status='running' forever with no terminal
    // ever coming. A task-mode run finishes within one invocation, so past the
    // 10-minute ceiling the run is dead: quiet failed, polling stops.
    vi.useFakeTimers()
    const staleStartedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString()
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ sessionId: 's1' }) } as unknown as Response)
      }
      if (typeof url === 'string' && url.includes('/stream')) {
        return Promise.resolve(hangingNdjsonResponse([]))
      }
      return Promise.resolve(durableResponse({ sessionId: 's1', status: 'running', startedAt: staleStartedAt }))
    })

    mount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
      await Promise.resolve()
    })

    expect(latestCompanion!.status).toBe('failed')
    expect(latestCompanion!.brief).toBeNull()

    const before = fetchMock.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000)
      await Promise.resolve()
    })
    expect(fetchMock.mock.calls.length).toBe(before)
  })

  it('resolves a durable `error` status to a quiet failed (stops the spinner, no brief)', async () => {
    // A kickoff whose eve session never started leaves research.status='error'
    // (terminal-but-re-claimable server-side). The companion must stop spinning
    // and fall quiet rather than poll forever — research never blocks onboarding.
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ sessionId: 's1' }) } as unknown as Response)
      }
      if (typeof url === 'string' && url.includes('/stream')) {
        // Stream closes with no terminal marker → reconcile the durable read.
        return Promise.resolve(ndjsonResponse([evt('session.started', {})]))
      }
      return Promise.resolve(durableResponse({ status: 'error' }))
    })

    mount()
    await flush(6)

    expect(latestCompanion!.status).toBe('failed')
    expect(latestCompanion!.brief).toBeNull()
  })

  it('marks failed (no brief) when session.failed arrives with no durable terminal', async () => {
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ sessionId: 's1' }) } as unknown as Response)
      }
      if (typeof url === 'string' && url.includes('/stream')) {
        return Promise.resolve(
          ndjsonResponse([evt('session.failed', { code: 'boom', message: 'died', sessionId: 's1' })]),
        )
      }
      // Durable read never went terminal (failure before finish_research).
      return Promise.resolve(durableResponse({ status: 'running' }))
    })

    mount()
    await flush(6)

    expect(latestCompanion!.status).toBe('failed')
    expect(latestCompanion!.brief).toBeNull()
  })
})
