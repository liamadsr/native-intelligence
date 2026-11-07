// @vitest-environment jsdom
/**
 * Every terminal status says its own true thing (§9, §10).
 *
 * The four are genuinely different situations, and the two that get flattened
 * by a generic "Run finished" banner are exactly the two that matter:
 *
 *   - `budget_exhausted` is an OUTCOME, not a failure. The run did what it was
 *     told and kept everything. Offering Resume and Raise cap — and NOT styling
 *     it as an error — is what stops the cap from feeling like a punishment.
 *   - a completed run with zero new candidates is an EXHAUSTED ICP. "0 new" on
 *     its own reads as a broken search; the honest reading is that the list
 *     already has everything this ICP finds, and the fix is editing the ICP,
 *     so that is the button.
 *
 * `completedSummary` is asserted directly as well as through the render: it is
 * the feature's central claim in one sentence, assembled from two independently
 * written jsonb blobs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { MONTHLY_CAP_ERROR, PROSPECTING_MONTHLY_CAP_DOLLARS } from '@/lib/prospecting/spend'
import type { SpendPayload } from '../api'
import { RunOutcome, completedSummary, monthlyCapMessage, targetedSummary } from '../run-outcome'
import { counts, progress, run } from './run-fixtures'

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

function text(): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  )
}

const handlers = {
  onResume: vi.fn(),
  onRetry: vi.fn(),
  onDismiss: vi.fn(),
  onEditIcp: vi.fn(),
}

async function render(payload: ReturnType<typeof run>, spend: SpendPayload | null = null) {
  Object.values(handlers).forEach((h) => h.mockReset())
  await act(async () => {
    root.render(<RunOutcome run={payload} spend={spend} {...handlers} />)
  })
}

/** A spend payload shaped exactly as GET /spend returns it. */
function spendPayload(overrides: Partial<SpendPayload> = {}): SpendPayload {
  return {
    month_spent_dollars: PROSPECTING_MONTHLY_CAP_DOLLARS,
    cap_dollars: PROSPECTING_MONTHLY_CAP_DOLLARS,
    resets_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * The WORKSPACE ceiling wears the same `budget_exhausted` status as the
 * per-run cap and is a completely different situation.
 *
 * A per-run cap is the number the user typed on the consent screen thirty
 * seconds earlier, so "Stopped early" plus [Resume] is
 * exactly right. The monthly ceiling is a workspace fact they may never have
 * seen, partly spent by colleagues, and NEITHER button can do anything about
 * it: Resume queues a run preflight refuses again, and Raise cap raises the
 * per-run budget — the wrong number — quietly widening a cap for a run that
 * will never get to spend it. Offering either would be a lie told by a button.
 */
describe('monthlyCapMessage', () => {
  it('names the ceiling and the date it lifts', () => {
    expect(monthlyCapMessage(spendPayload())).toBe('Prospecting is paused for this month — back on Oct 1')
  })

  it('falls back to the constant when the ceiling has not loaded', () => {
    // The run is parked either way; a missing footnote must not leave the
    // banner unable to say WHY.
    expect(monthlyCapMessage(null)).toBe('Prospecting is paused for this month')
  })
})

describe('RunOutcome — the monthly ceiling', () => {
  it('replaces the per-run copy, and offers neither Resume nor Raise cap', async () => {
    await render(
      run({ status: 'budget_exhausted', budget_dollars: 2, error: MONTHLY_CAP_ERROR }),
      spendPayload(),
    )

    expect(text()).toContain('Prospecting is paused for this month — back on Oct 1')
    // The per-run sentence must NOT also appear: two different caps in one
    // banner is how a user concludes the feature does not know why it stopped.
    expect(text()).not.toContain('Stopped early')
    expect(button('Resume')).toBeUndefined()
  })

  it('still reports the partial results the run kept', async () => {
    await render(
      run({ status: 'budget_exhausted', budget_dollars: 2, error: MONTHLY_CAP_ERROR }),
      spendPayload(),
    )
    expect(text()).toContain('12 companies kept')
  })

  it('leaves the per-run cap branch alone when the error is not the ceiling', async () => {
    // Same status, different cause — the discriminator is the `error` column,
    // not the status, and getting this backwards would strip Resume from every
    // ordinary capped run.
    await render(run({ status: 'budget_exhausted', budget_dollars: 2 }), spendPayload())
    expect(text()).toContain('Stopped early')
    expect(text()).not.toContain('paused for this month')
    expect(button('Resume')).toBeDefined()
  })
})

describe('completedSummary', () => {
  it('names every non-zero suppression bucket and ends on the new count', () => {
    expect(completedSummary(progress(), counts())).toBe(
      '24 candidates · 6 already in this list · 2 you dismissed · 4 already in your CRM · 12 new',
    )
  })

  it('drops zero clauses rather than dragging them behind a clean run', () => {
    expect(
      completedSummary(
        progress({ found: 12, new: 12 }),
        counts({ this_list: 0, crm: 0, dismissed_global: 0 }),
      ),
    ).toBe('12 candidates · 12 new')
  })
})

describe('RunOutcome', () => {
  it('renders the ledger sentence for a completed run', async () => {
    await render(run({ status: 'completed' }))
    expect(text()).toContain('Round 2')
    expect(text()).toContain('6 already in this list')
    expect(text()).toContain('4 already in your CRM')
    expect(text()).toContain('12 new')
  })

  it('reads an exhausted ICP as an editing prompt, not a failure', async () => {
    await render(
      run({ status: 'completed', progress: progress({ new: 0, found: 18 }) }),
    )
    expect(text()).toContain('Nothing new this round.')
    expect(text()).toContain('try editing it')

    const edit = button('Edit the ICP')
    expect(edit).toBeTruthy()
    await act(async () => {
      edit!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(handlers.onEditIcp).toHaveBeenCalledTimes(1)
  })

  it('parks budget_exhausted as an outcome with Resume', async () => {
    await render(run({ status: 'budget_exhausted', budget_dollars: 2 }))

    expect(text()).toContain('Stopped early')
    expect(text()).toContain('12 companies found')
    // Not a failure: no warning glyph, no amber.
    expect(container.querySelector('.border-amber-500\\/40')).toBeNull()

    await act(async () => {
      button('Resume')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(handlers.onResume).toHaveBeenCalledTimes(1)
    expect(button('Raise cap')).toBeUndefined()
  })

  it('shows the engine’s own error text and a Retry for a failed run', async () => {
    await render(run({ status: 'failed', error: 'Exa timed out' }))
    expect(text()).toContain('The run failed.')
    expect(text()).toContain('Exa timed out')
    // Partial results survive a failure and the copy has to say so.
    expect(text()).toContain('12 kept')

    await act(async () => {
      button('Retry')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(handlers.onRetry).toHaveBeenCalledTimes(1)
  })

  it('tells a user who cancelled that their results were kept', async () => {
    await render(run({ status: 'canceled' }))
    expect(text()).toContain('Cancelled — 12 kept')
  })

  it('renders nothing for a run that is still live', async () => {
    await render(run({ status: 'running' }))
    expect(text()).toBe('')
  })

  it('dismisses without cancelling anything', async () => {
    await render(run({ status: 'completed' }))
    const dismiss = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Dismiss run result',
    )
    await act(async () => {
      dismiss!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(handlers.onDismiss).toHaveBeenCalledTimes(1)
  })
})

/**
 * PR 5: the same five terminal states, per run KIND.
 *
 * THE BUG THIS FENCES is not hypothetical — it is what the component did
 * before the fork existed. An `account_card` run discovers nothing, so every
 * clause of the discovery ledger is zero, and a run that had just researched
 * eighteen companies reported "0 candidates · 0 new". A people run's yield
 * lives in `people_found`, which the ledger never reads at all.
 *
 * The people line states PARTIALITY (§7 Stage 4) rather than hiding a
 * shortfall: 3-of-5 is the expected outcome of a domain-anchored search over
 * an index that does not contain every profile, and a headline that implied a
 * full roster would make a working stage read as broken.
 */
describe('RunOutcome — per-kind copy', () => {
  it('renders NOTHING for a finished account-card run — the rows already say it', async () => {
    // The banner used to read "Research finished · Researched 18 companies"
    // above eighteen rows that each now carry a profile. Same fact twice;
    // Liam asked for the banner to go.
    await render(
      run({
        kind: 'account_card',
        status: 'completed',
        is_live: false,
        progress: progress({ stage: 'done', accounts_done: 18, accounts_total: 18 }),
      }),
    )
    expect(container.innerHTML).toBe('')
  })

  it('renders NOTHING for a finished people run — the tab count already says it', async () => {
    await render(
      run({
        kind: 'people',
        status: 'completed',
        is_live: false,
        progress: progress({ stage: 'done', people_found: 5, people_target: 5 }),
      }),
    )
    expect(container.innerHTML).toBe('')
  })

  it('still knows the people yield as a partial, for the branches that report it', () => {
    // `targetedSummary` is what budget_exhausted, failed and canceled say for
    // a people run — the denominator matters there because those are the
    // runs that did NOT get everything.
    expect(
      targetedSummary(
        'people',
        progress({ people_found: 3, people_target: 5, accounts_done: 2, accounts_total: 2 }),
      ),
    ).toBe('Found 3 of the 5 roles you asked for · searched 2 companies')
    expect(targetedSummary('people', progress({ people_found: 5, people_target: 5 }))).toBe(
      'Found all 5 roles you asked for',
    )
    expect(targetedSummary('account_card', progress({ accounts_done: 18, accounts_total: 18 }))).toBe(
      'Researched 18 companies',
    )
  })

  it('reports a capped account-card run in the units it produced', async () => {
    // "0 companies found" on a run that researched 7 of 18 is how a partial
    // success reads as a failure.
    await render(
      run({
        kind: 'account_card',
        status: 'budget_exhausted',
        is_live: false,
        budget_dollars: 2,
        progress: progress({ accounts_done: 7, accounts_total: 18, new: 0 }),
      }),
    )
    const rendered = text()
    expect(rendered).toContain('Stopped early')
    expect(rendered).toContain('researched 7 of 18 companies')
  })

  it('keeps the discovery ledger for a discovery run', async () => {
    await render(run({ kind: 'discover', status: 'completed', is_live: false }))
    expect(text()).toContain('already in this list')
  })
})
