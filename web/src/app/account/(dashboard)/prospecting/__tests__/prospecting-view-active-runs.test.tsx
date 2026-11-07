// @vitest-environment jsdom
/**
 * The index and a run it did not start (§B5a).
 *
 * THE BUG THIS SUITE EXISTS TO PREVENT. `runs[list.id]` is a ONE-SHOT probe:
 * each list's newest run, fetched once when the index mounts and never
 * refreshed. That was complete when the only way to start a run was to press a
 * button inside a list, because pressing it navigated away from this screen.
 *
 * Scout broke that. It starts runs from the chat strip beside this very index,
 * without unmounting it. So a user who says "find me twenty companies", watches
 * the agent confirm it started, and looks back at the index would see the row
 * still reporting the PREVIOUS run — for the whole four minutes, and then
 * forever, because nothing refetches.
 *
 * WHAT CHANGED WITH THE VIEWS SYSTEM. The one-shot probe is gone entirely: a
 * row's newest run now rides on the views query as an embedded relation, and
 * the workspace-wide active feed reaches the rows through a published module
 * store (`publishProspectListLive`) rather than through a `liveRun` prop the
 * page threaded into each card. The precedence rule is unchanged and still
 * load-bearing — the feed is polled, so when it has an answer it is by
 * construction the newer of the two — it just lives one layer down, inside the
 * row (pinned by prospect-list-row.test.tsx). What this suite owns is the
 * PAGE's half: the header count, and that the right ids reach the store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../list-detail', () => ({ ListDetail: () => null }))
vi.mock('@/components/views/unified-view-layout', () => ({
  UnifiedViewLayout: () => null,
  // The page's research poll gates on this (useDrawnPollGate) — same module.
  useIsWindowDrawn: () => true,
}))

/** The seam the live feed reaches the rows through. Captured rather than
 *  rendered: the row's own reaction to it is pinned next door. */
const publishProspectListLive = vi.fn()
vi.mock('@/components/views/list/entity-row', async () => {
  const actual =
    await vi.importActual<typeof import('@/components/views/list/entity-row')>(
      '@/components/views/list/entity-row',
    )
  return {
    ...actual,
    publishProspectListLive: (ids: ReadonlySet<string>) => publishProspectListLive(ids),
  }
})

const fetchLists = vi.fn(async () => [] as unknown[])
const fetchSource = vi.fn()
const fetchRuns = vi.fn(async (_id: string, _limit?: number) => [] as unknown[])
const fetchActiveRuns = vi.fn(async () => [] as unknown[])
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    fetchLists: () => fetchLists(),
    fetchSource: () => fetchSource(),
    researchSource: () => Promise.resolve(null),
    fetchRuns: (id: string, limit?: number) => fetchRuns(id, limit),
    fetchActiveRuns: () => fetchActiveRuns(),
  }
})

import { ProspectingView } from '../prospecting-view'
import { CARDED_COMPANY, sourcePayload } from './fixtures'

let container: HTMLDivElement
let root: Root

const LIST_ROW = {
  id: 'list-1',
  name: 'Customers like us',
  purpose: 'buyers',
  updated_at: new Date().toISOString(),
  entry_counts: { discovered: 8, shortlisted: 0, saved: 2, dismissed: 1, total: 11 },
}

/** What the agent just started, seen only by the active feed. */
const AGENT_RUN = {
  id: 'run-agent',
  list_id: 'list-1',
  list_name: 'Customers like us',
  status: 'running',
  stage: 'discover',
  is_live: true,
  spent_dollars: 0.05,
  progress: { new: 0 },
  error: null,
  started_at: '2026-09-04T12:00:00.000Z',
  finished_at: null,
  created_at: '2026-09-04T12:00:00.000Z',
}

beforeEach(() => {
  fetchLists.mockReset().mockResolvedValue([LIST_ROW])
  fetchSource.mockReset().mockResolvedValue(sourcePayload(CARDED_COMPANY))
  fetchRuns.mockReset().mockResolvedValue([])
  fetchActiveRuns.mockReset().mockResolvedValue([])
  publishProspectListLive.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render() {
  await act(async () => {
    root.render(
      <ProspectingView
        listId={null}
        onOpenList={() => {}}
        onCloseDetail={() => {}}
      />,
    )
  })
  await act(async () => {})
}

function text() {
  return container.textContent ?? ''
}

describe('Prospecting index — live runs from the workspace feed', () => {
  it('says nothing about active runs when nothing is running', async () => {
    await render()
    expect(text()).not.toContain('run active')
    expect(text()).not.toContain('runs active')
  })

  it('counts one active run in the header', async () => {
    fetchActiveRuns.mockResolvedValue([AGENT_RUN])
    await render()
    expect(text()).toContain('1 run active')
  })

  it('pluralises across lists', async () => {
    fetchActiveRuns.mockResolvedValue([
      AGENT_RUN,
      { ...AGENT_RUN, id: 'run-2', list_id: 'list-2', list_name: 'Investors' },
    ])
    await render()
    expect(text()).toContain('2 runs active')
  })

  /** What the page owes the rows: the ids of the lists that are running, so a
   *  telescope lights within one poll rather than one refetch. */
  it('publishes the live list ids to the rows', async () => {
    fetchActiveRuns.mockResolvedValue([AGENT_RUN])
    await render()

    const published = publishProspectListLive.mock.calls.at(-1)?.[0] as Set<string>
    expect(published.has('list-1')).toBe(true)
  })

  it('publishes an empty set while nothing is running', async () => {
    await render()

    const published = publishProspectListLive.mock.calls.at(-1)?.[0] as Set<string>
    expect(published.size).toBe(0)
  })

  /** The header counts every workspace run; the STORE names only the lists
   *  that actually have one, so a row cannot inherit its neighbour's dot. */
  it('does not put another list’s live run into this list’s id set', async () => {
    fetchActiveRuns.mockResolvedValue([
      { ...AGENT_RUN, id: 'run-2', list_id: 'list-2', list_name: 'Investors' },
    ])
    await render()

    expect(text()).toContain('1 run active')
    const published = publishProspectListLive.mock.calls.at(-1)?.[0] as Set<string>
    expect(published.has('list-1')).toBe(false)
    expect(published.has('list-2')).toBe(true)
  })
})

/**
 * The index in a chat card (pages in the chat, P3): the live store is the
 * page's, one per app. A card neither writes it nor clears it on unmount, so
 * the real page's "Finding…" stays lit.
 */
describe('Prospecting index in a chat card', () => {
  it('never publishes to the live store, nor clears it when it goes', async () => {
    const { ProspectEntryActionTargetContext } = await import('@/components/views/list/entity-row')
    fetchActiveRuns.mockResolvedValue([AGENT_RUN])
    await act(async () => {
      root.render(
        <ProspectEntryActionTargetContext.Provider value={new EventTarget()}>
          <ProspectingView listId={null} onOpenList={() => {}} onCloseDetail={() => {}} />
        </ProspectEntryActionTargetContext.Provider>,
      )
    })
    await act(async () => {})
    await act(async () => root.render(<></>))
    expect(publishProspectListLive).not.toHaveBeenCalled()
  })
})
