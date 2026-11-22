// @vitest-environment jsdom
/**
 * The list pages in a card name themselves once (Liam, 11-22: one title, every
 * control in the header): the card's header says Evals, Sequences, Flows,
 * Campaigns or Agents & skills, so the page draws no title row, and its New …
 * is a pill at the header's end. A place inside the page (a new sequence) is
 * the header's breadcrumb, the card's title the way back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CardHeaderSlotsProvider, type CardHeaderBack } from '@/components/chat-cards/card-header-slot'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/components/views/unified-view-layout', () => ({ UnifiedViewLayout: () => <div data-testid="list" /> }))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))
vi.mock('@/app/account/(dashboard)/evals/suite-detail', () => ({ EvalSuiteDetail: () => null }))
vi.mock('@/app/account/(dashboard)/sequences/sequence-detail', () => ({ SequenceDetail: () => null }))
vi.mock('@/app/account/(dashboard)/sequences/api', async () => {
  const actual = await vi.importActual<typeof import('@/app/account/(dashboard)/sequences/api')>('@/app/account/(dashboard)/sequences/api')
  return { ...actual, fetchEmailAccounts: async () => [{ id: 'acct-1', provider: 'google', account_email: 'sam@fernhill.example', display_name: null }] }
})
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-1' }))
vi.mock('@/app/account/(dashboard)/views/flows/flow-canvas-editor', () => ({ FlowCanvasEditor: () => null }))

import { EvalsView } from '@/app/account/(dashboard)/evals/evals-view'
import { SequencesView } from '@/app/account/(dashboard)/sequences/sequences-view'
import { FlowsView } from '../flows-view'
import { CampaignsView } from '../campaigns-view'

let container: HTMLDivElement
let right: HTMLDivElement
let trail: HTMLDivElement
let root: Root
let back: CardHeaderBack | null

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.startsWith('/api/account/campaigns') ? { campaigns: [] } : url.startsWith('/api/account/flows/paused') ? { paused_flows: [] } : {}
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  container = document.createElement('div')
  right = document.createElement('div')
  trail = document.createElement('div')
  document.body.append(right, trail, container)
  root = createRoot(container)
  back = null
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  right.remove()
  trail.remove()
  vi.unstubAllGlobals()
})

const noop = () => {}

async function renderInCard(node: React.ReactNode) {
  await act(async () => {
    root.render(<CardHeaderSlotsProvider value={{ left: null, right, trail, setBack: (b) => (back = b) }}>{node}</CardHeaderSlotsProvider>)
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

/** The page's own title row: an h1, or a "+" left in the page. */
const pageHeaderLeft = () => container.querySelector('h1, [aria-label^="New "]')

describe('list pages in a card', () => {
  it.each([
    ['Evals', () => <EvalsView suiteId={null} onOpenSuite={noop} onCloseDetail={noop} />, 'New eval suite'],
    ['Sequences', () => <SequencesView sequenceId={null} onOpenSequence={noop} onCloseDetail={noop} />, 'New sequence'],
    ['Flows', () => <FlowsView card={{ editing: null, onEdit: noop }} />, 'New flow'],
    ['Campaigns', () => <CampaignsView />, 'New campaign'],
  ])('%s: New … in the header, no title row in the page', async (title, page, label) => {
    await renderInCard(page())
    const pills = [...right.querySelectorAll('button')].map((b) => b.textContent)
    expect(pills).toContain(label)
    expect(pageHeaderLeft()).toBeNull()
    expect(container.textContent).not.toContain(title)
  })

  it('Flows: nothing of the list’s in the header while the canvas is open', async () => {
    await renderInCard(<FlowsView card={{ editing: 'flow-1', onEdit: noop }} />)
    expect(right.childElementCount).toBe(0)
  })

  it('Sequences: a new sequence is "Sequences › New sequence", Cancel and Create at the header’s end', async () => {
    await renderInCard(<SequencesView sequenceId={null} onOpenSequence={noop} onCloseDetail={noop} />)
    await act(async () => right.querySelector<HTMLButtonElement>('[data-new-sequence]')!.click())
    expect(trail.textContent).toBe('New sequence')
    expect(back!.label).toBe('Back to sequences')
    expect(right.querySelector('[data-save-sequence]')?.textContent).toBe('Create sequence')
    expect([...right.querySelectorAll('button')].some((b) => b.textContent === 'Cancel')).toBe(true)
    expect(container.querySelector('h1')).toBeNull()
    await act(async () => back!.go())
    expect(right.querySelector('[data-new-sequence]')).not.toBeNull()
  })

  it('outside a card: each keeps its own header', async () => {
    await act(async () => root.render(<CampaignsView />))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('Campaigns')
    expect(container.textContent).toContain('New campaign')
    expect(right.childElementCount).toBe(0)
  })
})
