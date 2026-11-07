// @vitest-environment jsdom
/**
 * The request storm (the live bug): `GET /api/account/evals/suites/<id>`
 * firing every ~250-500ms with no gaps on a suite whose only run is COMPLETED.
 *
 * THE SHAPE. `tab-content.tsx` renders `<EvalsView onSuiteNameLoaded={(id,
 * name) => navigate(...)} />` — an inline arrow, a NEW function identity on
 * every render of the tab, and `navigate` re-renders the tab. The detail page
 * put that prop in `load`'s dependency array AND called it from inside `load`,
 * which closes the circuit:
 *
 *   load() → fetchSuite → onSuiteNameLoaded() → parent navigate → parent
 *   re-render → new callback identity → new `load` identity → the mount effect
 *   (deps `[load]`) re-fires → load() → …
 *
 * There is no timer involved and no `is_live` gate to stop it: the loop runs as
 * fast as the network answers. That is exactly the observed cadence.
 *
 * WHAT THIS SUITE LOCKS IN. Two independent halves of the fix, so a partial
 * regression still fails:
 *
 *  1. A parent that rebuilds `onSuiteNameLoaded` every render, and re-renders
 *     when it is called, must still produce exactly ONE `fetchSuite`. The
 *     callback belongs in a ref, and `load`'s only dep is `suiteId`.
 *  2. The name must be reported ONCE PER VALUE. Even a stable callback would
 *     otherwise push a redundant navigation on every poll tick refetch, which
 *     is the same storm one level up in the tab.
 *
 * Fake timers run several poll intervals forward to prove the completed run
 * arms nothing: a suite with no live run must be silent after its first load.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fetchSuite = vi.fn()
const fetchRuns = vi.fn()
const fetchRun = vi.fn()
const fetchCase = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    fetchSuite: (id: string) => fetchSuite(id),
    fetchRuns: (id: string, limit?: number) => fetchRuns(id, limit),
    fetchRun: (id: string) => fetchRun(id),
    fetchCase: (id: string) => fetchCase(id),
  }
})

import { EvalCasePage } from '../case-page'
import { EvalRunPage } from '../run-page'
import { EvalSuiteDetail } from '../suite-detail'
import { RUN_POLL_INTERVAL_MS } from '../use-eval-run-poll'
import { caseRow, runRow, suiteRow, trialRow } from './fixtures'

let container: HTMLDivElement
let root: Root

/** A COMPLETED run — `is_live` false, so nothing should be polling. */
const completed = runRow({ id: 'run-done', status: 'completed' })

