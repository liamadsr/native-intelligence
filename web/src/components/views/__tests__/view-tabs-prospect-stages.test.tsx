// @vitest-environment jsdom
/**
 * The prospect list's STAGE TABS, drawn by ViewTabs in the views' own tab row
 * (Liam, 2026-09-06: "combine the top-level filters — All, Saved, Dismissed —
 * with the filtered views; those could just be the default views").
 *
 * They are baseline navigation exactly like "All issues / Assigned to me" on
 * the Actions list: not saved views, so nothing can delete or rename them, and
 * mutually exclusive with a custom view — while one is open no tab reads as
 * selected. Their counts ARE the affordance: a bare "Dismissed" makes the user
 * click to find out whether it is worth clicking. And "Needs review" is the one
 * tab that hides itself at zero, because it is about an exception.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { ViewTabs } from '../view-tabs'
import {
  PROSPECT_STAGE_TABS,
  PROSPECT_STAGE_TAB_LABELS,
  isConditionalProspectStageTab,
  defaultProspectStageTab,
  prospectStageTabFilters,
  seedFiltersForProspectStageTab,
  type ProspectStageTab,
  type ProspectStageCounts,
} from '@/lib/views/prospect-stage-tabs'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const COUNTS: ProspectStageCounts = { all: 42, saved: 4, needs_review: 3, dismissed: 12 }

const noop = () => {}

async function renderTabs(props: {
  stage?: ProspectStageTab | null
  counts?: ProspectStageCounts | null
  onPick?: (tab: ProspectStageTab) => void
  activeViewId?: string | null
  entityType?: 'prospect_list_entry' | 'sequence'
  withHandler?: boolean
}) {
  const withHandler = props.withHandler ?? true
  await act(async () => {
    root.render(
      <ViewTabs
        views={[]}
        activeViewId={props.activeViewId ?? null}
        onViewChange={noop}
        onDuplicateView={noop}
        onDeleteView={noop}
        onEditView={noop}
        entityType={props.entityType ?? 'prospect_list_entry'}
        /* The toolbar always passes the edit mode; an omitted one reads as
           "editing", which is what hides every highlight. */
        editMode={null}
        prospectStage={props.stage === undefined ? 'all' : props.stage}
        prospectStageCounts={props.counts === undefined ? COUNTS : props.counts}
        onProspectStageChange={withHandler ? (props.onPick ?? noop) : undefined}
      />,
    )
  })
}

function tabs(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button[role="tab"]'))
}

function tab(label: string): HTMLButtonElement | undefined {
  return tabs().find((b) => (b.textContent ?? '').startsWith(label))
}

