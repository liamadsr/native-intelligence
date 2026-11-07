// @vitest-environment jsdom
/**
 * Rendering-branch tests for the research companion presentation components
 * (ResearchLiveStrip + ResearchBriefCard). These pin the state→UI contract the
 * task calls out: skipped shows a gentle line, done shows the brief card,
 * running shows a live indicator, and idle/failed render nothing.
 *
 * framer-motion is stubbed to plain elements so we can assert on static DOM
 * without waiting on animation frames (AnimatePresence exit would otherwise
 * keep exiting nodes mounted across a tick).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Stub framer-motion: motion.<tag> → the plain tag; AnimatePresence → fragment.
vi.mock('framer-motion', () => {
  const React = require('react')
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        function MotionStub(props: Record<string, unknown>) {
          // Drop motion-only props so React doesn't warn on unknown attrs.
          const { initial, animate, exit, transition, ...rest } = props as Record<string, unknown>
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

import { ResearchLiveStrip, ResearchBriefCard } from '../research-companion'
import type { ResearchCompanion, ResearchActivity } from '../use-research-companion'

let container: HTMLDivElement
let root: Root

function companion(overrides: Partial<ResearchCompanion> = {}): ResearchCompanion {
  return {
    status: 'idle',
    latest: null,
    activities: [],
    brief: null,
    companyFound: false,
    seededSummary: null,
    active: false,
    companyName: null,
    activePhase: null,
    ...overrides,
  }
}

function render(node: React.ReactElement) {
  act(() => root.render(node))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

// ─── Live strip ──────────────────────────────────────────────

describe('ResearchLiveStrip', () => {
  it('shows the latest friendly activity while running', () => {
    const latest: ResearchActivity = {
      id: 'c1',
      kind: 'web_search',
      label: 'Searching the web for Acme…',
    }
    render(h(ResearchLiveStrip, { companion: companion({ status: 'running', latest }) }))
    expect(container.textContent).toContain('Searching the web for Acme…')
  })

  it('shows a gentle placeholder while running before any activity lands', () => {
    render(h(ResearchLiveStrip, { companion: companion({ status: 'running', latest: null }) }))
    expect(container.textContent).toContain('Getting to know you…')
  })

  it('renders nothing once terminal or idle', () => {
    for (const status of ['idle', 'done', 'skipped', 'failed'] as const) {
      render(h(ResearchLiveStrip, { companion: companion({ status }) }))
      expect(container.textContent).toBe('')
    }
  })
})

// ─── Brief card ──────────────────────────────────────────────

describe('ResearchBriefCard', () => {
  it("renders the brief under a 'While you were setting up…' heading when done", () => {
    render(
      h(ResearchBriefCard, {
        companion: companion({
          status: 'done',
          brief: 'Hi! I looked into Acme.\n\nI set up your company profile.',
        }),
      }),
    )
    expect(container.textContent).toContain('While you were setting up…')
    expect(container.textContent).toContain('I looked into Acme.')
    // Blank-line split → two paragraphs.
    expect(container.textContent).toContain('I set up your company profile.')
  })

  it('shows a single gentle line for a skipped (personal-email) run', () => {
    render(h(ResearchBriefCard, { companion: companion({ status: 'skipped' }) }))
    expect(container.textContent).toContain('Your workspace is all yours')
    // No card heading for the skip case.
    expect(container.textContent).not.toContain('While you were setting up…')
  })

  it('shows a live "Getting to know you" indicator while still running with no brief', () => {
    render(
      h(ResearchBriefCard, {
        companion: companion({
          status: 'running',
          latest: { id: 'c1', kind: 'web_fetch', label: 'Reading acme.com…' },
        }),
      }),
    )
    expect(container.textContent).toContain('Getting to know you')
    expect(container.textContent).toContain('Reading acme.com…')
  })

  it('renders nothing for idle or failed (quiet absence, never an error)', () => {
    render(h(ResearchBriefCard, { companion: companion({ status: 'idle' }) }))
    expect(container.textContent).toBe('')
    render(h(ResearchBriefCard, { companion: companion({ status: 'failed' }) }))
    expect(container.textContent).toBe('')
  })
})
