// @vitest-environment jsdom
/**
 * The prospect LIST row — the Prospecting index, now on the views system.
 *
 * WHAT THIS SUITE IS PROTECTING. The index used to be a hand-built card grid
 * that could not be sorted, filtered or saved as a view; it is now
 * `UnifiedViewLayout` over a `prospect_list` entity, and this row is where
 * everything the card said has to survive the move. Three of its cells are the
 * reason it has a bespoke body at all, and each fails SILENTLY (a blank chip,
 * not an error) if its source shape drifts:
 *
 *   1. `entry_counts` — an object the views query ROUTE merges in a
 *      post-query enrichment block, not a column. The generic PropertyCell
 *      would render nothing for it.
 *   2. `prospecting_run` — an EMBEDDED to-many relation, so PostgREST hands it
 *      back as an ARRAY of one even though the query limits it to the newest.
 *      Reading it as an object is the classic version of this bug.
 *   3. Liveness, which has TWO sources that must both work: the module store
 *      the index publishes from its 5-second active-run poll (what catches a
 *      run Scout starts beside this screen), and the embedded run itself (what
 *      makes the row correct before the first poll settles, and on any surface
 *      that publishes nothing).
 *
 * And one honesty assertion: `needs_input` is NOT a pulsing dot. That helper's
 * `isRunLive` counts it as live because the POLLER should keep asking, but a
 * run parked on a question is not making progress, and a pulse promising it
 * would be the one place this row actively lies.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { EntityRow, getTitle, publishProspectListLive } from '@/components/views/list/entity-row'
import { DEFAULT_DISPLAY_PROPERTIES, DISPLAY_PROPERTIES } from '@/lib/views/types'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  publishProspectListLive(new Set())
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  publishProspectListLive(new Set())
})

/** Every tickable property, for the assertions about cells the default hides. */
const ALL_PROPS = DISPLAY_PROPERTIES.prospect_list.map((p) => p.field)

function list(overrides: Record<string, unknown> = {}) {
  return {
    id: 'list-1',
    name: 'Customers like us',
    purpose: 'buyers',
    status: 'active',
    created_at: '2026-09-01T09:00:00.000Z',
    updated_at: '2026-09-04T09:00:00.000Z',
    entry_counts: {
      discovered: 8,
      shortlisted: 0,
      saved: 2,
      dismissed: 1,
      total: 11,
      saved_people: 3,
    },
    ...overrides,
  }
}

/** The embedded newest run, in the ARRAY shape PostgREST actually returns. */
function withRun(item: Record<string, unknown>, run: Record<string, unknown>) {
  return { ...item, prospecting_run: [run] }
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    kind: 'discover',
    status: 'completed',
    // numeric(10,6) arrives from PostgREST as a STRING — the row must not
    // render every real cost as "$0.00".
    spent_dollars: '0.420000',
    progress: { stage: 'done', new: 12, found: 38 },
    started_at: '2026-09-04T09:00:00.000Z',
    finished_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    created_at: '2026-09-04T09:00:00.000Z',
    ...overrides,
  }
}

async function render(
  item: Record<string, unknown>,
  displayProperties: string[] = DEFAULT_DISPLAY_PROPERTIES.prospect_list,
) {
  await act(async () => {
    root.render(
      <EntityRow
        item={item}
        entityType="prospect_list"
        displayProperties={displayProperties}
        isSelected={false}
        onItemSelect={() => {}}
      />,
    )
  })
}

function text() {
  return container.textContent ?? ''
}

function nameEl(): HTMLElement {
  return container.querySelector('[data-prospect-list-name]') as HTMLElement
}

function glyph(): HTMLElement | null {
  return container.querySelector('[data-prospect-list-live]')
}

function runChip(): HTMLElement | null {
  return container.querySelector('[data-prospect-list-run]')
}

