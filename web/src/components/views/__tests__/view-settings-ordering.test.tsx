// @vitest-environment jsdom
/**
 * The Ordering control in View settings.
 *
 * The direction toggle rebuilt the ordering as a ONE-element array from
 * `config.ordering?.[0]`, which silently dropped every trailing key. That is
 * invisible for the entities whose default is a single key, and destructive
 * for `eval_case`, whose default is `sort_order asc, created_at asc` — the
 * second key is the only thing breaking a total tie (nothing ever writes
 * `sort_order`, so every row holds 252's DEFAULT 0), and losing it hands the
 * list's offset pagination a nondeterministic order that duplicates or skips
 * cases.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { TooltipProvider } from '@/components/ui/tooltip'
import { ViewSettingsPopover } from '../view-settings-popover'
import type { ViewConfig } from '../hooks/use-view'
import type { ViewEntityType } from '@/lib/views/types'

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

const CASES_CONFIG = {
  filters: [],
  grouping: null,
  sub_grouping: null,
  ordering: [
    { field: 'sort_order', direction: 'asc' },
    { field: 'created_at', direction: 'asc' },
  ],
  display_properties: [],
  layout: 'list',
} as unknown as ViewConfig

async function openSettings(onChange: (u: Partial<ViewConfig>) => void, entityType: ViewEntityType = 'eval_case', config = CASES_CONFIG) {
  await act(async () => {
    root.render(
      h(
        TooltipProvider,
        null,
        h(ViewSettingsPopover, {
          config,
          entityType,
          onChange,
        }),
      ),
    )
  })
  // The content is inside a Popover; click the trigger to mount it.
  const trigger = container.querySelector('button')
  await act(async () => {
    trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** The direction toggle is the only button whose child is the arrow icon. */
function directionToggle(): HTMLButtonElement {
  const buttons = [...document.querySelectorAll('button')] as HTMLButtonElement[]
  const found = buttons.find((b) => b.querySelector('svg.lucide-arrow-up, svg.lucide-arrow-down'))
  if (!found) throw new Error('No direction toggle rendered')
  return found
}

describe('ViewSettingsPopover — Ordering', () => {
  it.each(['agent', 'skill'] as const)('%s shows the existing collection order and only supported settings', async entityType => {
    await openSettings(vi.fn(), entityType, { ...CASES_CONFIG, ordering: [] })
    const triggers = [...document.querySelectorAll('[role="combobox"]')]
    expect(triggers).toHaveLength(1)
    expect(triggers[0].textContent).toBe('Default')
    expect(directionToggle().disabled).toBe(true)
    expect(document.body.textContent).not.toContain('Board')
    expect(document.body.textContent).not.toContain('Grouping')
    expect(document.body.textContent).not.toContain('Display properties')
  })

  it('the Ordering select shows the current field, not a blank trigger', async () => {
    await openSettings(vi.fn())
    // A Radix Select whose value matches no SelectItem renders an EMPTY
    // trigger — the symptom when `sort_order` was missing from
    // FILTERABLE_FIELDS. The label of the declared field is the proof.
    const triggers = [...document.querySelectorAll('[role="combobox"]')] as HTMLElement[]
    const ordering = triggers.find((t) => (t.textContent ?? '').trim() === 'Order')
    expect(ordering, 'no Ordering trigger rendered the sort_order label').toBeTruthy()
  })

  it('flipping the direction KEEPS the tie-break key', async () => {
    const onChange = vi.fn()
    await openSettings(onChange)
    await act(async () => {
      directionToggle().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith({
      ordering: [
        { field: 'sort_order', direction: 'desc' },
        { field: 'created_at', direction: 'asc' },
      ],
    })
  })
})
