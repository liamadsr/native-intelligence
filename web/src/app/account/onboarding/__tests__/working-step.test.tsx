// @vitest-environment jsdom
/**
 * Behavior tests for the "Arrival" WORKING step — the wizard's last screen.
 *
 * The load-bearing contract: WorkingStep owns all THREE advance triggers
 * (terminal research status, the 25s hard cap, the skip link) and funnels every
 * one of them through a SINGLE `onComplete` call, guarded against double-fire.
 * In the real wizard `onComplete` stamps onboarding_completed_at (PATCH) and
 * then router.replace('/account') — so "onComplete called exactly once" is the
 * proxy for "completion stamped before we navigate, once".
 *
 * The skip link's LATE appearance (15s, not 2.5s) is pinned explicitly: the
 * whole point of Arrival is that the user watches the workspace get built, so
 * the escape hatch is a late safety valve, not an early exit.
 *
 * framer-motion is stubbed to plain elements so the settle/exit transitions run
 * synchronously; the ~0.35s exit fade + ~0.15s settle beat run on setTimeout, so
 * fake timers drive them deterministically.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { ResearchCompanion } from '../use-research-companion'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Stub framer-motion: motion.<tag> → the plain tag; AnimatePresence → fragment.
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
    AnimatePresence: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  }
})

import { WorkingStep } from '../onboarding-steps'

function companion(overrides: Partial<ResearchCompanion> = {}): ResearchCompanion {
  return {
    status: 'running',
    latest: null,
    activities: [],
    brief: null,
    companyFound: false,
    seededSummary: null,
    active: true,
    companyName: null,
    activePhase: null,
    ...overrides,
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

function render(node: React.ReactElement) {
  act(() => root.render(node))
}

/** Advance fake timers by ms inside act so effects/state flush. */
function advanceTime(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('WorkingStep — the single advance path', () => {
  it('terminal research status fires onComplete exactly once (after the settle+exit beats)', () => {
    const onComplete = vi.fn()
    // Start running, then flip to done — the terminal path.
    render(h(WorkingStep, { companion: companion({ status: 'running' }), onComplete }))
    render(h(WorkingStep, { companion: companion({ status: 'done' }), onComplete }))

    // Settle beat (~0.15s) then exit fade (~0.35s) → onComplete at ~0.5s.
    expect(onComplete).not.toHaveBeenCalled()
    advanceTime(600)
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it("'failed' and 'skipped' also advance quietly through the same path", () => {
    for (const status of ['failed', 'skipped'] as const) {
      const onComplete = vi.fn()
      render(h(WorkingStep, { companion: companion({ status }), onComplete }))
      advanceTime(600)
      expect(onComplete).toHaveBeenCalledTimes(1)
      act(() => root.unmount())
      container.remove()
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
    }
  })

  it('the 25s hard cap fires onComplete once even if research never terminates', () => {
    const onComplete = vi.fn()
    render(h(WorkingStep, { companion: companion({ status: 'running' }), onComplete }))

    // Just before the cap: nothing.
    advanceTime(24_900)
    expect(onComplete).not.toHaveBeenCalled()
    // Cross the cap → exit fade (~0.35s) → onComplete.
    advanceTime(500)
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('the skip link appears at 15s (not 2.5s) and routes through onComplete', () => {
    const onComplete = vi.fn()
    render(h(WorkingStep, { companion: companion({ status: 'running' }), onComplete }))

    // At 2.5s the old delay would have shown skip — it must NOT be present yet.
    advanceTime(2_500)
    expect(container.textContent).not.toContain('Skip — take me to my workspace')

    // At 15s the late safety valve + trust line appear.
    advanceTime(12_600)
    expect(container.textContent).toContain('Skip — take me to my workspace')
    expect(container.textContent).toContain(
      "You can leave anytime — I'll keep building your workspace.",
    )

    // Clicking skip funnels through the SAME single completion path.
    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Skip'),
    )!
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    advanceTime(500)
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('double-fire is guarded: a terminal transition AFTER the cap already fired does not re-complete', () => {
    const onComplete = vi.fn()
    render(h(WorkingStep, { companion: companion({ status: 'running' }), onComplete }))

    // Cap fires first.
    advanceTime(25_500)
    expect(onComplete).toHaveBeenCalledTimes(1)

    // A late terminal status must not fire onComplete a second time.
    render(h(WorkingStep, { companion: companion({ status: 'done' }), onComplete }))
    advanceTime(1_000)
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('shows the three ghost plan rows before any event arrives', () => {
    render(h(WorkingStep, { companion: companion({ status: 'running' }), onComplete: vi.fn() }))
    expect(container.textContent).toContain('Reading about your company')
    expect(container.textContent).toContain('Setting up a starter project')
    expect(container.textContent).toContain('Drafting your first actions')
  })

  it('swaps the headline to the company name once one lands, else stays generic', () => {
    const onComplete = vi.fn()
    render(
      h(WorkingStep, {
        companion: companion({ status: 'running', companyName: null }),
        onComplete,
      }),
    )
    expect(container.textContent).toContain('Setting up your workspace')
    expect(container.textContent).not.toContain('Setting up Acme')

    render(
      h(WorkingStep, {
        companion: companion({ status: 'running', companyName: 'Acme' }),
        onComplete,
      }),
    )
    expect(container.textContent).toContain('Setting up Acme')
  })
})
