// @vitest-environment jsdom
/**
 * The second gate and the two tabs, wired into the list detail (§9, §10).
 *
 * The pieces are unit-tested next door; this suite pins the SEAMS between them
 * and the page, which is where the money and the identity actually leak:
 *
 *   - the gate counts COMPANY entries by whether their `research` blob is
 *     empty, so it survives a reload and never quotes for dismissed rows;
 *   - the chip's action commits the ids the chip shows, not the whole list — the single
 *     assertion that stops the cheap option from spending the expensive
 *     amount;
 *   - the account_card / people kickoffs go out with `entry_ids`, which is
 *     §9's cost guarantee in its only observable form;
 *   - the tabs narrow through `scopeFilters`, the same seam the chips use, so
 *     the tab count and the visible rows come from one query;
 *   - people are nested under their company: the page queries companies only,
 *     and the Needs review chip is the one flat people view.
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
/** The page owns the selection bar (Save and Dismiss both need per-row
 *  outcomes the generic bulk endpoint cannot express), so the only way to
 *  drive it from a test is the callback the layout hands up. */
const selectionSpy = vi.fn()
/** The stage tabs (All · Saved · Needs review · Dismissed) are drawn by the
 *  shared views toolbar now; the stub captures what the page hands it and
 *  renders the page's toolbar actions — "Enrich · N" lives there. */
const stageSpy = vi.fn()
vi.mock('@/components/views/unified-view-layout', () => ({
  UnifiedViewLayout: (props: {
    scopeFilters?: unknown
    onBulkSelectionChange?: (info: unknown) => void
    prospectStage?: unknown
    prospectStageCounts?: unknown
    onProspectStageChange?: (tab: string) => void
    toolbarActions?: React.ReactNode
    selectionActions?: React.ReactNode
  }) => {
    scopeSpy(props.scopeFilters)
    selectionSpy(props.onBulkSelectionChange)
    stageSpy({ stage: props.prospectStage, counts: props.prospectStageCounts, pick: props.onProspectStageChange })
    // Both slots: "Enrich · N" lives in the toolbar, the selection's verbs in
    // the island the layout draws.
    return <>{props.toolbarActions}{props.selectionActions}</>
  },
}))
vi.mock('../../views/company-detail-panel', () => ({ CompanyDetailPanel: () => null }))
vi.mock('../../views/contact-detail-panel', () => ({ ContactDetailPanel: () => null }))

const fetchList = vi.fn()
const fetchRuns = vi.fn()
const fetchRun = vi.fn()
const startRun = vi.fn()
const fetchRunCandidates = vi.fn()
const patchList = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    fetchList: (id: string) => fetchList(id),
    fetchRuns: (listId: string, limit?: number) => fetchRuns(listId, limit),
    fetchRun: (id: string) => fetchRun(id),
    startRun: (listId: string, options?: unknown) => startRun(listId, options),
    fetchRunCandidates: (id: string) => fetchRunCandidates(id),
    patchList: (id: string, body: unknown) => patchList(id, body),
  }
})

import { ListDetail } from '../list-detail'
import { LIST, entry } from './fixtures'
import { progress, run } from './run-fixtures'
import { MAX_ENTRIES_PER_TARGETED_RUN } from '@/lib/prospecting/spend'

/**
 * A researched company — carrying the `candidate.account_card_at` STAMP the
 * account-card run writes, which is what takes an entry out of the gate's
 * queue. (The card keys in `research` are the pre-stamp fallback; a row
 * carrying both is the normal post-run shape.)
 */
function researched(overrides: Parameters<typeof entry>[0] = {}) {
  return entry({
    candidate: { name: 'Acme', domain: 'acme.com', account_card_at: '2026-09-04T12:00:00.000Z' },
    research: { fields: { employee_count: { value: '200', confidence: 'high' } } },
    ...overrides,
  })
}

/**
 * A company that discovery has written a research blob for and NOTHING ELSE.
 *
 * This is the shape the gate used to misread: `research` is non-empty, so the
 * old "blob is non-empty" predicate called it researched, and the observed
 * result on a live list of 45 was "1 company to research" beside an offer to
 * find people at 44 companies that had never been carded.
 */
function discoveryOnly(overrides: Parameters<typeof entry>[0] = {}) {
  return entry({
    research: {
      name: { value: 'Acme' },
      one_liner: { value: 'Sales tooling' },
      why_match: { value: 'Large sales org' },
      signal: { value: 'Raised a Series B' },
      employee_range: { value: '200' },
      founded_year: { value: '2015' },
    },
    ...overrides,
  })
}

