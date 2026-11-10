/**
 * Tests for GET/PATCH/DELETE /api/account/projects/[id].
 *
 * Covers:
 *   GET  — head-only action counts and the deterministic inherited team
 *   PATCH — a field update
 *   DELETE — captures are torn down through delete_capture_with_knowledge,
 *            never a raw row delete (knowledge-graph orphan prevention)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

// ── Hoisted mocks ──────────────────────────────────────────────────────────
const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  getCurrentWorkspaceId: vi.fn(),
  // Supabase chain helpers — replaced per-test via fromHandlers
  fromHandlers: new Map<string, unknown>(),
  // DELETE-path spies: every from(table) and every rpc() the route makes
  fromSpy: vi.fn(),
  rpc: vi.fn(),
  // Records .delete() per table, so a raw capture wipe is detectable
  tableDelete: vi.fn(),
  // The caller's member row (DELETE authorizes on role / project lead).
  member: { id: 'mem-1', role: 'owner' as string | null },
}))

// ── Chain builder ──────────────────────────────────────────────────────────
function makeChain(result: unknown, opts: { spy?: () => void; table?: string } = {}) {
  const chain: Record<string, unknown> = {}
  const proxy = new Proxy(chain, {
    get(_t, prop: string) {
      if (prop === 'then') return (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb)
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(result)
      if (prop === 'insert') {
        return () => {
          opts.spy?.()
          return Promise.resolve({ error: null })
        }
      }
      if (prop === 'delete') {
        return () => {
          if (opts.table) hoisted.tableDelete(opts.table)
          return proxy
        }
      }
      return () => proxy
    },
  })
  return proxy as unknown
}

function makeFakeSupabase() {
  return {
    auth: { getUser: hoisted.getUser },
    from: (table: string) => {
      hoisted.fromSpy(table)
      const handler = hoisted.fromHandlers.get(table)
      if (handler) return handler
      return makeChain({ data: null, error: null }, { table })
    },
    rpc: (...args: unknown[]) => hoisted.rpc(...args),
  }
}

// The route resolves auth via requireWorkspace (perf phase 2 migration); the
// mock mirrors the real helper's contract, driven by the same hoisted knobs
// the old getUser/getCurrentWorkspaceId mocks used.
vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: async () => {
    const { data } = await hoisted.getUser()
    if (!data?.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const workspaceId = await hoisted.getCurrentWorkspaceId()
    if (!workspaceId) {
      return new Response(JSON.stringify({ error: 'No workspace', code: 'NO_WORKSPACE' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return { supabase: makeFakeSupabase(), user: data.user, workspaceId }
  },
  // Same contract plus the member row, as the real helper returns it.
  requireWorkspaceMember: async () => {
    const { data } = await hoisted.getUser()
    if (!data?.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const workspaceId = await hoisted.getCurrentWorkspaceId()
    if (!workspaceId) {
      return new Response(JSON.stringify({ error: 'No workspace', code: 'NO_WORKSPACE' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return { supabase: makeFakeSupabase(), user: data.user, workspaceId, member: hoisted.member }
  },
}))
vi.mock('@/lib/notifications', () => ({
  createNotification: vi.fn(),
  getMemberByUserId: vi.fn(),
}))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn().mockResolvedValue(undefined) },
}))

const { GET, PATCH, DELETE } = await import('@/app/api/account/projects/[id]/route')

// ── Helpers ────────────────────────────────────────────────────────────────
const PROJECT_ID = 'proj-abc'

function makeParams(id = PROJECT_ID) {
  return { params: Promise.resolve({ id }) }
}

function getReq(): NextRequest {
  return buildRequest({
    url: `https://nativeintelligence.dev/api/account/projects/${PROJECT_ID}`,
    method: 'GET',
  }) as unknown as NextRequest
}

function patchReq(body: unknown): NextRequest {
  return buildRequest({
    url: `https://nativeintelligence.dev/api/account/projects/${PROJECT_ID}`,
    method: 'PATCH',
    body,
  }) as unknown as NextRequest
}

// Minimal project row the "projects" table returns
const projectRow = {
  id: PROJECT_ID,
  name: 'Test Project',
  description: null,
  icon: null,
  color: null,
  is_pinned: false,
  is_archived: false,
  sort_order: 0,
  initiative_id: null,
  status: 'active',
  start_date: null,
  target_date: null,
  github_repo: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  lead: null,
  initiative: null,
}

function happyAuth() {
  hoisted.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  hoisted.getCurrentWorkspaceId.mockResolvedValue('ws-1')
}

// ── Tests ──────────────────────────────────────────────────────────────────
beforeEach(() => {
  hoisted.fromHandlers.clear()
  hoisted.fromSpy.mockReset()
  hoisted.tableDelete.mockReset()
  hoisted.rpc.mockReset()
  hoisted.rpc.mockResolvedValue({ error: null })
  hoisted.member = { id: 'mem-1', role: 'owner' }
})

describe('GET /api/account/projects/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    hoisted.getUser.mockResolvedValue({ data: { user: null }, error: null })
    hoisted.getCurrentWorkspaceId.mockResolvedValue('ws-1')
    const res = await GET(getReq(), makeParams())
    expect(res.status).toBe(401)
  })

  it('returns the project', async () => {
    happyAuth()
    hoisted.fromHandlers.set('projects', makeChain({ data: projectRow, error: null }))
    hoisted.fromHandlers.set('milestone', makeChain({ data: [], error: null }))
    hoisted.fromHandlers.set('actions', makeChain({ data: [], error: null }))

    const res = await GET(getReq(), makeParams())
    expect(res.status).toBe(200)
    const body = await readJson<{ project: Record<string, unknown> }>(res)
    expect(body.project.id).toBe(PROJECT_ID)
  })

  it('counts actions with head-only count queries and inherits team_id from one row', async () => {
    happyAuth()

    // Record every actions select — the perf fix (audit 11.5) replaced the
    // full-row scan with two head counts + a single-row team_id select.
    const actionSelects: Array<{ fields: string; opts?: { count?: string; head?: boolean } }> = []
    const actionsChain = (() => {
      const make = (result: unknown) => {
        const chain: Record<string, unknown> = {}
        const proxy = new Proxy(chain, {
          get(_t, prop: string) {
            if (prop === 'then') return (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb)
            return () => proxy
          },
        })
        return proxy
      }
      return {
        select: (fields: string, opts?: { count?: string; head?: boolean }) => {
          actionSelects.push({ fields, opts })
          if (opts?.head) {
            // Head count responses carry no rows — total 5, completed 2 keyed
            // off the completed-filter select string.
            const isCompleted = fields.includes('workflow_state')
            return make({ data: null, count: isCompleted ? 2 : 5, error: null })
          }
          return make({ data: [{ team_id: 'team-9' }], error: null })
        },
      }
    })()

    hoisted.fromHandlers.set('projects', makeChain({ data: projectRow, error: null }))
    hoisted.fromHandlers.set('milestone', makeChain({ data: [], error: null }))
    hoisted.fromHandlers.set('actions', actionsChain)

    const res = await GET(getReq(), makeParams())
    expect(res.status).toBe(200)
    const body = await readJson<{
      project: { action_count: number; completed_action_count: number; team_id: string | null }
    }>(res)
    expect(body.project.action_count).toBe(5)
    expect(body.project.completed_action_count).toBe(2)
    expect(body.project.team_id).toBe('team-9')

    // Exactly three actions queries: two head-only counts, one row select.
    expect(actionSelects).toHaveLength(3)
    const headSelects = actionSelects.filter((s) => s.opts?.head)
    expect(headSelects).toHaveLength(2)
    for (const s of headSelects) {
      expect(s.opts?.count).toBe('exact')
    }
    // The completed count filters through an INNER workflow_state join.
    expect(headSelects.some((s) => s.fields.includes('workflow_state!status_id!inner(category)'))).toBe(true)
    // The team-inherit select ships only team_id — never the full action rows.
    const rowSelect = actionSelects.find((s) => !s.opts?.head)
    expect(rowSelect?.fields).toBe('team_id')
  })

  /**
   * Pins the nondeterministic-inheritance finding (route.ts:72). The perf
   * rewrite replaced the full unordered scan (whose `actions[0]` at least came
   * from one consistent plan) with `select('team_id').eq(...).limit(1)` and NO
   * ORDER BY. LIMIT 1 lets Postgres early-exit from whichever plan it happens
   * to pick, so a project whose actions span two teams could report ENG on one
   * reload and DES on the next — after a VACUUM, or once an index on
   * project_id appears.
   *
   * The query must therefore carry a deterministic order AND exclude null
   * team_ids, so a teamless action can never shadow a real one.
   */
  it('derives the inherited team from a deterministically ORDERED, non-null query', async () => {
    happyAuth()

    const teamQueryOps: Array<{ op: string; args: unknown[] }> = []
    const actionsChain = (() => {
      const make = (result: unknown, record: boolean) => {
        const chain: Record<string, unknown> = {}
        const proxy: unknown = new Proxy(chain, {
          get(_t, prop: string) {
            if (prop === 'then') return (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb)
            return (...args: unknown[]) => {
              if (record) teamQueryOps.push({ op: prop, args })
              return proxy
            }
          },
        })
        return proxy
      }
      return {
        select: (fields: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.head) return make({ data: null, count: 0, error: null }, false)
          // The team-inherit query — record every builder call on it.
          return make({ data: [{ team_id: 'team-eng' }], error: null }, true)
        },
      }
    })()

    hoisted.fromHandlers.set('projects', makeChain({ data: projectRow, error: null }))
    hoisted.fromHandlers.set('milestone', makeChain({ data: [], error: null }))
    hoisted.fromHandlers.set('actions', actionsChain)

    const res = await GET(getReq(), makeParams())
    expect(res.status).toBe(200)
    const body = await readJson<{ project: { team_id: string | null } }>(res)
    expect(body.project.team_id).toBe('team-eng')

    const ops = teamQueryOps.map((o) => o.op)
    // An explicit ORDER BY is what makes the single row reproducible.
    expect(ops).toContain('order')
    expect(ops).toContain('limit')
    const orderCall = teamQueryOps.find((o) => o.op === 'order')!
    expect(orderCall.args[0]).toBe('created_at')
    expect(orderCall.args[1]).toMatchObject({ ascending: true })
    // …and NULL team_ids are excluded, so a teamless action can't win the race.
    const notCall = teamQueryOps.find((o) => o.op === 'not')
    expect(notCall).toBeDefined()
    expect(notCall!.args.slice(0, 3)).toEqual(['team_id', 'is', null])
  })

  it('falls back to a null inherited team when no action carries one', async () => {
    happyAuth()
    hoisted.fromHandlers.set('projects', makeChain({ data: projectRow, error: null }))
    hoisted.fromHandlers.set('milestone', makeChain({ data: [], error: null }))
    // The .not() filter leaves the result set empty.
    hoisted.fromHandlers.set('actions', makeChain({ data: [], count: 0, error: null }))

    const res = await GET(getReq(), makeParams())
    const body = await readJson<{ project: { team_id: string | null } }>(res)
    expect(body.project.team_id).toBeNull()
  })

})

