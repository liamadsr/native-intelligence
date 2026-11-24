// @vitest-environment jsdom
/**
 * A crash inside a card stays in that card (../card-error-boundary.tsx).
 *
 * The owner's report (11-24): opening a spreadsheet "crashes and takes me to
 * the home page", and Sentry had nothing. The error went up to the dashboard's
 * boundary, which blanks the dashboard and mounts it again (the card gone,
 * Home in front) and only wrote to the console. Now the card catches it,
 * says so in place with Try again, and reports it with the card's kind; the
 * dashboard's boundary reports what still reaches it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { captureException, crash } = vi.hoisted(() => ({ captureException: vi.fn(), crash: { broken: false } }))
vi.mock('@sentry/nextjs', () => ({ captureException }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/views/unified-view-layout', async () => {
  const React = await import('react')
  return {
    CardSurfaceContext: React.createContext(null),
    WindowFocusProvider: ({ children }: { children: ReactNode }) => children,
    UnifiedViewLayout: () => null,
  }
})
const { stub } = vi.hoisted(() => ({ stub: (name: string) => () => ({ [name]: () => null }) }))
vi.mock('@/app/account/(dashboard)/views/action-detail-panel', stub('ActionDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/capture-detail-panel', stub('CaptureDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/document-detail-panel', stub('DocumentDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/contact-detail-panel', stub('ContactDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/company-detail-panel', stub('CompanyDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/project-detail-panel', stub('ProjectDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/initiative-detail-panel', stub('InitiativeDetailPanel'))
vi.mock('../pages/page-card', () => ({ PageGate: ({ children }: { children: ReactNode }) => children }))
// The Spreadsheets card: it throws while `crash.broken` (the open that crashed), and draws once that is over.
vi.mock('../pages/spreadsheets-card', async () => {
  const React = await import('react')
  return {
    default: function SpreadsheetsCard() {
      if (crash.broken) throw new Error('engine not ready')
      return React.createElement('div', { 'data-sheet-editor': '' }, 'Office supplies')
    },
  }
})

import CardBody from '../card-body'
import { ChatCardStore } from '../card-store'
import { DashboardErrorBoundary } from '@/app/account/(dashboard)/dashboard-error-boundary'
import type { CardSpec } from '@/lib/chat-cards/kinds'

let root: Root
let host: HTMLDivElement
let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  captureException.mockClear()
  crash.broken = false
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  // React and both boundaries log the caught error; keep the run quiet.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  consoleError.mockRestore()
})

const spec = { kind: 'spreadsheets', title: 'Spreadsheets' } as CardSpec

/** The card inside the dashboard's boundary, as the app mounts it; `outside` stands for the rest of the dashboard. */
function renderDashboardWithCard() {
  const store = new ChatCardStore()
  return act(async () => {
    root.render(
      h(DashboardErrorBoundary, null,
        h('div', { 'data-outside': '' }),
        h(CardBody, { toolCallId: 'tc-sheets', spec, store, fullScreen: true }),
      ),
    )
  })
}

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
}

describe('a crash inside a card', () => {
  it('stays in the card: the dashboard around it is still there, and the card says so with Try again', async () => {
    crash.broken = true
    await renderDashboardWithCard()
    await flush()

    // The dashboard was not blanked (its boundary renders nothing while it retries).
    expect(host.querySelector('[data-outside]')).not.toBeNull()
    const alert = host.querySelector('[data-card-error="spreadsheets"]')
    expect(alert).not.toBeNull()
    expect(alert!.textContent).toContain("Couldn't open this.")
  })

  it('is reported to Sentry with the card kind', async () => {
    crash.broken = true
    await renderDashboardWithCard()
    await flush()

    const calls = captureException.mock.calls.filter(([, ctx]) => (ctx as { tags?: { boundary?: string } })?.tags?.boundary === 'chat-card')
    expect(calls).toHaveLength(1)
    expect((calls[0][0] as Error).message).toBe('engine not ready')
    expect(calls[0][1]).toMatchObject({ tags: { boundary: 'chat-card', card_kind: 'spreadsheets' } })
    // The dashboard's boundary never saw it.
    expect(captureException.mock.calls.some(([, ctx]) => (ctx as { tags?: { boundary?: string } })?.tags?.boundary === 'dashboard')).toBe(false)
  })

  it('Try again draws the card afresh', async () => {
    crash.broken = true
    await renderDashboardWithCard()
    await flush()
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!
    crash.broken = false
    await act(async () => {
      button.click()
    })
    await flush()

    expect(host.querySelector('[data-card-error]')).toBeNull()
    expect(host.querySelector('[data-sheet-editor]')).not.toBeNull()
  })
})

describe("the dashboard's boundary", () => {
  it('reports what reaches it to Sentry, not only the console', async () => {
    function Broken(): never {
      throw new Error('outside any card')
    }
    vi.useFakeTimers()
    try {
      await act(async () => {
        root.render(h(DashboardErrorBoundary, null, h(Broken)))
      })
    } finally {
      vi.useRealTimers()
    }
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'outside any card' }),
      expect.objectContaining({ tags: { boundary: 'dashboard' } }),
    )
  })
})