function personEntry(overrides: Parameters<typeof entry>[0] = {}) {
  return entry({
    kind: 'person',
    parent_entry_id: 'c1',
    candidate_key: 'linkedin.com/in/dana',
    candidate: { name: 'Dana Reyes', title: 'VP RevOps', company_name: 'Acme' },
    identity_state: 'anchored',
    ...overrides,
  })
}

// Three unresearched (unscored — the profile is what scores), two researched
// and scored, one dismissed, one person.
const ENTRIES = [
  entry({ id: 'c1', fit_score: null }),
  entry({ id: 'c2', fit_score: null }),
  entry({ id: 'c3', fit_score: null }),
  researched({ id: 'c4', fit_score: 70 }),
  researched({ id: 'c5', fit_score: 70 }),
  entry({ id: 'c6', fit_score: null, stage: 'dismissed', dismissed_reason: 'competitor' }),
  personEntry({ id: 'p1' }),
]

const COUNTS = { discovered: 5, shortlisted: 0, saved: 0, dismissed: 1, total: 7 }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  toastError.mockReset()
  toastSuccess.mockReset()
  scopeSpy.mockReset()
  selectionSpy.mockReset()
  stageSpy.mockReset()
  startRun.mockReset().mockResolvedValue(run({ status: 'queued', kind: 'account_card' }))
  patchList.mockReset()
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

async function render() {
  await act(async () => {
    root.render(<ListDetail listId="list-1" onBack={() => {}} onNameLoaded={() => {}} />)
  })
  await act(async () => {})
}

function text(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find((b) =>
    b.textContent?.trim().startsWith(label),
  )
}

/**
 * The people action — "Find decision makers", an icon beside the gear with
 * its name and scope on hover (Liam, 2026-09-06). No label at all; the count
 * and the scope are in its title, and it is DISABLED rather than hidden when
 * there is nothing to run. Found by attribute.
 */
function findPeople(): HTMLButtonElement | undefined {
  return (document.body.querySelector('button[data-prospect-find-people-header]') as HTMLButtonElement | null) ?? undefined
}

/** The selection bar's Save — by attribute, because "Save" is a prefix of the
 *  "Saved" chip's label. */
function saveSelection(): HTMLButtonElement | undefined {
  return (document.body.querySelector('button[data-prospect-save-selection]') as HTMLButtonElement | null) ?? undefined
}

/** Just the Companies/People strip — the outcome banner states the same yield
 *  and would otherwise satisfy an assertion about the tab header. */
