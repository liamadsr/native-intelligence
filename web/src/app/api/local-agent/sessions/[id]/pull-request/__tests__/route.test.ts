/**
 * POST /api/local-agent/sessions/[id]/pull-request for a job a person started
 * from a card on their Mac: the job's own session token (the la1 the claim
 * minted, which Rust holds: the person's own coding agent never does) opens
 * its pull request whichever agent did the work, and the pull request is
 * linked to the card as a cloud run's is (action_github_pr), the card moving
 * to review.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: vi.fn() }))
const ledger = vi.hoisted(() => ({
  moveTurn: vi.fn(async (_svc: unknown, s: unknown) => s),
  startTurnRow: vi.fn(async () => 'job-1'),
  turnStatus: vi.fn(async (): Promise<string | null> => 'running'),
}))
vi.mock('@/lib/local-agent/ledger', async (orig) => ({ ...(await orig<typeof import('@/lib/local-agent/ledger')>()), ...ledger }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => undefined) } }))
vi.mock('@/lib/notifications', () => ({ createNotification: vi.fn(async () => undefined) }))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))
const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => holder.db }))
vi.mock('@/lib/actions/agent-writer', () => ({ agentWriterFor: () => holder.db }))
vi.mock('@/lib/oauth/github-token', () => ({ storedGithubToken: async () => 'gho_test' }))
// The state read a Mac-reported pull request gets: never on this path (opened here a moment ago).
const stateRead = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null))
vi.mock('@/lib/github/pr-metadata', () => ({ fetchPrMetadata: stateRead, readPrState: vi.fn() }))

import { POST } from '../route'
import { signModelToken } from '@/lib/local-agent/tokens'
import { startActionMacJob } from '@/lib/local-agent/unattended'
import { CONV, FOLDER, USER, WS, seeded, type FakeDb } from '@/lib/local-agent/__tests__/fake-db'

const ACTION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const TEAM = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const PR = 'https://github.com/fernhill/studio-site/pull/42'

let db: FakeDb
let sid: string

beforeEach(async () => {
  process.env.LOCAL_AGENT_TOKEN_SECRET = 'pull-request-route-test-secret'
  db = seeded({
    actions: [{ id: ACTION, workspace_id: WS, team_id: TEAM, status_id: 'doing', identifier: 'GEN-7', title: 'Fix the export' }],
    workflow_state: [
      { id: 'doing', team_id: TEAM, name: 'In Progress', category: 'started', sort_order: 2 },
      { id: 'review', team_id: TEAM, name: 'In Review', category: 'started', sort_order: 3 },
    ],
  })
  holder.db = db
  await startActionMacJob(
    db as never,
    { userId: USER, workspaceId: WS, folderId: FOLDER, request: 'Fix the export', mode: 'edit', origin: { actionId: ACTION, startId: 's1' } },
    { reviewerMode: () => 'default', paused: async () => false, homeThread: async () => CONV },
  )
  const row = db.tables.local_agent_session[0]
  sid = row.id as string
  // The person's own coding agent did the work; the job waits after its finish.
  Object.assign(row, { status: 'waiting', run_id: 'r1', worker: 'claude-code' })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST' ? new Response(JSON.stringify({ html_url: PR }), { status: 201 }) : new Response('{}', { status: 404 }),
    ),
  )
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function post(token: string, id = sid) {
  return POST(
    new Request(`http://localhost/api/local-agent/sessions/${id}/pull-request`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: id,
        remoteUrl: 'git@github.com:fernhill/studio-site.git',
        branch: `dial8/studio-site-${id.slice(0, 8)}`,
        base: 'main',
        title: 'Fix the export',
        body: 'What changed and why.',
      }),
    }),
    { params: Promise.resolve({ id }) },
  )
}

describe('a worker’s job opens its pull request with its own session token', () => {
  it('accepts the token as it does for our own agent’s job, links the pull request to the card and moves it to review', async () => {
    const res = await post(signModelToken({ sid, uid: USER, wid: WS }).token)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ url: PR })
    expect(db.tables.local_agent_session[0].pr_url).toBe(PR)
    expect(db.tables.action_github_pr).toEqual([
      expect.objectContaining({ workspace_id: WS, action_id: ACTION, pr_url: PR, repo_full_name: 'fernhill/studio-site', pr_number: 42 }),
    ])
    expect(db.tables.actions[0].status_id).toBe('review')
    // Opened by the route a moment ago: no state read on GitHub.
    expect(stateRead).not.toHaveBeenCalled()
  })

  it('refuses another session’s token, and no token at all', async () => {
    const other = signModelToken({ sid: '99999999-9999-4999-8999-999999999999', uid: USER, wid: WS }).token
    expect((await post(other)).status).toBe(403)
    expect((await post('')).status).toBe(401)
    expect(db.tables.action_github_pr ?? []).toHaveLength(0)
  })
})
