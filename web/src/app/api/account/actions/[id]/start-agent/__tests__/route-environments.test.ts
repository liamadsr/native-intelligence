/**
 * POST /api/account/actions/[id]/start-agent and environments (docs/plans/
 * environments.md §3, §7 Q7, E2): a coding Start runs where the person who
 * pressed it chose for the project. Their "Run my work here" (a per-person
 * environment_default naming their own Mac) puts it on their Mac; otherwise
 * it runs in the project's cloud environment, as before.
 *
 * Pinned here above all: a teammate's Start never reaches your Mac, even
 * with a default row of theirs that names it. getDefault runs for real over
 * the in-memory service client; the Mac start itself is startActionOnMac's
 * (tested in src/lib/environments/__tests__/start.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeDb, type FakeDb } from '@/lib/local-agent/__tests__/fake-db'

const ME = '11111111-1111-4111-8111-111111111111'
const TEAMMATE = '22222222-2222-4222-8222-222222222222'
const WS = '55555555-5555-4555-8555-555555555555'
const MAC = '77777777-7777-4777-8777-777777777777'
const MAC_ENV = '99999999-9999-4999-8999-999999999901'
const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ACTION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

interface Query {
  table: string
  op: 'select' | 'insert' | 'update'
  payload?: unknown
}

const hoisted = vi.hoisted(() => ({
  userId: '',
  role: 'developer' as string | null,
  queries: [] as Query[],
  db: null as unknown,
  send: vi.fn(async (..._a: unknown[]) => ({ ids: ['evt-1'] })),
  ensureWork: vi.fn(async (..._a: unknown[]) => ({})),
  envFor: vi.fn(async (..._a: unknown[]) => 'env-cloud' as string | null),
  launch: vi.fn(async (..._a: unknown[]) => ({ ok: true, reused: false, agentRunId: 'work-run-1' }) as Record<string, unknown>),
  onMac: vi.fn(async (..._a: unknown[]): Promise<Record<string, unknown>> => ({
    status: 'started', sessionId: 'sess-1', environmentId: '99999999-9999-4999-8999-999999999901', mac: 'Liam’s MacBook', folder: 'core', created: true,
  })),
}))

function client() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: hoisted.userId } } }) },
    from(table: string) {
      const q: Query = { table, op: 'select' }
      hoisted.queries.push(q)
      const b: Record<string, unknown> = {}
      const chain = () => b
      const settle = async () => {
        if (table === 'actions' && q.op === 'select') {
          return {
            data: {
              id: ACTION, identifier: 'ENG-42', title: 'Fix the export', description: 'Drops rows', status_id: 's1', team_id: 'team-1',
              project_id: PROJECT, assignee_ai_member_id: 'ai-1', agent_run_status: null, project: { github_repo: 'acme/core' },
            },
            error: null,
          }
        }
        if (table === 'ai_team_member') return { data: { id: 'ai-1', name: 'Dev', role: hoisted.role, team_id: 'team-1', is_system: false, fronts_only: false }, error: null }
        if (table === 'team') return { data: { is_private: false }, error: null }
        if (table === 'member') return { data: { id: 'member-1' }, error: null }
        if (table === 'agent_run' && q.op === 'insert') return { data: { id: 'run-new' }, error: null }
        return { data: null, error: null }
      }
      Object.assign(b, {
        select: chain,
        insert: (p: unknown) => ((q.op = 'insert'), (q.payload = p), b),
        update: (p: unknown) => ((q.op = 'update'), (q.payload = p), b),
        eq: chain,
        in: chain,
        order: chain,
        limit: chain,
        single: settle,
        maybeSingle: settle,
        then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => settle().then(ok, err),
      })
      return b
    },
  }
}

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => client() }))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => '55555555-5555-4555-8555-555555555555' }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.send } }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.db }))
vi.mock('@/lib/work/agent-run-mirror', () => ({ ensureWorkForAgentRun: hoisted.ensureWork }))
vi.mock('@/lib/environments/resolve', async (orig) => ({ ...(await orig<typeof import('@/lib/environments/resolve')>()), runEnvironmentIdFor: hoisted.envFor }))
vi.mock('@/lib/work/start-work-item', () => ({ launchWorkItem: hoisted.launch, snapshotResources: async (_s: unknown, raw: unknown) => raw }))
vi.mock('@/lib/environments/start', async (orig) => ({ ...(await orig<typeof import('@/lib/environments/start')>()), startActionOnMac: hoisted.onMac }))

import { POST } from '../route'

let db: FakeDb

const start = (userId: string) => {
  hoisted.userId = userId
  return POST(new Request(`http://localhost/api/account/actions/${ACTION}/start-agent`, { method: 'POST' }), { params: Promise.resolve({ id: ACTION }) })
}
const inserts = () => hoisted.queries.filter((q) => q.table === 'agent_run' && q.op === 'insert')

beforeEach(() => {
  db = fakeDb({
    member: [
      { workspace_id: WS, user_id: ME, role: 'member' },
      { workspace_id: WS, user_id: TEAMMATE, role: 'member' },
    ],
    projects: [{ id: PROJECT, workspace_id: WS, github_repo: 'acme/core', environment_id: null }],
    user_device: [{ user_id: ME, id: MAC, name: 'Liam’s MacBook', last_seen_at: new Date().toISOString() }],
    environment: [{ id: MAC_ENV, kind: 'mac', name: 'Liam’s MacBook', owner_user_id: ME, device_id: MAC, workspace_id: null, archived_at: null }],
    // My "Run my work here" for the project.
    environment_default: [{ id: 'd-me', user_id: ME, workspace_id: WS, project_id: PROJECT, environment_id: MAC_ENV }],
    local_agent_session: [],
  })
  hoisted.db = db
  hoisted.role = 'developer'
  hoisted.queries.length = 0
  for (const f of [hoisted.send, hoisted.ensureWork, hoisted.envFor, hoisted.launch, hoisted.onMac]) f.mockClear()
})

describe('start-agent: where a coding Start runs', () => {
  it('my Start with “Run my work here” on: my Mac, unattended, and no cloud run', async () => {
    const res = await start(ME)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mode: 'mac', worker: 'local_agent', sessionId: 'sess-1', environmentId: MAC_ENV, mac: 'Liam’s MacBook', folder: 'core' })
    expect(hoisted.onMac).toHaveBeenCalledTimes(1)
    expect(hoisted.onMac.mock.calls[0][1]).toEqual({
      userId: ME,
      workspaceId: WS,
      environmentId: MAC_ENV,
      repo: 'acme/core',
      action: { id: ACTION, identifier: 'ENG-42', title: 'Fix the export', description: 'Drops rows' },
    })
    expect(inserts()).toHaveLength(0)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('a teammate’s Start never reaches my Mac: it runs in the project’s cloud environment', async () => {
    const res = await start(TEAMMATE)
    expect(await res.json()).toEqual({ mode: 'server', worker: 'coding_run', agentRunId: 'run-new' })
    expect(hoisted.onMac).not.toHaveBeenCalled()
    expect(inserts()).toHaveLength(1)
    expect(inserts()[0].payload).toMatchObject({ triggered_by: TEAMMATE, environment_id: 'env-cloud' })
    expect(hoisted.send).toHaveBeenCalledTimes(1)
  })

  it('even a default row of the teammate’s that names my Mac (one the database would refuse) never sends their Start there', async () => {
    db.tables.environment_default.push({ id: 'd-forged', user_id: TEAMMATE, workspace_id: WS, project_id: PROJECT, environment_id: MAC_ENV })
    const res = await start(TEAMMATE)
    expect((await res.json()).mode).toBe('server')
    expect(hoisted.onMac).not.toHaveBeenCalled()
  })

  it('no default for the project (or one for the workspace only): the cloud, as before', async () => {
    db.tables.environment_default = [{ id: 'd-ws', user_id: ME, workspace_id: WS, project_id: null, environment_id: MAC_ENV }]
    expect((await (await start(ME)).json()).mode).toBe('server')
    expect(hoisted.onMac).not.toHaveBeenCalled()
  })

  it('a Mac start that is refused says why, in the api-errors shape, and starts nothing in the cloud', async () => {
    hoisted.onMac.mockResolvedValueOnce({ status: 'refused', code: 'NO_LINKED_FOLDER', reason: 'Link a folder on Liam’s MacBook to acme/core first, in its environment.', httpStatus: 409 })
    const res = await start(ME)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Link a folder on Liam’s MacBook to acme/core first, in its environment.', code: 'NO_LINKED_FOLDER' })
    expect(inserts()).toHaveLength(0)
  })

  it('a non-developer delegate keeps its work run: “Run my work here” is for coding work', async () => {
    hoisted.role = 'writer'
    const res = await start(ME)
    expect(await res.json()).toMatchObject({ kind: 'work', worker: 'work_run' })
    expect(hoisted.onMac).not.toHaveBeenCalled()
    expect(hoisted.launch).toHaveBeenCalledTimes(1)
  })
})

describe('start-agent: one live run per action, a Mac job too', () => {
  const live = (userId: string) => ({
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', user_id: userId, workspace_id: WS, device_id: MAC, folder_id: 'f1', status: 'running',
    idempotency_key: `local-agent-action:${ACTION}:start:s1`, lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    expires_at: new Date(Date.now() + 600_000).toISOString(), updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
  })

  it('mine on my Mac: that job, nothing new', async () => {
    db.tables.local_agent_session.push(live(ME))
    const res = await start(ME)
    expect(await res.json()).toEqual({ mode: 'mac', worker: 'local_agent', sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', reused: true })
    expect(hoisted.onMac).not.toHaveBeenCalled()
    expect(inserts()).toHaveLength(0)
  })

  it('on a teammate’s Mac: a 409, nothing started', async () => {
    db.tables.local_agent_session.push(live(ME))
    const res = await start(TEAMMATE)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'ACTION_BUSY' })
    expect(inserts()).toHaveLength(0)
    expect(hoisted.onMac).not.toHaveBeenCalled()
  })

  it('an ended one doesn’t hold the action', async () => {
    db.tables.local_agent_session.push({ ...live(ME), status: 'cancelled' })
    expect((await (await start(ME)).json()).sessionId).toBe('sess-1')
  })

  it('a finished one (its turn ended, nothing asked) holds nothing for a day: my Start goes on, a teammate’s runs in the cloud (B2)', async () => {
    db.tables.local_agent_session.push({ ...live(ME), status: 'waiting', last_signal: 'finish', lease_expires_at: null })
    expect((await (await start(ME)).json()).sessionId).toBe('sess-1')
    expect(hoisted.onMac).toHaveBeenCalledTimes(1)
    const theirs = await start(TEAMMATE)
    expect(theirs.status).toBe(200)
    expect((await theirs.json()).mode).toBe('server')
  })

  it('one waiting on my answer, or with a request on its way to the Mac, still holds it', async () => {
    db.tables.local_agent_session.push({ ...live(ME), status: 'waiting', last_signal: 'ask', lease_expires_at: null })
    expect((await start(TEAMMATE)).status).toBe(409)
    db.tables.local_agent_session[0].last_signal = 'finish'
    db.tables.local_agent_message = [{ id: 'm1', session_id: db.tables.local_agent_session[0].id, user_id: ME, status: 'pending' }]
    expect((await start(TEAMMATE)).status).toBe(409)
    expect(await (await start(ME)).json()).toMatchObject({ mode: 'mac', reused: true })
  })
})
