// @vitest-environment jsdom
/**
 * The suite detail — the two Run buttons and everything that gates them.
 *
 * Three regressions this suite is here to catch:
 *
 *  1. A LIVE RUN MUST DISABLE BOTH BUTTONS. `idx_eval_run_one_live` is a
 *     partial unique index on `(suite_id, mode)`, so the second press would be
 *     adopted rather than run — a button that silently does nothing visible is
 *     a worse explanation than a disabled one.
 *  2. AN EMPTY SUITE MUST DISABLE THEM TOO. A run over zero cases is a queued
 *     row that grades nothing and still costs a budget check.
 *  3. A BUDGET 409 IS A SENTENCE, NOT A CRASH. It is a fixable state the user
 *     can act on, and spec §8.3 says a budget stop is never silent.
 *
 * The page is TABBED now (Overview / Cases / Runs), so anything about a case
 * or a run is asserted after switching to its tab — `switchTab` below. The tab
 * itself rides on the LOCATION, and the last group here is what says so: the
 * strip reports every switch to `onTabChange`, and a `tab` prop selects the
 * tab on mount, which is how Back/Forward restore one.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAT_MODELS } from '@/lib/ai/models'
;(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

/**
 * jsdom shims the Properties popovers need.
 *
 * The picker rows are Radix Popovers over cmdk lists, and both reach for
 * browser APIs jsdom does not implement: cmdk measures its list with a
 * ResizeObserver, and Radix's dismissable layer gates on
 * `hasPointerCapture`/`scrollIntoView`. Without these the popover throws on
 * open, which would make "the picker patches its field" untestable — so they
 * are stubbed here rather than the assertions being weakened to not opening
 * one.
 */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.scrollIntoView ??= () => {}

const fetchSuite = vi.fn()
const fetchRuns = vi.fn()
const fetchRun = vi.fn()
const startRun = vi.fn()
const cancelRun = vi.fn()
const deleteSuite = vi.fn()
const patchSuite = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    fetchSuite: (id: string) => fetchSuite(id),
    fetchRuns: (id: string, limit?: number) => fetchRuns(id, limit),
    fetchRun: (id: string) => fetchRun(id),
    startRun: (body: unknown) => startRun(body),
    cancelRun: (id: string) => cancelRun(id),
    deleteSuite: (id: string) => deleteSuite(id),
    patchSuite: (id: string, body: unknown) => patchSuite(id, body),
  }
})

/**
 * The Cases and Runs tabs are `UnifiedViewLayout` mounts now — the SAME shared
 * views component a project's Actions tab embeds, scoped to this suite.
 *
 * It is mocked rather than rendered for real because what this file is
 * responsible for is the WIRING, not the views system: which entity type each
 * tab mounts, the `suite_id` scope filter that makes it this suite's list, and
 * the `eval_suite` viewScope that keeps a view saved here out of the next
 * suite's picker. Rendering the real component would instead assert the views
 * system's own behaviour (which its own suites cover) through a page that has
 * no say in it, and it would need a fetch stub for /api/account/views on top.
 *
 * The stub records every mount's props and prints its entity type, so the
 * existing tab assertions ("Overview's content is not rendered underneath")
 * still have something to read.
 */
const viewMounts: {
  entityType: string
  scopeFilters?: unknown
  viewScope?: unknown
  onItemSelect?: (id: string, title: string) => void
}[] = []
vi.mock('@/components/views/unified-view-layout', () => ({
  UnifiedViewLayout: (props: {
    entityType: string
    scopeFilters?: unknown
    viewScope?: unknown
    onItemSelect?: (id: string, title: string) => void
  }) => {
    viewMounts.push(props)
    return <div data-testid={`view-layout-${props.entityType}`} />
  },
}))

import { EvalsRequestError } from '../api'
import { EvalSuiteDetail } from '../suite-detail'
import { caseRow, runRow, suiteRow } from './fixtures'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  fetchSuite
    .mockReset()
    .mockResolvedValue({ suite: suiteRow(), cases: [], runs: [] })
  viewMounts.length = 0
  fetchRuns.mockReset().mockResolvedValue([])
  fetchRun.mockReset()
  startRun.mockReset()
  cancelRun.mockReset()
  deleteSuite.mockReset()
  patchSuite.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(
  props: Partial<React.ComponentProps<typeof EvalSuiteDetail>> = {},
) {
  await act(async () => {
    root.render(
      <EvalSuiteDetail suiteId="suite-1" onBack={() => {}} {...props} />,
    )
  })
  await act(async () => {})
}

