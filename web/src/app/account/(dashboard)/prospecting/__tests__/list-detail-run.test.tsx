// @vitest-environment jsdom
/**
 * The run surface wired into the list detail (§9, §10).
 *
 * The pieces are unit-tested next door; this suite pins the SEAMS, which is
 * where a run UI actually breaks:
 *
 *   - Find is disabled while a run is live, with the tooltip saying why. The
 *     server would 409 anyway; a button you can press into a 409 is a worse
 *     explanation than one that tells you first.
 *   - A 409 that happens anyway (two tabs, a stale render) renders as "Already
 *     running" and ATTACHES to the live run — never as a red error.
 *   - The filtering chips push their narrowing through `scopeFilters`, the
 *     same seam the list scope uses — so the chip count and the rows come from
 *     one query and cannot disagree.
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

/** Captures what the shared views layout was scoped to, so the chip wiring can
 *  be asserted on the FILTERS rather than on rows a stub does not render. */
const scopeSpy = vi.fn()
/** What the page publishes to the rows (ProspectListActivityContext) — the
 *  stub layout reads the context where the real rows would. */
const activitySpy = vi.fn()
/** The stage tabs (All · Saved · Needs review · Dismissed) are drawn by the
 *  shared views toolbar now; the stub captures what the page hands it — the
 *  tab in force, the counts and the pick handler — and renders the page's
 *  toolbar actions (the people run's stop button lives there). */
const stageSpy = vi.fn()
vi.mock('@/components/views/unified-view-layout', async () => {
  const { useProspectListActivity } = await import('@/lib/prospecting/list-activity')
  return {
    UnifiedViewLayout: (props: {
      scopeFilters?: unknown
      prospectStage?: unknown
      prospectStageCounts?: unknown
      onProspectStageChange?: (tab: string) => void
      toolbarActions?: React.ReactNode
    }) => {
      scopeSpy(props.scopeFilters)
      activitySpy(useProspectListActivity())
      stageSpy({ stage: props.prospectStage, counts: props.prospectStageCounts, pick: props.onProspectStageChange })
      return <>{props.toolbarActions}</>
    },
  }
})
vi.mock('../../views/company-detail-panel', () => ({ CompanyDetailPanel: () => null }))
vi.mock('../../views/contact-detail-panel', () => ({ ContactDetailPanel: () => null }))

const fetchList = vi.fn()
const fetchRuns = vi.fn()
const fetchRun = vi.fn()
const startRun = vi.fn()
const fetchRunCandidates = vi.fn()
const patchList = vi.fn()
const cancelRun = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    fetchList: (id: string) => fetchList(id),
    fetchRuns: (listId: string, limit?: number) => fetchRuns(listId, limit),
    fetchRun: (id: string) => fetchRun(id),
    startRun: (...args: unknown[]) => startRun(...args),
    fetchRunCandidates: (id: string) => fetchRunCandidates(id),
    patchList: (id: string, body: unknown) => patchList(id, body),
    cancelRun: (id: string) => cancelRun(id),
  }
})

import type { ProspectListActivity } from '@/lib/prospecting/list-activity'
import { ProspectingRequestError } from '../api'
import { ListDetail } from '../list-detail'
import { LIST, entry } from './fixtures'
import { run } from './run-fixtures'

const COUNTS = { discovered: 8, shortlisted: 0, saved: 2, dismissed: 1, total: 11 }

const ENTRIES = [
  entry({ id: 'e1', fit_score: 90, stage: 'discovered' }),
  entry({ id: 'e2', fit_score: 90, stage: 'discovered' }),
  entry({ id: 'e3', fit_score: 70, stage: 'saved' }),
]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  toastError.mockReset()
  toastSuccess.mockReset()
  scopeSpy.mockReset()
  activitySpy.mockReset()
  stageSpy.mockReset()
  startRun.mockReset()
  patchList.mockReset()
  cancelRun.mockReset()
  fetchRun.mockReset()
  fetchRunCandidates.mockReset().mockResolvedValue({ run: { id: 'run-1' }, groups: [], total: 0 })
  fetchRuns.mockReset().mockResolvedValue([])
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

