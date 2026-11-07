// @vitest-environment jsdom
/**
 * THE OUTCOME SURFACE AND THE SCOUT SEAM, wired into the list detail (C3, C5).
 *
 * Two problems arrive together the moment Scout can work a list from the chat
 * strip beside it, and this suite is the proof that the page answers both.
 *
 * PROBLEM ONE — THE PAGE GOES STALE AND SAYS NOTHING. Scout saves fourteen
 * rows. The page's stage counts, its gate populations and its Sequenced chips
 * are all derived from data that just changed, and nothing tells it. The user
 * pressed nothing, so there is no gesture to hang a toast off, and no refetch
 * would ever fire. So the page subscribes to what Scout did (`scout-activity`,
 * the mirror of `selection-context`) and refetches on a NEW tool call — new
 * being the load-bearing word, because a resumed conversation replays its whole
 * transcript through `setMessages` and a page that refetched on every republish
 * would hammer the route on every chat re-render.
 *
 * PROBLEM TWO — TWO INTERFACES BID FOR THE SAME MONEY. The full-size gate
 * banner offers to spend $0.23 researching eighteen companies, beside a
 * conversation that just offered to do the same thing to the same rows. The
 * user has to work out whether pressing both runs it twice. So the gate goes
 * QUIET — and quiet is not gone: every choice is still there, still firing the
 * same handler, still carrying the same price, because the page is where the
 * cost is stated in the engine's own units and a user who ignores Scout
 * entirely must lose nothing.
 *
 * And the third thing, which spans both: THE SAVE STORY. The page tells the
 * same sentence for its own save and for Scout's, in the same banner, with the
 * same doorways. A user who asked Scout to "save the hot ones" should not
 * have to go back to the chat to find out what happened to their list.
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

const scopeSpy = vi.fn()
const selectionSpy = vi.fn()
/** The stage tabs are drawn by the shared views toolbar now; the stub captures
 *  the tab, the counts and the pick handler the page hands it. */
const stageSpy = vi.fn()
vi.mock('@/components/views/unified-view-layout', () => ({
  UnifiedViewLayout: (props: {
    scopeFilters?: unknown
    onBulkSelectionChange?: (info: unknown) => void
    prospectStage?: unknown
    prospectStageCounts?: unknown
    onProspectStageChange?: (tab: string) => void
    selectionActions?: React.ReactNode
  }) => {
    scopeSpy(props.scopeFilters)
    selectionSpy(props.onBulkSelectionChange)
    stageSpy({ stage: props.prospectStage, counts: props.prospectStageCounts, pick: props.onProspectStageChange })
    // The selection island is the layout's; the page's verbs ride in it.
    return <>{props.selectionActions}</>
  },
}))
vi.mock('../../views/company-detail-panel', () => ({ CompanyDetailPanel: () => null }))
vi.mock('../../views/contact-detail-panel', () => ({ ContactDetailPanel: () => null }))

const fetchList = vi.fn()
const fetchRuns = vi.fn()
const fetchRun = vi.fn()
const fetchActiveRuns = vi.fn()
const saveEntries = vi.fn()
const publishList = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    fetchList: (id: string) => fetchList(id),
    fetchRuns: (listId: string, limit?: number) => fetchRuns(listId, limit),
    fetchRun: (id: string) => fetchRun(id),
    fetchActiveRuns: () => fetchActiveRuns(),
    fetchSequenced: () => Promise.resolve({}),
    saveEntries: (ids: string[], includeUnverified: boolean) =>
      saveEntries(ids, includeUnverified),
    publishList: (id: string) => publishList(id),
  }
})

import { ListDetail } from '../list-detail'
import {
  publishScoutActivity,
  __resetScoutActivityStore,
  type ScoutListActivity,
} from '../scout-activity'
import { LIST, entry } from './fixtures'

const COUNTS = { discovered: 6, shortlisted: 0, saved: 0, dismissed: 0, total: 6 }

/** Three companies nothing has been researched on — enough for the gate to have
 *  both a research half and something to quote. */