/**
 * Type into a controlled textarea.
 *
 * React tracks a node's last value on the DOM node itself, so assigning
 * `el.value` and dispatching `input` is deduped away as "no change" and the
 * onChange never fires. Going through the native setter is what makes React
 * see it — the standard workaround, not a quirk of this suite.
 */
function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Click a tab pill by its label. The count badge is part of the button's text,
 *  so match on the leading label rather than the whole string. */
async function switchTab(label: 'Overview' | 'Cases' | 'Runs') {
  const pill = Array.from(document.body.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').trim().startsWith(label),
  ) as HTMLButtonElement
  expect(pill).toBeTruthy()
  await act(async () => {
    pill.click()
  })
  await act(async () => {})
}

/** Dialogs and menus portal to document.body, so read the whole document. */
const text = () => document.body.textContent ?? ''

/**
 * Just the Overview COLUMN, without the Properties sidebar beside it.
 *
 * The two are siblings in the body row, and they now say overlapping things on
 * purpose — "Capability suite" and the case count belong to Properties and
 * must not also appear under the title. A whole-document `text()` cannot tell
 * those two places apart, so the column is found by the `max-w-[736px]` that
 * defines it.
 */
const overviewText = () =>
  container.querySelector('.max-w-\\[736px\\]')?.textContent ?? ''

function buttonByText(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === label,
  ) as HTMLButtonElement | undefined
}

/**
 * Press a Run button and confirm the quote.
 *
 * Neither button starts a run on its own any more: both open the
 * confirm-and-quote dialog (spec §10 — the price is said before it is spent,
 * the way prospecting gates its own metered run), and the dialog's primary
 * action is what calls `startRun`.
 */
async function confirmRun(mode: 'batch' | 'live') {
  const label = mode === 'batch' ? 'Run batch' : 'Run live'
  await act(async () => {
    buttonByText(label)!.click()
  })
  await act(async () => {})
  // Two buttons now read "Run batch" — the header's and the dialog's. The
  // dialog's is the LAST one in the document, since it portals to the end of
  // body.
  const confirms = Array.from(document.body.querySelectorAll('button')).filter(
    (b) => (b.textContent ?? '').trim() === label,
  )
  await act(async () => {
    ;(confirms[confirms.length - 1] as HTMLButtonElement).click()
  })
  await act(async () => {})
}

