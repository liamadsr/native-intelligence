// @vitest-environment jsdom
/**
 * The poll re-arms only while the SERVER says the run is live (§9).
 *
 * THE BUG THIS SUITE EXISTS TO PREVENT: `prospecting_run.status` diverges from
 * `AgentRunStatus` — no `pr_open`, plus `budget_exhausted` — so a loop that
 * recomputed liveness from a client-side status list would keep polling a
 * budget-exhausted run forever. `budget_exhausted` is a terminal state whose
 * NAME reads live, which is precisely the shape a hand-rolled predicate gets
 * wrong. `RunPayload.is_live` is the route's own answer and the only gate.
 *
 * Also pinned: the loop stops on unmount (a background tab must not keep a
 * timer and a fetch alive), and a mount-time `fetchRuns` probe adopts a run
 * that was started elsewhere — which is how the Find button knows to disable
 * itself for a run the user never pressed in this session.
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
    fetchRuns: (listId: string, limit?: number) => fetchRuns(listId, limit),
  }
})

import { RUN_POLL_INTERVAL_MS, useRunPoll } from '../use-run-poll'
import { run } from './run-fixtures'

let container: HTMLDivElement
let root: Root

/** The hook's latest return value, captured by a probe component. */
let latest: ReturnType<typeof useRunPoll> | null = null

function Probe({ onTick }: { onTick?: () => void }) {
  latest = useRunPoll({ listId: 'list-1', onTick })
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

/** Advance past one poll interval and let the awaited fetch settle. */
async function tick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS)
  })
}

describe('useRunPoll', () => {
  it('probes the run history on mount and adopts a live run started elsewhere', async () => {
    fetchRuns.mockResolvedValue([run({ status: 'running' })])
    await mount()

    expect(fetchRuns).toHaveBeenCalledWith('list-1', 1)
    expect(latest!.run?.id).toBe('run-1')
    expect(latest!.isLive).toBe(true)
  })

  it('re-arms every interval while the run is live', async () => {
    fetchRuns.mockResolvedValue([run({ status: 'running' })])
    fetchRun.mockResolvedValue(run({ status: 'running' }))
    await mount()

    await tick()
    expect(fetchRun).toHaveBeenCalledTimes(1)
    await tick()
    expect(fetchRun).toHaveBeenCalledTimes(2)
    await tick()
    expect(fetchRun).toHaveBeenCalledTimes(3)
  })

  it('stops the moment the server stops calling the run live', async () => {
    fetchRuns.mockResolvedValue([run({ status: 'running' })])
    fetchRun.mockResolvedValueOnce(run({ status: 'running' }))
    fetchRun.mockResolvedValue(run({ status: 'completed' }))
    await mount()

    await tick()
    expect(fetchRun).toHaveBeenCalledTimes(1)
    await tick()
    expect(fetchRun).toHaveBeenCalledTimes(2)

    // The second tick came back terminal — no more timers.
    await tick()
    await tick()
    expect(fetchRun).toHaveBeenCalledTimes(2)
    expect(latest!.isLive).toBe(false)
  })

  it('does not poll a budget_exhausted run, whose name reads live but is not', async () => {
    // The exact trap: a client-side `isLive` written from status names would
    // spin on this forever.
    fetchRuns.mockResolvedValue([
      run({ status: 'budget_exhausted', is_live: false }),
    ])
    await mount()

    expect(latest!.isLive).toBe(false)
    await tick()
    await tick()
    expect(fetchRun).not.toHaveBeenCalled()
  })

  it('never arms for a list with no runs', async () => {
    fetchRuns.mockResolvedValue([])
    await mount()

    expect(latest!.run).toBeNull()
    await tick()
    expect(fetchRun).not.toHaveBeenCalled()
  })

  it('nudges the caller to refetch entries on every poll', async () => {
    const onTick = vi.fn()
    fetchRuns.mockResolvedValue([run({ status: 'running' })])
    fetchRun.mockResolvedValueOnce(run({ status: 'running' }))
    fetchRun.mockResolvedValue(run({ status: 'completed' }))
    await mount(onTick)

    await tick()
    expect(onTick).toHaveBeenCalledTimes(1)
    // The TERMINAL tick fires too: the last round's entries commit just before
    // the run settles, and skipping this refetch leaves them invisible.
    await tick()
    expect(onTick).toHaveBeenCalledTimes(2)
  })

  it('arms immediately when a freshly started run is adopted', async () => {
    fetchRuns.mockResolvedValue([])
    fetchRun.mockResolvedValue(run({ status: 'running' }))
    await mount()
    expect(latest!.isLive).toBe(false)

    await act(async () => {
      latest!.adopt(run({ status: 'running' }))
    })
    expect(latest!.isLive).toBe(true)

    await tick()
    expect(fetchRun).toHaveBeenCalledWith('run-1')
  })

  it('keeps polling through a transient fetch failure', async () => {
    fetchRuns.mockResolvedValue([run({ status: 'running' })])
    fetchRun.mockRejectedValueOnce(new Error('network blip'))
    fetchRun.mockResolvedValue(run({ status: 'running' }))
    await mount()

    await tick()
    expect(fetchRun).toHaveBeenCalledTimes(1)
    // A dropped poll is a blip, not a dead run — declaring it terminal would
    // strand the rail on a run that is still going.
    await tick()
    expect(fetchRun).toHaveBeenCalledTimes(2)
    expect(latest!.isLive).toBe(true)
  })

  it('clears without cancelling, so a live run is re-adopted next mount', async () => {
    fetchRuns.mockResolvedValue([run({ status: 'running' })])
    await mount()
    expect(latest!.isLive).toBe(true)

    await act(async () => {
      latest!.clear()
    })
    expect(latest!.run).toBeNull()
    await tick()
    expect(fetchRun).not.toHaveBeenCalled()
  })

  it('stops on unmount', async () => {
    fetchRuns.mockResolvedValue([run({ status: 'running' })])
    fetchRun.mockResolvedValue(run({ status: 'running' }))
    await mount()

    await tick()
    const before = fetchRun.mock.calls.length

    await act(async () => root.unmount())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS * 3)
    })
    expect(fetchRun).toHaveBeenCalledTimes(before)

    // afterEach unmounts again; make that a no-op on a fresh root.
    root = createRoot(container)
  })
})