const ENTRIES = [
  entry({ id: 'c1', fit_score: 90 }),
  entry({ id: 'c2', fit_score: 70 }),
  entry({ id: 'c3', fit_score: 45 }),
]

let container: HTMLDivElement
let root: Root

interface SelectionInfo {
  hasSelection: boolean
  count: number
  selectedIds: string[]
  onClear: () => void
}

beforeEach(() => {
  __resetScoutActivityStore()
  toastError.mockReset()
  toastSuccess.mockReset()
  scopeSpy.mockClear()
  selectionSpy.mockClear()
  stageSpy.mockClear()
  saveEntries.mockReset()
  publishList.mockReset()
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
const onOpenSequence = vi.fn()

async function render() {
  onOpenSequence.mockReset()
  await act(async () => {
    root.render(
      <ListDetail
        listId="list-1"
        onBack={noop}
        onNameLoaded={noop}
        onOpenSequence={onOpenSequence}
      />,
    )
  })
  await act(async () => {})
}

function text(): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.trim().startsWith(label),
  )
}

/** The selection bar's Save — by attribute, because "Save" is a prefix of the
 *  "Saved" chip's label. */
function saveSelection(): HTMLButtonElement | undefined {
  return (document.body.querySelector('button[data-prospect-save-selection]') as HTMLButtonElement | null) ?? undefined
}

function banner(): Element | null {
  return container.querySelector('[data-save-story]')
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
}

async function select(ids: string[]) {
  const handler = selectionSpy.mock.calls.at(-1)?.[0] as
    | ((info: SelectionInfo) => void)
    | undefined
  await act(async () => {
    handler?.({
      hasSelection: ids.length > 0,
      count: ids.length,
      selectedIds: ids,
      onClear: () => {},
    })
  })
  await act(async () => {})
}

/** Publish one panel's activity for this list, the way chat-panel.tsx does. */
async function scoutDid(activity: Partial<ScoutListActivity>) {
  await act(async () => {
    publishScoutActivity('chat-1', 'list-1', {
      listId: 'list-1',
      version: 1,
      lastEventAt: Date.now(),
      touched: true,
      lastSave: null,
      lastEnroll: null,
      lastDismiss: null,
      ...activity,
    })
  })
  await act(async () => {})
}

function lastScope(): Array<{ field: string; operator: string; value: unknown }> {
  return (scopeSpy.mock.calls.at(-1)?.[0] ?? []) as Array<{
    field: string
    operator: string
    value: unknown
  }>
}

/** The tab in force and the counts, as the page last handed them to the layout. */
function lastStage(): { stage: unknown; counts: Record<string, number> | null } {
  const last = stageSpy.mock.calls.at(-1)?.[0]
  return { stage: last?.stage, counts: (last?.counts ?? null) as Record<string, number> | null }
}

/** Pick a stage tab the way a click on it in the views toolbar would. */
async function pickStage(tab: string) {
  const pick = stageSpy.mock.calls.at(-1)?.[0]?.pick as ((t: string) => void) | undefined
  if (!pick) throw new Error('stage handler not handed to the layout')
  await act(async () => {
    pick(tab)
  })
}

// ---------------------------------------------------------------------------