function click(el: Element) {
  return act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function lastScope(): Array<{ field: string; value: unknown }> {
  return scopeSpy.mock.calls.at(-1)?.[0] ?? []
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

/** The counts the page last handed the tabs. */
function lastCounts(): Record<string, number> {
  return (stageSpy.mock.calls.at(-1)?.[0]?.counts ?? {}) as Record<string, number>
}

interface SelectionInfo {
  hasSelection: boolean
  count: number
  selectedIds: string[]
  onClear: () => void
}

/** The live `onBulkSelectionChange` the page handed the layout on its most
 *  recent render — the only seam a test has into a selection bar the PAGE
 *  owns rather than the shared layout. */
function selectionHandler(): ((info: SelectionInfo) => void) | undefined {
  return selectionSpy.mock.calls.at(-1)?.[0]
}

describe('ListDetail — the toolbar actions', () => {
  it('offers Enrich for the unresearched, undismissed COMPANY entries in view', async () => {
    await render()
    // c1, c2, c3 — c4/c5 are researched, c6 is dismissed, p1 is a person.
    expect(button('Enrich · 3')).toBeTruthy()
    // The old gate block is gone: the chips are the choice now.
    expect(text()).not.toContain('Get their full profiles')
    expect(button('Choose manually')).toBeUndefined()
  })

  it('offers Find decision makers for the researched companies — the count in the title, not the label', async () => {
    await render()
    const people = findPeople()!
    expect(people.getAttribute('aria-label')).toBe('Find decision makers')
    expect(people.textContent?.trim()).toBe('')
    expect(people.disabled).toBe(false)
    expect(people.getAttribute('title')).toContain('Find decision makers — people at the 2 profiled companies')
  })

  it('a DISCOVERY blob does not count as researched — the inverted-gate bug', async () => {
    // Reproduces what was observed live: a list of discovered companies, each
    // carrying discovery's own `research` blob and NOTHING from the account
    // card. Under the old "blob is non-empty" predicate this list reported
    // nothing to research and offered people-search for all of them. Every one
    // of them owes an account card, and none of them is ready for people.
    fetchList.mockResolvedValue({
      list: LIST,
      entries: [
        discoveryOnly({ id: 'd1', fit_score: null }),
        discoveryOnly({ id: 'd2', fit_score: null }),
        discoveryOnly({ id: 'd3', fit_score: null }),
      ],
      entry_counts: { discovered: 3, shortlisted: 0, saved: 0, dismissed: 0, total: 3 },
    })
    await render()

    expect(button('Enrich · 3')).toBeTruthy()
    expect(findPeople()!.disabled).toBe(true)
  })

  it('the stamp alone moves a company from the research half to the people half', async () => {
    // The same three rows, one of them carded. The populations must move
    // together: a company counted in both halves would be billed twice, and one
    // counted in neither would have no affordance at all.
    fetchList.mockResolvedValue({
      list: LIST,
      entries: [
        discoveryOnly({ id: 'd1', fit_score: null }),
        discoveryOnly({ id: 'd2', fit_score: null }),
        discoveryOnly({
          id: 'd3',
          fit_score: null,
          candidate: { name: 'Acme', domain: 'acme.com', account_card_at: '2026-09-04T12:00:00.000Z' },
        }),
      ],
      entry_counts: { discovered: 3, shortlisted: 0, saved: 0, dismissed: 0, total: 3 },
    })
    await render()

    expect(button('Enrich · 2')).toBeTruthy()
    expect(findPeople()!.disabled).toBe(false)
    expect(findPeople()!.getAttribute('title')).toContain('the profiled company in this view')
  })

  it('scopes both actions to the selected tab', async () => {
    // The tab narrows the rows AND the actions: on All, three unprofiled
    // companies to enrich and two profiled ones to find people at; on
    // Dismissed, nothing — a dismissed company is out of both gate sets.
    await render()
    expect(button('Enrich · 3')).toBeTruthy()
    expect(findPeople()!.disabled).toBe(false)
    expect(findPeople()!.getAttribute('title')).toContain('2 profiled companies')

    await pickStage('dismissed')
    expect(button('Enrich · 3')).toBeUndefined()
    // Disabled, not gone: the header keeps its shape across tabs.
    expect(findPeople()!.disabled).toBe(true)

    await pickStage('all')
    expect(button('Enrich · 3')).toBeTruthy()
    expect(findPeople()!.disabled).toBe(false)
  })

  it("a row's Find people runs the people search for that ONE company", async () => {
    // The row's button states an intent through the same event Save and
    // Dismiss use; the page turns it into a one-company people run — the
    // same run kind the header's "Find decision makers" starts.
    await render()
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('dial8:prospect-entry-action', {
          detail: { action: 'people', entryIds: ['c4'] },
        }),
      )
    })
    expect(startRun).toHaveBeenCalledWith('list-1', {
      kind: 'people',
      entryIds: ['c4'],
    })
    expect(toastError).not.toHaveBeenCalled()
  })

  it("a profile intent still runs the one-company profile — the panel's catch-up path", async () => {
    // The row's button states an intent through the same event Save and
    // Dismiss use; the page turns it into a one-company account_card run —
    // the same run kind the strip's "Enrich · N" starts.
    await render()
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('dial8:prospect-entry-action', {
          detail: { action: 'profile', entryIds: ['c3'] },
        }),
      )
    })
    expect(startRun).toHaveBeenCalledWith('list-1', {
      kind: 'account_card',
      entryIds: ['c3'],
    })
    expect(toastError).not.toHaveBeenCalled()
  })

  it('sends every unresearched id on the All chip', async () => {
    await render()
    await click(button('Enrich · 3')!)
    expect(startRun).toHaveBeenCalledWith('list-1', {
      kind: 'account_card',
      entryIds: ['c1', 'c2', 'c3'],
    })
  })

  it('runs people over the RESEARCHED companies only', async () => {
    await render()
    await click(findPeople()!)

    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog).toBeTruthy()
    const confirm = Array.from(dialog!.querySelectorAll('button')).find(
      (b) => b.textContent?.trim().startsWith('Find people'),
    )!
    await click(confirm)
    await act(async () => {})

    expect(startRun).toHaveBeenCalledWith('list-1', {
      kind: 'people',
      entryIds: ['c4', 'c5'],
    })
  })

  it('retires a company from the people half once it HAS people', async () => {
    // c4 already has a person hanging off it, so re-running people over it
    // would buy a search whose every result comes back suppressed as
    // `this_list`. The half must shrink to c5 — count and target set.
    fetchList.mockResolvedValue({
      list: LIST,
      entries: [...ENTRIES, personEntry({ id: 'p2', parent_entry_id: 'c4' })],
      entry_counts: { ...COUNTS, total: 8 },
    })
    await render()

    expect(findPeople()!.getAttribute('title')).toContain('the profiled company in this view')
    await click(findPeople()!)
    const dialog = document.body.querySelector('[role="dialog"]')!
    const confirm = Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.textContent?.trim().startsWith('Find people'),
    )!
    await click(confirm)
    await act(async () => {})

    expect(startRun).toHaveBeenCalledWith('list-1', { kind: 'people', entryIds: ['c5'] })
  })

  it('disables the people action, with the reason, once every account has people', async () => {
    // Nothing left to run. The header control stays — a control that vanishes
    // reads as the layout breaking — and its title says why it is off.
    fetchList.mockResolvedValue({
      list: LIST,
      entries: [
        ...ENTRIES,
        personEntry({ id: 'p2', parent_entry_id: 'c4' }),
        personEntry({ id: 'p3', parent_entry_id: 'c5' }),
      ],
      entry_counts: { ...COUNTS, total: 9 },
    })
    await render()
    expect(findPeople()!.disabled).toBe(true)
    expect(findPeople()!.getAttribute('title')).toContain('already has people')
    // The profile action is untouched — three companies still owe research.
    expect(button('Enrich · 3')).toBeTruthy()
  })

  it('does not let a DISMISSED person retire its account', async () => {
    // Dismissing one person is not a decision to stop looking for that
    // company's buyers.
    fetchList.mockResolvedValue({
      list: LIST,
      entries: [
        ...ENTRIES,
        personEntry({ id: 'p2', parent_entry_id: 'c4', stage: 'dismissed' }),
      ],
      entry_counts: { ...COUNTS, total: 8 },
    })
    await render()
    expect(findPeople()!.disabled).toBe(false)
    expect(findPeople()!.getAttribute('title')).toContain('2 profiled companies')
  })

  it('takes the strip action down and disables the header one while a run is live — the index would 409 either half', async () => {
    // The strip's Enrich is gone while the run goes (the rail is what the strip
    // area says then); the header's Find decision makers stays, disabled with
    // the reason.
    fetchRuns.mockResolvedValue([run({ status: 'running' })])
    fetchRun.mockResolvedValue(run({ status: 'running' }))
    await render()
    expect(button('Enrich')).toBeUndefined()
    expect(findPeople()!.disabled).toBe(true)
    expect(findPeople()!.getAttribute('title')).toContain('a run is already going on this list')
    expect(text()).toContain('Finding companies')
  })

  it('steps aside for the selection bar, which carries the same verbs for "these"', async () => {
    await render()
    expect(button('Enrich · 3')).toBeTruthy()
    await act(async () => {
      selectionHandler()?.({
        hasSelection: true,
        count: 2,
        selectedIds: ['c1', 'c3'],
        onClear: () => {},
      })
    })
    // The chip-scoped button is gone; the selection bar's unscoped one stands.
    expect(button('Enrich · 3')).toBeUndefined()
    expect(button('Enrich')).toBeTruthy()

    await act(async () => {
      selectionHandler()?.({ hasSelection: false, count: 0, selectedIds: [], onClear: () => {} })
    })
    expect(button('Enrich · 3')).toBeTruthy()
  })

})

