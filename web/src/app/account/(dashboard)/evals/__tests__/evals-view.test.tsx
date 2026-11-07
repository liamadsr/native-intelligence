// @vitest-environment jsdom
/**
 * The Evals INDEX, now that it is a views-system list.
 *
 * The rows, the filtering, the grouping and the empty state all belong to
 * UnifiedViewLayout and are covered where that component is. What is left for
 * THIS view — and what would each be a silent regression — is:
 *
 *  1. THE INDEX IS THE SHARED LIST. If someone re-introduces a bespoke list
 *     here, saved views, filters and grouping quietly stop existing for Evals
 *     while the page still looks fine. So the entity type handed to
 *     UnifiedViewLayout is pinned.
 *  2. NO SECOND SEARCH BOX. The views toolbar owns search; a header input
 *     beside it would filter a different set from the one the toolbar counts.
 *  3. "+" MUST FIRE THE SKILL, NOT OPEN A FORM. `/create-eval` (migration 253)
 *     is what writes a suite AND its cases; a button that opened a name field
 *     would create empty suites that can never be run. The bridge is the
 *     `dial8:trigger-skill` window event the shell routes to the active tab's
 *     chat — a component-local handler would reach no chat at all.
 *  4. CLICKING A ROW OPENS THE SUITE, carrying its name so the tab label and
 *     Recently viewed are right before the detail page has loaded anything.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The detail page pulls in the case editor, the run detail and the poll; the
// index branch never renders it, and stubbing keeps this suite about the index.
vi.mock('../suite-detail', () => ({ EvalSuiteDetail: () => null }))

// The real layout drags in the whole views stack (data hooks, dnd-kit, the
// toolbar). Its own behaviour is tested in src/components/views/__tests__ —
// here it stands in as a probe for the props this page hands it.
const layoutProps: Array<{ entityType: string; onItemSelect?: (id: string, title: string) => void }> = []
vi.mock('@/components/views/unified-view-layout', () => ({
  UnifiedViewLayout: (props: { entityType: string; onItemSelect?: (id: string, title: string) => void }) => {
    layoutProps.push(props)
    return null
  },
}))

import { EvalsView } from '../evals-view'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  layoutProps.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const noop = () => {}

async function render(props: Partial<Parameters<typeof EvalsView>[0]> = {}) {
  await act(async () => {
    root.render(
      <EvalsView suiteId={null} onOpenSuite={noop} onCloseDetail={noop} {...props} />,
    )
  })
  await act(async () => {})
}

const text = () => container.textContent ?? ''

function buttonByLabel(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === label,
  ) as HTMLButtonElement | undefined
}

describe('EvalsView — index', () => {
  it('renders the shared views list for eval_suite, not a bespoke one', async () => {
    await render()

    expect(layoutProps).toHaveLength(1)
    expect(layoutProps[0].entityType).toBe('eval_suite')
    expect(text()).toContain('Evals')
  })

  it('leaves search to the views toolbar — the header carries no input of its own', async () => {
    await render()

    expect(container.querySelector('input')).toBeNull()
  })

  it('the "+" fires /create-eval through the shell bridge', async () => {
    const events: string[] = []
    const listener = (e: Event) => {
      events.push((e as CustomEvent).detail?.slug)
    }
    window.addEventListener('dial8:trigger-skill', listener)
    try {
      await render()

      await act(async () => {
        buttonByLabel('New eval suite')!.click()
      })

      expect(events).toEqual(['create-eval'])
    } finally {
      window.removeEventListener('dial8:trigger-skill', listener)
    }
  })

  it('opens a suite from the list, carrying its name for the history entry', async () => {
    const onOpenSuite = vi.fn()
    await render({ onOpenSuite })

    act(() => {
      layoutProps[0].onItemSelect!('suite-a', 'Sales Discovery')
    })

    expect(onOpenSuite).toHaveBeenCalledWith('suite-a', 'Sales Discovery')
  })

  it('renders the suite detail (and never the list) when a suite is open', async () => {
    await render({ suiteId: 'suite-a' })

    expect(layoutProps).toHaveLength(0)
  })
})
