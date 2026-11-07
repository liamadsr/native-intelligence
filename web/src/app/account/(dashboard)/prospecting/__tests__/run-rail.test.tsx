// @vitest-environment jsdom
/**
 * The rail is ONE kind-aware sentence rendered from a `ProspectingRunProgress`
 * fixture (§15).
 *
 * It exists because the rail reads an untyped jsonb blob the Inngest writer
 * produces out-of-band. Nothing else in the system fails when
 * `progress.found` becomes `progress.candidates_found` — the rail just
 * quietly drops the clause forever, which is indistinguishable from a run that
 * is not finding anything.
 *
 * Also pinned:
 *   - the words, per run kind, because the earlier three-segment stepper read
 *     as noise on profile and people runs ("Companies 0" lit green, "Round 1
 *     of 1 · 0 already known") and Liam asked for one line that names what
 *     the run is doing.
 *   - zero clauses are DROPPED, never printed as "0 found, 0 new".
 *   - "already known" stays on the discovery line — the cheapest place in the
 *     UI where dedup is legible.
 *   - Cancel's two-step copy: pressing it must say "Cancelling…", never read
 *     as a discard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The orb is a canvas animation; jsdom has no 2d context and it is not what
// this suite is about.
vi.mock('thinking-orbs', () => ({ ThinkingOrb: () => null }))

import { RunRail, runRailLine } from '../run-rail'
import { progress } from './run-fixtures'

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

/** Collapse whitespace so an assertion is about the words, not the JSX's
 *  line breaks between `{' · '}` expressions. */
function text(): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim()
}

describe('runRailLine', () => {
  it('discovery: verb, round, found/new, already known', () => {
    expect(runRailLine('discover', progress())).toEqual({
      verb: 'Finding companies',
      clauses: ['round 2 of 2', '24 found, 12 new', '6 already known'],
    })
  })

  it('discovery: says Scoring while the score stage runs', () => {
    expect(runRailLine('discover', progress({ stage: 'score' })).verb).toBe('Scoring companies')
  })

  it('discovery: drops "round 1 of 1" and every zero clause', () => {
    // A run that has just started has reported nothing. "0 found, 0 new · 0
    // already known" is not progress, it is a stage that has not spoken yet.
    expect(
      runRailLine('discover', progress({ max_rounds: 1, round: 1, found: 0, new: 0, suppressed: 0 })),
    ).toEqual({ verb: 'Finding companies', clauses: [] })
  })

  it('profiles: the one number that moves on that kind, and nothing else', () => {
    expect(
      runRailLine(
        'account_card',
        progress({ stage: 'account_card', accounts_done: 7, accounts_total: 18 }),
      ),
    ).toEqual({ verb: 'Building profiles', clauses: ['7 of 18'] })
    // Discovery's numbers are still in the blob (found 24, new 12, suppressed
    // 6) — and none of them is printed. That was the stepper's failure.
  })

  it('profiles: no clause before the engine sets a total', () => {
    expect(runRailLine('account_card', progress({ stage: 'account_card' })).clauses).toEqual([])
  })

  it('people: companies covered, then people found', () => {
    expect(
      runRailLine(
        'people',
        progress({
          stage: 'people',
          accounts_done: 2,
          accounts_total: 4,
          people_found: 3,
          people_target: 12,
        }),
      ),
    ).toEqual({ verb: 'Finding people', clauses: ['2 of 4 companies', '3 found'] })
    expect(
      runRailLine('people', progress({ stage: 'people', accounts_done: 1, accounts_total: 1 })),
    ).toEqual({ verb: 'Finding people', clauses: ['1 of 1 company'] })
    expect(runRailLine('people', progress({ stage: 'people' })).clauses).toEqual([])
  })
})

describe('RunRail', () => {
  it('renders the sentence for a live discovery run', async () => {
    await act(async () => {
      root.render(<RunRail kind="discover" progress={progress()} live onCancel={() => {}} />)
    })

    const rendered = text()
    expect(rendered).toContain('Finding companies · round 2 of 2 · 24 found, 12 new · 6 already known')
    // The stepper's words are gone with it.
    expect(rendered).not.toContain('Fit')
    expect(rendered).not.toContain('later')
    // No percentage anywhere: the denominator is unknowable and a bar that
    // crawls to 90% and parks is the exact lie the sentence exists to avoid.
    expect(rendered).not.toMatch(/\d+%/)
  })

  it('renders the profile and people sentences', async () => {
    await act(async () => {
      root.render(
        <RunRail
          kind="account_card"
          progress={progress({ stage: 'account_card', accounts_done: 7, accounts_total: 18 })}
          live
          onCancel={() => {}}
        />,
      )
    })
    expect(text()).toBe('Building profiles · 7 of 18Cancel')

    await act(async () => {
      root.render(
        <RunRail
          kind="people"
          progress={progress({
            stage: 'people',
            accounts_done: 2,
            accounts_total: 4,
            people_found: 3,
            people_target: 12,
          })}
          live
          onCancel={() => {}}
        />,
      )
    })
    expect(text()).toBe('Finding people · 2 of 4 companies · 3 foundCancel')
  })

  it('cancels and promises the results are kept', async () => {
    const onCancel = vi.fn()
    await act(async () => {
      root.render(<RunRail kind="discover" progress={progress()} live onCancel={onCancel} />)
    })

    const button = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Cancel'),
    )
    expect(button).toBeTruthy()
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onCancel).toHaveBeenCalledTimes(1)

    // The in-flight reading — the parent flips `canceling` while the POST is
    // out and the run settles asynchronously.
    await act(async () => {
      root.render(
        <RunRail kind="discover" progress={progress()} live canceling onCancel={onCancel} />,
      )
    })
    expect(text()).toContain('Cancelling…')
  })

  it('drops the cancel affordance on a run that is no longer live', async () => {
    await act(async () => {
      root.render(
        <RunRail kind="discover" progress={progress()} live={false} onCancel={() => {}} />,
      )
    })
    const button = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Cancel'),
    )
    expect(button).toBeUndefined()
  })
})
