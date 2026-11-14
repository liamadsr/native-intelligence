/**
 * The Mac's own line for a free slot (board step 2, migration 659's
 * mac_queued_at): the Mac runs 3 jobs at once and now holds further starts
 * in line, reporting them `queued` (status `starting`, `live`). A claimed job
 * waiting there stays alive while the Mac keeps reporting it (its lease is
 * renewed by the heartbeat), is never claimed twice, reads "queued" (the
 * session and its ledger row), and after six hours in the line is asked to
 * stop with a sentence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ledger = vi.hoisted(() => ({
  moveTurn: vi.fn(async (_svc: unknown, s: unknown) => s),
  startTurnRow: vi.fn(async () => 'job-1'),
}))
vi.mock('server-only', () => ({}))
vi.mock('../ledger', async (orig) => ({ ...(await orig<typeof import('../ledger')>()), ...ledger }))

import { MAC_LINE_MAX_MS, claimSession, macLineMaxMs, heartbeat, macLineTimeoutReason, parseHeartbeat, parseStateUpdate, updateState } from '../device'
import { QUEUE_DROPPED } from '../relay-core'
import { actionJobKey } from '../unattended'
import { createSession, getSession, staleness, toSessionRow, type DbSession } from '../store'
import { CONV, DEVICE, FOLDER, USER, WS, seeded, type FakeDb } from './fake-db'

let db: FakeDb
beforeEach(() => {
  db = seeded()
  ledger.moveTurn.mockClear()
})

const beat = (queuedJobIds: string[] | undefined, liveJobIds: string[]) =>
  parseHeartbeat({
    deviceId: DEVICE,
    name: 'Studio Mac',
    platform: 'macos',
    appVersion: '0.3.2',
    grants: [{ grantId: 'g1', label: 'native-intelligence', path: '/p', mode: 'edit', isGit: true }],
    liveJobIds,
    ...(queuedJobIds ? { queuedJobIds } : {}),
  })

async function claimed(): Promise<string> {
  const { session } = await createSession(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Do it', mode: 'edit', startedBy: 'person' })
  expect(await claimSession(db as never, USER, session.id, { deviceId: DEVICE, runId: 'p1', workers: true })).not.toBeNull()
  return session.id
}
const row = (id: string) => db.tables.local_agent_session.find((r) => r.id === id)!

describe('a job waiting in the Mac’s line', () => {
  it('reads "queued" while the Mac reports it, its ledger row left queued (no step at the claim), and clears when it begins', async () => {
    const id = await claimed()
    expect(ledger.moveTurn).not.toHaveBeenCalled()
    await heartbeat(db as never, USER, beat([id], [id]))
    expect(row(id).mac_queued_at).toEqual(expect.any(String))
    expect(toSessionRow(row(id) as unknown as DbSession).queuedOnMac).toBe(true)
    // It began: the Mac no longer lists it in its line.
    await heartbeat(db as never, USER, beat([], [id]))
    expect(row(id).mac_queued_at).toBeNull()
    expect(toSessionRow(row(id) as unknown as DbSession)).not.toHaveProperty('queuedOnMac')
  })

  it('stays alive while the Mac reports it: the heartbeat renews its lease, so it is never reaped or re-claimed', async () => {
    const id = await claimed()
    // The lease is about to lapse (the claim's 2 minutes, long gone by the wall clock of a long wait).
    row(id).lease_expires_at = new Date(Date.now() + 1_000).toISOString()
    await heartbeat(db as never, USER, beat([id], [id]))
    expect(Date.parse(row(id).lease_expires_at as string)).toBeGreaterThan(Date.now() + 60_000)
    expect(staleness(row(id) as never)).toBeNull()
    expect((await getSession(db as never, USER, id))?.status).toBe('starting')
    // Never claimed again: the claim takes only a queued session.
    expect(await claimSession(db as never, USER, id, { deviceId: DEVICE, runId: 'p2', workers: true })).toBeNull()
  })

  it('after six hours in the Mac’s line it is asked to stop, with the reason', async () => {
    const id = await claimed()
    await heartbeat(db as never, USER, beat([id], [id]))
    row(id).mac_queued_at = new Date(Date.now() - MAC_LINE_MAX_MS - 60_000).toISOString()
    await heartbeat(db as never, USER, beat([id], [id]))
    expect(row(id).stop_requested_at).toEqual(expect.any(String))
    expect(row(id).error).toBe(macLineTimeoutReason('Studio Mac'))
  })

  it('a loop’s fire keeps its own 15 minutes in the Mac’s line; a person’s start six hours', async () => {
    expect(macLineMaxMs('local-agent-loop:f:step:a:fire:x')).toBe(15 * 60_000)
    expect(macLineMaxMs('local-agent-action:cccccccc-cccc-4ccc-8ccc-cccccccccccc:start:first')).toBe(MAC_LINE_MAX_MS)
    expect(macLineMaxMs(null)).toBe(MAC_LINE_MAX_MS)
    const { session } = await createSession(db as never, {
      userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Check the build', mode: 'read', startedBy: 'agent',
      idempotencyKey: 'local-agent-loop:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee:step:cccccccc-cccc-4ccc-8ccc-cccccccccccc:fire:f1',
    })
    await claimSession(db as never, USER, session.id, { deviceId: DEVICE, runId: 'p1', workers: true })
    await heartbeat(db as never, USER, beat([session.id], [session.id]))
    row(session.id).mac_queued_at = new Date(Date.now() - 16 * 60_000).toISOString()
    await heartbeat(db as never, USER, beat([session.id], [session.id]))
    expect(row(session.id).stop_requested_at).toEqual(expect.any(String))
    expect(row(session.id).error).toBe('It waited 15 minutes for a free slot on Studio Mac, so it was stopped. Press Start again when the Mac has room.')
  })

  it('an older relay (no queuedJobIds) changes nothing', async () => {
    const id = await claimed()
    await heartbeat(db as never, USER, beat([id], [id]))
    await heartbeat(db as never, USER, beat(undefined, [id]))
    expect(row(id).mac_queued_at).toEqual(expect.any(String))
  })
})

describe('a card stopped while it waits in the Mac’s line', () => {
  it('ends cancelled with the Mac’s sentence (not failed), and the card goes back to idle', async () => {
    const ACTION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    db.tables.actions = [{ id: ACTION, workspace_id: WS, agent_run_status: 'working' }]
    const { session } = await createSession(db as never, {
      userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Fix it', mode: 'edit', startedBy: 'agent',
      idempotencyKey: actionJobKey({ actionId: ACTION, startId: 'first' }),
    })
    await claimSession(db as never, USER, session.id, { deviceId: DEVICE, runId: 'p1', workers: true })
    await heartbeat(db as never, USER, beat([session.id], [session.id]))
    await updateState(db as never, USER, session.id, parseStateUpdate({ runId: 'p1', status: 'cancelled', error: QUEUE_DROPPED }))
    expect(row(session.id)).toMatchObject({ status: 'cancelled', error: QUEUE_DROPPED })
    expect(db.tables.actions[0].agent_run_status).toBe('idle')
  })
})