describe('EvalSuiteDetail', () => {
  it('disables both Run buttons on a suite with no cases', async () => {
    await render()
    expect(buttonByText('Run batch')!.disabled).toBe(true)
    expect(buttonByText('Run live')!.disabled).toBe(true)
  })

  it('starts a batch run and adopts the returned run immediately', async () => {
    fetchSuite.mockResolvedValue({
      suite: suiteRow(),
      cases: [caseRow()],
      runs: [],
    })
    startRun.mockResolvedValue({
      run: runRow({ id: 'run-9', status: 'queued' }),
      adopted: false,
      estimated_cost_usd: 0.12,
    })
    fetchRun.mockResolvedValue({
      run: runRow({ id: 'run-9', status: 'queued' }),
      trials: [],
    })
    await render()

    await confirmRun('batch')

    expect(startRun).toHaveBeenCalledWith({
      suite_id: 'suite-1',
      mode: 'batch',
    })
    // Adopted without waiting for a poll: the run is live, so both Run buttons
    // are refused — those live in the header and are visible from every tab.
    expect(buttonByText('Run batch')!.disabled).toBe(true)
    expect(buttonByText('Run live')!.disabled).toBe(true)
    // The rail's Cancel is on the RUNS tab, with the run it is about.
    await switchTab('Runs')
    expect(buttonByText('Cancel')).toBeTruthy()
  })

  it('sends the selected speed on a live run, and only on a live run', async () => {
    fetchSuite.mockResolvedValue({
      suite: suiteRow(),
      cases: [caseRow()],
      runs: [],
    })
    startRun.mockResolvedValue({
      run: runRow({ id: 'run-9', status: 'completed', is_live: false }),
      adopted: false,
      estimated_cost_usd: 0.12,
    })
    await render()

    await confirmRun('live')

    // 'instant' is the P0 default and the only speed the server driver runs.
    expect(startRun).toHaveBeenCalledWith({
      suite_id: 'suite-1',
      mode: 'live',
      speed: 'instant',
    })
  })

  it('turns a budget 409 into a sentence rather than a crash or a silent stop', async () => {
    fetchSuite.mockResolvedValue({
      suite: suiteRow(),
      cases: [caseRow()],
      runs: [],
    })
    startRun.mockRejectedValue(
      new EvalsRequestError({
        message: 'This workspace has used its monthly eval budget',
        code: 'budget_exceeded',
        details: null,
        status: 409,
      }),
    )
    await render()

    await confirmRun('batch')

    expect(text()).toContain('monthly eval budget')
    // And the buttons come back, because nothing is running.
    expect(buttonByText('Run batch')!.disabled).toBe(false)
  })

  it('says what the suite grades in PROPERTIES, never as an Overview subtitle', async () => {
    // The subtitle read "Capability suite · grades the Sales Copilot agent" —
    // word for word the Suite kind and Target rows the sidebar already
    // carries. Two renderings of the same two properties, and only one of them
    // was editable.
    fetchSuite.mockResolvedValue({
      suite: suiteRow(),
      cases: [],
      runs: [],
      target: { id: 'recipe-1', name: 'Sales Copilot', category: 'agent' },
    })
    await render()
    // Gone from the page entirely — the sentence only ever existed up there.
    expect(text()).not.toContain('grades the Sales Copilot agent')
    expect(text()).not.toContain('grades an agent')
    // …and nothing of it is left in the Overview column, which is now the
    // name and the description and nothing else.
    expect(overviewText()).not.toContain('Capability suite')
    // What it says instead: the two Properties rows that always said it.
    expect(text()).toContain('Capability suite')
    expect(text()).toContain('Sales Copilot · Agent')
  })

  it('counts the cases and the runs as PROPERTIES rows, pluralised', async () => {
    // "1 case · 2 runs · last run 11h ago" was three properties wearing
    // prose under the title. They are rows in the sidebar now, beside the
    // suite kind and the target they were sitting next to anyway.
    fetchSuite.mockResolvedValue({
      suite: suiteRow(),
      cases: [caseRow()],
      runs: [runRow({ id: 'run-1' }), runRow({ id: 'run-2' })],
    })
    await render()
    expect(text()).toContain('1 case')
    expect(text()).toContain('2 runs')
    expect(text()).toContain('Last run ')
    // None of it in the Overview column any more.
    expect(overviewText()).not.toContain('1 case')
    expect(overviewText()).not.toContain('2 runs')
    // No tile labels left behind either.
    expect(text()).not.toContain('Per batch run')
    expect(text()).not.toContain('Per live run')
    // The estimate is still shown in Properties, as a bare icon + value row —
    // so what proves it is the NUMBER, not a label.
    expect(text()).toContain('batch ·')
    expect(text()).toContain('live')
  })

  it('drops the last-run row entirely on a suite that has never run', async () => {
    // "Last run —" is a row about an event that has not happened, and the
    // row above it already says there are no runs.
    fetchSuite.mockResolvedValue({
      suite: suiteRow(),
      cases: [caseRow()],
      runs: [],
    })
    await render()
    expect(text()).toContain('No runs yet')
    expect(text()).not.toContain('Last run')
  })

  it('renders no outcome chip in the header — a run failing is not the suite failing', async () => {
    // The last run's verdict belongs to THAT run: its row in the Runs tab and
    // the run page. A suite-level pass/fail pill said "this suite failed",
    // which is not a thing a suite can be.
    fetchSuite.mockResolvedValue({
      suite: suiteRow(),
      cases: [caseRow()],
      runs: [runRow({ id: 'run-1', outcome: 'failed' })],
    })
    await render()
    expect(text()).not.toContain('Failed')
    expect(text()).not.toContain('Passed')
    expect(text()).not.toContain('Outcome')
  })

  it('mounts the Cases tab as a views layout scoped to this suite', async () => {
    // THE POINT OF THE CHANGE: the Cases tab is the shared views system —
    // saved views, filters, grouping and a board — scoped to one suite, the
    // way a project's Actions tab embeds a scoped actions view. Not a
    // hand-rolled list that can offer none of those.
    await render({ tab: 'cases' })

    const mount = viewMounts.find((m) => m.entityType === 'eval_case')
    expect(mount).toBeTruthy()
    // The scope filter is what makes it THIS suite's cases: `suite_id` is a
    // real column, so no synthetic field and no subquery.
    expect(mount!.scopeFilters).toEqual([
      {
        id: '__scope_eval_suite',
        field: 'suite_id',
        operator: 'is',
        value: 'suite-1',
      },
    ])
    // And the viewScope is what keeps a view saved here out of the NEXT
    // suite's picker (migration 257 added 'eval_suite' to the scope CHECK).
    expect(mount!.viewScope).toEqual({ type: 'eval_suite', id: 'suite-1' })
  })

  it('mounts the Runs tab as a views layout scoped to the same suite', async () => {
    await render({ tab: 'runs' })

    const mount = viewMounts.find((m) => m.entityType === 'eval_run')
    expect(mount).toBeTruthy()
    expect(mount!.scopeFilters).toEqual([
      {
        id: '__scope_eval_suite',
        field: 'suite_id',
        operator: 'is',
        value: 'suite-1',
      },
    ])
    expect(mount!.viewScope).toEqual({ type: 'eval_suite', id: 'suite-1' })
    // Runs are NOT mounted as cases and vice versa — the two tabs are two
    // different entity types over two different tables.
    expect(viewMounts.some((m) => m.entityType === 'eval_case')).toBe(false)
  })

  it('opening a row from either tab is a navigation, not a sheet', async () => {
    // The views layout reports a row click through `onItemSelect`, and the
    // page turns it into an `onOpenCase` / `onOpenRun` navigation — so
    // Back/Forward and Recently viewed reach a case and a run exactly as they
    // reach a suite.
    const onOpenCase = vi.fn()
    const onOpenRun = vi.fn()

    await render({ tab: 'cases', onOpenCase })
    viewMounts
      .find((m) => m.entityType === 'eval_case')!
      .onItemSelect?.('case-9', 'Prospect stalls')
    expect(onOpenCase).toHaveBeenCalledWith(
      'case-9',
      'Prospect stalls',
      'Sales Discovery',
    )

    await act(async () => root.unmount())
    root = createRoot(container)
    viewMounts.length = 0
    await render({ tab: 'runs', onOpenRun })
    viewMounts
      .find((m) => m.entityType === 'eval_run')!
      .onItemSelect?.('run-9', 'Batch run · Sep 8, 3:38 PM')
    expect(onOpenRun).toHaveBeenCalledWith(
      'run-9',
      'Batch run · Sep 8, 3:38 PM',
      'Sales Discovery',
    )
  })

  it('opens the delete confirm from the preferences action and names the suite', async () => {
    // The confirm text is the whole guardrail: deleting a suite takes its
    // cases, their mock captures and the entire run history with it, and the
    // dialog is the only place that is said.
    fetchSuite.mockResolvedValue({
      suite: suiteRow({ name: 'Sales Discovery' }),
      cases: [caseRow()],
      runs: [],
    })
    await render()

    const deleteItem = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Delete suite'),
    )!
    expect(deleteItem).toBeTruthy()
    await act(async () => deleteItem.click())

    expect(text()).toContain('Delete "Sales Discovery"?')
    expect(text()).toContain('cannot be undone')
    // Nothing is deleted until Confirm.
    expect(deleteSuite).not.toHaveBeenCalled()
  })
})

