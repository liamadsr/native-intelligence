// @vitest-environment jsdom
/**
 * The workspace-wide active-run poll (§B5).
 *
 * THE BUGS THIS SUITE EXISTS TO PREVENT, in the order they would bite:
 *
 *  1. ONE CADENCE. A single interval would either burn 12 requests a minute on
 *     an idle workspace from every mounted nav rail forever, or take 20 seconds
 *     to move a progress rail. The two-speed loop is the whole design, and the
 *     transition has to happen on the very next arm — not at some boundary — so
 *     the interval is re-read from each fresh result.
 *  2. BACKGROUND TABS. Native Intelligence tabs stay MOUNTED when backgrounded (display:none),
 *     so an un-gated hook would poll once per tab the user has ever opened,
 *     forever. This is the expensive failure and the one that never shows up in
 *     a single-tab manual test.
 *  3. OVERLAPPING READS. `reload` landing on an armed tick must not produce two
 *     in-flight requests whose responses can settle out of order — the older
 *     one winning would blank a live dot for a full interval.
 *  4. A DROPPED READ IS NOT AN EMPTY WORKSPACE. Clearing `runs` on a rejected
 *     fetch would drop the dot for one tick and restore it on the next, which
 *     reads as the run having finished and started again.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fetchActiveRuns = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return { ...actual, fetchActiveRuns: () => fetchActiveRuns() }
})


import {
  ACTIVE_RUNS_IDLE_INTERVAL_MS,
  ACTIVE_RUNS_LIVE_INTERVAL_MS,
  useActiveRuns,
} from '../use-active-runs'

let container: HTMLDivElement
let root: Root
let latest: ReturnType<typeof useActiveRuns> | null = null

function activeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    list_id: 'list-1',
    list_name: 'Customers like us',
    status: 'running',
    is_live: true,
    ...overrides,
  }
}

function Probe({ enabled = true }: { enabled?: boolean }) {
  latest = useActiveRuns({ enabled })
  return null
}

beforeEach(() => {
  vi.useFakeTimers()
  latest = null
  // jsdom's `document.hidden` is a getter on the prototype; redefine per test.
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  fetchActiveRuns.mockReset().mockResolvedValue([])
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

async function mount(enabled = true) {
  await act(async () => {
    root.render(<Probe enabled={enabled} />)
  })
  await act(async () => {})
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('useActiveRuns', () => {
  it('reads immediately on mount rather than after an interval', async () => {
    // A 20-second wait for the first dot is the same as no dot at all.
    await mount()
    expect(fetchActiveRuns).toHaveBeenCalledTimes(1)
    expect(latest!.loading).toBe(false)
  })

  it('polls every 20s while nothing is running', async () => {
    await mount()
    expect(fetchActiveRuns).toHaveBeenCalledTimes(1)

    // Nowhere near the idle interval, and well past the live one — the whole
    // point is that an idle workspace is NOT on the 5s cadence.
    await advance(ACTIVE_RUNS_LIVE_INTERVAL_MS * 2)
    expect(fetchActiveRuns).toHaveBeenCalledTimes(1)

    await advance(ACTIVE_RUNS_IDLE_INTERVAL_MS)
    expect(fetchActiveRuns).toHaveBeenCalledTimes(2)
  })

  it('speeds up to 5s on the very next arm once a run is live', async () => {
    fetchActiveRuns.mockResolvedValue([activeRun()])
    await mount()
    expect(fetchActiveRuns).toHaveBeenCalledTimes(1)
    expect(latest!.runs).toHaveLength(1)

    // The FIRST result already carried a live run, so the first re-arm must
    // already be at the fast cadence. Reading liveness from React state here
    // instead of a ref would leave this at 20s.
    await advance(ACTIVE_RUNS_LIVE_INTERVAL_MS)
    expect(fetchActiveRuns).toHaveBeenCalledTimes(2)
    await advance(ACTIVE_RUNS_LIVE_INTERVAL_MS)
    expect(fetchActiveRuns).toHaveBeenCalledTimes(3)
  })

  it('drops back to the idle cadence when the last run settles', async () => {
    fetchActiveRuns.mockResolvedValueOnce([activeRun()])
    fetchActiveRuns.mockResolvedValue([])
    await mount()

    await advance(ACTIVE_RUNS_LIVE_INTERVAL_MS)
    expect(fetchActiveRuns).toHaveBeenCalledTimes(2)
    expect(latest!.runs).toHaveLength(0)

    // Now empty: the fast cadence must not persist.
    await advance(ACTIVE_RUNS_LIVE_INTERVAL_MS * 2)
    expect(fetchActiveRuns).toHaveBeenCalledTimes(2)
    await advance(ACTIVE_RUNS_IDLE_INTERVAL_MS)
    expect(fetchActiveRuns).toHaveBeenCalledTimes(3)
  })

  it('never polls while disabled', async () => {
    await mount(false)
    expect(fetchActiveRuns).not.toHaveBeenCalled()
    await advance(ACTIVE_RUNS_IDLE_INTERVAL_MS * 3)
    expect(fetchActiveRuns).not.toHaveBeenCalled()
  })

  it('skips the request while the browser tab is hidden, and keeps the loop', async () => {
    await mount()
    expect(fetchActiveRuns).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    await advance(ACTIVE_RUNS_IDLE_INTERVAL_MS * 2)
    expect(fetchActiveRuns).toHaveBeenCalledTimes(1)

    // The LOOP survived the hidden stretch — becoming visible again reads at
    // once rather than waiting out another interval.
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(fetchActiveRuns).toHaveBeenCalledTimes(2)
  })

  it('keeps one request in flight at a time', async () => {
    // A read that never settles: the armed tick must not stack a second one.
    let release: ((v: unknown) => void) | null = null
    fetchActiveRuns.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    await mount()
    expect(fetchActiveRuns).toHaveBeenCalledTimes(1)

    await advance(ACTIVE_RUNS_IDLE_INTERVAL_MS * 3)
    expect(fetchActiveRuns).toHaveBeenCalledTimes(1)

    await act(async () => {
      release?.([])
    })
  })

  it('keeps the last good answer when a read fails', async () => {
    fetchActiveRuns.mockResolvedValueOnce([activeRun()])
    fetchActiveRuns.mockRejectedValue(new Error('network blip'))
    await mount()
    expect(latest!.runs).toHaveLength(1)

    await advance(ACTIVE_RUNS_LIVE_INTERVAL_MS)
    expect(fetchActiveRuns).toHaveBeenCalledTimes(2)
    // Blanking here would read as the run having ended.
    expect(latest!.runs).toHaveLength(1)
  })

  it('indexes runs by list so a card can find its own', async () => {
    fetchActiveRuns.mockResolvedValue([
      activeRun(),
      activeRun({ id: 'run-2', list_id: 'list-2', list_name: 'Investors' }),
    ])
    await mount()

    expect(latest!.byListId.get('list-1')?.id).toBe('run-1')
    expect(latest!.byListId.get('list-2')?.list_name).toBe('Investors')
    expect(latest!.byListId.get('list-3')).toBeUndefined()
  })

  it('reload reads at once without waiting out the interval', async () => {
    await mount()
    expect(fetchActiveRuns).toHaveBeenCalledTimes(1)

    await act(async () => {
      latest!.reload()
    })
    await act(async () => {})
    expect(fetchActiveRuns).toHaveBeenCalledTimes(2)
  })

  it('stops on unmount', async () => {
    await mount()
    const before = fetchActiveRuns.mock.calls.length

    await act(async () => root.unmount())
    await advance(ACTIVE_RUNS_IDLE_INTERVAL_MS * 3)
    expect(fetchActiveRuns).toHaveBeenCalledTimes(before)

    root = createRoot(container)
  })
})
