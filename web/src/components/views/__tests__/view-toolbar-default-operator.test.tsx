// @vitest-environment jsdom
/**
 * WHAT A FRESHLY ADDED FILTER CHIP ASKS.
 *
 * The toolbar builds every new chip, and it used to pick the first operator
 * the field's TYPE offers. For a number that is `is` — exact equality — so
 * adding a Confidence filter produced "Confidence is ___" against a continuous
 * 0..1 column: a question with essentially no answers.
 *
 * `field-traits` fixes it per FIELD, and this file is the wiring test: the unit
 * behaviour lives in filters/__tests__/filter-percent-unit.test.tsx, and it
 * would keep passing even if the toolbar went on calling
 * OPERATORS_BY_TYPE[type][0] and nobody ever saw the difference.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { ViewConfig } from '../hooks/use-view'
import type { ViewEntityType, ViewFilter } from '@/lib/views/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// cmdk (the field picker's Command list) needs both; jsdom has neither.
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {}
}

import { ViewToolbar } from '../view-toolbar'

let container: HTMLDivElement
let root: Root
let onConfigChange: ReturnType<typeof vi.fn>

beforeEach(() => {
  onConfigChange = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function makeConfig(): ViewConfig {
  return {
    filters: [],
    grouping: null,
    sub_grouping: null,
    ordering: [],
    display_properties: [],
    layout: 'list',
    board_group_by: null,
    show_completed: true,
    completed_filter: 'all',
    show_sub_items: true,
    nested_sub_items: false,
    show_empty_groups: false,
    action_scope: 'assigned',
    workspace_scope: 'workspace',
    crm_scope: 'contacts',
    capture_scope: 'all',
  } as ViewConfig
}

async function renderToolbar(entityType: ViewEntityType) {
  await act(async () => {
    root.render(
      h(ViewToolbar, {
        entityType,
        views: [],
        activeViewId: null,
        onViewChange: vi.fn(),
        onCreateView: vi.fn(),
        onUpdateView: vi.fn(),
        onDuplicateView: vi.fn(),
        onDeleteView: vi.fn(),
        config: makeConfig(),
        onConfigChange,
        isDirty: false,
        overrides: {},
        onSaveDraft: vi.fn(),
        onDiscardDraft: vi.fn(),
      }),
    )
  })
}

/** Open the toolbar's filter picker and click a field by its label. The picker
 *  renders into a portal, so the items are looked up on the document. */
async function addFilter(label: string) {
  const trigger = Array.from(container.querySelectorAll('button'))
    .find(b => b.innerHTML.includes('list-filter'))
  if (!trigger) throw new Error('the toolbar rendered no filter button')
  await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

  const item = Array.from(document.querySelectorAll('[cmdk-item]'))
    .find(el => el.textContent === label)
  if (!item) throw new Error(`the field picker has no "${label}" row`)
  await act(async () => { item.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

function addedFilter(): ViewFilter {
  const last = onConfigChange.mock.calls.at(-1)
  if (!last) throw new Error('no config change was emitted')
  return (last[0] as { filters: ViewFilter[] }).filters[0]
}

describe('adding a filter from the toolbar picker', () => {
  it('opens Confidence on a threshold', async () => {
    await renderToolbar('claim')
    await addFilter('Confidence')

    expect(addedFilter()).toMatchObject({ field: 'confidence', operator: 'gte' })
  })

  it('leaves a plain number field on its type default', async () => {
    await renderToolbar('contact')
    await addFilter('Interaction count')

    expect(addedFilter()).toMatchObject({ field: 'interaction_count', operator: 'is' })
  })

  it('leaves a text field on its type default', async () => {
    await renderToolbar('claim')
    await addFilter('Text')

    expect(addedFilter()).toMatchObject({ field: 'text', operator: 'is' })
  })
})
