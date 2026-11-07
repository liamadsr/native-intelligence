// @vitest-environment jsdom
/**
 * The workspace-wide active-run feed meeting the list detail (§B5b).
 *
 * `useRunPoll` resumes an unknown live run at MOUNT and never again, which was
 * complete while the only way to start one was a button on this page. Scout now
 * starts runs from the chat strip beside the list without unmounting anything,
 * so the feed fills the gap — and the seam it creates is the whole reason this
 * suite exists:
 *
 *   - An EMPTY rail is filled by the feed. That is the feature.
 *   - A rail already showing a LIVE run is left to the 3s poll. The feed's copy
 *     is staler by construction, and adopting it every 5s would make the rail
 *     tick backwards twice a minute.
 *   - A rail showing a run the USER OPENED out of the history popover is left
 *     alone entirely. The feed hands out a fresh object every poll, so a guard
 *     that only knew "am I already following this run" would pass on every one
 *     of them and yank the user off the run they deliberately opened, forever.
 *
 * That last case is the regression this file was written for.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => null }))
vi.mock('@/components/views/unified-view-layout', () => ({
  UnifiedViewLayout: () => null,
}))
vi.mock('../../views/company-detail-panel', () => ({ CompanyDetailPanel: () => null }))
vi.mock('../../views/contact-detail-panel', () => ({ ContactDetailPanel: () => null }))

const fetchList = vi.fn()
const fetchRuns = vi.fn()
const fetchRun = vi.fn()
const fetchRunCandidates = vi.fn()
const fetchAngles = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    fetchList: (id: string) => fetchList(id),
    fetchRuns: (listId: string, limit?: number) => fetchRuns(listId, limit),
    fetchRun: (id: string) => fetchRun(id),
    fetchRunCandidates: (id: string) => fetchRunCandidates(id),
    fetchAngles: (id: string) => fetchAngles(id),
  }
})

/**
 * The feed is stubbed at the HOOK rather than at `fetchActiveRuns`, so a test
 * can hand the page a specific run at a specific moment without driving the
 * hook's own two-speed timer. The hook's fetching and cadence are pinned next
 * door in `use-active-runs.test.tsx`.
 */
let feedRun: ActiveRunPayload | null = null
vi.mock('../use-active-runs', () => ({
  useActiveRuns: () => ({
    runs: feedRun ? [feedRun] : [],
    // A NEW Map (and a new run object) every render — exactly what the real
    // hook produces on each 5s poll, and the thing a weak guard trips over.
    byListId: new Map(feedRun ? [[feedRun.list_id, { ...feedRun }]] : []),
    loading: false,
    reload: () => {},
  }),
}))

import { ListDetail } from '../list-detail'
import type { ActiveRunPayload } from '../api'
import { LIST, entry } from './fixtures'
import { run } from './run-fixtures'

const COUNTS = { discovered: 8, shortlisted: 0, saved: 2, dismissed: 1, total: 11 }
const ENTRIES = [entry({ id: 'e1', fit_score: 90, stage: 'discovered' })]

