// @vitest-environment jsdom
/**
 * The list → Scout seams (§B6 selection context, §B7 Ask about this list, §B5b adoption).
 *
 * All three exist for the same reason: Scout now lives in the chat strip
 * BESIDE this page, not inside it, and there is no prop channel between them.
 * So the page publishes to a module store and dispatches a window event, and
 * this suite is the proof that both halves are joined through those public
 * seams rather than by reaching into either component.
 *
 * WHAT WOULD GO WRONG WITHOUT EACH, in the order that matters:
 *
 *  1. NO SNAPSHOT WHILE NOTHING IS SELECTED. The tempting shortcut is to
 *     publish only when there is a selection. Then a user looking at a list
 *     with nothing ticked, saying "research these", gets an agent that does not
 *     know they are on a list at all — so it guesses, and it guesses with money.
 *     "Nothing selected" is a fact Scout needs in order to ASK.
 *  2. NULL ON EVERY KEYSTROKE. The mirror-image bug: folding the unmount
 *     cleanup into the publishing effect makes it fire on every selection
 *     change, publishing null between each one. The chat would see a selection
 *     that blinks out of existence whenever the user ticks a box.
 *  3. AN UNCAPPED ID LIST. The ids exist to become `entry_ids`, and the route
 *     refuses more than 50. Publishing 200 of them would put a request the
 *     server will reject into the model's context as if it were actionable —
 *     while `selectedCount` must stay UNTRUNCATED so Scout can say the
 *     selection is bigger than one run.
 *  4. ADOPTING WITH `adopt`. A run Scout started is re-reported by the active
 *     feed every 5s. `adopt` on each sighting would overwrite the 3s poll's
 *     fresher progress with the feed's staler copy — a rail that ticks
 *     backwards twice a minute. `track` is a no-op once the poll owns the run.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess } }))
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => null }))

/** The layout owns the selection island and hands the page the selection;
 *  the page hands back its verbs (`selectionActions`). So the only way to
 *  drive it from a test is the callback the layout hands up, and the stub
 *  renders the verbs the page hands down. */
const selectionSpy = vi.fn()
vi.mock('@/components/views/unified-view-layout', () => ({
  UnifiedViewLayout: (props: {
    onBulkSelectionChange?: (info: unknown) => void
    selectionActions?: React.ReactNode
  }) => {
    selectionSpy(props.onBulkSelectionChange)
    return <>{props.selectionActions}</>
  },
}))
vi.mock('../../views/company-detail-panel', () => ({ CompanyDetailPanel: () => null }))
vi.mock('../../views/contact-detail-panel', () => ({ ContactDetailPanel: () => null }))

const fetchList = vi.fn()
const fetchRuns = vi.fn()
const fetchRun = vi.fn()
const fetchActiveRuns = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    fetchList: (id: string) => fetchList(id),
    fetchRuns: (listId: string, limit?: number) => fetchRuns(listId, limit),
    fetchRun: (id: string) => fetchRun(id),
    fetchActiveRuns: () => fetchActiveRuns(),
    fetchSequenced: () => Promise.resolve({}),
  }
})

import { ListDetail } from '../list-detail'
import { PROSPECTING_ASK_EVENT, type ProspectingAskDetail } from '../start-event'
import {
  readProspectingSelection,
  __resetProspectingSelectionStore,
} from '../selection-context'
import { MAX_ENTRIES_PER_TARGETED_RUN } from '@/lib/prospecting/spend'
import { RUN_POLL_INTERVAL_MS } from '../use-run-poll'
import { LIST, entry } from './fixtures'

const COUNTS = { discovered: 8, shortlisted: 0, saved: 2, dismissed: 1, total: 11 }
const ENTRIES = [
  entry({ id: 'e1', fit_score: 90, stage: 'discovered' }),
  entry({ id: 'e2', fit_score: 70, stage: 'discovered' }),
  entry({ id: 'e3', fit_score: 45, stage: 'discovered' }),
]

let container: HTMLDivElement
let root: Root

