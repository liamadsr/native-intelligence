/**
 * An action-started Mac job keeps its action's agent_run_status in step (the
 * E2 review's S2), in the cloud path's values: `working` from the Start
 * (environments/start.ts), then once the job settles `pr_open` when it opened
 * a pull request, `failed` when it failed, else `idle`; never overwriting a
 * status a later run set. And a pull request links its folder to its repo
 * when none is linked (S3, environments §4).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ledger = vi.hoisted(() => ({
  moveTurn: vi.fn(async (_svc: unknown, s: unknown) => s),
  startTurnRow: vi.fn(async () => 'job-1'),
  nextTurn: vi.fn(async (_svc: unknown, s: unknown) => s),
  turnStatus: vi.fn(async (): Promise<string | null> => 'running'),
}))
vi.mock('../ledger', async (orig) => ({ ...(await orig<typeof import('../ledger')>()), ...ledger }))

import { ackMessage, claimSession, heartbeat, ingestEvents, parseEventUpload, parseHeartbeat, parseStateUpdate, pendingFor, updateState } from '../device'
import { actionIdOfJobKey, actionRunStatusFor, addMessage, createSession, loadSession, recordPullRequest, requestStop, settleActionRunStatus, type DbSession } from '../store'
import { liveActionMacJob } from '../unattended'
import { CONV, DEVICE, FOLDER, USER, WS, seeded, type FakeDb } from './fake-db'

const ACTION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const KEY = `local-agent-action:${ACTION}:start:first`

let db: FakeDb
beforeEach(() => {
  db = seeded({ actions: [{ id: ACTION, workspace_id: WS, agent_run_status: 'working' }] })
  for (const f of Object.values(ledger)) f.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

async function started(key = KEY) {
  const { session } = await createSession(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Fix it', mode: 'edit', startedBy: 'agent', idempotencyKey: key })
  await claimSession(db as never, USER, session.id, { deviceId: DEVICE, runId: 'p1' })
  await updateState(db as never, USER, session.id, parseStateUpdate({ runId: 'r1', previousRunId: 'p1' }))
  return session.id
}
const upload = (seqs: Array<[number, Record<string, unknown>]>) => parseEventUpload({ runId: 'r1', events: seqs.map(([seq, event]) => ({ seq, event })) })
const status = () => db.tables.actions[0].agent_run_status

describe('the action’s run status follows its Mac job', () => {
  it('its turn ends with nothing asked: idle; it asks: still working', async () => {
    const id = await started()
    await ingestEvents(db as never, USER, id, upload([[0, { kind: 'status', status: 'running' }], [1, { kind: 'ask', question: 'Which branch?' }], [2, { kind: 'status', status: 'waiting' }]]))
    expect(status()).toBe('working')
    await ingestEvents(db as never, USER, id, upload([[3, { kind: 'status', status: 'running' }], [4, { kind: 'finish', summary: 'Done' }], [5, { kind: 'status', status: 'completed' }]]))
    expect(db.tables.local_agent_session[0]).toMatchObject({ status: 'waiting' })
    expect(status()).toBe('idle')
  })

  it('it fails: failed; a pull request after its turn ended: pr_open, and its folder is linked to the repo', async () => {
    const id = await started()
    await updateState(db as never, USER, id, parseStateUpdate({ runId: 'r1', status: 'failed', error: 'boom' }))
    expect(status()).toBe('failed')

    db.tables.actions[0].agent_run_status = 'idle'
    expect(await recordPullRequest(db as never, USER, id, 'https://github.com/acme/core/pull/7')).toBe(true)
    expect(status()).toBe('pr_open')
    expect(db.tables.device_folder_setting).toEqual([expect.objectContaining({ device_folder_id: FOLDER, repo_full_name: 'acme/core' })])
  })

  it('stopped before it ran: idle', async () => {
    const { session } = await createSession(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Fix it', mode: 'edit', startedBy: 'agent', idempotencyKey: KEY })
    await requestStop(db as never, USER, session.id)
    expect(status()).toBe('idle')
  })

  it('never overwrites what a later run set, and never touches an action for a job that isn’t an action’s', async () => {
    db.tables.actions[0].agent_run_status = 'pr_open'
    const id = await started()
    await updateState(db as never, USER, id, parseStateUpdate({ runId: 'r1', status: 'failed', error: 'boom' }))
    expect(status()).toBe('pr_open')

    db.tables.actions[0].agent_run_status = 'working'
    const row = { ...db.tables.local_agent_session[0], idempotency_key: `local-agent:${CONV}:session:s:turn:t:call:c`, status: 'failed' } as unknown as DbSession
    await settleActionRunStatus(db as never, null, row)
    expect(status()).toBe('working')
  })

  it('the values, by the job’s state', () => {
    const r = (over: Partial<DbSession>) => ({ status: 'waiting', last_signal: 'finish', pr_url: null, error: null, ...over }) as DbSession
    expect(actionRunStatusFor(r({}))).toBe('idle')
    expect(actionRunStatusFor(r({ last_signal: 'ask' }))).toBeNull()
    expect(actionRunStatusFor(r({ status: 'running' }))).toBeNull()
    expect(actionRunStatusFor(r({ pr_url: 'https://github.com/a/b/pull/1' }))).toBe('pr_open')
    expect(actionRunStatusFor(r({ status: 'failed' }))).toBe('failed')
    expect(actionRunStatusFor(r({ status: 'expired', error: "your Mac didn't pick it up within 15 minutes" }))).toBe('failed')
    expect(actionRunStatusFor(r({ status: 'expired', error: 'it sat idle for 24 hours' }))).toBe('idle')
    expect(actionRunStatusFor(r({ status: 'cancelled' }))).toBe('idle')
    expect(actionIdOfJobKey(KEY)).toBe(ACTION)
    expect(actionIdOfJobKey('local-agent-loop:f:step:a:fire:x')).toBeNull()
  })
})

describe('a pull request links its folder to its repo (S3)', () => {
  it('only when no repo is linked yet, and only a plain owner/repo', async () => {
    const id = await started()
    db.tables.device_folder_setting = [{ device_folder_id: FOLDER, base_branch: 'main', repo_full_name: 'mine/linked' }]
    await recordPullRequest(db as never, USER, id, 'https://github.com/acme/core/pull/7')
    expect(db.tables.device_folder_setting).toEqual([expect.objectContaining({ base_branch: 'main', repo_full_name: 'mine/linked' })])
    db.tables.device_folder_setting[0].repo_full_name = null
    await recordPullRequest(db as never, USER, id, 'https://github.com/acme/core/pull/8')
    expect(db.tables.device_folder_setting).toEqual([expect.objectContaining({ base_branch: 'main', repo_full_name: 'acme/core' })])
  })

  it('a pull request from any job does it (a person’s too)', async () => {
    const { session } = await createSession(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Fix it', mode: 'edit', startedBy: 'person' })
    await recordPullRequest(db as never, USER, session.id, 'https://github.com/acme/site/pull/1')
    expect(db.tables.device_folder_setting).toEqual([expect.objectContaining({ device_folder_id: FOLDER, repo_full_name: 'acme/site' })])
    expect(status()).toBe('working')
  })
})

describe('a job that had settled never settles again (a later run’s `working` stands)', () => {
  // A's job finished its turn (the action reads idle), then a later run took
  // the action (a teammate's cloud run, A's own next Start): `working`.
  async function finishedThenTaken() {
    const id = await started()
    await ingestEvents(db as never, USER, id, upload([[0, { kind: 'status', status: 'running' }], [1, { kind: 'finish', summary: 'Done' }], [2, { kind: 'status', status: 'completed' }]]))
    expect(status()).toBe('idle')
    db.tables.actions[0].agent_run_status = 'working'
    db.tables.agent_run = [{ id: 'cloud-1', workspace_id: WS, action_id: ACTION, status: 'running' }]
    return id
  }

  it('another start taking its folder (endIdle), a stop, the folder removed, the 24-hour reap', async () => {
    let id = await finishedThenTaken()
    await createSession(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Look', mode: 'read', startedBy: 'person' })
    expect(db.tables.local_agent_session[0]).toMatchObject({ id, status: 'cancelled' })
    expect(status()).toBe('working')

    db = seeded({ actions: [{ id: ACTION, workspace_id: WS, agent_run_status: 'working' }] })
    id = await finishedThenTaken()
    await requestStop(db as never, USER, id)
    await ingestEvents(db as never, USER, id, upload([[3, { kind: 'status', status: 'cancelled' }]]))
    expect(db.tables.local_agent_session[0]).toMatchObject({ status: 'cancelled' })
    expect(status()).toBe('working')

    db = seeded({ actions: [{ id: ACTION, workspace_id: WS, agent_run_status: 'working' }] })
    await finishedThenTaken()
    await heartbeat(db as never, USER, parseHeartbeat({ deviceId: DEVICE, name: 'Mac', platform: 'macos', appVersion: '1', grants: [] }))
    expect(db.tables.local_agent_session[0]).toMatchObject({ status: 'cancelled' })
    expect(status()).toBe('working')

    db = seeded({ actions: [{ id: ACTION, workspace_id: WS, agent_run_status: 'working' }] })
    id = await finishedThenTaken()
    db.tables.local_agent_session[0].updated_at = '2026-01-01T00:00:00.000Z'
    await loadSession(db as never, USER, id)
    expect(db.tables.local_agent_session[0]).toMatchObject({ status: 'expired' })
    expect(status()).toBe('working')
  })

  it('a late pull request: idle → pr_open only while no live cloud run or newer action job owns the action', async () => {
    const id = await finishedThenTaken()
    // A cloud run owns it: nothing.
    await recordPullRequest(db as never, USER, id, 'https://github.com/acme/core/pull/7')
    expect(status()).toBe('working')
    db.tables.actions[0].agent_run_status = 'idle'
    await recordPullRequest(db as never, USER, id, 'https://github.com/acme/core/pull/8')
    expect(status()).toBe('idle')
    // The cloud run is done, but a newer action job exists: nothing.
    db.tables.agent_run[0].status = 'completed'
    db.tables.local_agent_session.push({ ...db.tables.local_agent_session[0], id: 'newer', idempotency_key: `local-agent-action:${ACTION}:start:x`, created_at: new Date(Date.now() + 60_000).toISOString() })
    await recordPullRequest(db as never, USER, id, 'https://github.com/acme/core/pull/9')
    expect(status()).toBe('idle')
    db.tables.local_agent_session.pop()
    await recordPullRequest(db as never, USER, id, 'https://github.com/acme/core/pull/10')
    expect(status()).toBe('pr_open')
  })
})

describe('an open push prompt holds the action (isIdle)', () => {
  it('a finished job whose push the Mac is asking about, or still pushing, holds it; once its PR is in, it doesn’t', async () => {
    const id = await started()
    await ingestEvents(db as never, USER, id, upload([[0, { kind: 'status', status: 'running' }], [1, { kind: 'finish', summary: 'Done' }], [2, { kind: 'status', status: 'completed' }]]))
    expect(await liveActionMacJob(db as never, { workspaceId: WS, actionId: ACTION })).toBeNull()
    await ingestEvents(db as never, USER, id, upload([[3, { kind: 'prompt', prompt: 'push', state: 'asking' }]]))
    expect(await liveActionMacJob(db as never, { workspaceId: WS, actionId: ACTION })).toMatchObject({ sessionId: id })
    await ingestEvents(db as never, USER, id, upload([[4, { kind: 'prompt', prompt: 'push', state: 'allowed' }]]))
    expect(await liveActionMacJob(db as never, { workspaceId: WS, actionId: ACTION })).toMatchObject({ sessionId: id })
    await ingestEvents(db as never, USER, id, upload([[5, { kind: 'pull_request', ok: true, url: 'https://github.com/acme/core/pull/7', branch: 'dial8/x' }]]))
    expect(await liveActionMacJob(db as never, { workspaceId: WS, actionId: ACTION })).toBeNull()
  })
})

describe('a joined re-Start the Mac never takes settles the action', () => {
  async function joinedStart() {
    const id = await started()
    await ingestEvents(db as never, USER, id, upload([[0, { kind: 'status', status: 'running' }], [1, { kind: 'finish', summary: 'Done' }], [2, { kind: 'status', status: 'completed' }]]))
    // The re-Start joined it (claimFolder keys the message `start:<its key>`) and marked the action working.
    const { messageId } = await addMessage(db as never, { userId: USER, sessionId: id, author: 'agent', text: 'Again', policy: 'queue', idempotencyKey: `start:local-agent-action:${ACTION}:start:${id}.t1`, refuseAsk: true })
    db.tables.actions[0].agent_run_status = 'working'
    return { id, messageId }
  }

  it('dropped after 15 minutes: idle', async () => {
    const { messageId } = await joinedStart()
    db.tables.local_agent_message.find((m) => m.id === messageId)!.created_at = '2026-01-01T00:00:00.000Z'
    await pendingFor(db as never, USER, DEVICE)
    expect(db.tables.local_agent_message.find((m) => m.id === messageId)).toMatchObject({ status: 'failed' })
    expect(status()).toBe('idle')
  })

  it('its delivery failed: idle; another message’s failure doesn’t settle it', async () => {
    const { id, messageId } = await joinedStart()
    const other = await addMessage(db as never, { userId: USER, sessionId: id, author: 'person', text: 'Also this', policy: 'queue', idempotencyKey: 'person:1' })
    await ackMessage(db as never, USER, other.messageId, { ok: false, error: 'full' })
    expect(status()).toBe('working')
    await ackMessage(db as never, USER, messageId, { ok: false, error: 'full' })
    expect(status()).toBe('idle')
  })
})