/**
 * The tab strip. It is the shape of the page now, so three things are locked:
 * which tabs exist, that a switch is reported to the caller (which turns it
 * into a history step), and that the caller's `tab` selects one on mount —
 * without which Back/Forward and a deep link would both land on Overview.
 */
describe('EvalSuiteDetail — tabs', () => {
  function pills(): HTMLButtonElement[] {
    return Array.from(document.body.querySelectorAll('button')).filter((b) =>
      ['Overview', 'Cases', 'Runs'].some((t) =>
        (b.textContent ?? '').trim().startsWith(t),
      ),
    ) as HTMLButtonElement[]
  }

  it('renders exactly three tabs, with counts', async () => {
    fetchSuite.mockResolvedValue({
      suite: suiteRow(),
      cases: [caseRow({ id: 'c1' }), caseRow({ id: 'c2' })],
      runs: [runRow({ id: 'run-1' })],
    })
    await render()
    const labels = pills().map((b) => (b.textContent ?? '').trim())
    expect(labels).toEqual(['Overview', 'Cases2', 'Runs1'])
  })

  it('reports every switch to onTabChange so the caller can push a history step', async () => {
    const onTabChange = vi.fn()
    await render({ onTabChange })

    await switchTab('Cases')
    expect(onTabChange).toHaveBeenCalledWith('cases')

    await switchTab('Runs')
    expect(onTabChange).toHaveBeenLastCalledWith('runs')

    // Clicking the tab already open is a no-op — a phantom history step costs
    // an extra Back press to get past.
    onTabChange.mockClear()
    await switchTab('Runs')
    expect(onTabChange).not.toHaveBeenCalled()
  })

  it('opens on the tab the location names', async () => {
    fetchSuite.mockResolvedValue({
      suite: suiteRow(),
      cases: [caseRow({ name: 'Prospect stalls' })],
      runs: [],
    })
    await render({ tab: 'cases' })
    // No click: the location alone put the page on the Cases layout.
    expect(
      container.querySelector('[data-testid="view-layout-eval_case"]'),
    ).toBeTruthy()
    // And Overview's own content is not rendered underneath it.
    expect(text()).not.toContain('Recent runs')
  })

  it('falls back to Overview on a tab name it does not know', async () => {
    // A tab persisted by an older build must not render a blank body with no
    // pill selected.
    await render({ tab: 'nonsense' as never })
    // Anchored on the description editor, which only Overview renders — the
    // case and run counts moved to Properties, and Properties is a sibling of
    // all three tabs.
    expect(
      container.querySelector('textarea[aria-label="Suite description"]'),
    ).toBeTruthy()
  })

  it('renders no recent-runs section on Overview — the Runs tab is the list', async () => {
    fetchSuite.mockResolvedValue({
      suite: suiteRow(),
      cases: [caseRow()],
      runs: [runRow({ id: 'run-1' })],
    })
    await render()
    // The counts live in Properties now; what Overview must not grow back is
    // a list of runs.
    expect(text()).toContain('1 case')
    expect(text()).toContain('1 run')
    expect(text()).not.toContain('Recent runs')
  })
})