beforeEach(() => {
  fetchSuite.mockReset().mockResolvedValue({
    suite: suiteRow(),
    cases: [caseRow({ id: 'c1' })],
    runs: [completed],
  })
  fetchRuns.mockReset().mockResolvedValue([completed])
  fetchRun.mockReset().mockResolvedValue({ run: completed, trials: [trialRow()] })
  // fetchCase answers with the row AND the capture's participants — the editor
  // needs the list because a PATCH replaces it wholesale.
  fetchCase.mockReset().mockResolvedValue({ case: caseRow({ id: 'c1' }), participants: [] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

/**
 * The tab, in miniature. `onSuiteNameLoaded` is an inline arrow (new identity
 * every render) whose body bumps parent state (standing in for `navigate`),
 * which is precisely what `tab-content.tsx` does.
 */
function Host({ onNavigate }: { onNavigate: () => void }) {
  const [, setNav] = useState(0)
  return (
    <EvalSuiteDetail
      suiteId="suite-1"
      onBack={() => {}}
      onSuiteNameLoaded={(_id, _name) => {
        onNavigate()
        setNav((n) => n + 1)
      }}
    />
  )
}

/** Let every pending microtask-driven state update settle. */
async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

describe('EvalSuiteDetail — request storm', () => {
  it('loads the suite exactly once under a parent that rebuilds the callback and re-renders', async () => {
    const onNavigate = vi.fn()
    await act(async () => {
      root.render(<Host onNavigate={onNavigate} />)
    })
    await settle()

    expect(fetchSuite).toHaveBeenCalledTimes(1)
    // The real name is reported, but only once per value.
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })

  it('stays quiet across several poll intervals when the newest run is completed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await act(async () => {
      root.render(<Host onNavigate={() => {}} />)
    })
    await settle()
    const afterMount = fetchSuite.mock.calls.length

    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS)
      })
      await settle(4)
    }

    expect(afterMount).toBe(1)
    // A completed run arms no timer, so nothing refetched the suite.
    expect(fetchSuite).toHaveBeenCalledTimes(1)
    expect(fetchRun).not.toHaveBeenCalled()
  })

  it('switches tabs without refetching or re-reporting the name', async () => {
    // The tab strip lives on the same page as the name report. A tab switch
    // re-renders the page and (through the caller) re-navigates the location,
    // which is exactly the shape that closed the original circuit — so both
    // halves of the fix have to survive it: `load`'s only dep is still
    // `suiteId`, and the name is still reported once per VALUE.
    const onNavigate = vi.fn()
    await act(async () => {
      root.render(<Host onNavigate={onNavigate} />)
    })
    await settle()
    expect(fetchSuite).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledTimes(1)

    for (const label of ['Cases', 'Runs', 'Overview']) {
      const pill = Array.from(document.body.querySelectorAll('button')).find(
        (b) => (b.textContent ?? '').trim().startsWith(label),
      ) as HTMLButtonElement
      expect(pill).toBeTruthy()
      await act(async () => {
        pill.click()
      })
      await settle(4)
    }

    expect(fetchSuite).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })

  it('reports an unchanged suite name only once even across repeat loads', async () => {
    const onNavigate = vi.fn()
    await act(async () => {
      root.render(<Host onNavigate={onNavigate} />)
    })
    await settle()
    expect(onNavigate).toHaveBeenCalledTimes(1)

    // A second render pass of the parent must not re-report the same name.
    await act(async () => {
      root.render(<Host onNavigate={onNavigate} />)
    })
    await settle()
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })
})

/**
 * The same circuit, one screen down. A case and a run are LOCATIONS now, so
 * each reports its own label to `tab-content.tsx` through an inline arrow that
 * calls `navigate` — exactly the prop shape that closed the loop on the suite.
 * Both callbacks therefore live in a ref and fire from a value-deduped effect,
 * and these two suites are what say so.
 */
describe('EvalCasePage — request storm', () => {
  function CaseHost({ onNavigate }: { onNavigate: () => void }) {
    const [, setNav] = useState(0)
    return (
      <EvalCasePage
        caseId="c1"
        suiteName="Sales Discovery"
        onBack={() => {}}
        onCaseNameLoaded={() => {
          onNavigate()
          setNav((n) => n + 1)
        }}
      />
    )
  }

  it('loads the case exactly once under a parent that rebuilds the callback and re-renders', async () => {
    const onNavigate = vi.fn()
    await act(async () => {
      root.render(<CaseHost onNavigate={onNavigate} />)
    })
    await settle()

    expect(fetchCase).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })

  it('reports an unchanged case name only once even across repeat renders', async () => {
    const onNavigate = vi.fn()
    await act(async () => {
      root.render(<CaseHost onNavigate={onNavigate} />)
    })
    await settle()
    await act(async () => {
      root.render(<CaseHost onNavigate={onNavigate} />)
    })
    await settle()
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })
})

describe('EvalRunPage — request storm', () => {
  function RunHost({ onNavigate }: { onNavigate: () => void }) {
    const [, setNav] = useState(0)
    return (
      <EvalRunPage
        runId="run-done"
        suiteName="Sales Discovery"
        onBack={() => {}}
        onRunLabelLoaded={() => {
          onNavigate()
          setNav((n) => n + 1)
        }}
      />
    )
  }

  it('loads the run exactly once under a parent that rebuilds the callback and re-renders', async () => {
    const onNavigate = vi.fn()
    await act(async () => {
      root.render(<RunHost onNavigate={onNavigate} />)
    })
    await settle()

    expect(fetchRun).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })

  it('stays quiet across several poll intervals on a settled run', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await act(async () => {
      root.render(<RunHost onNavigate={() => {}} />)
    })
    await settle()
    const afterMount = fetchRun.mock.calls.length

    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS)
      })
      await settle(4)
    }

    expect(afterMount).toBe(1)
    expect(fetchRun).toHaveBeenCalledTimes(1)
  })
})
