/**
 * A job a person started from a card on their Mac moves the card itself
 * (agent-finish.ts moveCardForRun, the one path cloud runs' merge shares):
 * it begins → out of Backlog / Todo; its pull request opens → linked to the
 * card as a cloud run's is, and the card to review. Each as the person's
 * agent, never over a move they made by hand since the Start.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: vi.fn() }))
const ledger = vi.hoisted(() => ({
  moveTurn: vi.fn(async (_svc: unknown, s: unknown) => s),
  startTurnRow: vi.fn(async () => 'job-1'),
  nextTurn: vi.fn(async (_svc: unknown, s: unknown) => s),
  turnStatus: vi.fn(async (): Promise<string | null> => 'running'),
}))
vi.mock('../ledger', async (orig) => ({ ...(await orig<typeof import('../ledger')>()), ...ledger }))
const send = vi.hoisted(() => vi.fn(async (_p: unknown) => undefined))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send } }))
vi.mock('@/lib/notifications', () => ({ createNotification: vi.fn(async () => undefined) }))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))
// The person's agent's client: the same fake, so the test sees what it wrote.
const writer = vi.hoisted(() => ({ db: null as unknown, forUser: vi.fn() }))
vi.mock('@/lib/actions/agent-writer', () => ({
  agentWriterFor: (userId: string) => {
    writer.forUser(userId)
    return writer.db
  },
}))

// The pull request's present state on GitHub (lib/github/pr-metadata.ts): null unless a test says.
const prMeta = vi.hoisted(() => ({ fetch: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) }))
vi.mock('@/lib/github/pr-metadata', () => ({ fetchPrMetadata: prMeta.fetch }))

import { claimSession, ingestEvents, parseEventUpload, parseStateUpdate, updateState } from '../device'
import { recordPullRequest } from '../store'
import { startActionMacJob, type UnattendedDeps } from '../unattended'
import { createSession } from '../store'
import { CONV, DEVICE, FOLDER, USER, WS, seeded, type FakeDb } from './fake-db'

const ACTION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const TEAM = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const deps: UnattendedDeps = { reviewerMode: () => 'default', paused: async () => false, homeThread: async () => CONV }
const PR = 'https://github.com/fernhill/studio-site/pull/42'

let db: FakeDb
beforeEach(() => {
  db = seeded({
    actions: [{ id: ACTION, workspace_id: WS, team_id: TEAM, status_id: 'todo', identifier: 'GEN-7', title: 'Fix the export', agent_run_status: 'working' }],
    workflow_state: [
      { id: 'backlog', team_id: TEAM, name: 'Backlog', category: 'backlog', sort_order: 0 },
      { id: 'todo', team_id: TEAM, name: 'Todo', category: 'unstarted', sort_order: 1 },
      { id: 'doing', team_id: TEAM, name: 'In Progress', category: 'started', sort_order: 2 },
      { id: 'review', team_id: TEAM, name: 'In Review', category: 'started', sort_order: 3 },
      { id: 'done', team_id: TEAM, name: 'Done', category: 'completed', sort_order: 4 },
    ],
  })
  writer.db = db
  writer.forUser.mockClear()
  prMeta.fetch.mockReset()
  prMeta.fetch.mockResolvedValue(null)
  send.mockClear()
  for (const f of Object.values(ledger)) f.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const card = () => db.tables.actions[0]
const upload = (seqs: Array<[number, Record<string, unknown>]>, runId = 'r1') => parseEventUpload({ runId, events: seqs.map(([seq, event]) => ({ seq, event })) })

/** A card Start on the Mac, claimed and bound to its run: `starting`, as the Mac took it. */
async function startedCard(opts: { worker?: string } = {}): Promise<string> {
  const out = await startActionMacJob(
    db as never,
    {
      userId: USER,
      workspaceId: WS,
      folderId: FOLDER,
      request: 'Fix the export',
      mode: 'edit',
      origin: { actionId: ACTION, startId: 's1' },
      ...(opts.worker ? { agent: { worker: opts.worker } } : {}),
    },
    deps,
  )
  if (out.status !== 'started') throw new Error(`not started: ${JSON.stringify(out)}`)
  const id = db.tables.local_agent_session[0].id as string
  if (opts.worker) {
    // The Mac offers it (the start checks the offered list upstream; the store stamps it).
    db.tables.local_agent_session[0].worker = opts.worker
  }
  await claimSession(db as never, USER, id, { deviceId: DEVICE, runId: 'p1', workers: true })
  await updateState(db as never, USER, id, parseStateUpdate({ runId: 'r1', previousRunId: 'p1' }))
  return id
}