describe('EvalSuiteDetail — description', () => {
  it('debounces to exactly ONE patchSuite call carrying { description }', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    patchSuite.mockResolvedValue(suiteRow({ description: 'Catches stalls' }))
    await render()

    const box = container.querySelector(
      'textarea[aria-label="Suite description"]',
    ) as HTMLTextAreaElement
    expect(box).toBeTruthy()

    for (const value of ['C', 'Ca', 'Catches stalls']) {
      await act(async () => {
        typeInto(box, value)
      })
    }
    // Mid-flight: nothing has been written yet.
    expect(patchSuite).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(patchSuite).toHaveBeenCalledTimes(1)
    expect(patchSuite).toHaveBeenCalledWith('suite-1', {
      description: 'Catches stalls',
    })
    vi.useRealTimers()
  })

  it('writes null, not an empty string, when the description is cleared', async () => {
    // The column is nullable and "" is not a description: a suite whose summary
    // was deleted should read as having none, not as having a blank one.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchSuite.mockResolvedValue({
      suite: suiteRow({ description: 'Old text' }),
      cases: [],
      runs: [],
    })
    patchSuite.mockResolvedValue(suiteRow({ description: null }))
    await render()

    const box = container.querySelector(
      'textarea[aria-label="Suite description"]',
    ) as HTMLTextAreaElement
    expect(box.value).toBe('Old text')

    await act(async () => {
      typeInto(box, '')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(patchSuite).toHaveBeenCalledWith('suite-1', { description: null })
    vi.useRealTimers()
  })

  it('no longer renders the description as read-only prose', async () => {
    fetchSuite.mockResolvedValue({
      suite: suiteRow({ description: 'Catches stalls' }),
      cases: [],
      runs: [],
    })
    await render()
    const box = container.querySelector(
      'textarea[aria-label="Suite description"]',
    ) as HTMLTextAreaElement
    expect(box.value).toBe('Catches stalls')
    // ONE rendering of it, and it is the editable one — the read-only <p> that
    // used to sit under the subtitle is gone. Asserted structurally rather
    // than on the page text, because jsdom folds a textarea's own value into
    // textContent and the string would appear either way.
    const prose = Array.from(container.querySelectorAll('p')).filter((el) =>
      (el.textContent ?? '').includes('Catches stalls'),
    )
    expect(prose).toHaveLength(0)
  })
})

