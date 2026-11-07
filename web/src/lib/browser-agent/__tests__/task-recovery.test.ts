import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeBrowserTask, type TaskExecutorPorts } from '../task-executor'
import type { BrowserObservation } from '../task-contract'

const task = { goal: 'Find Berlin', bindings: [{ name: 'City', value: 'Berlin' }], completion: [{ kind: 'text', value: 'Results for Berlin' }] }
const observation: BrowserObservation = {
  protocol: 'dial8-browser-decision-v1', documentId: 'doc', observationId: 1, interactionEpoch: 0, observedAt: 1,
  url: 'https://example.com/', title: 'Cities', text: 'Search', readyState: 'complete',
  elements: [{ ref: 'e1', role: 'textbox', name: 'City', value: '', canType: true, disabled: false, sensitive: false, forbidden: false, context: '', destination: '' }],
}
function fixture() {
  const abort = new AbortController()
  let current = structuredClone(observation), id = 0
  const ports: TaskExecutorPorts = {
    signal: abort.signal, deadline: Date.now() + 45000, alive: () => true, blockedSites: () => [], approve: async () => false,
    navigate: async () => {},
    snapshot: vi.fn(async () => ({ ...current, observationId: ++id, observedAt: Date.now() })),
    act: vi.fn(async () => ({ ok: true })),
    decide: vi.fn<TaskExecutorPorts['decide']>(async () => ({ decision: { status: 'escalate', reason: 'uncertain' }, deadline: Date.now() + 45000 })),
  }
  return { ports, abort, set: (next: Partial<BrowserObservation>) => { current = { ...current, ...next } } }
}
async function run(p: TaskExecutorPorts, overrides = {}) {
  const promise = executeBrowserTask({ ...task, ...overrides }, p)
  await vi.runAllTimersAsync()
  return promise
}
const accepted = (operation: 'done' | 'type' | 'click' | 'escalate') => ({ decision: { status: 'accepted' as const,
  value: operation === 'type' ? { operation, ref: 'e1', binding: 0 } as const : operation === 'click' ?
    { operation, ref: 'e1' } as const : { operation }, inferenceId: 'id', version: 'v' }, deadline: Date.now() + 45000 })