describe('the job begins', () => {
  it('a card in Todo moves to the team’s first started state, as the person’s agent', async () => {
    const id = await startedCard()
    expect(card().status_id).toBe('todo')
    await ingestEvents(db as never, USER, id, upload([[0, { kind: 'status', status: 'running' }]]))
    expect(card().status_id).toBe('doing')
    expect(writer.forUser).toHaveBeenCalledWith(USER)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ from_status_id: 'todo', to_status_id: 'doing', origin: { actor: 'agent', depth: 1, run_id: id } }) }),
    )
  })

  it('the person’s own coding agent’s job does the same', async () => {
    const id = await startedCard({ worker: 'claude-code' })
    await ingestEvents(db as never, USER, id, upload([[0, { kind: 'status', status: 'running' }]]))
    expect(card().status_id).toBe('doing')
  })

  it('only once: a later turn of the job (waiting → running) leaves the card where it is', async () => {
    const id = await startedCard()
    await ingestEvents(db as never, USER, id, upload([[0, { kind: 'status', status: 'running' }], [1, { kind: 'status', status: 'waiting' }]]))
    card().status_id = 'backlog'
    send.mockClear()
    await ingestEvents(db as never, USER, id, upload([[2, { kind: 'status', status: 'running' }]]))
    expect(card().status_id).toBe('backlog')
    expect(send).not.toHaveBeenCalled()
  })

  it('a card already started, or moved by hand since the Start, stays where it is', async () => {
    card().status_id = 'review'
    const id = await startedCard()
    await ingestEvents(db as never, USER, id, upload([[0, { kind: 'status', status: 'running' }]]))
    expect(card().status_id).toBe('review')

    db = seeded({ actions: [{ ...card(), status_id: 'todo' }], workflow_state: [] })
    writer.db = db
    db.tables.workflow_state = [
      { id: 'todo', team_id: TEAM, name: 'Todo', category: 'unstarted', sort_order: 1 },
      { id: 'doing', team_id: TEAM, name: 'In Progress', category: 'started', sort_order: 2 },
    ]
    const again = await startedCard()
    db.tables.entity_activity = [
      { id: 'e1', entity_type: 'action', entity_id: ACTION, action: 'status_changed', actor_kind: 'member', created_at: new Date(Date.now() + 1000).toISOString() },
    ]
    await ingestEvents(db as never, USER, again, upload([[0, { kind: 'status', status: 'running' }]]))
    expect(card().status_id).toBe('todo')
  })

  it('a chat’s job in the folder never moves a card', async () => {
    const { session } = await createSession(db as never, {
      userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Look', mode: 'read', startedBy: 'agent',
    })
    await claimSession(db as never, USER, session.id, { deviceId: DEVICE, runId: 'p1', workers: true })
    await updateState(db as never, USER, session.id, parseStateUpdate({ runId: 'r1', previousRunId: 'p1' }))
    await ingestEvents(db as never, USER, session.id, upload([[0, { kind: 'status', status: 'running' }]]))
    expect(card().status_id).toBe('todo')
    expect(writer.forUser).not.toHaveBeenCalled()
  })
})

describe('its pull request opens', () => {
  it('links the pull request to the card as a cloud run’s is, and moves the card to review', async () => {
    const id = await startedCard()
    db.tables.local_agent_session[0].branch = 'dial8/fix-the-export-' + id.slice(0, 8)
    expect(await recordPullRequest(db as never, USER, id, PR)).toBe(true)
    expect(db.tables.action_github_pr).toHaveLength(1)
    expect(db.tables.action_github_pr[0]).toMatchObject({
      workspace_id: WS,
      action_id: ACTION,
      pr_url: PR,
      repo_full_name: 'fernhill/studio-site',
      pr_number: 42,
      head_branch: `dial8/fix-the-export-${id.slice(0, 8)}`,
      created_by: USER,
    })
    expect(card().status_id).toBe('review')
    // A replay (the Mac's own pull_request event after the route's) links it once.
    await recordPullRequest(db as never, USER, id, PR)
    expect(db.tables.action_github_pr).toHaveLength(1)
  })

  it('the person’s own coding agent’s pull request is linked the same way', async () => {
    const id = await startedCard({ worker: 'codex' })
    await recordPullRequest(db as never, USER, id, PR)
    expect(db.tables.action_github_pr[0]).toMatchObject({ action_id: ACTION, pr_number: 42 })
    expect(card().status_id).toBe('review')
  })

  it('a chat job’s pull request links no card', async () => {
    const { session } = await createSession(db as never, {
      userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Fix', mode: 'edit', startedBy: 'agent',
    })
    await recordPullRequest(db as never, USER, session.id, PR)
    expect(db.tables.action_github_pr ?? []).toHaveLength(0)
    expect(card().status_id).toBe('todo')
  })
})

