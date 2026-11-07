// @vitest-environment jsdom
/**
 * The eval-run poll re-arms only while the SERVER says the run is live.
 *
 * THE BUG THIS SUITE EXISTS TO PREVENT: `eval_run.is_live` is a GENERATED
 * column (`status in ('queued','running')`, migration 252). A loop that
 * recomputed liveness from a client-side status list would carry its own copy
 * of a five-value CHECK constraint — and `cancelled` is the terminal state a
 * hand-rolled predicate reaches for last, so the bug shape is "polls a
 * cancelled run forever, in every open tab". The fixtures therefore set
 * `is_live` independently of `status`, so a hook that inferred it from the
 * name would fail here rather than in production.
 *
 * Also pinned: the loop stops on unmount (a background tab must not keep a
 * timer and a fetch alive); a mount-time probe adopts a run started elsewhere,
 * which is how the Run buttons know to disable themselves for a run the user
 * never pressed; the TERMINAL tick still fires `onTick`, because trials commit
 * just before the run settles and a missed final refresh leaves the last
 * case's outcome invisible; and a failed poll keeps polling rather than
 * declaring the run dead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fetchRun = vi.fn()
const fetchRuns = vi.fn()
vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    fetchRun: (id: string) => fetchRun(id),
    fetchRuns: (suiteId: string, limit?: number) => fetchRuns(suiteId, limit),
  }
})

import { RUN_POLL_INTERVAL_MS, useEvalRunPoll } from '../use-eval-run-poll'
import { runRow, trialRow } from './fixtures'

/** `fetchRun` answers `{ run, trials }` — the run detail payload, not a bare run. */
function detail(run = runRow({ status: 'running' }), trials = [trialRow()]) {
  return { run, trials }
}

let container: HTMLDivElement
let root: Root
let latest: ReturnType<typeof useEvalRunPoll> | null = null

function Probe({ onTick }: { onTick?: () => void }) {
  latest = useEvalRunPoll({ suiteId: 'suite-1', onTick })
  return null
}

beforeEach(() => {
  vi.useFakeTimers()
  latest = null
  fetchRun.mockReset()
  fetchRuns.mockReset().mockResolvedValue([])
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

async function mount(onTick?: () => void) {
  await act(async () => {
    root.render(<Probe onTick={onTick} />)
  })
  await act(async () => {})
}

async function tick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS)
  })
}