describe('local browser recovery', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('waits for delayed results then verifies inside the same task, without replaying a write', async () => {
    const f = fixture()
    vi.mocked(f.ports.decide).mockImplementationOnce(async () => accepted('type'))
      .mockImplementationOnce(async () => {
        setTimeout(() => f.set({ text: 'Results for Berlin' }), 150)
        return { decision: { status: 'escalate', reason: 'uncertain' }, deadline: f.ports.deadline }
      }).mockImplementationOnce(async () => accepted('done'))
    const result = await run(f.ports)
    expect(result).toMatchObject({ status: 'verified', steps: 1 })
    expect(result.trace.map(t => t.operation)).toEqual(['type', 'escalate', 'done'])
    expect(result.trace[1].recovery).toBe('page_changed')
    expect(f.ports.act).toHaveBeenCalledTimes(1)
    expect(vi.mocked(f.ports.decide).mock.calls.map(c => c[1])).toEqual([0, 1, 2])
    expect(vi.mocked(f.ports.decide).mock.calls[1][2]).toEqual(['Filled textbox "City" with binding 0.'])
  })

  it('settles autocomplete locally before buying another decision', async () => {
    const f = fixture()
    vi.mocked(f.ports.act).mockImplementation(async () => {
      f.set({ elements: [{ ...observation.elements[0], value: 'Berlin' }] })
      setTimeout(() => f.set({ text: 'Results for Berlin' }), 150)
      return { ok: true }
    })
    vi.mocked(f.ports.decide).mockImplementationOnce(async () => accepted('type')).mockImplementation(async obs => {
      expect(obs.text).toBe('Results for Berlin')
      return accepted('done')
    })
    expect(await run(f.ports)).toMatchObject({ status: 'verified', steps: 1 })
    expect(f.ports.decide).toHaveBeenCalledTimes(2)
  })

  it('retries read failures during acknowledged navigation and decides only on the new document', async () => {
    const f = fixture()
    vi.mocked(f.ports.act).mockImplementation(async () => {
      f.set({ documentId: 'new-document', url: 'https://example.com/results', text: 'Results for Berlin' })
      vi.mocked(f.ports.snapshot).mockRejectedValueOnce(new Error('document replaced'))
        .mockRejectedValueOnce(new Error('new runtime not ready'))
      return { ok: true }
    })
    vi.mocked(f.ports.decide).mockImplementationOnce(async () => accepted('click')).mockImplementation(async obs => {
      expect(obs.documentId).toBe('new-document')
      expect(obs.url).toBe('https://example.com/results')
      return accepted('done')
    })
    const result = await run(f.ports)
    expect(result).toMatchObject({ status: 'verified', steps: 1 })
    expect(f.ports.act).toHaveBeenCalledTimes(1)
    expect(f.ports.decide).toHaveBeenCalledTimes(2)
    expect(result.timings.settlingMs).toBeLessThanOrEqual(700)
  })

  it('bounds persistent read failure without replaying the acknowledged write or reusing its old observation', async () => {
    const f = fixture()
    vi.mocked(f.ports.decide).mockImplementation(async () => accepted('click'))
    vi.mocked(f.ports.act).mockImplementation(async () => {
      vi.mocked(f.ports.snapshot).mockRejectedValue(new Error('document unavailable'))
      return { ok: true }
    })
    const result = await run(f.ports)
    expect(result).toMatchObject({ status: 'escalate', reason: 'observation_unavailable_after_settle', elapsedMs: 700 })
    expect(f.ports.act).toHaveBeenCalledTimes(1)
    expect(f.ports.decide).toHaveBeenCalledTimes(1)
  })

  it('requires a fresh successful read after the last failure even if an earlier read matched completion', async () => {
    const f = fixture()
    vi.mocked(f.ports.decide).mockImplementation(async () => accepted('click'))
    vi.mocked(f.ports.act).mockImplementation(async () => {
      vi.mocked(f.ports.snapshot).mockResolvedValueOnce({ ...observation, text: 'Results for Berlin' })
        .mockRejectedValue(new Error('next navigation replaced the document'))
      return { ok: true }
    })
    expect(await run(f.ports)).toMatchObject({ status: 'escalate', reason: 'observation_unavailable_after_settle' })
    expect(f.ports.decide).toHaveBeenCalledTimes(1)
    expect(f.ports.act).toHaveBeenCalledTimes(1)
  })

  it.each(['stop', 'deadline', 'ownership'] as const)('stops for %s during read recovery before making another decision', async cause => {
    const f = fixture()
    let alive = true
    f.ports.alive = () => alive
    if (cause === 'deadline') f.ports.deadline = Date.now() + 125
    vi.mocked(f.ports.decide).mockImplementation(async () => accepted('click'))
    vi.mocked(f.ports.act).mockImplementation(async () => {
      vi.mocked(f.ports.snapshot).mockRejectedValue(new Error('document replaced'))
      if (cause === 'stop') setTimeout(() => f.abort.abort(), 125)
      if (cause === 'ownership') setTimeout(() => { alive = false }, 125)
      return { ok: true }
    })
    // Running out of time is unfinished work, not a user cancellation.
    expect(await run(f.ports)).toMatchObject(cause === 'deadline' ? { status: 'escalate', reason: 'deadline' } : { status: 'cancelled' })
    expect(f.ports.act).toHaveBeenCalledTimes(1)
    expect(f.ports.decide).toHaveBeenCalledTimes(1)
  })

  it('does not mistake new snapshot IDs or timestamps for progress', async () => {
    const f = fixture()
    expect(await run(f.ports)).toMatchObject({ status: 'escalate', reason: 'uncertain' })
    expect(f.ports.decide).toHaveBeenCalledTimes(1)
    expect(f.ports.act).not.toHaveBeenCalled()
    expect(f.ports.snapshot).toHaveBeenCalled()
  })

  it('caps changing-page recovery at two extra decisions', async () => {
    const f = fixture()
    let decisions = 0
    vi.mocked(f.ports.decide).mockImplementation(async () => {
      setTimeout(() => f.set({ title: `Updated ${++decisions}` }), 50)
      return accepted('escalate')
    })
    expect(await run(f.ports)).toMatchObject({ status: 'escalate', reason: 'planner_review_required' })
    expect(f.ports.decide).toHaveBeenCalledTimes(3)
    expect(f.ports.act).not.toHaveBeenCalled()
  })

  it('stops during recovery and respects the task decision budget', async () => {
    const f = fixture()
    setTimeout(() => f.abort.abort(), 120)
    expect(await run(f.ports)).toMatchObject({ status: 'cancelled' })
    expect(f.ports.decide).toHaveBeenCalledTimes(1)
    const limited = fixture()
    vi.mocked(limited.ports.decide).mockImplementation(async () => {
      limited.set({ text: 'Results for Berlin' })
      return { decision: { status: 'escalate', reason: 'uncertain' }, deadline: limited.ports.deadline }
    })
    expect(await run(limited.ports, { maxSteps: 1 })).toMatchObject({ status: 'escalate' })
    expect(limited.ports.decide).toHaveBeenCalledTimes(1)
  })

  it('reports deadline as unfinished and tab ownership loss during recovery as cancellation', async () => {
    const deadline = fixture()
    deadline.ports.deadline = Date.now() + 100
    expect(await run(deadline.ports)).toMatchObject({ status: 'escalate', reason: 'deadline' })
    expect(deadline.ports.decide).toHaveBeenCalledTimes(1)
    const ownership = fixture()
    let alive = true
    ownership.ports.alive = () => alive
    setTimeout(() => { alive = false }, 100)
    expect(await run(ownership.ports)).toMatchObject({ status: 'cancelled', reason: 'stopped_or_deadline' })
    expect(ownership.ports.act).not.toHaveBeenCalled()
  })

  it('does not retry service/budget failures even when the page changes', async () => {
    const f = fixture()
    vi.mocked(f.ports.decide).mockImplementation(async () => {
      f.set({ text: 'Results for Berlin' })
      return { decision: { status: 'escalate', reason: 'budget_unavailable' }, deadline: f.ports.deadline }
    })
    expect(await run(f.ports)).toMatchObject({ status: 'escalate', reason: 'budget_unavailable' })
    expect(f.ports.decide).toHaveBeenCalledTimes(1)
  })

  it('never repeats a write with an unknown outcome even if completion text appears', async () => {
    const f = fixture()
    vi.mocked(f.ports.decide).mockImplementation(async () => accepted('type'))
    vi.mocked(f.ports.act).mockImplementation(async () => {
      f.set({ text: 'Results for Berlin' })
      throw new Error('response lost')
    })
    expect(await run(f.ports)).toMatchObject({ status: 'escalate', evidence: 'Results for Berlin' })
    expect(f.ports.act).toHaveBeenCalledTimes(1)
    expect(f.ports.decide).toHaveBeenCalledTimes(1)
  })

  it('keeps a lost decision response as an unknown-usage attempt', async () => {
    const f = fixture()
    vi.mocked(f.ports.decide).mockRejectedValue(new Error('response lost after inference'))
    const result = await run(f.ports)
    expect(result).toMatchObject({ status: 'escalate', trace: [{ step: 0, operation: 'unavailable' }] })
    expect(result.trace[0].metrics).toBeUndefined()
    expect(f.ports.act).not.toHaveBeenCalled()
  })

  it('does not report success if ownership is lost during the final verification', async () => {
    const f = fixture()
    f.set({ text: 'Results for Berlin' })
    let live = true
    f.ports.alive = () => live
    vi.mocked(f.ports.decide).mockImplementation(async () => {
      const read = f.ports.snapshot
      f.ports.snapshot = async () => { live = false; return read() }
      return accepted('done')
    })
    expect(await run(f.ports)).toMatchObject({ status: 'cancelled', reason: 'stopped_or_deadline' })
    expect(f.ports.act).not.toHaveBeenCalled()
  })

  it('requires a fresh semantic DONE after the page changes during final verification', async () => {
    const f = fixture()
    f.set({ text: 'Results for Berlin', title: 'Completed result' })
    vi.mocked(f.ports.decide).mockImplementationOnce(async () => {
      f.set({ title: 'Results after hydration' })
      return accepted('done')
    }).mockImplementationOnce(async fresh => {
      expect(fresh.title).toBe('Results after hydration')
      return accepted('done')
    })
    const result = await run(f.ports)
    expect(result).toMatchObject({ status: 'verified', steps: 0 })
    expect(result.trace.map(entry => entry.operation)).toEqual(['done', 'done'])
    expect(result.trace[0].recovery).toBe('page_changed')
    expect(f.ports.decide).toHaveBeenCalledTimes(2)
    expect(f.ports.act).not.toHaveBeenCalled()
  })

  it('never upgrades a stale DONE when the new decision is uncertain', async () => {
    const f = fixture()
    f.set({ text: 'Results for Berlin' })
    vi.mocked(f.ports.decide).mockImplementationOnce(async () => {
      f.set({ title: 'Different page with the same completion text' })
      return accepted('done')
    })
    expect(await run(f.ports)).toMatchObject({ status: 'escalate', reason: 'uncertain' })
    expect(f.ports.decide).toHaveBeenCalledTimes(2)
    expect(f.ports.act).not.toHaveBeenCalled()
  })

  it('does not buy another DONE for unchanged failing predicates', async () => {
    const f = fixture()
    vi.mocked(f.ports.decide).mockImplementation(async () => accepted('done'))
    expect(await run(f.ports)).toMatchObject({ status: 'escalate', reason: 'completion_changed' })
    expect(f.ports.decide).toHaveBeenCalledTimes(1)
    expect(f.ports.act).not.toHaveBeenCalled()
  })

  it('bounds repeated DONE invalidations with the same recovery budget used by uncertainty', async () => {
    const f = fixture()
    f.set({ text: 'Results for Berlin' })
    let decisions = 0
    vi.mocked(f.ports.decide).mockImplementation(async () => {
      f.set({ title: `Changed page ${++decisions}` })
      return decisions === 1 ? { decision: { status: 'escalate', reason: 'uncertain' }, deadline: f.ports.deadline } : accepted('done')
    })
    const result = await run(f.ports)
    expect(result).toMatchObject({ status: 'escalate', reason: 'completion_changed' })
    expect(result.trace.map(entry => entry.operation)).toEqual(['escalate', 'done', 'done'])
    expect(result.trace.filter(entry => entry.recovery === 'page_changed')).toHaveLength(2)
    expect(f.ports.decide).toHaveBeenCalledTimes(3)
    expect(f.ports.act).not.toHaveBeenCalled()
  })

  it('keeps the task decision cap when DONE is invalidated', async () => {
    const f = fixture()
    f.set({ text: 'Results for Berlin' })
    vi.mocked(f.ports.decide).mockImplementation(async () => {
      f.set({ title: 'Hydrated result' })
      return accepted('done')
    })
    expect(await run(f.ports, { maxSteps: 1 })).toMatchObject({ status: 'escalate', reason: 'completion_changed' })
    expect(f.ports.decide).toHaveBeenCalledTimes(1)
    expect(f.ports.act).not.toHaveBeenCalled()
  })

  it.each(['stop', 'deadline'] as const)('does not buy another DONE after %s during completion recovery', async cause => {
    const f = fixture()
    f.set({ text: 'Results for Berlin' })
    if (cause === 'deadline') f.ports.deadline = Date.now() + 50
    vi.mocked(f.ports.decide).mockImplementation(async () => {
      f.set({ title: 'Hydrated result' })
      if (cause === 'stop') setTimeout(() => f.abort.abort(), 50)
      return accepted('done')
    })
    expect(await run(f.ports)).toMatchObject(cause === 'deadline' ? { status: 'escalate', reason: 'deadline' } : { status: 'cancelled' })
    expect(f.ports.decide).toHaveBeenCalledTimes(1)
    expect(f.ports.act).not.toHaveBeenCalled()
  })
})
