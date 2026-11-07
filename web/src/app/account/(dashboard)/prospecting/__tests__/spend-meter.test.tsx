// @vitest-environment jsdom
/**
 * The monthly ceiling's copy and its gate (§9, decision 5).
 *
 * WHAT THESE TESTS DEFEND. The per-run cap is consented to on every press, so
 * it cannot surprise anyone. The WORKSPACE ceiling is the opposite: shared,
 * partly spent by colleagues, and enforced in preflight. If this line is wrong
 * or absent, the first time a user learns the ceiling exists is a run they
 * just approved refusing to start — which reads as a broken feature, not as a
 * guardrail.
 *
 * Three things are pinned:
 *
 * 1. THE COPY, from a fixture. "$3.40 of $20 this month · resets Oct 1" — the
 *    spend carries cents (it is a measured, billed amount), the cap does not
 *    (it is a round policy number), and the reset date is rendered in UTC,
 *    because the ceiling's month boundary is UTC and formatting the server's
 *    instant locally would show "Sep 30" to everyone west of Greenwich.
 *
 * 2. FIND IS DISABLED BELOW THE ESTIMATE, with the reason. The comparison is
 *    against THIS run's estimate rather than a fixed floor: a ceiling with
 *    $0.30 left can genuinely afford a one-round run and must not be refused.
 *
 * 3. AN UNKNOWN CEILING GATES NOTHING. A failed or in-flight read must leave
 *    Find pressable — the server refuses in preflight either way, and a client
 *    inventing a refusal because its own footnote would not load is strictly
 *    worse than no footnote.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { PROSPECTING_MONTHLY_CAP_DOLLARS } from '@/lib/prospecting/spend'
import type { SpendPayload } from '../api'
import {
  SpendMeter,
  formatResetDate,
  remainingDollars,
  spendMeterLabel,
  spendRemainingLabel,
} from '../spend-meter'
import { estimateRunDollars } from '../ui-helpers'
import { LIST } from './fixtures'

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

/** Radix portals the dialog out of `container`, so assertions read the body. */
function text(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** A spend payload shaped exactly as GET /spend returns it. */
function spend(overrides: Partial<SpendPayload> = {}): SpendPayload {
  return {
    month_spent_dollars: 3.4,
    cap_dollars: PROSPECTING_MONTHLY_CAP_DOLLARS,
    resets_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}


function confirmButton(): HTMLButtonElement {
  const buttons = Array.from(document.body.querySelectorAll('button'))
  const found = buttons.find((b) => b.textContent?.includes('Find companies'))
  if (!found) throw new Error('confirm button not rendered')
  return found as HTMLButtonElement
}

describe('spendMeterLabel', () => {
  it('states spend with cents, the cap without, and the UTC reset date', () => {
    // The cap is $20, not $20.00: it is policy, not a measured amount, and two
    // zeroes on it are noise beside a figure that genuinely bills in cents.
    expect(spendMeterLabel(spend())).toBe('$3.40 of $20 this month · resets Oct 1')
  })

  it('renders the reset date in UTC, not the viewer’s timezone', () => {
    // The month boundary the engine sums against is UTC. Formatting the same
    // instant locally shows "Sep 30" to anyone west of Greenwich and makes a
    // correct ceiling look a day off.
    expect(formatResetDate('2026-10-01T00:00:00.000Z')).toBe('Oct 1')
  })

  it('drops the reset clause rather than printing an invalid date', () => {
    expect(spendMeterLabel(spend({ resets_at: 'not-a-date' }))).toBe(
      '$3.40 of $20 this month',
    )
  })

  it('renders nothing at all without a payload', async () => {
    await act(async () => {
      root.render(<SpendMeter spend={null} />)
    })
    // Disclosure, not a load-bearing element: no skeleton, no reserved space.
    expect(container.textContent).toBe('')
  })

  it('renders the line when the payload arrives', async () => {
    await act(async () => {
      root.render(<SpendMeter spend={spend()} />)
    })
    expect(container.textContent).toContain('$3.40 of $20 this month')
  })
})

describe('spendRemainingLabel', () => {
  it('leads with the room left, so a refusal says how short it is', () => {
    // The meter's own line ("$3.40 of $20") makes the reader subtract to find
    // out whether they are $0.10 or $10 away. A surface refusing a run has to
    // answer that outright.
    expect(spendRemainingLabel(spend())).toBe('$16.60 left of $20 this month · resets Oct 1')
  })

  it('shares the meter’s cents-on-spend, none-on-cap house style', () => {
    expect(spendRemainingLabel(spend({ month_spent_dollars: 19.99 }))).toBe(
      '$0.01 left of $20 this month · resets Oct 1',
    )
  })

  it('drops the reset clause rather than printing an invalid date', () => {
    expect(spendRemainingLabel(spend({ resets_at: 'not-a-date' }))).toBe(
      '$16.60 left of $20 this month',
    )
  })
})

describe('remainingDollars', () => {
  it('is the room left under the ceiling', () => {
    expect(remainingDollars(spend())).toBeCloseTo(16.6, 6)
  })

  it('is never negative — an over-spent month has zero room, not -$2', () => {
    expect(remainingDollars(spend({ month_spent_dollars: 22 }))).toBe(0)
  })

  it('is Infinity for an unknown ceiling, so a missing read never gates', () => {
    expect(remainingDollars(null)).toBe(Number.POSITIVE_INFINITY)
  })
})