describe('useEvalRunPoll', () => {
  it('probes the run history on mount and adopts a live run started elsewhere', async () => {
    fetchRuns.mockResolvedValue([runRow({ status: 'running' })])
    await mount()

    expect(fetchRuns).toHaveBeenCalledWith('suite-1', 1)
    expect(latest!.run?.id).toBe('run-1')
    expect(latest!.isLive).toBe(true)
    expect(latest!.loading).toBe(false)
  })

  it('re-arms every interval while the run is live', async () => {
    fetchRuns.mockResolvedValue([runRow({ status: 'running' })])
    fetchRun.mockResolvedValue(detail())
    await mount()

    await tick()
    expect(fetchRun).toHaveBeenCalledTimes(1)
    await tick()
    expect(fetchRun).toHaveBeenCalledTimes(2)
    await tick()
    expect(fetchRun).toHaveBeenCalledTimes(3)
  })

  it('stops the moment the server stops calling the run live', async () => {
    fetchRuns.mockResolvedValue([runRow({ status: 'running' })])
    fetchRun.mockResolvedValueOnce(detail())
    fetchRun.mockResolvedValue(detail(runRow({ status: 'completed' })))
    await mount()

    await tick()
    await tick()
    expect(fetchRun).toHaveBeenCalledTimes(2)

    // The second tick came back terminal — no more timers.
    await tick()
    await tick()
    expect(fetchRun).toHaveBeenCalledTimes(2)
    expect(latest!.isLive).toBe(false)
  })

  it('does not poll a cancelled run whose is_live the server already cleared', async () => {
    // The exact trap: a client-side `isLive` derived from status names reaches
    // for `cancelled` last, and would spin on this forever.
    fetchRuns.mockResolvedValue([runRow({ status: 'cancelled', is_live: false, outcome: null })])
    await mount()

    expect(latest!.isLive).toBe(false)
    await tick()
    await tick()
    expect(fetchRun).not.toHaveBeenCalled()
  })

  it('trusts the server flag over the status name in BOTH directions', async () => {
    // A status the client would call terminal, which the server says is live.
    // The hook must poll it — inverting the previous test proves the gate is
    // the flag and not a lucky agreement between the two.
    fetchRuns.mockResolvedValue([runRow({ status: 'completed', is_live: true })])
    fetchRun.mockResolvedValue(detail(runRow({ status: 'completed', is_live: true })))
    await mount()

    expect(latest!.isLive).toBe(true)
    await tick()
    expect(fetchRun).toHaveBeenCalledTimes(1)
  })

  it('never arms for a suite with no runs', async () => {
    fetchRuns.mockResolvedValue([])
    await mount()

    expect(latest!.run).toBeNull()
    expect(latest!.trials).toEqual([])
    await tick()
    expect(fetchRun).not.toHaveBeenCalled()
  })

  it('carries the trials through on every tick', async () => {
    fetchRuns.mockResolvedValue([runRow({ status: 'running' })])
    fetchRun.mockResolvedValue(
      detail(runRow({ status: 'running' }), [
        trialRow({ id: 'trial-1', outcome: 'passed' }),
        trialRow({ id: 'trial-2', case_id: 'case-2', outcome: 'failed' }),
      ]),
    )
    await mount()
    expect(latest!.trials).toHaveLength(0)

    await tick()
    expect(latest!.trials.map((t) => t.outcome)).toEqual(['passed', 'failed'])
  })

  it('fires onTick on the TERMINAL tick too', async () => {
    // Trials commit just before the run settles. Skipping the final refresh
    // would leave the last case's outcome invisible until a manual reload.
    const onTick = vi.fn()
    fetchRuns.mockResolvedValue([runRow({ status: 'running' })])
    fetchRun.mockResolvedValue(detail(runRow({ status: 'completed' })))
    await mount(onTick)

    await tick()
    expect(onTick).toHaveBeenCalledTimes(1)
    expect(latest!.isLive).toBe(false)
  })

  it('keeps polling through a failed tick rather than declaring the run dead', async () => {
    fetchRuns.mockResolvedValue([runRow({ status: 'running' })])
    fetchRun.mockRejectedValueOnce(new Error('cold lambda'))
    fetchRun.mockResolvedValue(detail())
    await mount()

    await tick()
    expect(fetchRun).toHaveBeenCalledTimes(1)
    expect(latest!.isLive).toBe(true)
    await tick()
    expect(fetchRun).toHaveBeenCalledTimes(2)
  })

  it('adopt() arms the loop immediately, without waiting for a history probe', async () => {
    fetchRuns.mockResolvedValue([])
    fetchRun.mockResolvedValue(detail())
    await mount()
    expect(latest!.isLive).toBe(false)

    await act(async () => {
      latest!.adopt(runRow({ id: 'run-2', status: 'queued' }))
    })
    expect(latest!.isLive).toBe(true)
    await tick()
    expect(fetchRun).toHaveBeenCalledWith('run-2')
  })

  it('clear() drops the run and its trials without cancelling anything', async () => {
    fetchRuns.mockResolvedValue([runRow({ status: 'running' })])
    fetchRun.mockResolvedValue(detail())
    await mount()
    await tick()
    expect(latest!.trials).toHaveLength(1)

    await act(async () => {
      latest!.clear()
    })
    expect(latest!.run).toBeNull()
    expect(latest!.trials).toEqual([])
    expect(latest!.isLive).toBe(false)
  })

  it('stops the loop on unmount', async () => {
    fetchRuns.mockResolvedValue([runRow({ status: 'running' })])
    fetchRun.mockResolvedValue(detail())
    await mount()
    await tick()
    expect(fetchRun).toHaveBeenCalledTimes(1)

    await act(async () => root.unmount())
    await tick()
    await tick()
    expect(fetchRun).toHaveBeenCalledTimes(1)

    // Re-arm a root so the shared afterEach unmount is a no-op rather than a
    // second unmount on a dead tree.
    root = createRoot(container)
  })
})