/**
 * The discovery control lives in the List settings popover now (Liam,
 * 2026-09-06: "rename this to find more companies and move it into the
 * settings dropdown since this shows after the initial find happens"). Opens
 * the popover and returns the item.
 */
async function openFindMore(): Promise<HTMLButtonElement> {
  const gear = document.body.querySelector('button[aria-label="List settings"]')
  if (!gear) throw new Error('settings button not rendered')
  await click(gear)
  const item = document.body.querySelector('button[data-prospect-find-more]')
  if (!item) throw new Error('Find more companies not in the settings menu')
  return item as HTMLButtonElement
}

/**
 * The dialog's confirm, scoped to the dialog. The header's primary button and
 * the dialog's confirm deliberately share the label "Find companies" (the
 * dialog confirms the action it was opened by), so a document-wide query finds
 * the header button first and clicks nothing.
 */
function confirmButton(): HTMLButtonElement {
  const dialog = document.body.querySelector('[role="dialog"]')
  if (!dialog) throw new Error('find dialog not open')
  const button = Array.from(dialog.querySelectorAll('button')).find(
    // Both carry the price now (C4), so the match is a prefix.
    (b) => b.textContent?.trim().startsWith('Find companies'),
  )
  if (!button) throw new Error('confirm button not rendered')
  return button
}

/** Pick a stage tab, the way a click on it in the views toolbar would: the
 *  tabs live in the (stubbed) shared layout, so this drives the handler the
 *  page hands it. */
async function pickStage(tab: string) {
  const pick = stageSpy.mock.calls.at(-1)?.[0]?.pick as ((t: string) => void) | undefined
  if (!pick) throw new Error('stage handler not handed to the layout')
  await act(async () => {
    pick(tab)
  })
}

/** The tab in force and the counts, as the page last handed them to the layout. */
function lastStage(): { stage: unknown; counts: Record<string, number> | null } {
  const last = stageSpy.mock.calls.at(-1)?.[0]
  return { stage: last?.stage, counts: (last?.counts ?? null) as Record<string, number> | null }
}