describe('the page tells its OWN save as a story', () => {
  it('renders the banner instead of a toast for a multi-row save', async () => {
    saveEntries.mockResolvedValue({
      saved: [
        { entry_id: 'c1', list_id: 'list-1', kind: 'company', company_id: 'co-1' },
        { entry_id: 'c2', list_id: 'list-1', kind: 'company', company_id: 'co-2' },
        { entry_id: 'p1', list_id: 'list-1', kind: 'person', contact_id: 'ct-1' },
      ],
      skipped: [
        { entry_id: 'p2', list_id: 'list-1', reason: 'needs_review' },
        { entry_id: 'c9', list_id: 'list-1', reason: 'no_domain' },
      ],
    })
    await render()
    await select(['c1', 'c2', 'p1', 'p2', 'c9'])
    await click(saveSelection()!)

    // The toast is reserved for the single-row case, where the record's own
    // panel opens underneath it. A bulk save's outcome has to survive longer
    // than four seconds and has to be clickable.
    expect(toastSuccess).not.toHaveBeenCalled()
    const said = (banner()?.textContent ?? '').replace(/\s+/g, ' ')
    expect(said).toContain('2 companies and 1 person saved to the list')
    expect(said).toContain('1 need review')
    expect(said).toContain('1 skipped')
    expect(banner()?.getAttribute('data-save-story')).toBe('page')
  })

  it('keeps the toast for a SINGLE-row save', async () => {
    saveEntries.mockResolvedValue({
      saved: [{ entry_id: 'c1', list_id: 'list-1', kind: 'company', company_id: 'co-1' }],
      skipped: [],
    })
    await render()
    await select(['c1'])
    await click(saveSelection()!)

    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(banner()).toBeNull()
  })

  it('separates needs_review from every other refusal', async () => {
    // They are counted apart because they are the only refusal the user can do
    // something about, and the thing they do about it is a different chip.
    saveEntries.mockResolvedValue({
      saved: [
        { entry_id: 'c1', list_id: 'list-1', kind: 'company', company_id: 'co-1' },
        { entry_id: 'c2', list_id: 'list-1', kind: 'company', company_id: 'co-2' },
      ],
      skipped: [
        { entry_id: 'p1', list_id: 'list-1', reason: 'needs_review' },
        { entry_id: 'p2', list_id: 'list-1', reason: 'needs_review' },
        { entry_id: 'p3', list_id: 'list-1', reason: 'dismissed' },
      ],
    })
    await render()
    await select(['c1', 'c2', 'p1', 'p2', 'p3'])
    await click(saveSelection()!)

    const said = (banner()?.textContent ?? '').replace(/\s+/g, ' ')
    expect(said).toContain('2 need review')
    expect(said).toContain('1 skipped')
  })

  it('sends the saved clause to the Saved tab and the review clause to its own', async () => {
    saveEntries.mockResolvedValue({
      saved: [
        { entry_id: 'c1', list_id: 'list-1', kind: 'company', company_id: 'co-1' },
        { entry_id: 'c2', list_id: 'list-1', kind: 'company', company_id: 'co-2' },
      ],
      skipped: [{ entry_id: 'p1', list_id: 'list-1', reason: 'needs_review' }],
    })
    await render()
    await select(['c1', 'c2', 'p1'])
    await click(saveSelection()!)

    await click(button('2 companies saved to the list')!)
    expect(lastStage().stage).toBe('saved')
    expect(lastScope().find((f) => f.field === 'stage')?.value).toBe('saved')

    await click(button('1 need review')!)
    const identity = lastScope().find((f) => f.field === 'identity_state')
    expect(identity).toMatchObject({ operator: 'is', value: 'needs_review' })
  })

  it('is dismissible, and stays dismissed', async () => {
    saveEntries.mockResolvedValue({
      saved: [
        { entry_id: 'c1', list_id: 'list-1', kind: 'company', company_id: 'co-1' },
        { entry_id: 'c2', list_id: 'list-1', kind: 'company', company_id: 'co-2' },
      ],
      skipped: [],
    })
    await render()
    await select(['c1', 'c2'])
    await click(saveSelection()!)
    expect(banner()).toBeTruthy()

    await click(container.querySelector('[aria-label="Dismiss"]')!)
    expect(banner()).toBeNull()
  })
})

