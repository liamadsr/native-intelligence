/**
 * steer-ledger: how a steer reads in a helper's history, and how the watcher
 * tells which steers reached the turn (applied) and which are orphans.
 */
import { describe, expect, it, vi } from 'vitest'
import { listUnappliedSteers, markSteersApplied, renderSteerMessage, settleSteersAtBoundary, steerSeenIn, STEER_PREFIX } from '../steer-ledger'

function relayDb(rows: Array<Record<string, unknown>>, opts: { readError?: string; taken?: string[] } = {}) {
  const taken = new Set(opts.taken ?? [])
  const filters: Array<[string, string, unknown]> = []
  const updates: Array<{ patch: Record<string, unknown>; filters: Array<[string, string, unknown]> }> = []
  const from = vi.fn(() => {
    const local: Array<[string, string, unknown]> = []
    let patch: Record<string, unknown> | null = null
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (c: string, v: unknown) => (local.push(['eq', c, v]), chain),
      is: (c: string, v: unknown) => (local.push(['is', c, v]), chain),
      in: (c: string, v: unknown) => (local.push(['in', c, v]), chain),
      order: () => chain,
      update: (p: Record<string, unknown>) => ((patch = p), chain),
      limit: async () => {
        filters.push(...local)
        return opts.readError ? { data: null, error: { message: opts.readError } } : { data: rows, error: null }
      },
      then: (r: (x: unknown) => unknown) => {
        if (patch) updates.push({ patch, filters: [...local] })
        // The compare-and-set answers the rows it stamped: the ids named, minus any already taken.
        const named = (local.find(([op, c]) => op === 'in' && c === 'id')?.[2] as string[] | undefined) ?? []
        return Promise.resolve({ data: named.filter((id) => !taken.has(id)).map((id) => ({ id })), error: null }).then(r)
      },
    }
    return chain
  })
  return { client: { from } as never, filters, updates }
}

describe('the steer as its history reads', () => {
  it('"You → …" from the person, "Your agent, for you → …" relayed from the main chat', () => {
    expect(renderSteerMessage('  stick to fintech ', 'person')).toBe('You → stick to fintech')
    expect(renderSteerMessage('stick to fintech', 'agent')).toBe('Your agent, for you → stick to fintech')
    expect(STEER_PREFIX).toEqual({ person: 'You →', agent: 'Your agent, for you →' })
  })

  it('a received message carries a steer only with its prefix (folded steers too), never a bare substring', () => {
    expect(steerSeenIn('Your agent, for you → stick to fintech', 'stick to fintech')).toBe(true)
    expect(steerSeenIn('You → shorter\n\nYour agent, for you → stick to fintech', 'stick to fintech')).toBe(true)
    expect(steerSeenIn('You → stick to fintech', 'stick to fintech')).toBe(true)
    // The kickoff brief happening to contain the words is not the steer.
    expect(steerSeenIn('{"task":"research and stick to fintech"}', 'stick to fintech')).toBe(false)
    expect(steerSeenIn('anything', '   ')).toBe(false)
  })
})

describe('the watcher\'s ledger', () => {
  it('lists a run\'s unapplied steers that reached or are reaching eve, fenced on the run and workspace', async () => {
    const db = relayDb([{ id: 'r1', message: 'fintech only' }, { id: 7, message: 'junk' }])
    expect(await listUnappliedSteers(db.client, { agentRunId: 'run-1', workspaceId: 'ws-1' })).toEqual([{ id: 'r1', message: 'fintech only' }])
    expect(db.filters).toEqual([
      ['eq', 'agent_run_id', 'run-1'],
      ['eq', 'workspace_id', 'ws-1'],
      ['eq', 'mode', 'steer'],
      ['is', 'applied_at', null],
      ['in', 'status', ['running', 'done']],
    ])
  })

  it('a failed read is "no steers" (the turn classifies as before)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await listUnappliedSteers(relayDb([], { readError: 'boom' }).client, { agentRunId: 'run-1', workspaceId: 'ws-1' })).toEqual([])
  })

  it('at a boundary: the steers the turn received are marked applied; the rest come back as orphans', async () => {
    const db = relayDb([{ id: 'r1', message: 'fintech only' }, { id: 'r2', message: 'three pages max' }])
    const orphans = await settleSteersAtBoundary(db.client, {
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      receivedMessages: ['{"task":"brief"}', 'Your agent, for you → fintech only'],
    })
    expect(orphans).toEqual([{ id: 'r2', message: 'three pages max' }])
    expect(db.updates).toHaveLength(1)
    expect(db.updates[0].patch).toHaveProperty('applied_at')
    expect(db.updates[0].filters).toEqual(expect.arrayContaining([['in', 'id', ['r1']], ['eq', 'mode', 'steer'], ['is', 'applied_at', null], ['eq', 'agent_run_id', 'run-1']]))
  })

  it('marking is a claim: it answers only the ids this call stamped', async () => {
    const db = relayDb([], { taken: ['r2'] })
    expect(await markSteersApplied(db.client, { agentRunId: 'run-1', workspaceId: 'ws-1', ids: ['r1', 'r2'] })).toEqual(['r1'])
  })

  it('marking nothing writes nothing', async () => {
    const db = relayDb([])
    await markSteersApplied(db.client, { agentRunId: 'run-1', workspaceId: 'ws-1', ids: [] })
    expect(db.updates).toEqual([])
    expect(await settleSteersAtBoundary(db.client, { agentRunId: 'run-1', workspaceId: 'ws-1', receivedMessages: [] })).toEqual([])
  })
})
