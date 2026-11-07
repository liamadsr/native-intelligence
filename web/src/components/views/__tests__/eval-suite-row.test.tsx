// @vitest-environment jsdom
/**
 * An `eval_suite` row in the shared views list.
 *
 * Every cell here reads a REAL column that migration 255 denormalized onto
 * eval_suite behind triggers. That is what lets a view group and sort on them
 * — and it is also why a regression is silent: each accessor degrades to null
 * on a missing key, so a dropped column renders a blank cell under a
 * correct-looking header rather than throwing.
 *
 * Three distinctions are pinned because getting any of them wrong changes what
 * the row CLAIMS about a suite:
 *
 *  - "NEVER RUN" is not "ran, no verdict". A suite whose only run is still
 *    queued has a `last_run_at` and no `last_outcome`; it must not render as
 *    never run, or someone waiting on a run sees a screen saying nothing
 *    started.
 *  - The outcome cell renders NOTHING when there is no settled verdict.
 *    OutcomeChip's own dash placeholder is for a RUN that has not finished —
 *    on a suite row it would read as "graded, and we have no result".
 *  - `judge_model` null means the workspace default judge, which is a real
 *    configuration, not a missing value — so the cell says "Default".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/tasks/action-platform-cell', () => ({
  ActionPlatformCell: () => null,
}))

import { EntityRow, getTitle } from '../list/entity-row'
import { DEFAULT_DISPLAY_PROPERTIES } from '@/lib/views/types'

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

const SUITE = {
  id: 'suite-1',
  name: 'Sales Discovery',
  description: 'Does the agent catch a pricing stall?',
  target_kind: 'agent',
  suite_kind: 'capability',
  case_count: 7,
  last_run_at: new Date().toISOString(),
  last_run_mode: 'batch',
  last_outcome: 'failed',
  judge_model: null,
}

async function renderSuiteRow(
  item: Record<string, unknown>,
  displayProperties: string[] = DEFAULT_DISPLAY_PROPERTIES.eval_suite,
) {
  await act(async () => {
    root.render(
      h(EntityRow, {
        item,
        entityType: 'eval_suite',
        displayProperties,
        isSelected: false,
        onItemSelect: vi.fn(),
      }),
    )
  })
}

const text = () => container.textContent ?? ''

describe('EntityRow — eval_suite', () => {
  it('titles the row with the suite name, and never blank', () => {
    expect(getTitle('eval_suite', SUITE)).toBe('Sales Discovery')
    expect(getTitle('eval_suite', { id: 'x' })).toBe('Untitled suite')
  })

  it('renders the default columns: target, case count, outcome, mode and when', async () => {
    await renderSuiteRow(SUITE)

    expect(text()).toContain('Sales Discovery')
    expect(text()).toContain('Agent')
    expect(text()).toContain('7 cases')
    expect(text()).toContain('Failed')
    expect(text()).toContain('Batch')
  })

  it('says "1 case", not "1 cases"', async () => {
    await renderSuiteRow({ ...SUITE, case_count: 1 })
    expect(text()).toContain('1 case')
    expect(text()).not.toContain('1 cases')
  })

  it('a suite that has never run says so, in the last-run cell', async () => {
    await renderSuiteRow({
      ...SUITE,
      last_run_at: null,
      last_run_mode: null,
      last_outcome: null,
    })
    expect(text()).toContain('Never run')
  })

  it('a queued run does NOT read as never run, and shows no verdict', async () => {
    // last_run_at set, last_outcome still null — 255's semantics: an in-flight
    // run does not clear the previous verdict, and there was none.
    await renderSuiteRow({ ...SUITE, last_outcome: null, last_run_mode: 'live' })
    expect(text()).not.toContain('Never run')
    expect(text()).toContain('Live')
    // No chip at all, and specifically not OutcomeChip's dash placeholder.
    for (const verdict of ['Passed', 'Scored', 'Failed', 'Errored', '—']) {
      expect(text()).not.toContain(verdict)
    }
  })

  it('renders the capability/regression kind and the judge', async () => {
    await renderSuiteRow(
      { ...SUITE, suite_kind: 'regression', judge_model: 'anthropic/claude-opus-4' },
      ['suite_kind', 'judge_model'],
    )
    expect(text()).toContain('Regression')
    expect(text()).toContain('anthropic/claude-opus-4')
  })

  it('a null judge_model reads as the workspace Default, not as blank', async () => {
    await renderSuiteRow(SUITE, ['judge_model'])
    expect(text()).toContain('Default')
  })

  it('a skill suite is labelled Skill', async () => {
    await renderSuiteRow({ ...SUITE, target_kind: 'skill' }, ['target_kind'])
    expect(text()).toContain('Skill')
    expect(text()).not.toContain('Agent')
  })
})