describe('ListDetail — the selection bar', () => {
  /**
   * The filter strip answers "all or the A's?"; the selection bar answers
   * "these seven". Both routes have to reach the same kickoff.
   */
  it('exposes Enrich and Find people for a company selection', async () => {
    await render()
    await act(async () => {
      selectionHandler()?.({
        hasSelection: true,
        count: 2,
        selectedIds: ['c1', 'c3'],
        onClear: () => {},
      })
    })

    await click(button('Enrich')!)
    expect(startRun).toHaveBeenCalledWith('list-1', {
      kind: 'account_card',
      entryIds: ['c1', 'c3'],
    })
  })

  it('states the run-size cap rather than truncating a big selection in silence', async () => {
    // `beginTargetedRun` slices at the cap either way; the bar has to say so,
    // or a user who checked 60 rows counts 60 and gets 50.
    const ids = Array.from({ length: 60 }, (_, i) => `c${i}`)
    await render()
    await act(async () => {
      selectionHandler()?.({
        hasSelection: true,
        count: ids.length,
        selectedIds: ids,
        onClear: () => {},
      })
    })

    expect(text()).toContain(`researching the first ${MAX_ENTRIES_PER_TARGETED_RUN}`)

    await click(button('Enrich')!)
    expect(startRun).toHaveBeenCalledWith('list-1', {
      kind: 'account_card',
      entryIds: ids.slice(0, MAX_ENTRIES_PER_TARGETED_RUN),
    })
  })

  it('withholds the per-company runs on a PEOPLE selection but Save is live', async () => {
    // Neither per-company stage takes person entries — a button that 400s is a
    // worse answer than one not offered. Save is a different question: phase 6
    // promotes people through `createProspectContact`, so it is enabled.
    // p1 is a person row nested under c1; it checks like any other row.
    await render()
    await act(async () => {
      selectionHandler()?.({
        hasSelection: true,
        count: 1,
        selectedIds: ['p1'],
        onClear: () => {},
      })
    })

    expect(button('Enrich')).toBeUndefined()
    // The header's Find decision makers acts on the CHIP, not the selection,
    // so it stays; the selection bar carries its own Find people for "these".
    expect(findPeople()).toBeTruthy()
    const save = saveSelection()
    expect(save!.disabled).toBe(false)
  })

})