/** The feed's row shape: a run plus the list name the endpoint joins in. */
function active(overrides: Parameters<typeof run>[0] = {}): ActiveRunPayload {
  return { ...run(overrides), list_name: 'Series A fintech' }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  feedRun = null
  fetchRun.mockReset()
  fetchAngles.mockReset().mockResolvedValue([])
  fetchRunCandidates.mockReset().mockResolvedValue({ run: { id: 'run-1' }, groups: [], total: 0 })
  fetchRuns.mockReset().mockResolvedValue([])
  fetchList.mockReset().mockResolvedValue({ list: LIST, entries: ENTRIES, entry_counts: COUNTS })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

const noop = () => {}

async function render() {
  await act(async () => {
    root.render(<ListDetail listId="list-1" onBack={noop} onNameLoaded={noop} />)
  })
  await act(async () => {})
}

/** Re-render without changing props — the way a 5s feed poll reaches the page. */
async function feedTick() {
  await act(async () => {
    root.render(<ListDetail listId="list-1" onBack={noop} onNameLoaded={noop} />)
  })
  await act(async () => {})
}

/**
 * The live rail and the terminal outcome banner are mutually exclusive in
 * `ListDetail`, and only the rail carries a bare "Cancel" button — so its
 * presence is the cleanest read of "a LIVE run is what this page is showing".
 */
function liveRailPresent(): boolean {
  return Array.from(document.body.querySelectorAll('button')).some(
    (b) => b.textContent?.trim() === 'Cancel',
  )
}

describe('ListDetail — adopting a run from the active-run feed', () => {
  it('fills an EMPTY rail with a run Scout started elsewhere', async () => {
    await render()
    expect(liveRailPresent()).toBe(false)

    feedRun = active({ id: 'agent-run', status: 'running' })
    await feedTick()

    expect(liveRailPresent()).toBe(true)
  })

  it('does not re-adopt the same run on every feed tick', async () => {
    feedRun = active({ id: 'agent-run', status: 'running' })
    await render()
    expect(liveRailPresent()).toBe(true)

    // Three more polls, each handing over a fresh object for the same run. The
    // poll must stay the owner: `track` is a no-op once it knows the id.
    for (let i = 0; i < 3; i++) await feedTick()

    expect(liveRailPresent()).toBe(true)
    // The 3s poll — not the feed — is what refetches this run.
    expect(fetchRun).not.toHaveBeenCalledWith('agent-run')
  })

  /**
   * THE REGRESSION. The user opens a finished run out of the history popover;
   * a run is live elsewhere in the workspace. Before the fix, the feed's next
   * fresh object passed `track`'s id guard and replaced the terminal run on
   * screen — and did it again 5 seconds later, so the user could not keep a
   * past run open at all while anything was running.
   */
  it('replaces a run that merely SETTLED on screen with the live run that followed it — the hand-off', async () => {
    // Discovery hands off to the profile run by itself: the poll follows
    // discovery to `completed`, the outcome banner shows, and the feed then
    // reports the profile run scoring the rows on screen. It must take the
    // rail, or the list sits on a stale outcome while 50 scores land unseen.
    const past = run({ id: 'discover-run', status: 'completed', stage: 'done' })
    fetchRuns.mockResolvedValue([past])
    await render()
    expect(liveRailPresent()).toBe(false)

    feedRun = active({ id: 'profile-run', status: 'running' })
    await feedTick()
    await feedTick()

    expect(liveRailPresent()).toBe(true)
  })

  it('leaves a terminal run the user opened from HISTORY alone', async () => {
    const past = run({ id: 'past-run', status: 'completed', stage: 'done' })
    fetchRuns.mockResolvedValue([past])
    await render()

    // Open it deliberately: List settings → Run history → the run's row.
    const byLabel = (label: string) =>
      Array.from(document.body.querySelectorAll('button')).find(
        (b) => b.getAttribute('aria-label') === label,
      )
    const byText = (text: string) =>
      Array.from(document.body.querySelectorAll('button')).find((b) =>
        (b.textContent ?? '').includes(text),
      )
    await act(async () => {
      byLabel('List settings')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      byText('Run history')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})
    const row = byText('Round ')
    expect(row, 'the past run is listed in the history panel').toBeTruthy()
    await act(async () => {
      row!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    feedRun = active({ id: 'agent-run', status: 'running' })
    await feedTick()
    await feedTick()

    // The live run never takes the screen: no "Finding companies" rail.
    expect(liveRailPresent()).toBe(false)
  })

  it('a live run on screen is still replaced by nothing — the poll keeps it', async () => {
    const live = run({ id: 'own-run', status: 'running' })
    fetchRuns.mockResolvedValue([live])
    fetchRun.mockResolvedValue(live)
    await render()
    expect(liveRailPresent()).toBe(true)

    // A DIFFERENT live run in the feed (another list's run mis-keyed, or a
    // second run this list somehow has) may take over: both are live, so the
    // "deliberate choice" guard does not apply and the feed is the fresher
    // workspace-wide answer.
    feedRun = active({ id: 'agent-run', status: 'running' })
    await feedTick()

    expect(liveRailPresent()).toBe(true)
  })
})
