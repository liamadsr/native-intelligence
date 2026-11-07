// @vitest-environment jsdom
/**
 * `eval_case` and `eval_run` rows in the shared views list — the two entity
 * types the suite detail page's Cases and Runs tabs are built on.
 *
 * Both are silent-failure shaped in the same way the suite row is: every
 * accessor degrades to null on a missing key, so a dropped column renders a
 * blank cell under a correct-looking header rather than throwing. What is
 * pinned here is what each cell CLAIMS.
 *
 * The load-bearing distinctions:
 *
 *  - A RUN HAS NO NAME. Its title is COMPOSED from mode + started_at, and
 *    that composition is shared with the tab bar and Recently viewed — two
 *    spellings would be two names for the same run depending on which screen
 *    reached it.
 *  - `polarity` is asymmetric ON PURPOSE. A negative control gets a pill and a
 *    positive case gets muted text, because negative is the exceptional,
 *    meaning-inverting case; giving both an identical pill would make the
 *    exception invisible in a scan.
 *  - AN ABSENT OUTCOME RENDERS NOTHING on both rows. OutcomeChip's own dash
 *    placeholder is for a run table that needs to keep its column width; on a
 *    list row it would read as "graded, and we have no result".
 *  - A SCORE OF '—' IS NOT 0%. Every check in that dimension was `unknown` or
 *    `skipped`, both excluded from the denominator — printing a bare zero
 *    would claim a total failure of something never measured.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/tasks/action-platform-cell', () => ({
  ActionPlatformCell: () => null,
}))

// The orb is a canvas/animation component; jsdom has no use for it and it is
// not what these assertions are about. A marker element stands in so "the row
// spins the orb while a run is live" stays assertable.
vi.mock('thinking-orbs', () => ({
  ThinkingOrb: () => h('span', { 'data-testid': 'thinking-orb' }),
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

const CASE = {
  id: 'case-1',
  suite_id: 'suite-1',
  name: 'Prospect stalls on pricing',
  polarity: 'positive',
  modes: ['batch', 'live'],
  visibility: 'workspace',
  last_outcome: 'failed',
  last_run_at: new Date().toISOString(),
}

const RUN = {
  id: 'run-1',
  suite_id: 'suite-1',
  mode: 'batch',
  speed: 'instant',
  status: 'completed',
  is_live: false,
  outcome: 'scored',
  scores: {
    gate: { rate: 1 },
    tools: { rate: 1 },
    summary: { rate: 1 },
    proposals: { rate: 0.6 },
  },
  cost_usd: 0.0188,
  duration_ms: 82_000,
  trials_per_case: 1,
  target_prompt_hash: 'a1b2c3d4e5f60718',
  started_at: '2026-09-08T15:38:00.000Z',
  ended_at: '2026-09-08T15:39:22.000Z',
}

async function renderRow(
  entityType: 'eval_case' | 'eval_run',
  item: Record<string, unknown>,
  displayProperties: string[] = DEFAULT_DISPLAY_PROPERTIES[entityType],
  onPatch?: (id: string, patch: Record<string, unknown>) => void,
) {
  await act(async () => {
    root.render(
      h(EntityRow, {
        item,
        entityType,
        displayProperties,
        isSelected: false,
        onItemSelect: vi.fn(),
        ...(onPatch ? { onPatch } : {}),
      }),
    )
  })
}

const text = () => container.textContent ?? ''

describe('EntityRow — eval_case', () => {
  it('titles the row with the case name, and never blank', () => {
    expect(getTitle('eval_case', CASE)).toBe('Prospect stalls on pricing')
    expect(getTitle('eval_case', { id: 'x' })).toBe('Untitled case')
  })

  it('renders the default columns: polarity, modes, outcome and when', async () => {
    await renderRow('eval_case', CASE)
    expect(text()).toContain('Prospect stalls on pricing')
    expect(text()).toContain('Positive')
    expect(text()).toContain('Batch')
    expect(text()).toContain('Live')
    expect(text()).toContain('Failed')
  })

  it('marks a NEGATIVE control with a pill, and a positive one with muted text', async () => {
    await renderRow('eval_case', { ...CASE, polarity: 'negative' }, ['polarity'])
    expect(text()).toContain('Negative')
    // The amber pill is the whole signal — a suite of only positives measures
    // recall and never precision, which is what the suite page's banner warns
    // about, and this row is where the reader sees which case is the control.
    expect(container.querySelector('.bg-amber-500\\/10')).toBeTruthy()

    await renderRow('eval_case', CASE, ['polarity'])
    expect(text()).toContain('Positive')
    expect(container.querySelector('.bg-amber-500\\/10')).toBeNull()
  })

  it('renders every mode a case declares, not just the first', async () => {
    await renderRow('eval_case', { ...CASE, modes: ['batch'] }, ['modes'])
    expect(text()).toContain('Batch')
    expect(text()).not.toContain('Live')
  })

  it('renders NOTHING for an outcome no trial has settled', async () => {
    await renderRow('eval_case', { ...CASE, last_outcome: null }, ['last_outcome'])
    // Not a dash, not an empty chip — absence says "never graded" more plainly
    // than a placeholder that reads as a verdict.
    expect(text()).not.toContain('—')
    expect(text()).not.toContain('Failed')
  })

  it('says "Never run" when nothing has ever graded the case', async () => {
    await renderRow('eval_case', { ...CASE, last_run_at: null }, ['last_run_at'])
    expect(text()).toContain('Never run')
  })

  it('chips PRIVATE visibility only — "workspace" is the unremarkable case', async () => {
    // A case seeded from a private capture stays creator-only (§3.2), which is
    // worth a chip. Stamping every other row "Workspace" would be a column of
    // furniture saying "normal".
    await renderRow('eval_case', { ...CASE, visibility: 'private' }, ['visibility'])
    expect(text()).toContain('Private')

    await renderRow('eval_case', CASE, ['visibility'])
    expect(text()).not.toContain('Private')
    expect(text()).not.toContain('Workspace')
  })

  it('renders a real PICKER for polarity when onPatch is wired', async () => {
    // The descriptor declares `picker: 'enum'`, but renderEditableCell bails
    // to a read-only chip whenever resolveEnumOptions has no case for the
    // field — a silent downgrade that looks identical to a correct row. The
    // interactive trigger is the only observable difference.
    await renderRow('eval_case', CASE, ['polarity'], vi.fn())
    expect(container.querySelector('[aria-haspopup="dialog"]')).toBeTruthy()
  })

  it('leaves polarity read-only when no onPatch is wired', async () => {
    await renderRow('eval_case', CASE, ['polarity'])
    expect(container.querySelector('[aria-haspopup="dialog"]')).toBeNull()
  })
})

describe('EntityRow — eval_run', () => {
  it('COMPOSES a title from mode and start time, because a run has no name', () => {
    // The exact shape the suite page, the tab bar and Recently viewed all use.
    expect(getTitle('eval_run', RUN)).toMatch(/^Batch run · /)
    expect(getTitle('eval_run', { ...RUN, mode: 'live' })).toMatch(/^Live run · /)
    // Absolute, never relative: two runs of the same suite an hour apart are
    // the thing being compared, and "2h ago" on both cannot tell them apart.
    expect(getTitle('eval_run', RUN)).not.toContain('ago')
  })

  it('renders the default columns: outcome, mode, the score line, cost and duration', async () => {
    await renderRow('eval_run', RUN)
    // The verdict LEADS the meta line — it is the one thing a reader scans a
    // run list for, so it is on by default rather than picker-only.
    expect(DEFAULT_DISPLAY_PROPERTIES.eval_run[0]).toBe('outcome')
    expect(text()).toContain('Scored')
    expect(text()).toContain('Batch')
    // ONE line, labels with bare numbers — four labelled percentages do not
    // fit a row cell, and the label establishes the unit.
    expect(text()).toContain('Gate')
    expect(text()).toContain('Proposals')
    expect(text()).toContain('60')
    expect(text()).toContain('$0.0188')
    expect(text()).toContain('1m 22s')
  })

  it('spells the score line out in full in the title attribute', async () => {
    await renderRow('eval_run', RUN, ['scores'])
    const cell = container.querySelector('[title]')
    expect(cell?.getAttribute('title')).toContain('Gate 100%')
    expect(cell?.getAttribute('title')).toContain('Proposals 60%')
  })

  it('renders a dimension with an empty denominator as "—", never 0', async () => {
    await renderRow(
      'eval_run',
      { ...RUN, scores: { nudges: { rate: null } } },
      ['scores'],
    )
    expect(text()).toContain('Nudges')
    expect(text()).toContain('—')
    expect(text()).not.toContain('Nudges 0')
  })

  it('renders nothing at all for a run with no scores yet', async () => {
    await renderRow('eval_run', { ...RUN, scores: {} }, ['scores'])
    expect(text()).not.toContain('Gate')
  })

  it('renders NOTHING for an outcome the run has not reached', async () => {
    await renderRow('eval_run', { ...RUN, outcome: null }, ['outcome'])
    expect(text()).not.toContain('—')
    expect(text()).not.toContain('Scored')
  })

  it('spins the orb on a LIVE run, and only on a live one', async () => {
    await renderRow(
      'eval_run',
      { ...RUN, status: 'running', is_live: true, outcome: null },
      ['status'],
    )
    expect(text()).toContain('running')
    expect(container.querySelector('[data-testid="thinking-orb"]')).toBeTruthy()

    // `is_live` is the SERVER's own generated column. A settled run never
    // spins, whatever its status text says.
    await renderRow('eval_run', RUN, ['status'])
    expect(container.querySelector('[data-testid="thinking-orb"]')).toBeNull()
  })

  it('shortens the prompt hash to eight characters, full value in the title', async () => {
    await renderRow('eval_run', RUN, ['target_prompt_hash'])
    // The composed title is in the row text too, so this is a containment
    // check on the CELL rather than an equality one on the whole row.
    expect(text()).toContain('a1b2c3d4')
    expect(text()).not.toContain('a1b2c3d4e5f60718')
    expect(container.querySelector('[title]')?.getAttribute('title')).toBe(
      'a1b2c3d4e5f60718',
    )
  })

  it('renders start and end times absolutely, never as "ago"', async () => {
    await renderRow('eval_run', RUN, ['started_at', 'ended_at'])
    // The shared `started_at` cell renders RELATIVE time for every other
    // entity; the run row resolves its own before the shared switch sees it.
    expect(text()).not.toContain('ago')
    expect(text()).toContain('Sep 8')
  })

  it('names the trial count rather than printing a bare number', async () => {
    await renderRow('eval_run', { ...RUN, trials_per_case: 3 }, ['trials_per_case'])
    expect(text()).toContain('3 trials')
    await renderRow('eval_run', RUN, ['trials_per_case'])
    expect(text()).toContain('1 trial')
  })
})