describe('PATCH /api/account/projects/[id]', () => {
  it('updates a field', async () => {
    happyAuth()
    hoisted.fromHandlers.set('projects', makeChain({ data: { ...projectRow, name: 'Renamed' }, error: null }))

    const res = await PATCH(patchReq({ name: 'Renamed' }), makeParams())
    expect(res.status).toBe(200)
    const body = await readJson<{ project: Record<string, unknown> }>(res)
    expect(body.project.name).toBe('Renamed')
  })
})

/**
 * The project's environment (migration 420): projects.environment_id, a
 * shared, live cloud environment of this workspace.
 */
describe('PATCH /api/account/projects/[id] — the environment', () => {
  const ENV_ID = '99999999-9999-4999-8999-999999999999'

  /** The environment lookup: records its filters, answers `found`. */
  function environmentLookup(found: boolean) {
    const filters: string[] = []
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (k: string, v: unknown) => (filters.push(`${k}=${String(v)}`), chain),
      is: (k: string, v: unknown) => (filters.push(`${k} is ${String(v)}`), chain),
      maybeSingle: async () => ({ data: found ? { id: ENV_ID } : null, error: null }),
    }
    hoisted.fromHandlers.set('environment', chain)
    return filters
  }

  /** The projects update: records the patch, answers the row with the embedded environment. */
  function projectsUpdate() {
    const patches: Record<string, unknown>[] = []
    const selects: string[] = []
    const row = { ...projectRow, environment_id: ENV_ID, environment: { id: ENV_ID, name: 'Web', network_access: 'restricted' } }
    const chain: Record<string, unknown> = {
      update: (p: Record<string, unknown>) => (patches.push(p), chain),
      select: (f: string) => (selects.push(f), chain),
      eq: () => chain,
      single: async () => ({ data: row, error: null }),
    }
    hoisted.fromHandlers.set('projects', chain)
    return { patches, selects }
  }

  it('links a shared cloud environment of this workspace, and answers its name and network', async () => {
    happyAuth()
    const filters = environmentLookup(true)
    const { patches, selects } = projectsUpdate()
    const res = await PATCH(patchReq({ environment_id: ENV_ID }), makeParams())
    expect(res.status).toBe(200)
    expect(filters).toEqual([`id=${ENV_ID}`, 'workspace_id=ws-1', 'kind=cloud', 'shared=true', 'archived_at is null'])
    expect(patches).toEqual([{ environment_id: ENV_ID }])
    expect(selects[0]).toContain('environment:environment!projects_environment_id_fkey(id, name, network_access)')
    const body = await readJson<{ project: Record<string, unknown> }>(res)
    expect(body.project).toMatchObject({ environment_id: ENV_ID, environment_name: 'Web', environment_network_access: 'restricted' })
    expect(body.project).not.toHaveProperty('environment')
  })

  it('refuses an environment that is not a shared cloud one of this workspace (a Mac, "only me", another workspace’s)', async () => {
    happyAuth()
    environmentLookup(false)
    const { patches } = projectsUpdate()
    const res = await PATCH(patchReq({ environment_id: ENV_ID }), makeParams())
    expect(res.status).toBe(400)
    expect(await readJson(res)).toMatchObject({ error: 'Invalid environment_id', code: 'BAD_REQUEST' })
    expect(patches).toEqual([])
  })

  it('null (or empty) unlinks it, with no lookup', async () => {
    happyAuth()
    const filters = environmentLookup(true)
    const { patches } = projectsUpdate()
    const res = await PATCH(patchReq({ environment_id: '' }), makeParams())
    expect(res.status).toBe(200)
    expect(filters).toEqual([])
    expect(patches).toEqual([{ environment_id: null }])
  })
})