interface SelectionInfo {
  hasSelection: boolean
  count: number
  selectedIds: string[]
  entityType: string
  onClear: () => void
  onAction: () => void
}

beforeEach(() => {
  __resetProspectingSelectionStore()
  toastError.mockReset()
  toastSuccess.mockReset()
  selectionSpy.mockClear()
  fetchRun.mockReset()
  fetchRuns.mockReset().mockResolvedValue([])
  fetchActiveRuns.mockReset().mockResolvedValue([])
  fetchList.mockReset().mockResolvedValue({
    list: LIST,
    entries: ENTRIES,
    entry_counts: COUNTS,
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const noop = () => {}

async function render() {
  await act(async () => {
    root.render(<ListDetail listId="list-1" onBack={noop} onNameLoaded={noop} />)
  })
  await act(async () => {})
}

function selectionHandler(): ((info: SelectionInfo) => void) | undefined {
  return selectionSpy.mock.calls.at(-1)?.[0]
}

/** Drive the page's selection bar the way the shared layout would. */
async function select(ids: string[]) {
  const handler = selectionHandler()
  await act(async () => {
    handler?.({
      hasSelection: ids.length > 0,
      count: ids.length,
      selectedIds: ids,
      entityType: 'prospect_list_entry',
      onClear: noop,
      onAction: noop,
    })
  })
  await act(async () => {})
}

function snapshot() {
  return readProspectingSelection('list-1')
}

/** The Ask about this list button in the selection bar. */
function askButton(): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Ask about this list',
    ) ?? null
  )
}

describe('ListDetail — the selection Scout can see (§B6)', () => {
  it('publishes an EMPTY snapshot while the list is open with nothing selected', async () => {
    // The fact that makes "research these" answerable with "which ones?"
    // rather than with a guess that spends money.
    await render()
    const snap = snapshot()
    expect(snap).not.toBeNull()
    expect(snap!.listId).toBe('list-1')
    expect(snap!.listName).toBe(LIST.name)
    expect(snap!.selectedEntryIds).toEqual([])
    expect(snap!.selectedCount).toBe(0)
  })

  it('publishes the selected ids as the user ticks rows', async () => {
    await render()
    await select(['e1', 'e3'])

    const snap = snapshot()
    expect(snap!.selectedEntryIds).toEqual(['e1', 'e3'])
    expect(snap!.selectedCount).toBe(2)
  })

  it('carries the tab and the filter, so "these" means what is on screen', async () => {
    await render()
    const snap = snapshot()
    // The list opens on Companies, on the Saved tab — this list has two saved
    // rows, and Saved is where a list with anything saved opens (Liam,
    // 2026-09-06). That is what Scout reads before the user narrows anything.
    expect(snap!.tab).toBe('company')
    expect(snap!.filter).toBe('saved')
  })

  it('re-publishes rather than blanking when the selection changes', async () => {
    // The keystroke-null bug: a cleanup folded into the publishing effect.
    await render()
    await select(['e1'])
    expect(snapshot()!.selectedEntryIds).toEqual(['e1'])

    await select(['e1', 'e2'])
    expect(snapshot()).not.toBeNull()
    expect(snapshot()!.selectedEntryIds).toEqual(['e1', 'e2'])
  })

  it('publishes an empty snapshot — not null — when the selection is cleared', async () => {
    await render()
    await select(['e1'])
    await select([])

    // Still on the list, still looking at it. Only unmount publishes null.
    expect(snapshot()).not.toBeNull()
    expect(snapshot()!.selectedCount).toBe(0)
  })

  it('caps the ids at the run limit but reports the untruncated count', async () => {
    await render()
    const many = Array.from({ length: MAX_ENTRIES_PER_TARGETED_RUN + 12 }, (_, i) => `e${i}`)
    await select(many)

    const snap = snapshot()
    expect(snap!.selectedEntryIds).toHaveLength(MAX_ENTRIES_PER_TARGETED_RUN)
    // Untruncated: Scout has to be able to say the selection is bigger than
    // one run can cover.
    expect(snap!.selectedCount).toBe(MAX_ENTRIES_PER_TARGETED_RUN + 12)
  })

  it('publishes null on unmount, so the next screen is not attributed this list', async () => {
    await render()
    await select(['e1'])
    expect(snapshot()).not.toBeNull()

    await act(async () => root.unmount())
    expect(snapshot()).toBeNull()

    root = createRoot(container)
  })
})

describe('ListDetail — Ask about this list (§B7)', () => {
  it('offers the button only once something is selected', async () => {
    await render()
    expect(askButton()).toBeNull()

    await select(['e1', 'e2'])
    expect(askButton()).not.toBeNull()
  })

  it('dispatches the ask with the list and the selection size', async () => {
    const seen: ProspectingAskDetail[] = []
    const onAsk = (e: Event) => seen.push((e as CustomEvent<ProspectingAskDetail>).detail)
    window.addEventListener(PROSPECTING_ASK_EVENT, onAsk)

    await render()
    await select(['e1', 'e2', 'e3'])
    await act(async () => {
      askButton()?.click()
    })

    window.removeEventListener(PROSPECTING_ASK_EVENT, onAsk)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({
      listId: 'list-1',
      listName: LIST.name,
      selectedCount: 3,
    })
  })

  it('does NOT send a message — the user says what they want done', async () => {
    // The button arms the composer; it must not spend or speak on its own.
    // Its whole contract here is the event, so nothing else may fire.
    await render()
    await select(['e1'])
    await act(async () => {
      askButton()?.click()
    })
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })
})

describe('ListDetail — adopting a run the agent started (§B5b)', () => {
  const AGENT_RUN = {
    id: 'run-agent',
    list_id: 'list-1',
    list_name: LIST.name,
    status: 'running',
    stage: 'discover',
    is_live: true,
    spent_dollars: 0.1,
    progress: null,
    error: null,
    started_at: '2026-09-04T12:00:00.000Z',
    finished_at: null,
    created_at: '2026-09-04T12:00:00.000Z',
  }

  it('picks up a run started elsewhere and starts polling it', async () => {
    // Mount-time `fetchRuns` finds nothing — this run began AFTER the page was
    // already open, which is exactly the Scout case. The active feed is what
    // tells the page about it.
    vi.useFakeTimers()
    try {
      fetchRuns.mockResolvedValue([])
      fetchActiveRuns.mockResolvedValue([AGENT_RUN])
      fetchRun.mockResolvedValue({ ...AGENT_RUN, spent_dollars: 0.2 })
      await render()

      // The 3s poll is now following the AGENT's run, which nothing on this
      // page ever started.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS)
      })
      expect(fetchRun).toHaveBeenCalledWith('run-agent')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-adopt the same run on every feed tick', async () => {
    // `track`, not `adopt`. Re-adopting on each 5s sighting would overwrite the
    // 3s poll's fresher progress with the feed's staler copy — the rail would
    // tick backwards twice a minute.
    vi.useFakeTimers()
    try {
      fetchRuns.mockResolvedValue([])
      fetchActiveRuns.mockResolvedValue([AGENT_RUN])
      // The poll's own reads report progress the STALE feed row does not have.
      fetchRun.mockResolvedValue({ ...AGENT_RUN, spent_dollars: 0.9 })
      await render()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS * 4)
      })
      const polls = fetchRun.mock.calls.length
      expect(polls).toBeGreaterThan(1)
      // Every poll targeted the same run: an `adopt` on each feed sighting
      // would tear the timer down and back up, and the run followed would keep
      // resetting to the feed's copy.
      expect(fetchRun.mock.calls.every((c) => c[0] === 'run-agent')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a live run belonging to a DIFFERENT list', async () => {
    fetchActiveRuns.mockResolvedValue([
      { ...AGENT_RUN, id: 'run-other', list_id: 'list-2', list_name: 'Investors' },
    ])
    await render()

    // Nothing on THIS list is running, so the poll must never arm.
    expect(fetchRun).not.toHaveBeenCalled()
  })
})
