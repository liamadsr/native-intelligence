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
import { CARD_JOBS_PER_MAC_MAX, FOLDER_BUSY_CODE, createSession, isAttendedSession, isUnattendedKey, requestStop } from '../store'
import { CONV, DEVICE, FOLDER, USER, WS, seeded, type FakeDb } from './fake-db'

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

describe('cards side by side in one folder (migration 659)', () => {
  const card = (n: number) => `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, '0')}`
  const live = () => db.tables.local_agent_session.filter((r) => ['queued', 'starting', 'running', 'waiting', 'interrupted'].includes(r.status as string))
  const chatStart = (key?: string) =>
    createSession(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Look', mode: 'edit', startedBy: 'person', ...(key ? { idempotencyKey: key } : {}) })

  it('two cards in one folder both start, each its own job, each recording its action', async () => {
    expect(await startAction(card(1))).toMatchObject({ status: 'started', created: true })
    db.tables.local_agent_session[0].status = 'running'
    expect(await startAction(card(2))).toMatchObject({ status: 'started', created: true })
    expect(live().map((r) => r.action_id)).toEqual([card(1), card(2)])
  })

  it('the same card twice never makes two jobs: the second Start goes to its job', async () => {
    await startAction(card(1), 's1')
    const again = await startAction(card(1), 's2')
    expect(again).toMatchObject({ status: 'started', created: false, joined: true })
    expect(live()).toHaveLength(1)
  })

  it('a chat start with a card working in the folder starts its own (then joins its own), and never touches the card’s', async () => {
    await startAction(card(1))
    db.tables.local_agent_session[0].status = 'running'
    const first = await chatStart('local-agent:c:session:s:turn:t:call:1')
    expect(first.created).toBe(true)
    const second = await chatStart('local-agent:c:session:s:turn:t:call:2')
    expect(second).toMatchObject({ created: false, joined: true, session: { id: first.session.id } })
    expect(db.tables.local_agent_session[0]).toMatchObject({ action_id: card(1), status: 'running' })
    expect(live()).toHaveLength(2)
  })

  it('a card’s Start with a chat job busy in the folder starts beside it (its own worktree)', async () => {
    await chatStart()
    db.tables.local_agent_session[0].status = 'running'
    expect(await startAction(card(1))).toMatchObject({ status: 'started', created: true })
    expect(live()).toHaveLength(2)
  })

  it('an idle card job survives another card’s Start, and a chat start: its follow-ups go on', async () => {
    await startAction(card(1))
    db.tables.local_agent_session[0].status = 'waiting'
    db.tables.local_agent_session[0].last_signal = 'finish'
    ledger.turnStatus.mockResolvedValue('done')
    await startAction(card(2))
    await chatStart()
    expect(db.tables.local_agent_session[0]).toMatchObject({ action_id: card(1), status: 'waiting' })
    expect(live()).toHaveLength(3)
    ledger.turnStatus.mockResolvedValue('running')
  })

  it('a Mac takes at most 6 cards that run or wait for a slot; the next is refused with a sentence; idle ones don’t count', async () => {
    for (let n = 1; n <= CARD_JOBS_PER_MAC_MAX; n++) expect(await startAction(card(n))).toMatchObject({ status: 'started' })
    const full = await startAction(card(7))
    expect(full).toMatchObject({ status: 'skipped', code: 'MAC_FULL' })
    expect((full as { reason: string }).reason).toBe('6 cards are already running or waiting their turn on Liam’s MacBook. Press Start on this one when one of them finishes.')
    // One finishes its turn (idle, parked by the Mac): room again.
    db.tables.local_agent_session[0].status = 'waiting'
    expect(await startAction(card(7))).toMatchObject({ status: 'started' })
  })

  it('in the folder’s lane (chats, loops, a card’s READ job) an idle job ends for another start there, whichever side it is', async () => {
    const READ = '77777777-7777-4777-8777-777777777772'
    db.tables.device_folder.push({ id: READ, user_id: USER, device_id: DEVICE, grant_id: 'g2', label: 'notes', path: '/Users/l/notes', mode: 'read', is_git: false, revoked_at: null })
    await createSession(db as never, { userId: USER, workspaceId: WS, folderId: READ, conversationId: CONV, request: 'Look', mode: 'read', startedBy: 'person' })
    db.tables.local_agent_session[0].status = 'waiting'
    db.tables.local_agent_session[0].last_signal = 'finish'
    ledger.turnStatus.mockResolvedValue('done')
    // An idle chat job gives way to a card's read job…
    const read = await startActionMacJob(db as never, { userId: USER, workspaceId: WS, folderId: READ, request: 'Read it', mode: 'read', origin: { actionId: card(1), startId: 's1' } }, deps)
    expect(read).toMatchObject({ status: 'started', created: true })
    expect(db.tables.local_agent_session[0]).toMatchObject({ status: 'cancelled' })
    // …and an idle card read job to a chat start.
    const readJob = live().find((r) => r.folder_id === READ)!
    readJob.status = 'waiting'
    readJob.last_signal = 'finish'
    const chat = await createSession(db as never, { userId: USER, workspaceId: WS, folderId: READ, conversationId: CONV, request: 'Look again', mode: 'read', startedBy: 'person' })
    expect(chat.created).toBe(true)
    expect(readJob.status).toBe('cancelled')
    ledger.turnStatus.mockResolvedValue('running')
  })

  it('a job really busy in the lane refuses, saying who works there: a card by its identifier', async () => {
    const READ = '77777777-7777-4777-8777-777777777772'
    db.tables.device_folder.push({ id: READ, user_id: USER, device_id: DEVICE, grant_id: 'g2', label: 'notes', path: '/Users/l/notes', mode: 'read', is_git: false, revoked_at: null })
    db.tables.actions = [{ id: card(1), workspace_id: WS, identifier: 'GEN-7' }]
    await startActionMacJob(db as never, { userId: USER, workspaceId: WS, folderId: READ, request: 'Read it', mode: 'read', origin: { actionId: card(1), startId: 's1' } }, deps)
    live()[0].status = 'running'
    const refused = createSession(db as never, { userId: USER, workspaceId: WS, folderId: READ, conversationId: CONV, request: 'Look', mode: 'read', startedBy: 'person' })
    await expect(refused).rejects.toMatchObject({ code: 'conflict', details: { code: FOLDER_BUSY_CODE } })
    await expect(refused).rejects.toThrow(/already working in notes for card GEN-7/)
  })

  /** The jobs started so far, a minute apart in the past (started in one test they share a millisecond, and the order is then by id). */
  const spreadInTime = () =>
    db.tables.local_agent_session.forEach((r, i) => {
      r.created_at = new Date(Date.now() - (60 - i) * 60_000).toISOString()
    })

  it('two Starts at once can’t take a Mac past its ceiling: the one that went over is given back (MAC_FULL)', async () => {
    for (let n = 1; n < CARD_JOBS_PER_MAC_MAX; n++) await startAction(card(n))
    spreadInTime()
    // Another Start lands between this one's count and its insert.
    db.interleave(
      (q) => q.table === 'local_agent_session' && q.op === 'insert' && String((q.values as Array<{ idempotency_key?: string }>)[0]?.idempotency_key).includes(card(20)),
      async () => {
        db.tables.local_agent_session.push({
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', user_id: USER, workspace_id: WS, device_id: DEVICE, folder_id: FOLDER, mode: 'edit', status: 'queued',
          idempotency_key: `local-agent-action:${card(21)}:start:x`, action_id: card(21), created_at: new Date(Date.now() - 1).toISOString(),
        })
      },
    )
    const over = await startAction(card(20))
    expect(over).toMatchObject({ status: 'skipped', code: 'MAC_FULL' })
    const mine = db.tables.local_agent_session.find((r) => r.action_id === card(20))!
    expect(mine).toMatchObject({ status: 'cancelled' })
    expect(live().filter((r) => ['queued', 'starting', 'running', 'interrupted'].includes(r.status as string))).toHaveLength(CARD_JOBS_PER_MAC_MAX)
  })

  it('the give-back never refuses a start the Mac already took: only a cancel that took refuses', async () => {
    for (let n = 1; n < CARD_JOBS_PER_MAC_MAX; n++) await startAction(card(n))
    spreadInTime()
    db.interleave(
      (q) => q.table === 'local_agent_session' && q.op === 'insert' && String((q.values as Array<{ idempotency_key?: string }>)[0]?.idempotency_key).includes(card(20)),
      async () => {
        db.tables.local_agent_session.push({
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', user_id: USER, workspace_id: WS, device_id: DEVICE, folder_id: FOLDER, mode: 'edit', status: 'queued',
          idempotency_key: `local-agent-action:${card(21)}:start:x`, action_id: card(21), created_at: new Date(Date.now() - 1).toISOString(),
        })
      },
    )
    // Between the recount and the cancel, the Mac claims this job.
    db.interleave(
      (q) => q.table === 'local_agent_session' && q.op === 'update' && (q.values as { status?: string }).status === 'cancelled',
      async () => {
        const mine = db.tables.local_agent_session.find((r) => r.action_id === card(20))!
        mine.status = 'starting'
      },
    )
    expect(await startAction(card(20))).toMatchObject({ status: 'started' })
    expect(db.tables.local_agent_session.find((r) => r.action_id === card(20))).toMatchObject({ status: 'starting' })
  })

  it('jobs made in the same instant have one order (created_at, then id): exactly the newest by that order is given back', async () => {
    const SAME = '2026-11-14T10:00:00.000Z'
    for (let n = 1; n < CARD_JOBS_PER_MAC_MAX; n++) await startAction(card(n))
    db.tables.local_agent_session.forEach((r, i) => {
      r.id = `${i + 1}${i + 1}${i + 1}${i + 1}${i + 1}${i + 1}${i + 1}${i + 1}-1111-4111-8111-111111111111`
      r.created_at = SAME
    })
    const race = (newId: string) => {
      db.interleave(
        (q) => {
          const v = (q.values as Array<Record<string, unknown>> | undefined)?.[0]
          if (!(q.table === 'local_agent_session' && q.op === 'insert' && String(v?.idempotency_key).includes(card(20)))) return false
          // This start's row: the same instant, and an id that sorts as given.
          v!.id = newId
          v!.created_at = SAME
          return true
        },
        async () => {
          db.tables.local_agent_session.push({
            id: '99999999-9999-4999-8999-999999999999', user_id: USER, workspace_id: WS, device_id: DEVICE, folder_id: FOLDER, mode: 'edit', status: 'queued',
            idempotency_key: `local-agent-action:${card(21)}:start:x`, action_id: card(21), created_at: SAME,
          })
        },
      )
      return startAction(card(20))
    }
    // Its id sorts after the other start's: it is the one past the ceiling.
    expect(await race('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toMatchObject({ status: 'skipped', code: 'MAC_FULL' })
  })

  it('an idle card job holds no place: a follow-up to it is a message, never a new start, so it is never refused for room', async () => {
    for (let n = 1; n <= CARD_JOBS_PER_MAC_MAX; n++) await startAction(card(n))
    db.tables.local_agent_session[0].status = 'waiting'
    expect(await startAction(card(7))).toMatchObject({ status: 'started' })
    // The idle card takes its follow-up as its next turn (its own Start again).
    db.tables.local_agent_session[0].last_signal = 'finish'
    ledger.turnStatus.mockResolvedValue('done')
    expect(await startAction(card(1), 's2')).toMatchObject({ status: 'started', joined: true })
    ledger.turnStatus.mockResolvedValue('running')
  })

  it('a chat start still keeps one job per folder for chat work, with today’s join', async () => {
    const first = await chatStart('local-agent:c:session:s:turn:t:call:1')
    db.tables.local_agent_session[0].status = 'running'
    const refused = createSession(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', request: 'Look', mode: 'edit', startedBy: 'person' })
    db.tables.chat_conversations.push({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', user_id: USER, workspace_id: WS })
    await expect(refused).rejects.toMatchObject({ code: 'conflict', details: { code: FOLDER_BUSY_CODE } })
    expect(live().map((r) => r.id)).toEqual([first.session.id])
  })
})

describe('before migration 659 (no action_id column, one live job per folder)', () => {
  beforeEach(() => {
    db = seeded({}, { before647: true })
  })

  it('a card starts (without the column), and a second card in the folder is today’s FOLDER_BUSY, naming the first', async () => {
    expect(await startAction(ACTION)).toMatchObject({ status: 'started', created: true })
    expect(db.tables.local_agent_session[0]).not.toHaveProperty('action_id')
    db.tables.local_agent_session[0].status = 'running'
    const busy = await startAction(OTHER_ACTION)
    expect(busy).toMatchObject({ status: 'skipped', code: 'FOLDER_BUSY' })
  })

  it('a chat start with a card working in the folder is refused there, as it always was', async () => {
    await startAction(ACTION)
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