/**
 * The Properties sidebar is the CAPTURE PANEL's sidebar, row for row.
 *
 * That panel's rows are one column — a `h-4 w-4` icon then the value, `h-8`,
 * `px-3`, `text-sm` — with no field-name column and no right-aligned `text-xs`
 * value. This suite's sidebar had grown its own two-column dialect, which read
 * as a different kind of control for the same job and left its left edges out
 * of line with every other panel in the app. These assertions are what stops it
 * drifting back: the labels must be GONE, the values must still be there, and
 * the rows must carry the panel's own padding.
 */
describe('EvalSuiteDetail — Properties rows match the capture panel', () => {
  /** Every row inside the Properties group — buttons and read-only divs. */
  function propertyRows(): HTMLElement[] {
    const group = Array.from(container.querySelectorAll('div')).find((el) =>
      Array.from(el.children).some(
        (c) => (c.textContent ?? '').trim() === 'Properties',
      ),
    )
    expect(group).toBeTruthy()
    return Array.from(
      group!.querySelectorAll<HTMLElement>('button, div.flex.h-8'),
    ).filter((el) => el.className.includes('h-8'))
  }

  it('writes no field-name labels, only the values', async () => {
    fetchSuite.mockResolvedValue({
      suite: suiteRow(),
      cases: [],
      runs: [],
      target: { id: 'recipe-1', name: 'Sales Copilot', category: 'agent' },
    })
    await render()

    // The four labels the two-column dialect used to print. A value that
    // reads "Sales Copilot · Agent" or "Default · Sonnet 4.5" names its own
    // field; a column repeating "Target" or "Judge model" beside it does not.
    expect(text()).not.toContain('Judge model')
    expect(text()).not.toContain('Est. per run')
    expect(text()).not.toContain('Created')
    // "Target" only as a placeholder ("Set target"), never as a label beside a
    // set value.
    expect(text()).not.toMatch(/(?<!Se)(?<!Set )Target(?! )/)

    // …and every value survived the labels going away.
    expect(text()).toContain('Sales Copilot · Agent')
    expect(text()).toContain('Default · Sonnet 4.5')
    expect(text()).toContain('Capability suite')
    expect(text()).toContain('Nightly watch')
    expect(text()).toContain('batch ·')
  })

  it("gives every row the capture panel's px-3 padding", async () => {
    await render()
    const rows = propertyRows()
    // Six: target, suite kind, judge, watch, estimate, created.
    // Nine on a suite that has run: target, suite kind, judge, watch, cases,
    // runs, last run, estimate, created.
    expect(rows.length).toBeGreaterThanOrEqual(8)
    for (const row of rows) {
      expect(row.className).toContain('px-3')
      expect(row.className).not.toContain('px-2')
    }
  })

  it('renders the read-only rows as icon + one muted value', async () => {
    fetchSuite.mockResolvedValue({
      suite: suiteRow(),
      cases: [caseRow()],
      runs: [runRow({ id: 'run-1' })],
    })
    await render()
    const readOnly = propertyRows().filter((el) => el.tagName === 'DIV')
    // The case count, the run count, the last run, the estimate and the
    // created date — informational, so they are plain divs and muted
    // throughout, which is how the eye tells them from the four rows that open
    // something.
    expect(readOnly).toHaveLength(5)
    for (const row of readOnly) {
      expect(row.className).toContain('text-muted-foreground')
      expect(row.querySelector('svg')).toBeTruthy()
      expect(row.querySelectorAll('span')).toHaveLength(1)
      // The old dialect shrank the value to text-xs against a text-sm label.
      expect(row.className).not.toContain('text-xs')
    }
  })

  it('opens the judge picker on the house Command shell, like suite kind', async () => {
    await render()

    const judge = Array.from(document.body.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').includes('Default · Sonnet 4.5'),
    ) as HTMLButtonElement
    await act(async () => {
      judge.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
      )
      judge.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, button: 0 }),
      )
      judge.click()
    })
    await act(async () => {})

    // cmdk items, not the hand-rolled <button> list it used to render — that
    // list looked and keyboard-navigated differently from the suite-kind
    // dropdown sitting one row above it.
    const items = document.body.querySelectorAll('[cmdk-item]')
    expect(items.length).toBe(CHAT_MODELS.length + 1) // the Default sentinel + every catalog model
    expect(
      Array.from(items).some((el) =>
        (el.textContent ?? '').includes('Sonnet 4.5'),
      ),
    ).toBe(true)
  })
})