function click(el: Element) {
  return act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** The last filter set handed to UnifiedViewLayout. */
function lastScope(): Array<{ field: string; value: unknown }> {
  return scopeSpy.mock.calls.at(-1)?.[0] ?? []
}

describe('ListDetail — run surface', () => {
  it('offers Find more companies, in the settings menu, on a list with no run in flight', async () => {
    await render()
    // Not a top-level button any more: by the time this page is open the
    // first search has run, and the header should not read as step one.
    expect(
      Array.from(document.body.querySelectorAll('button')).some((b) =>
        (b.textContent ?? '').includes('Find companies'),
      ),
    ).toBe(false)
    const find = await openFindMore()
    expect(find.textContent).toContain('Find more companies')
    expect(find.disabled).toBe(false)
  })

  it('disables Find while a run is live and says why', async () => {
    fetchRuns.mockResolvedValue([run({ status: 'running' })])
    fetchRun.mockResolvedValue(run({ status: 'running' }))
    await render()

    const find = await openFindMore()
    expect(find.disabled).toBe(true)
    expect(find.getAttribute('title')).toBe('A run is already going on this list')
  })

  it('shows the live rail with the run’s own counts', async () => {
    fetchRuns.mockResolvedValue([run({ status: 'running' })])
    fetchRun.mockResolvedValue(run({ status: 'running' }))
    await render()

    const text = (document.body.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('Finding companies · round 2 of 2 · 24 found, 12 new · 6 already known')
  })

  it('starts a run with the list’s own defaults — no budget crosses the wire', async () => {
    startRun.mockResolvedValue(run({ status: 'queued' }))
    await render()

    await click(await openFindMore())
    await click(confirmButton())

    expect(startRun).toHaveBeenCalledWith('list-1')
    expect(toastError).not.toHaveBeenCalled()
  })

  it('renders a 409 as "Already running" and attaches to the live run', async () => {
    startRun.mockRejectedValue(
      new ProspectingRequestError({
        message: 'A run is already going on this list',
        code: 'RUN_ALREADY_LIVE',
        details: null,
        status: 409,
      }),
    )
    // The attach probe finds the run that is actually in flight.
    fetchRuns.mockResolvedValueOnce([]).mockResolvedValue([run({ status: 'running' })])
    fetchRun.mockResolvedValue(run({ status: 'running' }))
    await render()

    await click(await openFindMore())
    await click(confirmButton())
    await act(async () => {})

    // Never a red toast — the 409 is the one-live-run index working.
    expect(toastError).not.toHaveBeenCalled()
    // And the page is now showing the run that was already going.
    expect((document.body.textContent ?? '').replace(/\s+/g, ' ')).toContain('24 found, 12 new')
  })

  it('shows the terminal outcome banner once a run settles', async () => {
    fetchRuns.mockResolvedValue([run({ status: 'completed', is_live: false })])
    await render()

    const text = (document.body.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('6 already in this list')
    expect(text).toContain('12 new')
  })

  it('opens on Saved — this list has two saved rows, and the Saved tab IS the list', async () => {
    // Liam, 2026-09-06: "once you save at least one, the default view should
    // be saved and not all". The stage rides the SAME scopeFilters seam as the
    // list scope, so the tab and the rows are one query and cannot disagree.
    await render()
    expect(lastStage().stage).toBe('saved')
    expect(lastScope().find((f) => f.field === 'stage')?.value).toBe('saved')
  })

  it('narrows the list through scopeFilters — All is the list scope and the kind, nothing more', async () => {
    await render()
    await pickStage('all')
    // The list scope plus the Companies kind (the kind rides the same seam).
    // "All" adds NO stage filter: the SERVER hides the dismissed rows unless a
    // filter names `stage` (applyEntityDefaults), which is also what lets a
    // custom view built as "Stage is dismissed" be honoured.
    const scope = lastScope()
    expect(scope.map((f) => f.field)).toEqual(['list_id', 'kind'])
  })

  it('narrows by stage for Saved and Dismissed', async () => {
    await render()

    await pickStage('dismissed')
    expect(lastScope().find((f) => f.field === 'stage')?.value).toBe('dismissed')

    await pickStage('saved')
    expect(lastScope().find((f) => f.field === 'stage')?.value).toBe('saved')

    await pickStage('all')
    expect(lastScope().map((f) => f.field)).toEqual(['list_id', 'kind'])
  })

  it('counts the tabs from the loaded entries', async () => {
    fetchRuns.mockResolvedValue([run({ status: 'completed', is_live: false })])
    await render()
    // Three rows still on the list; the saved and dismissed tallies come from
    // the route's counts.
    expect(lastStage().counts).toMatchObject({ all: 3, saved: 2, dismissed: 1, needs_review: 0 })
  })

  it('retries a failed people run as a people run over its own selection, not as discovery', async () => {
    const failed = run({ kind: 'people', status: 'failed', is_live: false, target_entry_ids: ['e1', 'e2'] })
    fetchRuns.mockResolvedValue([failed])
    startRun.mockResolvedValue(run({ kind: 'people', status: 'queued', target_entry_ids: ['e1', 'e2'] }))
    await render()

    const retry = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Retry',
    )
    if (!retry) throw new Error('Retry not rendered')
    await click(retry)

    expect(startRun).toHaveBeenCalledWith('list-1', { kind: 'people', entryIds: ['e1', 'e2'] })
  })

  it('says why a failed targeted run with no targets cannot be retried, and starts nothing', async () => {
    const failed = run({ kind: 'account_card', status: 'failed', is_live: false, target_entry_ids: [] })
    fetchRuns.mockResolvedValue([failed])
    await render()

    const retry = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Retry',
    )
    if (!retry) throw new Error('Retry not rendered')
    await click(retry)

    expect(startRun).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledTimes(1)
  })
})

/**
 * A PEOPLE run lives in the rows, not in a rail (Liam, 2026-09-06: "show
 * that icon on each of the lines until it resolves, so we don't need that top
 * header thing"). The page hands the rows the run's targets and start time
 * through ProspectListActivityContext, draws no rail, and keeps the one
 * control a row cannot offer — stopping the whole run — on the filter strip.
 */
describe('ListDetail — a people run is drawn on its rows', () => {
  const PEOPLE = () =>
    run({
      kind: 'people',
      status: 'running',
      target_entry_ids: ['e1', 'e2'],
      started_at: '2026-09-06T10:00:00.000Z',
    })

  function stopButton(): HTMLButtonElement | undefined {
    return Array.from(document.body.querySelectorAll('button')).find((b) =>
      b.hasAttribute('data-prospect-stop-people'),
    )
  }

  function lastActivity(): ProspectListActivity {
    return activitySpy.mock.calls.at(-1)?.[0] as ProspectListActivity
  }

  it('draws no rail for a live people run and hands the rows its targets', async () => {
    fetchRuns.mockResolvedValue([PEOPLE()])
    fetchRun.mockResolvedValue(PEOPLE())
    await render()

    const text = (document.body.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).not.toContain('Finding people')

    // The rows get the run instead: which companies, and since when.
    const activity = lastActivity()
    expect(activity.runLive).toBe(true)
    expect(activity.profiling).toBe(false)
    expect([...activity.findingPeople!.ids]).toEqual(['e1', 'e2'])
    expect(activity.findingPeople!.since).toBe('2026-09-06T10:00:00.000Z')

    // The one page-level control, and Find more companies still knows a run is live.
    expect(stopButton()!.textContent).toBe('Stop finding people')
    expect((await openFindMore()).disabled).toBe(true)
  })

  it('the profile run keeps its rail — the rows it scores say "Scoring…", the rail says how far along', async () => {
    fetchRuns.mockResolvedValue([run({ kind: 'account_card', status: 'running' })])
    fetchRun.mockResolvedValue(run({ kind: 'account_card', status: 'running' }))
    await render()

    expect((document.body.textContent ?? '').replace(/\s+/g, ' ')).toContain('Building profiles')
    expect(stopButton()).toBeUndefined()
    expect(lastActivity().profiling).toBe(true)
    expect(lastActivity().findingPeople).toBeNull()
  })

  it('Stop finding people cancels the run and says the people found are kept', async () => {
    fetchRuns.mockResolvedValue([PEOPLE()])
    fetchRun.mockResolvedValue(PEOPLE())
    cancelRun.mockResolvedValue({ ...PEOPLE(), status: 'canceling' })
    await render()

    await click(stopButton()!)

    expect(cancelRun).toHaveBeenCalledWith('run-1')
    expect(toastSuccess).toHaveBeenCalledWith('Cancelling — results are kept')
    // Two-step copy, like the rail's: the run is still live until the engine
    // stops between companies, and the rows keep their orbs until then.
    expect(stopButton()!.textContent).toBe('Stopping…')
    expect(stopButton()!.disabled).toBe(true)
    expect(lastActivity().findingPeople).not.toBeNull()
  })

  it('a settled people run hands the rows nothing — the orbs come off with it', async () => {
    fetchRuns.mockResolvedValue([run({ ...PEOPLE(), status: 'completed', is_live: false })])
    await render()

    expect(lastActivity().runLive).toBe(false)
    expect(lastActivity().findingPeople).toBeNull()
    expect(stopButton()).toBeUndefined()
  })
})