describe('the page tells SCOUT’s save as the same story', () => {
  it('adopts a save Scout made in the chat strip', async () => {
    await render()
    expect(banner()).toBeNull()

    await scoutDid({
      lastSave: {
        toolCallId: 'call-1', published: true,
        saved_companies: 6,
        saved_people: 8,
        needs_review: 2,
        skipped_other: 1,
        sequenceable_count: 8,
      },
    })

    const said = (banner()?.textContent ?? '').replace(/\s+/g, ' ')
    expect(said).toContain('6 companies and 8 people added to your CRM')
    expect(said).toContain('2 need review')
    expect(banner()?.getAttribute('data-save-story')).toBe('scout')
  })

  it('merges an enrollment into the save it followed, rather than stacking a second banner', async () => {
    await render()
    await scoutDid({
      lastSave: {
        toolCallId: 'call-1', published: true,
        saved_companies: 0,
        saved_people: 8,
        needs_review: 0,
        skipped_other: 0,
        sequenceable_count: 8,
      },
    })
    await scoutDid({
      version: 2,
      lastSave: {
        toolCallId: 'call-1', published: true,
        saved_companies: 0,
        saved_people: 8,
        needs_review: 0,
        skipped_other: 0,
        sequenceable_count: 8,
      },
      lastEnroll: {
        toolCallId: 'call-2',
        sequence_id: 'seq-1',
        sequence_name: 'Q4 Outbound',
        enrolled_count: 8,
        skipped_count: 0,
      },
    })

    expect(container.querySelectorAll('[data-save-story]')).toHaveLength(1)
    const said = (banner()?.textContent ?? '').replace(/\s+/g, ' ')
    expect(said).toContain('8 people added to your CRM')
    expect(said).toContain('8 enrolled in Q4 Outbound')
  })

  it('navigates to the sequence — the one link on this page that leaves it', async () => {
    await render()
    await scoutDid({
      lastEnroll: {
        toolCallId: 'call-2',
        sequence_id: 'seq-1',
        sequence_name: 'Q4 Outbound',
        enrolled_count: 14,
        skipped_count: 0,
      },
    })
    await click(button('14 enrolled in Q4 Outbound')!)
    expect(onOpenSequence).toHaveBeenCalledWith('seq-1', 'Q4 Outbound')
  })

  /**
   * The store republishes an equal object on any unrelated re-render of the
   * chat panel. Re-setting the story on each one would resurrect a banner the
   * user had just dismissed — the single most annoying possible bug in a
   * dismissible surface.
   */
  it('does not resurrect a dismissed banner when the same tool call is republished', async () => {
    await render()
    const save = {
      toolCallId: 'call-1', published: true,
      saved_companies: 3,
      saved_people: 0,
      needs_review: 0,
      skipped_other: 0,
      sequenceable_count: 0,
    }
    await scoutDid({ lastSave: save })
    await click(container.querySelector('[aria-label="Dismiss"]')!)
    expect(banner()).toBeNull()

    // Same toolCallId, a later lastEventAt — exactly what a re-render produces.
    await scoutDid({ lastSave: save, lastEventAt: Date.now() + 1000 })
    expect(banner()).toBeNull()
  })
})

describe('the page refetches when Scout mutates the list', () => {
  it('reloads on a NEW event', async () => {
    await render()
    const before = fetchList.mock.calls.length

    await scoutDid({
      version: 1,
      lastDismiss: { toolCallId: 'call-1', updated: 4 },
    })
    expect(fetchList.mock.calls.length).toBeGreaterThan(before)
  })

  it('does NOT reload on a republish of the same version', async () => {
    // A resumed conversation replays its entire transcript through setMessages.
    // The store's `version` bumps only on a not-yet-seen toolCallId precisely so
    // this page does not treat that replay as a fresh burst of writes.
    await render()
    await scoutDid({ version: 1, lastDismiss: { toolCallId: 'call-1', updated: 4 } })
    const after = fetchList.mock.calls.length

    await scoutDid({
      version: 1,
      lastEventAt: Date.now() + 5000,
      lastDismiss: { toolCallId: 'call-1', updated: 4 },
    })
    expect(fetchList.mock.calls.length).toBe(after)
  })
})

