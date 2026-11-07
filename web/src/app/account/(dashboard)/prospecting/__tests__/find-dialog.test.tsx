// @vitest-environment jsdom
/**
 * The consent screen states numbers that BIND (§9).
 *
 * The load-bearing assertion is that the estimate is derived from the same
 * (no price on it — limits live in the backend, not on this dialog)
 * against — not hard-coded here. A dialog with its own number drifts from the
 * gate the moment the measured call price moves, and then the figure the user
 * approved stops being the figure that is enforced, which is the one promise
 * this screen exists to make.
 *
 * Also pinned: the cap is editable and clamped to the band the route accepts
 * (a typed 999 must not reach `startRun` as 999 and come back silently
 * corrected), and the 409 renders as "Already running" rather than as an error.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { FindDialog } from '../find-dialog'
import { formatDollars } from '../ui-helpers'
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

async function render(props: Partial<Parameters<typeof FindDialog>[0]> = {}) {
  await act(async () => {
    root.render(
      <FindDialog
        open
        list={LIST}
        onCancel={() => {}}
        onConfirm={() => {}}
        {...props}
      />,
    )
  })
  await act(async () => {})
}

describe('FindDialog', () => {
  it('states the plan in the list’s own rounds, with no price on it', async () => {
    // LIST.max_rounds is 2 → 2 rounds × 4 searches.
    await render()

    const rendered = text()
    expect(rendered).toContain('2 rounds × 4 searches')
    // One yes covers both halves: discovery hands off to the profile run.
    expect(rendered).toContain('then a full profile and a score for every company it finds.')
    expect(rendered).not.toMatch(/approve/i)
    expect(rendered).toContain('re-sorts best match first')
    // Limits live in the backend; nothing on this dialog names money.
    expect(rendered).not.toContain('$')
  })

  it('says round (singular) for a one-round list', async () => {
    await render({ list: { ...LIST, max_rounds: 1 } })
    expect(text()).toContain('1 round × 4 searches')
  })

  it('confirms on the button, with the list’s own defaults', async () => {
    const onConfirm = vi.fn()
    await render({ onConfirm })

    const confirm = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Find companies',
    )
    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('renders a 409 as "Already running", not as an error', async () => {
    await render({ alreadyRunning: true })
    expect(text()).toContain('Already running')
    // No red: the one-live-run index firing on a double-press is the feature
    // working, and painting it as a failure teaches users to distrust it.
    expect(document.body.querySelector('[class*="destructive"]')).toBeNull()
  })

  it('renders nothing when closed', async () => {
    await act(async () => {
      root.render(
        <FindDialog open={false} list={LIST} onCancel={() => {}} onConfirm={() => {}} />,
      )
    })
    expect(text()).not.toContain('Find companies')
  })
})


/**
 * `budget_dollars` is `numeric(10,4)` and `spent_dollars` is `numeric(10,6)`
 * (migration 248), and supabase-js serializes `numeric` as a STRING — the run
 * read path casts the row rather than coercing, so `RunPayload`'s `number`
 * declaration is a claim the wire does not honour. A `typeof === 'number'`
 * guard therefore rendered every raw column as "$0.00", including the cap
 * banner: "Stopped at your $0.00 cap", on the one screen whose whole job is
 * that the figure the user consented to is the figure that binds.
 */
describe('formatDollars', () => {
  it('reads the numeric-as-string shape PostgREST returns', () => {
    expect(formatDollars('2.0000')).toBe('$2.00')
    expect(formatDollars('0.416000')).toBe('$0.42')
    expect(formatDollars('20')).toBe('$20.00')
  })

  it('still formats real numbers to two places', () => {
    expect(formatDollars(0.4)).toBe('$0.40')
    expect(formatDollars(2)).toBe('$2.00')
  })

  it('falls back to $0.00 for anything unreadable, never NaN', () => {
    expect(formatDollars(null)).toBe('$0.00')
    expect(formatDollars(undefined)).toBe('$0.00')
    expect(formatDollars('')).toBe('$0.00')
    expect(formatDollars('abc')).toBe('$0.00')
    expect(formatDollars(-3)).toBe('$0.00')
  })
})
