// @vitest-environment jsdom
/**
 * Rehydration integration test for the onboarding wizard shell.
 *
 * Finding under regression: the research companion's `initial`-based fast path
 * (instant brief, NO kickoff POST, NO stream) was DEAD, because the wizard
 * called useResearchCompanion on a shell that always mounts with `initial: null`
 * (the GET /api/account/onboarding hasn't resolved on the first render, the only
 * render the hook's initializers consume `initial`). The fix splits the wizard:
 * OnboardingWizard loads data, and only once it lands mounts <WizardBody>, whose
 * FIRST render already carries the durable blob — so the hook seeds terminal
 * from it and skips kickoff.
 *
 * This test drives the REAL OnboardingWizard + WizardBody + the REAL
 * useResearchCompanion hook end-to-end in jsdom. Only the leaf STEP/companion
 * presentation modules are stubbed to inert placeholders — they carry timers
 * (skip-link/auto-advance) and data fetches irrelevant to this seam, and would
 * otherwise just add noise. The behavior under test lives entirely in the wizard
 * shell + hook wiring: after the GET resolves with research.status='done', the
 * kickoff POST is NEVER fired and the eve stream is NEVER opened.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

// hard-navigate — the wizard's ONLY navigation seam. Every wizard → dashboard
// hop is a full-document hardNavigate (never router.replace): a soft navigation
// can be served a stale client-cached /account payload that still redirects
// back to onboarding, which produced the production /account ↔
// /account/onboarding ping-pong. Mocked here because jsdom cannot navigate.
const hardNavigate = vi.fn()
vi.mock('../hard-navigate', () => ({
  hardNavigate: (path: string) => hardNavigate(path),
  DOCUMENT_SCOPE_HEADERS: { 'x-workspace-id': '' },
}))

// Stub the leaf step + companion modules to inert placeholders. This keeps the
// REAL wizard shell and REAL useResearchCompanion hook under test while dropping
// the step components' own timers/fetches (skip-link delay, loops panel fetch),
// which are unrelated to the rehydration seam and only add flakiness.
vi.mock('../onboarding-steps', () => {
  const React = require('react')
  return {
    PrimeStep: () => React.createElement('div', { 'data-step': 'prime' }),
    WorkingStep: () => React.createElement('div', { 'data-step': 'working' }),
  }
})

// framer-motion — render children directly, drop animation-only props.
vi.mock('framer-motion', () => {
  const React = require('react')
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        function MotionStub(props: Record<string, unknown>) {
          const { initial, animate, exit, transition, ...rest } = props as Record<
            string,
            unknown
          >
          void initial
          void animate
          void exit
          void transition
          return React.createElement(tag, rest)
        },
    },
  )
  return {
    motion,
    AnimatePresence: ({ children }: { children: unknown }) =>
      React.createElement(React.Fragment, null, children),
  }
})

import { OnboardingWizard } from '../onboarding-wizard'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fetchMock = vi.fn()
globalThis.fetch = fetchMock as never

/** A GET /api/account/onboarding response with the given research blob. */
function onboardingResponse(research: Record<string, unknown> | null) {
  return {
    ok: true,
    json: async () => ({
      member: {
        id: 'member-1',
        displayName: 'Liam',
        onboardingCompletedAt: null,
        onboardingProgress: {
          prime: true,
          ...(research ? { research } : {}),
        },
      },
      connectedAccounts: [],
      workspace: { id: 'ws-1' },
      userEmail: 'liam@dial8.ai',
      userName: 'Liam A',
      avatarUrl: null,
    }),
  } as unknown as Response
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** Mount synchronously inside act (the proven harness pattern). */
function mount() {
  act(() => {
    root.render(<OnboardingWizard />)
  })
}

/** Flush queued micro/macrotasks so the load effect's fetch chain settles. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

/** Recorded fetch calls as { url, method } for assertions. */
function recordedCalls() {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: (init as RequestInit | undefined)?.method ?? 'GET',
  }))
}

