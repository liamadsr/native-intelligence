/**
 * A Mac job an action's Start put on the starter's Mac (environments E2,
 * src/lib/local-agent/unattended.ts startActionMacJob) is unattended like a
 * loop's, with its own key (`local-agent-action:<action>:start:<id>`) and its
 * own words: one agent per folder names it as "one of your actions", the
 * start-agent route finds it as the action's live run, and its key never
 * reads as a loop's or a chat's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: vi.fn() }))
const ledger = vi.hoisted(() => ({
  moveTurn: vi.fn(async (_svc: unknown, s: unknown) => s),
  startTurnRow: vi.fn(async () => 'job-1'),
  turnStatus: vi.fn(async (): Promise<string | null> => 'running'),
}))
vi.mock('../ledger', async (orig) => ({ ...(await orig<typeof import('../ledger')>()), ...ledger }))

import {
  ACTION_JOB_KEY_PREFIX,
  actionJobKey,
  isUnattendedSession,
  liveActionMacJob,
  parseActionJobKey,
  parseUnattendedKey,
  startActionMacJob,
  type UnattendedDeps,
} from '../unattended'
import { FOLDER_BUSY_CODE, createSession, isAttendedSession, isUnattendedKey, requestStop } from '../store'
import { CONV, FOLDER, USER, WS, seeded, type FakeDb } from './fake-db'

const ACTION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OTHER_ACTION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccd'
const deps: UnattendedDeps = { reviewerMode: () => 'default', paused: async () => false, homeThread: async () => CONV }

let db: FakeDb
beforeEach(() => {
  db = seeded()
  for (const f of Object.values(ledger)) f.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const startAction = (actionId = ACTION, startId = 's1') =>
  startActionMacJob(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, request: 'Fix the export', mode: 'edit', origin: { actionId, startId } }, deps)

describe('the key', () => {
  it('round-trips, is unattended, and is never a loop’s or a chat’s', () => {
    const key = actionJobKey({ actionId: ACTION, startId: 's1' })
    expect(key).toBe(`${ACTION_JOB_KEY_PREFIX}${ACTION}:start:s1`)
    expect(parseActionJobKey(key)).toEqual({ actionId: ACTION, startId: 's1' })
    expect(parseUnattendedKey(key)).toBeNull()
    expect(isUnattendedKey(key)).toBe(true)
    expect(isUnattendedSession({ idempotency_key: key })).toBe(true)
    expect(isAttendedSession({ started_by: 'agent', idempotency_key: key })).toBe(false)
    for (const other of [`local-agent:${CONV}:session:s:turn:t:call:c`, 'local-agent-loop:f:step:a:fire:x', `${ACTION_JOB_KEY_PREFIX}not-a-uuid:start:s1`, null]) {
      expect(parseActionJobKey(other), String(other)).toBeNull()
    }
    expect(() => actionJobKey({ actionId: 'ENG-42', startId: 's1' })).toThrow()
    expect(() => actionJobKey({ actionId: ACTION, startId: 'a:b' })).toThrow()
  })
})

describe('one agent per folder, in its own words', () => {
  it('a busy job of the person’s makes an action’s Start skip, saying what to do', async () => {
    await createSession(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Look', mode: 'edit', startedBy: 'person' })
    db.tables.local_agent_session[0].status = 'running'
    const out = await startAction()
    expect(out).toMatchObject({ status: 'skipped', code: 'FOLDER_BUSY' })
    expect((out as { reason: string }).reason).toBe('Native Intelligence is already working in native-intelligence on Liam’s MacBook. Wait for it to finish, or stop it, then press Start again.')
  })

  it('a running action job refuses the person’s start, naming it as one of their actions', async () => {
    await startAction()
    db.tables.local_agent_session[0].status = 'running'
    const refused = createSession(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Look', mode: 'edit', startedBy: 'person' })
    await expect(refused).rejects.toMatchObject({ code: 'conflict', details: { code: FOLDER_BUSY_CODE } })
    await expect(refused).rejects.toThrow(/for one of your actions/)
  })
})

describe('liveActionMacJob', () => {
  it('finds the action’s live job in the workspace (whoever’s Mac), and nothing once it ended', async () => {
    const out = await startAction()
    const sessionId = (out as { session: { id: string } }).session.id
    expect(await liveActionMacJob(db as never, { workspaceId: WS, actionId: ACTION })).toMatchObject({ sessionId, userId: USER, deviceName: 'Liam’s MacBook', folderLabel: 'native-intelligence' })
    expect(await liveActionMacJob(db as never, { workspaceId: WS, actionId: OTHER_ACTION })).toBeNull()
    expect(await liveActionMacJob(db as never, { workspaceId: '44444444-4444-4444-8444-444444444441', actionId: ACTION })).toBeNull()
    expect(await liveActionMacJob(db as never, { workspaceId: WS, actionId: 'not-a-uuid' })).toBeNull()
    await requestStop(db as never, USER, sessionId)
    expect(await liveActionMacJob(db as never, { workspaceId: WS, actionId: ACTION })).toBeNull()
  })
})