/**
 * Every Properties control PATCHes ITS OWN FIELD and nothing else. A control
 * that sent a second field along would silently overwrite a value the user did
 * not touch, which is the failure this group exists to catch.
 */
describe('EvalSuiteDetail — editable properties', () => {
  /**
   * Open a popover trigger by the TEXT its row shows.
   *
   * The rows carry no field-name column any more — they are icon + value, like
   * the capture panel's — so what identifies a row here is its VALUE
   * ("Default · Sonnet 4.5", "Set target"), which is also what a reader looking
   * at the sidebar sees.
   */
  async function openRow(label: string) {
    const row = Array.from(document.body.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes(label),
    ) as HTMLButtonElement
    expect(row).toBeTruthy()
    await act(async () => {
      row.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
      )
      row.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, button: 0 }),
      )
      row.click()
    })
    await act(async () => {})
  }

  /**
   * Click an item inside an open popover, by its text.
   *
   * `includes`, not `startsWith`: the brand glyphs render their provider name
   * as text, so a model row's textContent reads "ClaudeSonnet 4.5". The LAST
   * match wins because the popover portals to the end of body, after the
   * trigger row that shows the same value.
   */
  async function pick(text: string) {
    const matches = Array.from(
      document.body.querySelectorAll('[cmdk-item], button'),
    ).filter((el) => (el.textContent ?? '').includes(text))
    const item = matches[matches.length - 1] as HTMLElement
    expect(item).toBeTruthy()
    await act(async () => {
      item.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
      )
      item.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, button: 0 }),
      )
      item.click()
    })
    await act(async () => {})
  }

  it('patches suite_kind and nothing else', async () => {
    patchSuite.mockResolvedValue(suiteRow({ suite_kind: 'regression' }))
    await render()
    // The row and the popover name the FIELD, because the shared
    // `EnumPanelField` renders the value with no field name of its own —
    // "Capability" alone is the one row here a reader cannot identify.
    await openRow('Capability suite')
    await pick('Regression suite')
    expect(patchSuite).toHaveBeenCalledWith('suite-1', {
      suite_kind: 'regression',
    })
  })

  it('patches watch on the Nightly watch toggle', async () => {
    patchSuite.mockResolvedValue(suiteRow({ watch: true }))
    await render()
    const toggle = Array.from(document.body.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').includes('Nightly watch'),
    ) as HTMLButtonElement
    await act(async () => toggle.click())
    await act(async () => {})
    expect(patchSuite).toHaveBeenCalledWith('suite-1', { watch: true })
  })

  it('patches a judge model id, and NULL for the Default sentinel', async () => {
    patchSuite.mockResolvedValue(suiteRow({ judge_model: 'deepseek-v4-pro' }))
    await render()
    // The row IS its value now: null judge renders "Default · Sonnet 4.5".
    await openRow('Default · Sonnet 4.5')
    await pick('DeepSeek V4 Pro')
    expect(patchSuite).toHaveBeenCalledWith('suite-1', {
      judge_model: 'deepseek-v4-pro',
    })

    // The sentinel writes NULL, never the current default's id — writing the id
    // would freeze this suite on today's judge forever.
    // The row is its value, so after the first pick landed it now reads
    // "DeepSeek V4 Pro" — which is exactly the point of the row shape.
    patchSuite.mockClear().mockResolvedValue(suiteRow({ judge_model: null }))
    await openRow('DeepSeek V4 Pro')
    await pick('Default')
    expect(patchSuite).toHaveBeenCalledWith('suite-1', { judge_model: null })
  })

  it('patches target_recipe_id from the recipe picker, and null for "No target"', async () => {
    const listFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        agents: [
          { id: '11111111-1111-4111-8111-111111111111', name: 'Sales Copilot' },
        ],
      }),
    })
    vi.stubGlobal('fetch', listFetch)
    fetchSuite.mockResolvedValue({
      suite: suiteRow({ target_recipe_id: null }),
      cases: [],
      runs: [],
      target: null,
    })
    patchSuite.mockResolvedValue(
      suiteRow({ target_recipe_id: '11111111-1111-4111-8111-111111111111' }),
    )
    await render()

    // No target set, so the row reads as its placeholder.
    await openRow('Set target')
    // The list is fetched LAZILY, on first open — not on mount.
    expect(listFetch).toHaveBeenCalledWith('/api/account/agents')
    await pick('Sales Copilot')
    expect(patchSuite).toHaveBeenCalledWith('suite-1', {
      target_recipe_id: '11111111-1111-4111-8111-111111111111',
    })

    patchSuite
      .mockClear()
      .mockResolvedValue(suiteRow({ target_recipe_id: null }))
    await openRow('Set target')
    await pick('No target')
    expect(patchSuite).toHaveBeenCalledWith('suite-1', {
      target_recipe_id: null,
    })
    vi.unstubAllGlobals()
  })
})