describe('the needs-review tab', () => {
  it('has nothing to say when the list has none — the tab hides itself at zero', async () => {
    await render()
    expect(lastStage().counts?.needs_review).toBe(0)
  })

  it('appears and narrows on the persisted identity_state, not the save-time refusal', async () => {
    fetchList.mockResolvedValue({
      list: LIST,
      entries: [
        ...ENTRIES,
        entry({
          id: 'p1',
          kind: 'person',
          parent_entry_id: 'c1',
          identity_state: 'needs_review',
        }),
      ],
      entry_counts: { ...COUNTS, total: 7 },
    })
    await render()

    expect(lastStage().counts?.needs_review).toBe(1)

    await pickStage('needs_review')
    expect(lastScope().find((f) => f.field === 'identity_state')).toMatchObject({
      operator: 'is',
      value: 'needs_review',
    })
    // The tab is visible on Companies (it is an exception cue, counted over
    // both kinds) and picking it switches to People, where the row lives —
    // on Companies the same filter would narrow to nothing.
    expect(lastScope().find((f) => f.field === 'kind')?.value).toBe('person')
  })
})



/**
 * PUBLISH — the list becomes its group in the CRM (migration 259). The
 * header's button counts what a press would write, the outcome is told as
 * the same story a save is, naming the list, and a SAVE story opens onto the
 * publish so the user is never left wondering what to press next.
 */
describe('the page publishes the list', () => {
  function publishButton(): HTMLButtonElement | null {
    return document.body.querySelector('button[data-prospect-publish]') as HTMLButtonElement | null
  }

  it('offers Publish · N from the pending count', async () => {
    fetchList.mockResolvedValue({ list: LIST, entries: ENTRIES, entry_counts: { ...COUNTS, pending_publish: 3 } })
    await render()
    expect(publishButton()!.textContent).toContain('Publish · 3')
    expect(publishButton()!.disabled).toBe(false)
  })

  it('says Published, quietly and disabled, once nothing is pending on a published list', async () => {
    fetchList.mockResolvedValue({
      list: { ...LIST, published_at: '2026-09-06T00:00:00Z' },
      entries: ENTRIES,
      entry_counts: { ...COUNTS, pending_publish: 0 },
    })
    await render()
    expect(publishButton()!.textContent).toContain('Published')
    expect(publishButton()!.disabled).toBe(true)
  })

  it('tells the publish as a story naming the list, with the review clause, and refetches', async () => {
    fetchList.mockResolvedValue({ list: LIST, entries: ENTRIES, entry_counts: { ...COUNTS, pending_publish: 3 } })
    publishList.mockResolvedValue({
      saved: [
        { entry_id: 'c1', list_id: 'list-1', kind: 'company', company_id: 'co-1' },
        { entry_id: 'c2', list_id: 'list-1', kind: 'company', company_id: 'co-2' },
        { entry_id: 'p1', list_id: 'list-1', kind: 'person', contact_id: 'ct-1', email: 'a@x.test' },
      ],
      skipped: [{ entry_id: 'p2', list_id: 'list-1', reason: 'needs_review' }],
      list_ids: ['list-1'],
      published_at: '2026-09-06T00:00:00Z',
      list_name: 'Customers like us',
    })
    await render()
    const before = fetchList.mock.calls.length
    await click(publishButton()!)

    expect(publishList).toHaveBeenCalledWith('list-1')
    const said = (banner()?.textContent ?? '').replace(/\s+/g, ' ')
    expect(said).toContain('2 companies and 1 person added to your CRM under “Customers like us”')
    expect(said).toContain('1 need review')
    // The saved clause never sits beside a Publish doorway on a PUBLISHED story.
    expect(button('Publish to CRM')).toBeUndefined()
    expect(fetchList.mock.calls.length).toBeGreaterThan(before)
  })

  it('a SAVE story opens onto Publish to CRM', async () => {
    saveEntries.mockResolvedValue({
      saved: [
        { entry_id: 'c1', list_id: 'list-1', kind: 'company' },
        { entry_id: 'c2', list_id: 'list-1', kind: 'company' },
      ],
      skipped: [],
    })
    publishList.mockResolvedValue({ saved: [], skipped: [], list_ids: ['list-1'], published_at: null })
    await render()
    await select(['c1', 'c2'])
    await click(saveSelection()!)
    const said = (banner()?.textContent ?? '').replace(/\s+/g, ' ')
    expect(said).toContain('2 companies saved to the list')

    await click(button('Publish to CRM')!)
    expect(publishList).toHaveBeenCalledWith('list-1')
  })
})