describe('OnboardingWizard rehydration (initial fast path is live)', () => {
  it('reload after research is DONE: no kickoff POST, no stream opened', async () => {
    // The durable GET carries a finished run. The companion seeds terminal from
    // `initial` and must never kick off or stream. Non-GET-onboarding calls
    // resolve benignly so nothing hangs, then we assert they never happened.
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const method = (init as RequestInit | undefined)?.method ?? 'GET'
      if (url === '/api/account/onboarding' && method === 'GET') {
        return Promise.resolve(
          onboardingResponse({
            sessionId: 'wrun_DONE',
            status: 'done',
            brief: 'Here is what I learned…',
            companyFound: true,
          }),
        )
      }
      return Promise.resolve(onboardingResponse(null))
    })

    mount()
    await flush()

    const calls = recordedCalls()

    // The kickoff POST must NEVER fire on a terminal reload.
    expect(
      calls.some(
        (c) => c.url === '/api/account/onboarding/research' && c.method === 'POST',
      ),
    ).toBe(false)
    // The eve stream must NEVER be opened.
    expect(calls.some((c) => c.url.includes('/stream'))).toBe(false)
    // Only calls to /api/account/onboarding happened (durable GET + the
    // completion PATCH).
    expect(calls.every((c) => c.url === '/api/account/onboarding')).toBe(true)

    // A terminal member has no wizard step to show: Arrival stamps completion
    // (PATCH {completed:true}) and navigates straight to the dashboard.
    expect(
      calls.some(
        (c) => c.url === '/api/account/onboarding' && c.method === 'PATCH',
      ),
    ).toBe(true)
    // Arrival must be a HARD navigation (fresh document request) — a soft
    // router.replace can replay a stale cached redirect back to onboarding.
    expect(hardNavigate).toHaveBeenCalledWith('/account')
  })

  it('already-completed member: hard-navigates to /account without stamping again', async () => {
    // The anomalous leg of the old redirect loop: a member whose completion is
    // already stamped lands on the wizard anyway (stale cache, bookmark, race).
    // The shell must exit via hardNavigate — one fresh document request that
    // lets the server layout re-read the stamp — and must NOT re-PATCH.
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const method = (init as RequestInit | undefined)?.method ?? 'GET'
      if (url === '/api/account/onboarding' && method === 'GET') {
        const base = onboardingResponse(null)
        return Promise.resolve({
          ok: true,
          json: async () => {
            const body = await base.json()
            body.member.onboardingCompletedAt = '2026-08-09T07:18:01.637Z'
            return body
          },
        } as unknown as Response)
      }
      return Promise.resolve(onboardingResponse(null))
    })

    mount()
    await flush()

    const calls = recordedCalls()
    expect(hardNavigate).toHaveBeenCalledWith('/account')
    expect(
      calls.some(
        (c) => c.url === '/api/account/onboarding' && c.method === 'PATCH',
      ),
    ).toBe(false)
  })

  it('reload MID-research (running with a sessionId): attaches to the known session, no redundant kickoff POST', async () => {
    // A running run with a sessionId already exists. The hook must attach to it
    // via the stream — never re-POST kickoff (the session id is already known).
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const method = (init as RequestInit | undefined)?.method ?? 'GET'
      if (url === '/api/account/onboarding' && method === 'GET') {
        return Promise.resolve(
          onboardingResponse({ sessionId: 'wrun_LIVE', status: 'running' }),
        )
      }
      if (url.includes('/session/') && url.includes('/stream')) {
        // A stream that closes immediately — the hook then reconciles via GET.
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.close()
          },
        })
        return Promise.resolve({ ok: true, body } as unknown as Response)
      }
      return Promise.resolve(onboardingResponse(null))
    })

    mount()
    await flush()

    const calls = recordedCalls()

    // No redundant kickoff POST — the sessionId was already known.
    expect(
      calls.some(
        (c) => c.url === '/api/account/onboarding/research' && c.method === 'POST',
      ),
    ).toBe(false)
    // It DID attach to the known session's stream.
    expect(calls.some((c) => c.url.includes('/session/wrun_LIVE/stream'))).toBe(true)
  })
})