describe('the stage tabs in the views tab row', () => {
  it('renders every tab with its count, in place of the generic "All candidates" tab', async () => {
    await renderTabs({})
    expect(tabs()).toHaveLength(PROSPECT_STAGE_TABS.length)
    const text = container.textContent ?? ''
    for (const label of Object.values(PROSPECT_STAGE_TAB_LABELS)) {
      expect(text, label).toContain(label)
    }
    for (const count of Object.values(COUNTS)) {
      expect(text).toContain(String(count))
    }
    expect(text).not.toContain('All candidates')
    expect(text).not.toContain('A-tier')
  })

  it('keeps the generic tab for every other embed, and for a prospect list that passes no handler', async () => {
    await renderTabs({ entityType: 'sequence', withHandler: false })
    expect(tabs()).toHaveLength(0)
    expect(container.textContent).toContain('All sequences')

    await renderTabs({ withHandler: false })
    expect(tabs()).toHaveLength(0)
    expect(container.textContent).toContain('All candidates')
  })

  it('says what each tab means on hover — All is everything still on the list, Saved is the list itself', async () => {
    await renderTabs({})
    expect(tab('All')!.getAttribute('title')).toBe('Everything still on this list')
    expect(tab('Saved')!.getAttribute('title')).toContain('Publish')
    expect(tab('Dismissed')!.getAttribute('title')).toContain('will not be found again')
  })

  it('marks exactly the active tab as selected', async () => {
    await renderTabs({ stage: 'dismissed' })
    const selected = tabs().filter((c) => c.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0].textContent).toContain('Dismissed')
    expect(selected[0].getAttribute('data-prospect-stage')).toBe('dismissed')
  })

  it('selects NO tab while a custom view is open — a tab and a view are mutually exclusive', async () => {
    await renderTabs({ stage: null, activeViewId: 'view-1' })
    expect(tabs().filter((c) => c.getAttribute('aria-selected') === 'true')).toHaveLength(0)
    // The tabs are still there to click back to.
    expect(tabs().length).toBeGreaterThan(0)
  })

  it('selects no tab either when the page says the stage is in force but a view id is active', async () => {
    // Belt and braces: the highlight keys on the layout's own activeViewId,
    // like the other scope sets, so a stale page value cannot double-select.
    await renderTabs({ stage: 'saved', activeViewId: 'view-1' })
    expect(tabs().filter((c) => c.getAttribute('aria-selected') === 'true')).toHaveLength(0)
  })

  it('reports every tab through onProspectStageChange', async () => {
    const onPick = vi.fn<(next: ProspectStageTab) => void>()
    await renderTabs({ onPick })
    for (const t of tabs()) {
      act(() => {
        t.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    }
    expect(onPick.mock.calls.map(([v]) => v)).toEqual([...PROSPECT_STAGE_TABS])
  })

  it('is keyboard reachable — real buttons in a tablist, none of them removed from the tab order', async () => {
    await renderTabs({})
    expect(container.querySelector('[role="tablist"][aria-label="Filter candidates"]')).toBeTruthy()
    for (const t of tabs()) {
      expect(t.tagName).toBe('BUTTON')
      expect(t.getAttribute('type')).toBe('button')
      expect(t.getAttribute('tabindex')).toBeNull()
    }
  })

  it('renders a zero count rather than hiding the tab', async () => {
    await renderTabs({ counts: { all: 0, saved: 0, needs_review: 0, dismissed: 0 } })
    // A row whose tabs appear and disappear as a run streams in is worse than
    // one that says zero — for every tab EXCEPT the conditional one, which is
    // about an exception and hides itself when there is none.
    expect(tabs()).toHaveLength(
      PROSPECT_STAGE_TABS.filter((t) => !isConditionalProspectStageTab(t)).length,
    )
    expect(tab('Dismissed')!.textContent).toContain('0')
  })

  it('draws the tabs bare when there are no counts to show — an empty list', async () => {
    await renderTabs({ counts: null })
    expect(tab('All')!.textContent?.trim()).toBe('All')
    expect(tab('Saved')!.textContent?.trim()).toBe('Saved')
    expect(tab('Needs review')).toBeUndefined()
  })

  /**
   * NEEDS REVIEW IS THE ONE TAB THAT HIDES ITSELF (C5).
   *
   * It counts people the save route held back because their employer could not
   * be verified. On a healthy list that is zero for the list's whole life, and
   * a permanent "Needs review 0" trains the user to read the row as decoration
   * rather than as state. But it must NOT vanish while it is the active tab:
   * the rows would narrow to nothing with no highlighted tab left to explain
   * why, and the only way out would be a guess.
   */
  describe('Needs review — the conditional tab', () => {
    it('is hidden at zero', async () => {
      await renderTabs({ counts: { ...COUNTS, needs_review: 0 } })
      expect(container.textContent).not.toContain('Needs review')
    })

    it('appears as soon as it has something to say', async () => {
      await renderTabs({ counts: { ...COUNTS, needs_review: 2 } })
      expect(container.textContent).toContain('Needs review')
    })

    it('stays visible at zero while it is the ACTIVE tab', async () => {
      await renderTabs({ stage: 'needs_review', counts: { ...COUNTS, needs_review: 0 } })
      const active = tabs().filter((c) => c.getAttribute('aria-selected') === 'true')
      expect(active).toHaveLength(1)
      expect(active[0].textContent).toContain('Needs review')
    })

    it('is the ONLY tab that hides itself at zero', () => {
      expect(isConditionalProspectStageTab('needs_review')).toBe(true)
      for (const t of PROSPECT_STAGE_TABS.filter((x) => x !== 'needs_review')) {
        expect(isConditionalProspectStageTab(t), t).toBe(false)
      }
    })
  })
})

describe('the vocabulary behind the tabs', () => {
  it('opens on Saved once anything is saved, and on All before that', () => {
    expect(defaultProspectStageTab({ saved: 0 })).toBe('all')
    expect(defaultProspectStageTab({ saved: 1 })).toBe('saved')
    expect(defaultProspectStageTab(null)).toBe('all')
    expect(defaultProspectStageTab(undefined)).toBe('all')
  })

  it('narrows Saved and Dismissed by stage, Needs review by identity — and All by NOTHING', () => {
    // "All" sends no stage filter: the server hides dismissed rows unless a
    // filter names `stage`, which is also what lets a custom view built as
    // "Stage is dismissed" be honoured instead of shadowed.
    expect(prospectStageTabFilters('all')).toEqual([])
    expect(prospectStageTabFilters('saved')).toEqual([
      { id: '__tab_stage', field: 'stage', operator: 'is', value: 'saved' },
    ])
    expect(prospectStageTabFilters('dismissed')).toEqual([
      { id: '__tab_stage', field: 'stage', operator: 'is', value: 'dismissed' },
    ])
    expect(prospectStageTabFilters('needs_review')).toEqual([
      { id: '__tab_identity', field: 'identity_state', operator: 'is', value: 'needs_review' },
    ])
  })

  it('seeds a new custom view from Saved with a VISIBLE "Stage is saved" chip, and from All with nothing', () => {
    expect(seedFiltersForProspectStageTab('saved')).toMatchObject([
      { field: 'stage', operator: 'is', value: 'saved' },
    ])
    expect(seedFiltersForProspectStageTab('dismissed')).toMatchObject([
      { field: 'stage', operator: 'is', value: 'dismissed' },
    ])
    expect(seedFiltersForProspectStageTab('all')).toEqual([])
    expect(seedFiltersForProspectStageTab('needs_review')).toEqual([])
    expect(seedFiltersForProspectStageTab(null)).toEqual([])
    // A real, user-removable chip — not one of the page's locked scope ids.
    expect(seedFiltersForProspectStageTab('saved')[0].id).not.toMatch(/^__/)
  })
})