describe('prospect_list row — identity', () => {
  it('titles the row from the list name', () => {
    expect(getTitle('prospect_list', list())).toBe('Customers like us')
  })

  /** The title feeds the tab label and the detail breadcrumb, neither of which
   *  may be blank — even though `name` is NOT NULL behind it. */
  it('never returns an empty title', () => {
    expect(getTitle('prospect_list', { id: 'x' })).toBe('Untitled list')
    expect(getTitle('prospect_list', { id: 'x', name: '' })).toBe('Untitled list')
  })

  it('renders the name and keeps it from collapsing', async () => {
    await render(list())
    expect(nameEl().textContent).toBe('Customers like us')
    // A width FLOOR, not a width: the chips beside it are `shrink-0`, and
    // without this the name is what gives until it is one letter wide.
    expect(nameEl().className).toContain('min-w-[7rem]')
    expect(nameEl().className).toContain('truncate')
    // The full name on hover is the other half of truncation.
    expect(nameEl().getAttribute('title')).toBe('Customers like us')
  })
})

describe('prospect_list row — the chips the card used to carry', () => {
  it('labels the purpose in the product’s own words', async () => {
    await render(list())
    // 'buyers' is the column value; "Customers" is what a user calls them.
    expect(text()).toContain('Customers')
    expect(text()).not.toContain('buyers')
  })

  it('counts candidates from entry_counts, which is not a column', async () => {
    await render(list())
    expect(text()).toContain('11 candidates')
  })

  it('agrees with its own noun on a single candidate', async () => {
    await render(list({ entry_counts: { total: 1, saved: 0, saved_people: 0 } }))
    expect(text()).toContain('1 candidate')
    expect(text()).not.toContain('1 candidates')
  })

  it('says so when a list has nothing in it yet', async () => {
    await render(list({ entry_counts: { total: 0, saved: 0, saved_people: 0 } }))
    expect(text()).toContain('No candidates')
  })

  /**
   * SAVED counts companies AND people. The card it replaces showed people when
   * there were any and companies otherwise, so the same number meant two
   * different things on two adjacent rows — unreadable down a column. The
   * split still exists, in the title.
   */
  it('sums saved companies and saved people, and says which in the title', async () => {
    await render(list())
    const chip = container.querySelector('[data-prospect-list-saved]')
    expect(chip?.textContent).toBe('5 saved')
    expect(chip?.getAttribute('title')).toContain('2 companies')
    expect(chip?.getAttribute('title')).toContain('3 people')
  })

  it('renders no saved chip at all when nothing has been saved', async () => {
    await render(list({ entry_counts: { total: 11, saved: 0, saved_people: 0 } }))
    expect(container.querySelector('[data-prospect-list-saved]')).toBeNull()
    expect(text()).not.toContain('0 saved')
  })

  /** 'active' is every row by default (the query hides archived unless asked),
   *  so a column of "Active" chips would say nothing. */
  it('chips only the archived status', async () => {
    await render(list(), ALL_PROPS)
    expect(text()).not.toContain('Active')

    await render(list({ status: 'archived' }), ALL_PROPS)
    expect(text()).toContain('Archived')
  })
})

describe('prospect_list row — the last run', () => {
  it('reads the run out of the EMBEDDED ARRAY PostgREST returns', async () => {
    await render(withRun(list(), run()))
    expect(text()).toContain('12 new')
    expect(text()).toContain('1h ago')
  })

  it('is honest when the last run admitted nothing', async () => {
    await render(withRun(list(), run({ progress: { new: 0 } })))
    expect(text()).toContain('Nothing new')
  })

  it('renders no run chip at all for a list that has never been run', async () => {
    await render(list())
    expect(runChip()).toBeNull()
    expect(text()).not.toContain('Nothing new')
  })

  /** budget_exhausted is an OUTCOME, not a failure (§9): the run kept every
   *  partial result, so "Stopped early" sits BESIDE the count, not in place of it. */
  it('marks a capped run without hiding what it found', async () => {
    await render(withRun(list(), run({ status: 'budget_exhausted' })))
    expect(text()).toContain('Stopped early')
    expect(text()).toContain('12 new')
  })

  it('says failed plainly rather than printing a count', async () => {
    await render(withRun(list(), run({ status: 'failed' })))
    expect(text()).toContain('Failed')
    expect(text()).not.toContain('12 new')
  })
})