describe('a pull request merged before the Mac reported it', () => {
  it('its state is read when it is recorded: already merged, the card is Done on the merge’s own path', async () => {
    const id = await startedCard()
    prMeta.fetch.mockResolvedValueOnce({ title: 'Fix the export', state: 'merged', draft: false, headBranch: 'dial8/x' })
    await recordPullRequest(db as never, USER, id, PR)
    expect(prMeta.fetch).toHaveBeenCalledWith(db, 'fernhill/studio-site', 42, USER, expect.objectContaining({ requireToken: true }))
    expect(db.tables.action_github_pr[0]).toMatchObject({ pr_state: 'merged', pr_title: 'Fix the export' })
    expect(db.tables.action_github_pr[0].last_synced_at).toBeTruthy()
    expect(card().status_id).toBe('done')
  })

  it('still open: synced, and the card goes to review; unreadable: the row stays as it was', async () => {
    const id = await startedCard()
    prMeta.fetch.mockResolvedValueOnce({ title: 'Fix the export', state: 'open', draft: true, headBranch: 'dial8/x' })
    await recordPullRequest(db as never, USER, id, PR)
    expect(db.tables.action_github_pr[0]).toMatchObject({ pr_state: 'open', pr_draft: true })
    expect(card().status_id).toBe('review')

    db.tables.action_github_pr = []
    db.tables.local_agent_session[0].pr_url = null
    card().status_id = 'doing'
    await recordPullRequest(db as never, USER, id, PR)
    expect(db.tables.action_github_pr[0].pr_state).toBeUndefined()
    expect(db.tables.action_github_pr[0].last_synced_at).toBeUndefined()
    expect(card().status_id).toBe('review')
  })
})

describe('a pull request the Mac reports: kept on the job’s own branch, whatever repository it is in', () => {
  async function reported(url: string): Promise<string> {
    const id = await startedCard()
    await ingestEvents(db as never, USER, id, upload([[0, { kind: 'status', status: 'running' }]]))
    await ingestEvents(db as never, USER, id, upload([[1, { kind: 'pull_request', ok: true, url, branch: `dial8/studio-site-${id.slice(0, 8)}` }]]))
    return id
  }

  it('the folder’s linked repository (owner and name in any case): kept, linked, the card moves', async () => {
    db.tables.device_folder_setting = [{ device_folder_id: FOLDER, repo_full_name: 'Fernhill/Studio-Site' }]
    await reported(PR)
    expect(db.tables.local_agent_session[0].pr_url).toBe(PR)
    expect(db.tables.action_github_pr).toHaveLength(1)
    expect(card().status_id).toBe('review')
  })

  it('opened in the person’s fork, or a renamed repository: kept, the card moves, the folder’s link left as it is, one log line', async () => {
    for (const url of ['https://github.com/mara-okafor/studio-site/pull/7', 'https://github.com/fernhill/studio-website/pull/7']) {
      db = seeded({ actions: [{ ...card(), status_id: 'todo' }], workflow_state: db.tables.workflow_state })
      writer.db = db
      db.tables.device_folder_setting = [{ device_folder_id: FOLDER, repo_full_name: 'fernhill/studio-site' }]
      const warn = vi.mocked(console.warn)
      warn.mockClear()
      const id = await reported(url)
      // A replayed upload logs nothing new.
      await ingestEvents(db as never, USER, id, upload([[2, { kind: 'pull_request', ok: true, url, branch: `dial8/studio-site-${id.slice(0, 8)}` }]]))
      expect(db.tables.local_agent_session[0].pr_url, url).toBe(url)
      expect(db.tables.action_github_pr[0], url).toMatchObject({ pr_url: url })
      expect(card().status_id, url).toBe('review')
      expect(db.tables.device_folder_setting, url).toEqual([expect.objectContaining({ device_folder_id: FOLDER, repo_full_name: 'fernhill/studio-site' })])
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('the folder’s link is left as it is') || String(c[0]).includes("the folder's link is left as it is")), url).toHaveLength(1)
    }
  })

  it('a folder not linked yet: the first one is kept and links it', async () => {
    await reported(PR)
    expect(db.tables.local_agent_session[0].pr_url).toBe(PR)
    expect(db.tables.device_folder_setting).toEqual([expect.objectContaining({ device_folder_id: FOLDER, repo_full_name: 'fernhill/studio-site' })])
  })
})
