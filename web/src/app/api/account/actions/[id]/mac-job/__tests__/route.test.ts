/**
 * GET /api/account/actions/[id]/mac-job: the signed-in person's own job for
 * the action on their Mac (migration 658's panel): the live one, else the
 * latest; never a teammate's; null when there is none; the action must be
 * one this person's client can read in the workspace.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeDb, type FakeDb } from '@/lib/local-agent/__tests__/fake-db'

vi.mock('server-only', () => ({}))
const ME = '11111111-1111-4111-8111-111111111111'
const TEAMMATE = '22222222-2222-4222-8222-222222222222'
const WS = '55555555-5555-4555-8555-555555555555'
const MAC = '77777777-7777-4777-8777-777777777777'
const ACTION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn(), db: null as unknown, actionVisible: true }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => hoisted.db }))

const { GET } = await import('../route')

let db: FakeDb
const session = (over: Record<string, unknown>) => ({
  user_id: ME, workspace_id: WS, device_id: MAC, folder_id: 'f1', status: 'cancelled', idempotency_key: `local-agent-action:${ACTION}:start:s1`,
  expires_at: new Date(Date.now() + 600_000).toISOString(), lease_expires_at: null, updated_at: new Date().toISOString(),
  ...over,
})
const get = async (userId = ME, id = ACTION) => {
  hoisted.requireWorkspace.mockResolvedValue({
    user: { id: userId },
    workspaceId: WS,
    supabase: {
      from: () => {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.eq = () => b
        b.maybeSingle = async () => ({ data: hoisted.actionVisible ? { id } : null, error: null })
        return b
      },
    },
  })
  return GET(new Request(`http://localhost/api/account/actions/${id}/mac-job`), { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  hoisted.actionVisible = true
  db = fakeDb({
    user_device: [{ user_id: ME, id: MAC, name: 'Studio Mac', last_seen_at: new Date().toISOString() }],
    device_folder: [{ id: 'f1', user_id: ME, device_id: MAC, grant_id: 'g1', label: 'harbor-site', path: '/p', mode: 'edit', is_git: true, revoked_at: null }],
    local_agent_session: [
      session({ id: 'aaaaaaaa-0000-4000-8000-000000000001', created_at: '2026-11-01T00:00:00Z', worker: null }),
      session({ id: 'aaaaaaaa-0000-4000-8000-000000000002', created_at: '2026-11-02T00:00:00Z', worker: 'claude-code' }),
      session({ id: 'aaaaaaaa-0000-4000-8000-000000000003', created_at: '2026-11-03T00:00:00Z', user_id: TEAMMATE, worker: 'codex' }),
    ],
  })
  hoisted.db = db
})

describe('GET …/actions/[id]/mac-job', () => {
  it('my latest job for the action, naming its agent; never a teammate’s', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      job: { sessionId: 'aaaaaaaa-0000-4000-8000-000000000002', status: 'cancelled', worker: 'claude-code', deviceName: 'Studio Mac', folderLabel: 'harbor-site', live: false },
    })
  })

  it('a live one wins over a later ended one', async () => {
    db.tables.local_agent_session[0].status = 'running'
    db.tables.local_agent_session[0].lease_expires_at = new Date(Date.now() + 60_000).toISOString()
    expect((await (await get()).json()).job).toMatchObject({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', live: true, worker: null })
  })

  it('none of mine: null; an action I can’t read, or not an id: 404', async () => {
    expect(await (await get('44444444-4444-4444-8444-444444444444')).json()).toEqual({ job: null })
    hoisted.actionVisible = false
    expect((await get()).status).toBe(404)
    hoisted.actionVisible = true
    expect((await get(ME, 'ENG-7')).status).toBe(404)
  })
})