describe('prospect_list row — liveness', () => {
  it('pulses from the row’s own embedded run, with no store published', async () => {
    await render(withRun(list(), run({ status: 'running', finished_at: null })))
    expect(glyph()?.getAttribute('data-prospect-list-live')).toBe('true')
    expect(runChip()?.getAttribute('data-prospect-list-run')).toBe('live')
    expect(text()).toContain('Finding…')
  })

  /**
   * THE BUG THIS PINS. The views query runs on mount; the thing that knows a
   * run started 3 seconds ago is the index's 5-second active-run poll. A row
   * waiting for its own query to come round again sits dark for the whole run
   * — the §B5a report, one surface up.
   */
  it('pulses from the published store for a run its own query never saw', async () => {
    const stale = withRun(list(), run({ status: 'completed', progress: { new: 0 } }))
    await render(stale)
    expect(glyph()?.getAttribute('data-prospect-list-live')).toBe('false')

    await act(async () => {
      publishProspectListLive(new Set(['list-1']))
    })
    expect(glyph()?.getAttribute('data-prospect-list-live')).toBe('true')
    expect(text()).toContain('Finding…')
    expect(text()).not.toContain('Nothing new')
  })

  it('does not attribute another list’s live run to this row', async () => {
    await render(withRun(list(), run()))
    await act(async () => {
      publishProspectListLive(new Set(['list-2']))
    })
    expect(glyph()?.getAttribute('data-prospect-list-live')).toBe('false')
    expect(text()).toContain('12 new')
  })

  it('goes dark again when the store is cleared', async () => {
    await render(list())
    await act(async () => {
      publishProspectListLive(new Set(['list-1']))
    })
    expect(glyph()?.getAttribute('data-prospect-list-live')).toBe('true')

    await act(async () => {
      publishProspectListLive(new Set())
    })
    expect(glyph()?.getAttribute('data-prospect-list-live')).toBe('false')
  })

  /**
   * `needs_input` is live to the POLLER (keep asking) and not to the DOT (no
   * work is happening until a person acts). A pulse there would promise
   * progress that cannot arrive.
   */
  it('does not pulse for a run parked on a question', async () => {
    await render(withRun(list(), run({ status: 'needs_input', finished_at: null })))
    expect(glyph()?.getAttribute('data-prospect-list-live')).toBe('false')
    expect(text()).not.toContain('Finding…')
  })
})

describe('prospect_list row — the display-property picker means what it says', () => {
  it('renders exactly the default four cells', async () => {
    await render(withRun(list(), run()))
    expect(text()).toContain('Customers')
    expect(text()).toContain('11 candidates')
    expect(text()).toContain('5 saved')
    expect(text()).toContain('12 new')
    // Not in the default set.
    expect(container.querySelector('[data-prospect-list-spend]')).toBeNull()
  })

  it('drops every optional cell when the view asks for none of them', async () => {
    await render(withRun(list({ status: 'archived' }), run()), [])
    // The name is the fixed skeleton — a row without it is unclickable.
    expect(nameEl().textContent).toBe('Customers like us')
    expect(text()).not.toContain('Customers like us candidates')
    expect(container.querySelector('[data-prospect-list-purpose]')).toBeNull()
    expect(container.querySelector('[data-prospect-list-candidates]')).toBeNull()
    expect(container.querySelector('[data-prospect-list-saved]')).toBeNull()
    expect(runChip()).toBeNull()
    expect(text()).not.toContain('Archived')
  })

  /** The glyph is NOT a display property — it is the row's identity, and it
   *  carries the liveness a user scans the column for. */
  it('keeps the telescope even with every property switched off', async () => {
    await render(withRun(list(), run({ status: 'running' })), [])
    expect(glyph()?.getAttribute('data-prospect-list-live')).toBe('true')
  })

})