describe('ListDetail — people nested under companies', () => {
  const withNeedsReview = () =>
    fetchList.mockResolvedValue({
      list: LIST,
      entries: [
        ...ENTRIES,
        personEntry({ id: 'p9', parent_entry_id: 'c4', identity_state: 'needs_review' }),
      ],
      entry_counts: { ...COUNTS, total: 8 },
    })

  it('queries companies only — people ride beneath them as child rows', async () => {
    // The views route attaches each company's people as inline `children`
    // and the list draws them as expandable child rows, so the page never
    // asks for person rows of its own. There is no Companies/People toggle.
    await render()
    expect(lastScope().find((f) => f.field === 'kind')?.value).toBe('company')
    expect(document.body.querySelector('[role="tablist"][aria-label="Candidate kind"]')).toBeNull()
  })

  it('the All tab counts the companies still on the list, never companies plus people', async () => {
    await render()
    // Five company rows: c6 is dismissed and has LEFT the list (it is counted
    // under Dismissed); p1 is a child, not a row.
    expect(lastCounts()).toMatchObject({ all: 5, dismissed: 1 })
  })

  it('sends the kind beside the list scope — and no stage filter on All, which the server hides the dismissed for', async () => {
    await render()
    // "All" is everything STILL ON the list: the dismissed rows left it. That
    // is the views query's own default (applyEntityDefaults) whenever no
    // filter names `stage`, so the page sends nothing — which is also what
    // lets a custom view built as "Stage is dismissed" be honoured.
    expect(lastScope().map((f) => f.field)).toEqual(['list_id', 'kind'])
  })

  it('the Needs review tab is the one flat people view', async () => {
    // People the save gate held back have no company-row home: the tab
    // lists them flat, with the company actions down, and All brings the
    // companies back.
    withNeedsReview()
    await render()
    expect(lastCounts().needs_review).toBe(1)
    await pickStage('needs_review')
    const scope = lastScope()
    expect(scope.find((f) => f.field === 'kind')?.value).toBe('person')
    expect(scope.find((f) => f.field === 'identity_state')).toMatchObject({
      operator: 'is',
      value: 'needs_review',
    })
    expect(button('Enrich')).toBeUndefined()

    await pickStage('all')
    expect(lastScope().find((f) => f.field === 'kind')?.value).toBe('company')
  })

  it('a selection that mixes a nested person into companies withholds the per-company runs', async () => {
    await render()
    await act(async () => {
      selectionHandler()?.({
        hasSelection: true,
        count: 2,
        selectedIds: ['c1', 'p1'],
        onClear: () => {},
      })
    })
    expect(button('Enrich')).toBeUndefined()
    expect(button('Add to sequence')).toBeTruthy()
    expect(saveSelection()).toBeTruthy()
  })
})
