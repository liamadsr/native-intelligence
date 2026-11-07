/**
 * cancelInFlightWorkRuns — the autonomy kill switch's fan-out (pre-step 1 of
 * docs/plans/agent-orchestration-product.md). Contract: every in-flight WORK run
 * in the workspace is CAS'd to `canceling` and handed to agentRunCancel by one
 * `agent/run.cancel` event each; a run that settled in the gap loses the CAS and
 * is skipped; an `origins` filter narrows the sweep; nothing in flight → no event.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  send: vi.fn(async (_events: unknown) => ({ ids: [] as string[] })),
}))

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: h.send } }))

const { cancelInFlightWorkRuns, requestWorkspaceAutonomyOff, AUTONOMY_OFF_REASON, WORKSPACE_AUTONOMY_OFF_EVENT } =
  await import('../cancel-workspace-runs')

/**
 * A fake agent_run table: `rows` is what the sweep finds; `liveStatus` per id is
 * what the CAS sees at write time (defaults to the swept status).
 */
function fakeDb(rows: Array<{ id: string; status: string; origin?: string }>, live: Record<string, string> = {}) {
  const filters: Record<string, unknown> = {}
  const flips: string[] = []
  const inFlight = new Set(['queued', 'running', 'needs_input'])
  const from = vi.fn((table: string) => {
    expect(table).toBe('agent_run')
    const select: Record<string, unknown> = {}
    Object.assign(select, {
      select: () => select,
      eq: (col: string, v: unknown) => ((filters[`eq:${col}`] = v), select),
      in: (col: string, v: unknown) => ((filters[`in:${col}`] = v), select),
      then: (resolve: (v: unknown) => void) => {
        const origins = filters['in:origin'] as string[] | undefined
        const found = rows.filter((r) => !origins || origins.includes(r.origin ?? ''))
        resolve({ data: found.map((r) => ({ id: r.id })), error: null })
      },
    })
    // The CAS update chain: update → eq → eq → in → select
    const upd: Record<string, unknown> = {}
    let target: string | null = null
    Object.assign(upd, {
      eq: (col: string, v: unknown) => {
        if (col === 'id') target = v as string
        return upd
      },
      in: () => upd,
      select: async () => {
        const row = rows.find((r) => r.id === target)
        const status = live[target ?? ''] ?? row?.status ?? 'completed'
        const took = inFlight.has(status)
        if (took) flips.push(target!)
        return { data: took ? [{ id: target }] : [], error: null }
      },
    })
    ;(select as { update?: unknown }).update = (patch: Record<string, unknown>) => {
      expect(patch).toEqual({ status: 'canceling' })
      return upd
    }
    return select
  })
  return { client: { from } as never, filters, flips }
}

beforeEach(() => h.send.mockClear())

describe('cancelInFlightWorkRuns', () => {
  it('flips every in-flight work run to canceling and emits one agent/run.cancel per run with the reason', async () => {
    const db = fakeDb([
      { id: 'r-queued', status: 'queued' },
      { id: 'r-running', status: 'running' },
      { id: 'r-parked', status: 'needs_input' },
    ])
    const out = await cancelInFlightWorkRuns(db.client, { workspaceId: 'ws-1' })
    expect(out).toEqual({ requested: ['r-queued', 'r-running', 'r-parked'], skipped: [] })
    expect(db.filters['eq:workspace_id']).toBe('ws-1')
    expect(db.filters['eq:kind']).toBe('workspace')
    expect(db.filters['in:status']).toEqual(['queued', 'running', 'needs_input'])
    expect(db.filters['in:origin']).toBeUndefined()
    expect(h.send).toHaveBeenCalledTimes(1)
    const events = h.send.mock.calls[0][0] as Array<{ name: string; data: Record<string, unknown> }>
    expect(events.map((e) => e.name)).toEqual(['agent/run.cancel', 'agent/run.cancel', 'agent/run.cancel'])
    expect(events[2].data).toEqual({ agent_run_id: 'r-parked', workspace_id: 'ws-1', reason: AUTONOMY_OFF_REASON })
  })

  it('a run that settled between the sweep and the CAS is skipped, not resurrected', async () => {
    const db = fakeDb([{ id: 'r-1', status: 'running' }, { id: 'r-2', status: 'running' }], { 'r-2': 'completed' })
    const out = await cancelInFlightWorkRuns(db.client, { workspaceId: 'ws-1', reason: 'kill switch' })
    expect(out).toEqual({ requested: ['r-1'], skipped: ['r-2'] })
    const events = h.send.mock.calls[0][0] as Array<{ data: Record<string, unknown> }>
    expect(events).toHaveLength(1)
    expect(events[0].data.reason).toBe('kill switch')
  })

  it('origins narrows the sweep to those agent_run.origin values (attempted runs only)', async () => {
    const db = fakeDb([
      { id: 'r-attempt', status: 'running', origin: 'attempt' },
      { id: 'r-human', status: 'running', origin: 'user' },
    ])
    const out = await cancelInFlightWorkRuns(db.client, { workspaceId: 'ws-1', origins: ['attempt'] })
    expect(db.filters['in:origin']).toEqual(['attempt'])
    expect(out.requested).toEqual(['r-attempt'])
  })

  it('nothing in flight → no CAS, no event', async () => {
    const db = fakeDb([])
    const out = await cancelInFlightWorkRuns(db.client, { workspaceId: 'ws-1' })
    expect(out).toEqual({ requested: [], skipped: [] })
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('requestWorkspaceAutonomyOff', () => {
  it('emits the kill-switch event with only the fields given', async () => {
    await requestWorkspaceAutonomyOff({ workspaceId: 'ws-1' })
    expect(h.send).toHaveBeenCalledWith({ name: WORKSPACE_AUTONOMY_OFF_EVENT, data: { workspace_id: 'ws-1' } })
    await requestWorkspaceAutonomyOff({ workspaceId: 'ws-1', reason: 'off', origins: ['attempt'] })
    expect(h.send).toHaveBeenLastCalledWith({
      name: 'workspace/autonomy.off',
      data: { workspace_id: 'ws-1', reason: 'off', origins: ['attempt'] },
    })
  })
})