// ── A server row landing on top of a mid-edit field ───────────────────────

/**
 * The pending-edit guard has to outlive the request it protects against.
 *
 * Both fields are debounced and fully controlled off `detail.suite`, so ANY
 * server row that arrives between a keystroke and the PATCH carrying it — a
 * poll tick's `load()`, or the full row a property PATCH answers with — would
 * repaint the field with the server's older text under the user's cursor. The
 * write still lands, so the database is right and only the screen is wrong,
 * which is exactly the kind of drift nobody reports.
 */
describe('EvalSuiteDetail — mid-edit clobber', () => {
  it('keeps the typed name while its own rename PATCH is still in flight', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const live = runRow({ id: 'run-live', status: 'running' })
    fetchRuns.mockResolvedValue([live])
    fetchRun.mockResolvedValue({ run: live, trials: [] })
    // The poll refetches the suite, and the server still holds the old name
    // until the rename PATCH commits.
    fetchSuite.mockResolvedValue({
      suite: suiteRow({ name: 'Smoke 3' }),
      cases: [],
      runs: [live],
    })

    // A rename that never settles: the poll tick lands squarely inside it.
    let settle: (v: unknown) => void = () => {}
    patchSuite.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve
        }),
    )

    await render()
    const title = container.querySelector(
      'input[aria-label="Suite name"], textarea[aria-label="Suite name"]',
    ) as HTMLInputElement | HTMLTextAreaElement
    expect(title).toBeTruthy()

    const setter = Object.getOwnPropertyDescriptor(
      title instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )!.set!
    await act(async () => {
      setter.call(title, 'Smoke 4')
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // The debounce fires the PATCH, which does not resolve; then a poll tick
    // refetches the suite and gets the server's pre-PATCH name back.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(patchSuite).toHaveBeenCalledWith('suite-1', { name: 'Smoke 4' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3200)
    })

    const after = container.querySelector(
      'input[aria-label="Suite name"], textarea[aria-label="Suite name"]',
    ) as HTMLInputElement
    expect(after.value).toBe('Smoke 4')

    await act(async () => {
      settle(suiteRow({ name: 'Smoke 4' }))
    })
    vi.useRealTimers()
  })

  it('keeps a mid-typed description when a property PATCH answers with the old row', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchSuite.mockResolvedValue({
      suite: suiteRow({ description: 'Old text' }),
      cases: [],
      runs: [],
    })
    await render()

    const box = container.querySelector(
      'textarea[aria-label="Suite description"]',
    ) as HTMLTextAreaElement
    await act(async () => {
      typeInto(box, 'Catches stalls on price')
    })

    // Inside the 500ms window, a picker fires its own un-debounced PATCH. The
    // row it answers with still carries the OLD description.
    patchSuite.mockResolvedValue(
      suiteRow({ description: 'Old text', watch: true }),
    )
    const toggle = Array.from(document.body.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').includes('Nightly watch'),
    ) as HTMLButtonElement
    await act(async () => {
      toggle.click()
    })
    await act(async () => {})

    const after = container.querySelector(
      'textarea[aria-label="Suite description"]',
    ) as HTMLTextAreaElement
    expect(after.value).toBe('Catches stalls on price')
    vi.useRealTimers()
  })
})