/**
 * DELETE — the knowledge-graph orphan fix.
 *
 * This handler used to run `.from('notes').delete()` against a table renamed to
 * `captures` back in migration 025: the call errored and, with its error never
 * checked, silently no-opped. The captures were actually being destroyed by the
 * DB-level `notes_project_id_fkey` ON DELETE CASCADE, which raw-deletes rows
 * with zero application involvement — bypassing delete_capture_with_knowledge
 * and stranding every sole-sourced claim as evidence-orphaned. Deleting the
 * captures is still the intended behaviour; it just has to go through the RPC.
 */
function deleteReq(): NextRequest {
  return buildRequest({
    url: `https://nativeintelligence.dev/api/account/projects/${PROJECT_ID}`,
    method: 'DELETE',
  }) as unknown as NextRequest
}

// A `captures` table handler whose select resolves to the given ids.
function capturesChain(ids: string[]) {
  const rows = ids.map((id) => ({ id }))
  const chain: Record<string, unknown> = {}
  const proxy = new Proxy(chain, {
    get(_t, prop: string) {
      if (prop === 'then') return (cb: (v: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(cb)
      if (prop === 'delete') {
        return () => {
          hoisted.tableDelete('captures')
          return proxy
        }
      }
      return () => proxy
    },
  })
  return proxy as unknown
}

// The project is visible (lead_id null), the caller is an owner, and the
// delete matches the row (count 1).
function setDeletableProject(role = 'owner', leadId: string | null = null, count = 1) {
  hoisted.fromHandlers.set(
    'projects',
    makeChain({ data: { id: PROJECT_ID, lead_id: leadId }, error: null, count }, { table: 'projects' }),
  )
  hoisted.member = { id: 'mem-1', role }
}

describe('DELETE /api/account/projects/[id] — knowledge-graph-safe capture teardown', () => {
  it('tears down every capture through the RPC and never raw-deletes captures or notes', async () => {
    happyAuth()
    const ids = ['cap-1', 'cap-2', 'cap-3']
    hoisted.fromHandlers.set('captures', capturesChain(ids))
    setDeletableProject()

    const res = await DELETE(deleteReq(), makeParams())
    expect(res.status).toBe(200)

    const body = await readJson<{ success: boolean; captures_deleted: number }>(res)
    expect(body.success).toBe(true)
    expect(body.captures_deleted).toBe(3)

    // One RPC call per capture id, with the teardown RPC's real signature
    // (migration 237 added p_user_id).
    expect(hoisted.rpc).toHaveBeenCalledTimes(3)
    for (const id of ids) {
      expect(hoisted.rpc).toHaveBeenCalledWith('delete_capture_with_knowledge', {
        p_capture_id: id,
        p_workspace_id: 'ws-1',
        p_user_id: 'user-1',
      })
    }

    // The captures table is READ (to collect ids) but never row-deleted…
    expect(hoisted.tableDelete).not.toHaveBeenCalledWith('captures')
    // …and the long-dead `notes` table is not touched at all.
    expect(hoisted.fromSpy).not.toHaveBeenCalledWith('notes')
    // The project row itself is still deleted.
    expect(hoisted.tableDelete).toHaveBeenCalledWith('projects')
  })

  it('deletes the project even when it holds no captures', async () => {
    happyAuth()
    hoisted.fromHandlers.set('captures', capturesChain([]))
    setDeletableProject()

    const res = await DELETE(deleteReq(), makeParams())
    expect(res.status).toBe(200)
    const body = await readJson<{ captures_deleted: number }>(res)
    expect(body.captures_deleted).toBe(0)
    expect(hoisted.rpc).not.toHaveBeenCalled()
    expect(hoisted.tableDelete).toHaveBeenCalledWith('projects')
  })

  it('a P0002 on one capture does not abort the remaining ids or the project delete', async () => {
    happyAuth()
    const ids = ['cap-1', 'gone', 'cap-3']
    hoisted.fromHandlers.set('captures', capturesChain(ids))
    setDeletableProject()

    // P0002 = row already gone. Not a failure — nothing left to tear down.
    hoisted.rpc.mockImplementation((_name: string, args: { p_capture_id: string }) =>
      Promise.resolve(
        args.p_capture_id === 'gone'
          ? { error: { code: 'P0002', message: 'capture not found' } }
          : { error: null },
      ),
    )

    const res = await DELETE(deleteReq(), makeParams())
    expect(res.status).toBe(200)

    // Every id was still attempted — the loop did not unwind on the error.
    expect(hoisted.rpc).toHaveBeenCalledTimes(3)
    const body = await readJson<{ success: boolean; captures_deleted: number; captures_failed?: number }>(res)
    expect(body.success).toBe(true)
    expect(body.captures_deleted).toBe(2)
    // P0002 is tolerated, so it is not reported as a failure.
    expect(body.captures_failed).toBeUndefined()
    expect(hoisted.tableDelete).toHaveBeenCalledWith('projects')
  })

  it('reports a real per-capture error as failed without aborting the project delete', async () => {
    happyAuth()
    const ids = ['cap-1', 'denied']
    hoisted.fromHandlers.set('captures', capturesChain(ids))
    setDeletableProject()

    hoisted.rpc.mockImplementation((_name: string, args: { p_capture_id: string }) =>
      Promise.resolve(
        args.p_capture_id === 'denied'
          ? { error: { code: '42501', message: 'not the capture owner' } }
          : { error: null },
      ),
    )

    const res = await DELETE(deleteReq(), makeParams())
    expect(res.status).toBe(200)
    expect(hoisted.rpc).toHaveBeenCalledTimes(2)

    const body = await readJson<{ captures_deleted: number; captures_failed?: number }>(res)
    expect(body.captures_deleted).toBe(1)
    expect(body.captures_failed).toBe(1)
    expect(hoisted.tableDelete).toHaveBeenCalledWith('projects')
  })

  it('returns 500 and skips the project delete when the capture lookup fails', async () => {
    happyAuth()
    hoisted.fromHandlers.set(
      'captures',
      makeChain({ data: null, error: { message: 'boom' } }, { table: 'captures' }),
    )
    setDeletableProject()

    const res = await DELETE(deleteReq(), makeParams())
    expect(res.status).toBe(500)
    // The project must survive a teardown we could not even enumerate.
    expect(hoisted.tableDelete).not.toHaveBeenCalledWith('projects')
  })

  it('returns 401 when unauthenticated and touches nothing', async () => {
    hoisted.getUser.mockResolvedValue({ data: { user: null }, error: null })
    hoisted.getCurrentWorkspaceId.mockResolvedValue('ws-1')

    const res = await DELETE(deleteReq(), makeParams())
    expect(res.status).toBe(401)
    expect(hoisted.rpc).not.toHaveBeenCalled()
    expect(hoisted.tableDelete).not.toHaveBeenCalled()
  })

  it('returns 400 when the request carries no workspace', async () => {
    hoisted.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    hoisted.getCurrentWorkspaceId.mockResolvedValue(null)

    const res = await DELETE(deleteReq(), makeParams())
    expect(res.status).toBe(400)
    expect(hoisted.rpc).not.toHaveBeenCalled()
    expect(hoisted.tableDelete).not.toHaveBeenCalled()
  })

  // projects_delete RLS (migration 028) is owner/admin or the project lead;
  // any member can SEE the project. The check must run before any capture is
  // torn down, or a refused delete still destroys the caller's recordings.
  it('returns 403 for a plain member who is not the lead, and tears nothing down', async () => {
    happyAuth()
    hoisted.fromHandlers.set('captures', capturesChain(['cap-1']))
    setDeletableProject('member', 'someone-else')

    const res = await DELETE(deleteReq(), makeParams())
    expect(res.status).toBe(403)
    expect(hoisted.rpc).not.toHaveBeenCalled()
    expect(hoisted.tableDelete).not.toHaveBeenCalledWith('projects')
  })

  it('lets the project lead delete', async () => {
    happyAuth()
    hoisted.fromHandlers.set('captures', capturesChain(['cap-1']))
    setDeletableProject('member', 'mem-1')

    const res = await DELETE(deleteReq(), makeParams())
    expect(res.status).toBe(200)
    expect(hoisted.rpc).toHaveBeenCalledTimes(1)
    expect(hoisted.tableDelete).toHaveBeenCalledWith('projects')
  })

  it('returns 404 when the project is not visible, and tears nothing down', async () => {
    happyAuth()
    hoisted.fromHandlers.set('captures', capturesChain(['cap-1']))
    hoisted.fromHandlers.set('projects', makeChain({ data: null, error: null }, { table: 'projects' }))

    const res = await DELETE(deleteReq(), makeParams())
    expect(res.status).toBe(404)
    expect(hoisted.rpc).not.toHaveBeenCalled()
  })

  it('does not report success when the delete matches no row', async () => {
    happyAuth()
    hoisted.fromHandlers.set('captures', capturesChain([]))
    setDeletableProject('owner', null, 0)

    const res = await DELETE(deleteReq(), makeParams())
    expect(res.status).toBe(403)
  })
})
