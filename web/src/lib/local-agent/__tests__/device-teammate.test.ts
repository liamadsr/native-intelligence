/**
 * The device side of the teammate plan (WS-C): the Mac body's teammate tools
 * never make a step line (and so never undo its question to its teammate),
 * the Mac's `pull_request` event keeps the session's pull request (C5), and a
 * claim keeps the Mac's model (C1 narrows the tools by it).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ledger = vi.hoisted(() => ({
  moveTurn: vi.fn(async (_svc: unknown, s: unknown, _move: { type: string; [k: string]: unknown }) => s),
  startTurnRow: vi.fn(async () => 'job-1'),
  nextTurn: vi.fn(async (_svc: unknown, s: unknown) => s),
  turnStatus: vi.fn(async (): Promise<string | null> => 'running'),
}))
vi.mock('../ledger', async (orig) => ({ ...(await orig<typeof import('../ledger')>()), ...ledger }))

import { askTeammate, createSession } from '../store'
import { claimSession, deriveFromEvents, ingestEvents } from '../device'
import { CONV, DEVICE, FOLDER, USER, WS, seeded, type FakeDb } from './fake-db'

const moves = () => ledger.moveTurn.mock.calls.map((c) => c[2])

async function running(db: FakeDb, mode: 'read' | 'edit' = 'edit') {
  const { session } = await createSession(db as never, {
    userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Fix the login bug', mode, startedBy: 'agent',
  })
  const row = db.tables.local_agent_session.find((s) => s.id === session.id)!
  Object.assign(row, { status: 'running', run_id: 'run-1', lease_expires_at: new Date(Date.now() + 60_000).toISOString() })
  ledger.moveTurn.mockClear()
  return { id: session.id, row }
}

beforeEach(() => {
  for (const f of Object.values(ledger)) f.mockClear()
})

describe('the Mac body’s teammate tools on the device stream', () => {
  it('make no step line: a turn of only them beats, other tools step', () => {
    const row = { status: 'running' as const, last_signal: null, last_signal_text: null, error: null }
    const silent = deriveFromEvents(row, [
      { kind: 'tool', payload: { name: 'report_to_person', input: '{"text":"Reading the tests"}' } },
      { kind: 'tool', payload: { name: 'message_teammate', input: '{"text":"Which branch?"}' } },
    ])
    expect(silent.moves).toEqual([{ type: 'beat' }])
    const loud = deriveFromEvents(row, [{ kind: 'tool', payload: { name: 'read_file', input: '{"path":"src/a.ts"}' } }])
    expect(loud.moves).toEqual([{ type: 'step', text: 'Reading src/a.ts' }])
  })

  it('a question to its teammate survives the turn’s own upload, then the end of the turn', async () => {
    const db = seeded()
    const { id, row } = await running(db)
    await askTeammate(db as never, { userId: USER, workspaceId: WS, sessionId: id, text: 'Which branch?', key: 'k1' })
    ledger.moveTurn.mockClear()
    // The upload that carries the call itself (it can land after the server recorded it), then the turn's end.
    await ingestEvents(db as never, USER, id, {
      runId: 'run-1',
      events: [
        { seq: 1, event: { kind: 'tool', callId: 'c1', name: 'message_teammate', input: '{"text":"Which branch?"}' } },
        { seq: 2, event: { kind: 'tool_result', callId: 'c1', name: 'message_teammate', ok: true, output: '{"status":"sent"}' } },
        { seq: 3, event: { kind: 'status', status: 'waiting' } },
      ],
    })
    expect(row).toMatchObject({ status: 'waiting', last_signal: 'ask', last_signal_text: 'Which branch?' })
    // No turn end: the turn stays parked on the question until it's answered.
    expect(moves().filter((m) => m.type !== 'beat')).toEqual([])
  })
})

describe('a finish after its question to its teammate', () => {
  it('keeps the question standing: no turn end, the summary stays in the transcript', () => {
    const row = { status: 'running' as const, last_signal: 'ask' as const, last_signal_text: 'Which branch?', error: null, mode: 'edit' as const }
    const out = deriveFromEvents(row, [
      { kind: 'finish', payload: { summary: 'Asked Native Intelligence which branch; done otherwise.' } },
      { kind: 'status', payload: { status: 'waiting' } },
    ], { serverAsk: true })
    expect(out.patch.last_signal).toBeUndefined()
    expect(out.patch.status).toBe('waiting')
    expect(out.moves).toEqual([])
    expect(out.turnEnded).toBe(false)
  })

  it('a question the Mac asked itself is spent: the next turn it runs (a queued message) finishes and reports', () => {
    const asked = { status: 'waiting' as const, last_signal: 'ask' as const, last_signal_text: 'Which branch?', error: null, mode: 'read' as const }
    const turn = [
      { kind: 'status', payload: { status: 'running' } },
      { kind: 'finish', payload: { summary: 'Read the queued file.' } },
      { kind: 'status', payload: { status: 'waiting' } },
    ]
    const own = deriveFromEvents(asked, turn, { serverAsk: false })
    expect(own.patch).toMatchObject({ last_signal: 'finish', last_signal_text: 'Read the queued file.' })
    expect(own.moves).toEqual([{ type: 'turn_end', summary: 'Read the queued file.', review: false }])
    expect(own.turnEnded).toBe(true)
    // Without the flag (who asked unknown) it reads as the Mac's own.
    expect(deriveFromEvents(asked, turn).moves).toEqual(own.moves)
    // The teammate question, by contrast, outlives the late upload.
    const kept = deriveFromEvents(asked, turn, { serverAsk: true })
    expect(kept.patch.last_signal).toBeUndefined()
    expect(kept.moves).toEqual([])
  })

  it('a device question in the same upload still ends the turn on it; a plain finish still finishes', () => {
    const fresh = { status: 'running' as const, last_signal: null, last_signal_text: null, error: null, mode: 'edit' as const }
    const finished = deriveFromEvents(fresh, [
      { kind: 'finish', payload: { summary: 'Done.' } },
      { kind: 'status', payload: { status: 'waiting' } },
    ])
    expect(finished.moves).toEqual([{ type: 'turn_end', summary: 'Done.', review: true }])
    const asked = deriveFromEvents(fresh, [
      { kind: 'ask', payload: { question: 'Which branch?' } },
      { kind: 'status', payload: { status: 'waiting' } },
    ])
    expect(asked.moves).toEqual([{ type: 'ask', question: 'Which branch?' }])
  })
})

describe('the pull request event (C5)', () => {
  const pr = (extra: Record<string, unknown>) => ({
    kind: 'pull_request', ok: true, branch: 'dial8/native-intelligence-', commit: 'c'.repeat(40), remote: 'origin', base: 'main', url: 'https://github.com/o/r/pull/12', via: 'gh', ...extra,
  })

  it('keeps the URL of its own branch’s pull request, from any run', async () => {
    const db = seeded()
    const { id, row } = await running(db)
    const branch = `dial8/native-intelligence-${id.slice(0, 8)}`
    await ingestEvents(db as never, USER, id, { runId: 'old-run', events: [{ seq: 9, event: pr({ branch }) }] })
    expect(row.pr_url).toBe('https://github.com/o/r/pull/12')
  })

  it('ignores a failed push, another branch, a read job and a URL that isn’t a pull request', async () => {
    for (const [mode, extra] of [
      ['edit', { ok: false, url: undefined, error: 'rejected' }],
      ['edit', { branch: 'dial8/other-12345678' }],
      ['edit', { url: 'https://github.com/o/r/issues/12' }],
      ['edit', { url: 'javascript:alert(1)//github.com/o/r/pull/1' }],
      ['edit', { url: 'https://ghe.corp.example/o/r/pull/1' }],
      ['read', {}],
    ] as const) {
      const db = seeded()
      const { id, row } = await running(db, mode)
      const branch = (extra as { branch?: string }).branch ?? `dial8/native-intelligence-${id.slice(0, 8)}`
      await ingestEvents(db as never, USER, id, { runId: 'run-1', events: [{ seq: 1, event: pr({ ...extra, branch }) }] })
      expect(row.pr_url ?? null, JSON.stringify(extra)).toBeNull()
    }
  })
})

describe('a pull request after the job ended (C5, S4)', () => {
  it('is kept when the person allowed the push before the job ended, and dropped otherwise', async () => {
    const db = seeded()
    const { id, row } = await running(db)
    const branch = `dial8/native-intelligence-${id.slice(0, 8)}`
    const pr = { kind: 'pull_request', ok: true, branch, url: 'https://github.com/o/r/pull/40', via: 'gh' }
    Object.assign(row, { status: 'cancelled' })
    // Never allowed: a settled job keeps nothing.
    expect(await ingestEvents(db as never, USER, id, { runId: 'run-1', events: [{ seq: 50, event: pr as never }] })).toMatchObject({ inserted: 0 })
    expect(row.pr_url ?? null).toBeNull()
    // Allowed before it ended (another chat took the folder mid-push): kept, and nothing else.
    db.tables.local_agent_event.push({ id: 900, session_id: id, user_id: USER, source: 'device', run_id: 'run-1', seq: 40, kind: 'prompt', payload: { kind: 'prompt', id: 'p-1', prompt: 'push', state: 'allowed' }, created_at: new Date().toISOString() })
    const out = await ingestEvents(db as never, USER, id, { runId: 'run-1', events: [{ seq: 51, event: { kind: 'text', delta: 'x' } as never }, { seq: 52, event: pr as never }] })
    expect(out.inserted).toBe(1)
    expect(row.pr_url).toBe('https://github.com/o/r/pull/40')
    expect(row.status).toBe('cancelled')
  })
})

describe('the claim keeps the Mac’s model', () => {
  async function queuedSession(db: FakeDb) {
    const { session } = await createSession(db as never, {
      userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Take a look', mode: 'read', startedBy: 'agent',
    })
    return { id: session.id, row: db.tables.local_agent_session.find((s) => s.id === session.id)! }
  }

  it('records a local model in the claim itself; a relay Mac resets it; an older relay that doesn’t say leaves it', async () => {
    const db = seeded()
    const { id, row } = await queuedSession(db)
    expect(await claimSession(db as never, USER, id, { deviceId: DEVICE, runId: 'p-1', localModel: true })).toMatchObject({ localModel: true })
    expect(row.local_model).toBe(true)
    Object.assign(row, { status: 'queued' })
    expect(await claimSession(db as never, USER, id, { deviceId: DEVICE, runId: 'p-2' })).toMatchObject({ localModel: true })
    expect(row.local_model).toBe(true)
    Object.assign(row, { status: 'queued' })
    await claimSession(db as never, USER, id, { deviceId: DEVICE, runId: 'p-3', localModel: false })
    expect(row.local_model).toBe(false)
  })

  it('fails closed: a local-model claim the server can’t record (no migration 418) is refused, and the job stays queued', async () => {
    const db = seeded()
    const { id, row } = await queuedSession(db)
    const realFrom = db.from
    db.from = ((table: string) => {
      const q = realFrom(table) as Record<string, unknown>
      if (table !== 'local_agent_session') return q
      const update = q.update as (p: Record<string, unknown>) => unknown
      q.update = (p: Record<string, unknown>) => {
        if ('local_model' in p) {
          const fail = { eq: () => fail, is: () => fail, gt: () => fail, select: () => fail, maybeSingle: async () => ({ data: null, error: { message: 'column "local_model" of relation "local_agent_session" does not exist' } }) }
          return fail
        }
        return update(p)
      }
      return q
    }) as typeof db.from
    await expect(claimSession(db as never, USER, id, { deviceId: DEVICE, runId: 'p-1', localModel: true })).rejects.toMatchObject({ code: 'conflict', details: { code: 'LOCAL_MODEL_UNRECORDED' } })
    expect(row.status).toBe('queued')
    // A relay Mac claims as before.
    expect(await claimSession(db as never, USER, id, { deviceId: DEVICE, runId: 'p-2', localModel: false })).not.toBeNull()
    expect(row.status).toBe('starting')
  })
})
