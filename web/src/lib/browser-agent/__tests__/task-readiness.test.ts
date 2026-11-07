import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observationSchema, type BrowserObservation } from '../task-contract'
import { executeBrowserTask, type TaskExecutorPorts } from '../task-executor'

const task = { goal: 'Show search results', completion: [{ kind: 'text', value: 'Results' }] }
const unavailable = { error: 'agent runtime not present' }
const observation: BrowserObservation = {
  protocol: 'dial8-browser-decision-v1', documentId: 'new-document', observationId: 1, interactionEpoch: 0,
  observedAt: 1, url: 'https://example.com/search', title: 'Search', text: 'Search', readyState: 'complete',
  elements: [{ ref: 'e1', role: 'button', name: 'Search', value: '', canType: false, disabled: false,
    sensitive: false, forbidden: false, context: '', destination: '' }],
}
function fixture() {
  const abort = new AbortController()
  let alive = true, done = false, id = 0
  const ports: TaskExecutorPorts = {
    signal: abort.signal, deadline: Date.now() + 45000, alive: () => alive,
    blockedSites: () => [], approve: vi.fn(async () => false), navigate: vi.fn(async () => {}),
    snapshot: vi.fn(async () => ({ ...observation, observationId: ++id, text: done ? 'Results' : 'Search' })),
    act: vi.fn(async () => { done = true; return { ok: true } }),
    decide: vi.fn<TaskExecutorPorts['decide']>(async seen => ({ decision: { status: 'accepted',
      value: seen.text === 'Results' ? { operation: 'done' } : { operation: 'click', ref: 'e1' },
      inferenceId: 'decision', version: 'test' }, deadline: Date.now() + 45000 })),
  }
  return { ports, abort, loseOwnership: () => { alive = false } }
}
async function finish(promise: ReturnType<typeof executeBrowserTask>) {
  await vi.runAllTimersAsync()
  return promise
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('cold browser task runtime readiness', () => {
  it('navigates once and waits for the new document runtime before acting', async () => {
    const f = fixture(), snapshot = f.ports.snapshot
    let ready = false
    // The URL commits before the document-start script is available in the isolated world.
    const navigate = vi.fn(async (_url: string) => { setTimeout(() => { ready = true }, 350) })
    f.ports.snapshot = vi.fn(async () => ready ? snapshot() : unavailable)
    f.ports.navigate = navigate
    const pending = executeBrowserTask({ ...task, startUrl: observation.url }, f.ports)
    await vi.advanceTimersByTimeAsync(349)
    expect(navigate).toHaveBeenCalledExactlyOnceWith(observation.url)
    expect(f.ports.decide).not.toHaveBeenCalled()
    expect(f.ports.act).not.toHaveBeenCalled()
    const result = await finish(pending)
    expect(result).toMatchObject({ status: 'verified', steps: 1 })
    expect(f.ports.decide).toHaveBeenCalledTimes(2)
    expect(vi.mocked(f.ports.decide).mock.calls[0][0].documentId).toBe('new-document')
    expect(f.ports.act).toHaveBeenCalledTimes(1)
    expect(result.timings.settlingMs).toBeGreaterThanOrEqual(400)
    expect(result.diagnostics).toMatchObject({ startupRetries: 4,
      lastSnapshotFailure: { phase: 'startup', code: 'runtime_starting' } })
  })

  it.each(['native_sentinel', 'exact_read_error'])('waits for a woken tab without navigation: %s', async mode => {
    const f = fixture(), snapshot = vi.mocked(f.ports.snapshot)
    if (mode === 'native_sentinel') snapshot.mockResolvedValueOnce(unavailable).mockResolvedValueOnce(unavailable)
    else snapshot.mockRejectedValueOnce(new Error('agent runtime not present')).mockRejectedValueOnce(new Error('agent runtime not present'))
    const result = await finish(executeBrowserTask(task, f.ports))
    expect(result).toMatchObject({ status: 'verified', steps: 1 })
    expect(f.ports.decide).toHaveBeenCalledTimes(2)
    expect(f.ports.act).toHaveBeenCalledTimes(1)
  })

  it('bounds startup exhaustion without buying inference or repeating navigation', async () => {
    const f = fixture()
    vi.mocked(f.ports.snapshot).mockResolvedValue(unavailable)
    const result = await finish(executeBrowserTask({ ...task, startUrl: observation.url }, f.ports))
    expect(result).toMatchObject({ status: 'escalate', reason: 'browser_observation_unavailable', elapsedMs: 2000, steps: 0, trace: [] })
    expect(f.ports.navigate).toHaveBeenCalledTimes(1)
    expect(f.ports.decide).not.toHaveBeenCalled()
    expect(f.ports.act).not.toHaveBeenCalled()
    expect(vi.mocked(f.ports.snapshot).mock.calls.length).toBeLessThanOrEqual(22)
  })

  it('retains time spent in a navigation that fails before a new observation', async () => {
    const f = fixture()
    f.ports.navigate = vi.fn(() => new Promise<void>((_resolve, reject) => {
      setTimeout(() => reject(new Error('Browser navigation did not settle')), 125)
    }))
    const result = await finish(executeBrowserTask({ ...task, startUrl: observation.url }, f.ports))
    expect(result).toMatchObject({ status: 'escalate', reason: 'transport_or_write_outcome_unknown',
      elapsedMs: 125, steps: 0, trace: [], timings: { navigationMs: 125 } })
    expect(f.ports.navigate).toHaveBeenCalledExactlyOnceWith(observation.url)
    expect(f.ports.snapshot).not.toHaveBeenCalled() // The page it left is never read.
    expect(f.ports.decide).not.toHaveBeenCalled()
    expect(f.ports.act).not.toHaveBeenCalled()
  })

  it('records independent bounded read budgets and native phase timings without treating them as page changes', async () => {
    const f = fixture(), original = f.ports.snapshot
    let reads = 0
    const native = { controlScan: 1, targetBuild: 2, viewportText: 3, completionEvidence: 4, documentLinks: 5, total: 15 }
    f.ports.snapshot = vi.fn(async () => ({ ...observationSchema.parse(await original()), readMetrics: { ...native, total: 15 + reads++ } }))
    const result = await finish(executeBrowserTask(task, f.ports))
    expect(result.status).toBe('verified')
    const settling = result.diagnostics?.snapshotReads?.filter(read => read.phase === 'settle') ?? []
    expect(settling.length).toBeGreaterThan(1)
    expect(settling[0]).toMatchObject({ budgetMs: 2000, outcome: 'read', native: { controlScan: 1 } })
    expect(settling.at(-1)!.budgetMs).toBe(2000)
    expect(f.ports.act).toHaveBeenCalledTimes(1)
  })

  it('allows a fresh native read to finish beyond the polling window without replaying its action', async () => {
    const f = fixture(), original = vi.mocked(f.ports.snapshot).getMockImplementation()!
    const originalAction = vi.mocked(f.ports.act).getMockImplementation()!
    vi.mocked(f.ports.act).mockImplementation(async () => {
      await originalAction({})
      vi.mocked(f.ports.snapshot).mockImplementationOnce(() => new Promise(resolve => setTimeout(async () => resolve({ ...observationSchema.parse(await original()), text: 'Results' }), 608)))
        .mockImplementationOnce(() => new Promise(resolve => setTimeout(async () => resolve({ ...observationSchema.parse(await original()), text: 'Results' }), 60)))
      return { ok: true }
    })
    const result = await finish(executeBrowserTask(task, f.ports))
    expect(result).toMatchObject({ status: 'verified', steps: 1, elapsedMs: 718 })
    expect(result.diagnostics?.snapshotReads?.filter(read => read.phase === 'settle').map(read => [read.elapsedMs, read.budgetMs, read.outcome]))
      .toEqual([[608, 2000, 'read'], [60, 2000, 'read']])
    expect(f.ports.act).toHaveBeenCalledTimes(1)
    expect(f.ports.decide).toHaveBeenCalledTimes(2)
  })

  it('bounds a hung post-action read to its independent read deadline without repeating the action', async () => {
    const f = fixture()
    vi.mocked(f.ports.snapshot).mockResolvedValueOnce(observation)
      .mockImplementation(() => new Promise(() => {}))
    const result = await finish(executeBrowserTask(task, f.ports))
    expect(result).toMatchObject({ status: 'escalate', reason: 'observation_unavailable_after_settle', steps: 1, elapsedMs: 2000 })
    expect(result.diagnostics?.lastSnapshotFailure).toEqual({ phase: 'settle', code: 'read_timeout' })
    expect(f.ports.act).toHaveBeenCalledTimes(1)
    expect(f.ports.decide).toHaveBeenCalledTimes(1)
  })

  it.each(['stop', 'deadline', 'ownership'])('stops for %s during startup retries', async cause => {
    const f = fixture()
    vi.mocked(f.ports.snapshot).mockResolvedValue(unavailable)
    if (cause === 'deadline') f.ports.deadline = Date.now() + 225
    else setTimeout(() => cause === 'stop' ? f.abort.abort() : f.loseOwnership(), 225)
    const result = await finish(executeBrowserTask(task, f.ports))
    expect(result).toMatchObject({ status: cause === 'deadline' ? 'escalate' : 'cancelled', steps: 0, trace: [] })
    expect(result.elapsedMs).toBeLessThanOrEqual(300)
    expect(f.ports.decide).not.toHaveBeenCalled()
    expect(f.ports.act).not.toHaveBeenCalled()
  })

  it.each([
    { cause: 'deadline timer', deadlineMs: 225, status: 'escalate', reason: 'deadline' },
    { cause: 'earlier user Stop', deadlineMs: 45000, status: 'cancelled', reason: 'user_stopped' },
  ])('classifies the shared controller abort from $cause correctly', async ({ deadlineMs, status, reason }) => {
    const f = fixture()
    f.ports.deadline = Date.now() + deadlineMs
    vi.mocked(f.ports.snapshot).mockImplementation(() => new Promise(() => {}))
    // The relay uses the same AbortController for its task timer and user Stop.
    setTimeout(() => f.abort.abort(), 225)
    const result = await finish(executeBrowserTask(task, f.ports))
    expect(f.abort.signal.aborted).toBe(true)
    expect(result).toMatchObject({ status, reason, elapsedMs: 225, steps: 0, trace: [] })
    expect(f.ports.decide).not.toHaveBeenCalled()
    expect(f.ports.act).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a late successful native read even if its timeout callback has not run', async () => {
    const f = fixture()
    vi.mocked(f.ports.snapshot).mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 2001) // Advance the clock without delivering timers.
      return { ...observation, text: 'Results' }
    })
    const result = await finish(executeBrowserTask(task, f.ports))
    expect(result).toMatchObject({ status: 'escalate', reason: 'browser_observation_unavailable', steps: 0, trace: [] })
    expect(result.url).toBeUndefined()
    expect(result.diagnostics?.lastSnapshotFailure).toEqual({ phase: 'startup', code: 'read_timeout' })
    expect(f.ports.decide).not.toHaveBeenCalled()
    expect(f.ports.act).not.toHaveBeenCalled()
  })

  it.each(['stop', 'deadline', 'ownership'])('does not wait for or apply a late native read after %s', async cause => {
    const f = fixture()
    let resolveRead!: (value: unknown) => void
    vi.mocked(f.ports.snapshot).mockReturnValue(new Promise(resolve => { resolveRead = resolve }))
    if (cause === 'deadline') f.ports.deadline = Date.now() + 225
    else setTimeout(() => cause === 'stop' ? f.abort.abort() : f.loseOwnership(), 225)
    const pending = executeBrowserTask(task, f.ports)
    await vi.advanceTimersByTimeAsync(300)
    const result = await pending
    expect(result).toMatchObject({ status: cause === 'deadline' ? 'escalate' : 'cancelled', steps: 0, trace: [] })
    resolveRead({ ...observation, text: 'Results' })
    await vi.runAllTimersAsync()
    expect(result.url).toBeUndefined()
    expect(f.ports.decide).not.toHaveBeenCalled()
    expect(f.ports.act).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    { ...unavailable, protocol: 'unsupported' }, { error: 'different native error' },
    { ...observation, protocol: 'unsupported' }, { text: 'incomplete snapshot' },
  ])('does not treat malformed protocol evidence as startup: %j', async value => {
    const f = fixture()
    vi.mocked(f.ports.snapshot).mockResolvedValueOnce(value)
    const result = await finish(executeBrowserTask(task, f.ports))
    expect(result).toMatchObject({ status: 'escalate', reason: 'browser_observation_unavailable', elapsedMs: 0 })
    expect(f.ports.snapshot).toHaveBeenCalledTimes(1)
    expect(f.ports.decide).not.toHaveBeenCalled()
  })

  it('records bounded native failure metadata without retaining the native exception', async () => {
    const f = fixture()
    vi.mocked(f.ports.snapshot).mockRejectedValueOnce(new Error('private page content and session token'))
    const result = await finish(executeBrowserTask(task, f.ports))
    expect(result.diagnostics).toMatchObject({ snapshotAttempts: 1, startupRetries: 0,
      lastSnapshotFailure: { phase: 'startup', code: 'native_read_failed' } })
    expect(JSON.stringify(result)).not.toContain('private page content')
    expect(f.ports.decide).not.toHaveBeenCalled()
  })
})
