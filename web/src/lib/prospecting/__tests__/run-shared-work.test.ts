/**
 * The engine's work-ledger hook (Sequence row 6): BaseRunState steps the
 * run's Activity row after every progress write (and phase start), and settles
 * it once, after THE terminal write — never as a step. Without `deps.work` the
 * engine behaves exactly as before (the engine suites run without it).
 */
import { describe, it, expect, vi } from 'vitest'
import { BaseRunState, type RunEngineDeps } from '../run-shared'
import type { ProspectingRunMirror } from '@/lib/work/prospecting-run-mirror'

type Progress = Parameters<ProspectingRunMirror['progress']>[0]
type Settle = Parameters<ProspectingRunMirror['settle']>[0]
const mirror = () => ({
  progress: vi.fn(async (_p: Progress) => {}),
  settle: vi.fn(async (_s: Settle) => {}),
})

function deps(work?: RunEngineDeps['work']) {
  const updates: Record<string, unknown>[] = []
  const chain = { eq: () => chain, then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r) }
  const supabase = {
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        updates.push(patch)
        return chain
      },
    }),
  }
  const d = {
    supabase,
    deepSearch: vi.fn(),
    now: () => new Date('2026-09-26T12:00:00Z'),
    guardUsage: vi.fn(),
    ...(work ? { work } : {}),
  } as unknown as RunEngineDeps
  return { d, updates }
}

const ARGS = { runId: 'pr-1', workspaceId: 'w1', listId: 'l1', userId: 'u1' }

describe('BaseRunState → deps.work', () => {
  it('steps after a progress write and a phase start, and settles once on the terminal write', async () => {
    const work = mirror()
    const { d, updates } = deps(work)
    const state = new BaseRunState(d, ARGS)
    state.progress.round = 2
    state.newEntries = 5

    await state.write({ status: 'running', stage: 'discover' })
    await state.write({})
    expect(work.progress).toHaveBeenCalledTimes(2)
    expect(work.progress.mock.calls[1][0]).toMatchObject({ round: 2 })

    await state.finish('completed', null)
    expect(work.progress).toHaveBeenCalledTimes(2) // the terminal write is not a step
    expect(work.settle).toHaveBeenCalledTimes(1)
    expect(work.settle.mock.calls[0][0]).toMatchObject({ status: 'completed', error: null, newEntries: 5 })
    // The run row was written first.
    expect(updates.at(-1)).toMatchObject({ status: 'completed' })
  })

  it('passes a parked status and its error through', async () => {
    const work = mirror()
    const state = new BaseRunState(deps(work).d, ARGS)
    await state.finish('budget_exhausted', 'run_cap')
    expect(work.settle.mock.calls[0][0]).toMatchObject({ status: 'budget_exhausted', error: 'run_cap' })
  })

  it('without deps.work the writes are unchanged', async () => {
    const { d, updates } = deps()
    const state = new BaseRunState(d, ARGS)
    await state.write({})
    await state.finish('failed', 'boom')
    expect(updates).toHaveLength(2)
  })
})
