/**
 * Tests for /api/account/reminders (GET / POST / DELETE).
 *
 * The load-bearing behaviour here is:
 *   - validation: entity_type is one of the five, entity_id is a uuid,
 *     remind_at parses and sits inside the allowed window
 *   - the entity must exist IN THE WORKSPACE — the reminder table is
 *     polymorphic with no FK, so this route is the only thing binding a
 *     reminder to a real row. The per-type TABLE names are not uniformly
 *     plural (initiative/document are singular), so the tests assert the
 *     table actually queried.
 *   - upsert-replace: a second POST on an entity that already has a pending
 *     reminder RESCHEDULES it (update) rather than inserting a second row,
 *     and a lost 23505 race falls back to the same update.
 *   - GET/DELETE only ever touch PENDING rows (`delivered_at IS NULL`).
 *   - IDENTITY: all three verbs address a row by (user_id, entity_type,
 *     entity_id) — the partial unique index's key. workspace_id is a mutable
 *     STAMP, not part of the identity, so a reminder survives its entity being
 *     moved between workspaces (ids are preserved in place by the move engine)
 *     and re-homes on the next reschedule instead of stranding.
 *   - There is NO member_id column: the notification recipient is resolved by
 *     the cron from (user_id, workspace_id), because a stored recipient is
 *     client-writable under an owner-only RLS policy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspaceMember: vi.fn(),
  reminderInsert: vi.fn(),
  reminderUpdate: vi.fn(),
  reminderDelete: vi.fn(),
  reminderFilters: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: hoisted.requireWorkspaceMember,
}))

const ACTION_ID = '11111111-1111-4111-8111-111111111111'
const REMINDER_ID = '22222222-2222-4222-8222-222222222222'

/** A resolved promise-like chain that records the filters applied to it. */
function chain(result: unknown, record?: (op: string, args: unknown[]) => void) {
  const handler: ProxyHandler<object> = {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb)
      }
      if (prop === 'single' || prop === 'maybeSingle') {
        return () => Promise.resolve(result)
      }
      return (...args: unknown[]) => {
        record?.(prop, args)
        return new Proxy({}, handler)
      }
    },
  }
  return new Proxy({}, handler)
}

interface SupabaseOpts {
  /** Result of the entity-existence lookup (actions/projects/...). */
  entityRow?: unknown
  entityError?: { message: string } | null
  /** Result of the "is there already a pending reminder" probe. */
  existingReminder?: unknown
  /** Result of the INSERT (used when no pending row existed). */
  insertResult?: { data: unknown; error: { code?: string; message: string } | null }
  /** Result of the UPDATE (reschedule / 23505 retry). */
  updateResult?: { data: unknown; error: { message: string } | null }
  /** Result of the GET select. */
  getResult?: { data: unknown; error: { message: string } | null }
  deleteError?: { message: string } | null
}

/** Filters applied to a query, in `col=value` form, for identity assertions. */
function filtersOf(calls: Array<[string, unknown[]]>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [op, args] of calls) {
    if ((op === 'eq' || op === 'is') && args.length === 2) out[args[0] as string] = args[1]
  }
  return out
}

function makeFakeSupabase(opts: SupabaseOpts = {}) {
  const {
    entityRow = { id: ACTION_ID },
    entityError = null,
    existingReminder = null,
    insertResult = { data: { id: REMINDER_ID }, error: null },
    updateResult = { data: { id: REMINDER_ID }, error: null },
    getResult = { data: null, error: null },
    deleteError = null,
  } = opts

  const tablesQueried: string[] = []
  /** Filters recorded per reminder verb, so the tests can assert identity. */
  const reminderQueries: Array<{ verb: string; filters: Record<string, unknown> }> = []
  // The route probes `reminder` twice on POST (existence, then insert/update);
  // track which select this is so the fake can answer them differently.
  let reminderSelectCount = 0

  const recordFor = (verb: string) => {
    const calls: Array<[string, unknown[]]> = []
    const entry = { verb, filters: {} as Record<string, unknown> }
    reminderQueries.push(entry)
    return (op: string, args: unknown[]) => {
      calls.push([op, args])
      entry.filters = filtersOf(calls)
    }
  }

  return {
    tablesQueried,
    reminderQueries,
    from: (table: string) => {
      tablesQueried.push(table)

      if (table === 'reminder') {
        return {
          select: () => {
            reminderSelectCount += 1
            // First select on a POST is the pending-row probe; on a GET there
            // is only ever one select and it wants the full row.
            return chain(
              reminderSelectCount === 1 && existingReminder !== null
                ? { data: existingReminder, error: null }
                : getResult,
              recordFor('select'),
            )
          },
          insert: (payload: unknown) => {
            hoisted.reminderInsert(payload)
            return chain(insertResult, recordFor('insert'))
          },
          update: (payload: unknown) => {
            hoisted.reminderUpdate(payload)
            return chain(updateResult, recordFor('update'))
          },
          delete: () => {
            hoisted.reminderDelete()
            return chain({ data: null, error: deleteError }, recordFor('delete'))
          },
        }
      }

      // Any entity table: the existence check.
      const record = recordFor(`entity:${table}`)
      return { select: () => chain({ data: entityRow, error: entityError }, record) }
    },
  }
}

function makeAuthContext(supabaseOpts?: SupabaseOpts) {
  return {
    supabase: makeFakeSupabase(supabaseOpts),
    user: { id: 'user-1', email: 'test@nativeintelligence.test' },
    workspaceId: 'workspace-1',
    member: { id: 'member-1', role: 'owner' },
  }
}

const UNAUTHED_RESPONSE = new Response(JSON.stringify({ error: 'Unauthorized' }), {
  status: 401,
  headers: { 'Content-Type': 'application/json' },
})

const { GET, POST, DELETE } = await import('@/app/api/account/reminders/route')

function queryReq(method: 'GET' | 'DELETE', query: string): NextRequest {
  const url = `https://nativeintelligence.dev/api/account/reminders?${query}`
  const req = buildRequest({ url, method })
  // next/server NextRequest exposes nextUrl; polyfill it for tests
  Object.defineProperty(req, 'nextUrl', { value: new URL(url) })
  return req as unknown as NextRequest
}

function postReq(body: unknown): NextRequest {
  const url = 'https://nativeintelligence.dev/api/account/reminders'
  const req = buildRequest({ url, method: 'POST', body })
  Object.defineProperty(req, 'nextUrl', { value: new URL(url) })
  return req as unknown as NextRequest
}

/** An ISO instant safely inside the accepted window. */
function soon(msFromNow = 60 * 60 * 1000): string {
  return new Date(Date.now() + msFromNow).toISOString()
}

beforeEach(() => {
  hoisted.requireWorkspaceMember.mockReset()
  hoisted.reminderInsert.mockReset()
  hoisted.reminderUpdate.mockReset()
  hoisted.reminderDelete.mockReset()
  hoisted.reminderFilters.mockReset()
  hoisted.requireWorkspaceMember.mockResolvedValue(makeAuthContext())
})

/** The (user_id, entity_type, entity_id) + pending identity every verb uses. */
const PENDING_IDENTITY = {
  user_id: 'user-1',
  entity_type: 'action',
  entity_id: ACTION_ID,
  delivered_at: null,
}

// ─── GET ────────────────────────────────────────────────────────────────────

describe('GET /api/account/reminders', () => {
  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(UNAUTHED_RESPONSE)
    const res = await GET(queryReq('GET', `entity_type=action&entity_id=${ACTION_ID}`))
    expect(res.status).toBe(401)
  })

  it('returns 400 for an unknown entity_type', async () => {
    const res = await GET(queryReq('GET', `entity_type=contact&entity_id=${ACTION_ID}`))
    expect(res.status).toBe(400)
  })

  it('returns 400 for a non-uuid entity_id', async () => {
    const res = await GET(queryReq('GET', 'entity_type=action&entity_id=not-a-uuid'))
    expect(res.status).toBe(400)
  })

  it('returns null when the entity has no pending reminder', async () => {
    const res = await GET(queryReq('GET', `entity_type=action&entity_id=${ACTION_ID}`))
    expect(res.status).toBe(200)
    const body = await readJson<{ reminder: unknown }>(res)
    expect(body.reminder).toBeNull()
  })

  it('returns the pending reminder when one exists', async () => {
    const reminder = { id: REMINDER_ID, entity_type: 'action', entity_id: ACTION_ID }
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(
      makeAuthContext({ getResult: { data: reminder, error: null } }),
    )
    const res = await GET(queryReq('GET', `entity_type=action&entity_id=${ACTION_ID}`))
    expect(res.status).toBe(200)
    const body = await readJson<{ reminder: { id: string } }>(res)
    expect(body.reminder.id).toBe(REMINDER_ID)
  })

  it('returns 500 when the select errors', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(
      makeAuthContext({ getResult: { data: null, error: { message: 'boom' } } }),
    )
    const res = await GET(queryReq('GET', `entity_type=action&entity_id=${ACTION_ID}`))
    expect(res.status).toBe(500)
  })
})

// ─── POST ───────────────────────────────────────────────────────────────────

describe('POST /api/account/reminders', () => {
  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(UNAUTHED_RESPONSE)
    const res = await POST(postReq({ entity_type: 'action', entity_id: ACTION_ID, remind_at: soon() }))
    expect(res.status).toBe(401)
    expect(hoisted.reminderInsert).not.toHaveBeenCalled()
  })

  it('returns 400 for an unknown entity_type', async () => {
    const res = await POST(postReq({ entity_type: 'meeting', entity_id: ACTION_ID, remind_at: soon() }))
    expect(res.status).toBe(400)
    expect(hoisted.reminderInsert).not.toHaveBeenCalled()
  })

  it('returns 400 when remind_at is missing', async () => {
    const res = await POST(postReq({ entity_type: 'action', entity_id: ACTION_ID }))
    expect(res.status).toBe(400)
    expect(hoisted.reminderInsert).not.toHaveBeenCalled()
  })

  it('returns 400 when remind_at is unparseable', async () => {
    const res = await POST(
      postReq({ entity_type: 'action', entity_id: ACTION_ID, remind_at: 'next tuesday-ish' }),
    )
    expect(res.status).toBe(400)
    expect(hoisted.reminderInsert).not.toHaveBeenCalled()
  })

  it('returns 400 when remind_at is well in the past', async () => {
    const res = await POST(
      postReq({ entity_type: 'action', entity_id: ACTION_ID, remind_at: soon(-60 * 60 * 1000) }),
    )
    expect(res.status).toBe(400)
    expect(hoisted.reminderInsert).not.toHaveBeenCalled()
  })

  it('accepts a remind_at marginally in the past (clock skew slack)', async () => {
    const res = await POST(
      postReq({ entity_type: 'action', entity_id: ACTION_ID, remind_at: soon(-5_000) }),
    )
    expect(res.status).toBe(200)
    expect(hoisted.reminderInsert).toHaveBeenCalled()
  })

  it('returns 400 when remind_at is beyond two years out', async () => {
    const threeYears = 3 * 365 * 24 * 60 * 60 * 1000
    const res = await POST(
      postReq({ entity_type: 'action', entity_id: ACTION_ID, remind_at: soon(threeYears) }),
    )
    expect(res.status).toBe(400)
    expect(hoisted.reminderInsert).not.toHaveBeenCalled()
  })

  it('returns 404 when the entity is not in this workspace', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(makeAuthContext({ entityRow: null }))
    const res = await POST(postReq({ entity_type: 'action', entity_id: ACTION_ID, remind_at: soon() }))
    expect(res.status).toBe(404)
    expect(hoisted.reminderInsert).not.toHaveBeenCalled()
  })

  it('inserts a pending reminder stamped with the caller workspace and user', async () => {
    const remindAt = soon()
    const res = await POST(postReq({ entity_type: 'action', entity_id: ACTION_ID, remind_at: remindAt }))
    expect(res.status).toBe(200)
    expect(hoisted.reminderInsert).toHaveBeenCalledWith({
      workspace_id: 'workspace-1',
      user_id: 'user-1',
      entity_type: 'action',
      entity_id: ACTION_ID,
      remind_at: new Date(remindAt).toISOString(),
    })
    expect(hoisted.reminderUpdate).not.toHaveBeenCalled()
  })

  // The recipient primitive is deliberately absent: any column naming an inbox
  // is writable by the row's owner under the owner-only UPDATE policy, so it
  // would let one member address a co-tenant's notifications. The cron resolves
  // it from (user_id, workspace_id) at fire time instead.
  it('never writes a member_id — the row carries no recipient column', async () => {
    await POST(postReq({ entity_type: 'action', entity_id: ACTION_ID, remind_at: soon() }))
    expect(hoisted.reminderInsert).toHaveBeenCalledWith(
      expect.not.objectContaining({ member_id: expect.anything() }),
    )
  })

  it('RESCHEDULES instead of inserting when a pending reminder already exists here', async () => {
    const remindAt = soon(2 * 60 * 60 * 1000)
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(
      makeAuthContext({
        existingReminder: { id: REMINDER_ID, workspace_id: 'workspace-1' },
      }),
    )
    const res = await POST(postReq({ entity_type: 'action', entity_id: ACTION_ID, remind_at: remindAt }))
    expect(res.status).toBe(200)
    expect(hoisted.reminderInsert).not.toHaveBeenCalled()
    expect(hoisted.reminderDelete).not.toHaveBeenCalled()
    expect(hoisted.reminderUpdate).toHaveBeenCalledWith({
      remind_at: new Date(remindAt).toISOString(),
    })
  })

  // The moved-entity case. Ids survive a workspace move in place (migration
  // 221's engine), so the pending row is found by the workspace-free identity
  // but still stamped with the workspace the entity LEFT. Firing it there would
  // deep-link an inbox in a workspace that no longer holds the entity.
  // workspace_id is frozen by the identity trigger, so re-homing is delete +
  // re-insert, not an update.
  it('RE-HOMES a pending reminder whose stamp is a different workspace', async () => {
    const remindAt = soon()
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(
      makeAuthContext({
        existingReminder: { id: REMINDER_ID, workspace_id: 'workspace-OLD' },
      }),
    )
    const res = await POST(postReq({ entity_type: 'action', entity_id: ACTION_ID, remind_at: remindAt }))
    expect(res.status).toBe(200)
    expect(hoisted.reminderDelete).toHaveBeenCalled()
    expect(hoisted.reminderUpdate).not.toHaveBeenCalled()
    expect(hoisted.reminderInsert).toHaveBeenCalledWith({
      workspace_id: 'workspace-1',
      user_id: 'user-1',
      entity_type: 'action',
      entity_id: ACTION_ID,
      remind_at: new Date(remindAt).toISOString(),
    })
  })

  it('returns 500 when the re-home delete fails, rather than orphaning the stale row', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(
      makeAuthContext({
        existingReminder: { id: REMINDER_ID, workspace_id: 'workspace-OLD' },
        deleteError: { message: 'boom' },
      }),
    )
    const res = await POST(postReq({ entity_type: 'action', entity_id: ACTION_ID, remind_at: soon() }))
    expect(res.status).toBe(500)
    expect(hoisted.reminderInsert).not.toHaveBeenCalled()
  })

  it('retries as an update when the insert loses a 23505 race', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(
      makeAuthContext({
        insertResult: { data: null, error: { code: '23505', message: 'duplicate' } },
      }),
    )
    const res = await POST(postReq({ entity_type: 'action', entity_id: ACTION_ID, remind_at: soon() }))
    expect(res.status).toBe(200)
    expect(hoisted.reminderInsert).toHaveBeenCalled()
    expect(hoisted.reminderUpdate).toHaveBeenCalled()
  })

  it('restores the original row when a re-home insert fails, so a failed move is not data loss', async () => {
    // Re-home = delete stale + insert fresh. If the fresh insert fails after the
    // delete succeeded, the user's pending reminder would vanish. The route must
    // re-insert the original (old workspace + old remind_at) instead.
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(
      makeAuthContext({
        existingReminder: {
          id: REMINDER_ID,
          workspace_id: 'workspace-OLD',
          remind_at: '2026-08-06T09:00:00.000Z',
        },
        insertResult: { data: null, error: { code: '42501', message: 'denied' } },
      }),
    )
    const res = await POST(postReq({ entity_type: 'action', entity_id: ACTION_ID, remind_at: soon() }))
    expect(res.status).toBe(500)
    expect(hoisted.reminderDelete).toHaveBeenCalled()
    // Two inserts: the failed re-home, then the restore of the original row.
    expect(hoisted.reminderInsert).toHaveBeenCalledTimes(2)
    expect(hoisted.reminderInsert).toHaveBeenLastCalledWith({
      workspace_id: 'workspace-OLD',
      user_id: 'user-1',
      entity_type: 'action',
      entity_id: ACTION_ID,
      remind_at: '2026-08-06T09:00:00.000Z',
    })
  })

  it('returns 500 when the insert fails for a non-conflict reason', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(
      makeAuthContext({
        insertResult: { data: null, error: { code: '42501', message: 'denied' } },
      }),
    )
    const res = await POST(postReq({ entity_type: 'action', entity_id: ACTION_ID, remind_at: soon() }))
    expect(res.status).toBe(500)
    expect(hoisted.reminderUpdate).not.toHaveBeenCalled()
  })

  // The table names are deliberately non-uniform (see ENTITY_TABLES); a typo
  // here would 404 every reminder on that entity type.
  it.each([
    ['action', 'actions'],
    ['project', 'projects'],
    ['initiative', 'initiative'],
    ['capture', 'captures'],
    ['document', 'document'],
  ])('checks existence of a %s against the %s table', async (entityType, table) => {
    const ctx = makeAuthContext()
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(ctx)
    const res = await POST(postReq({ entity_type: entityType, entity_id: ACTION_ID, remind_at: soon() }))
    expect(res.status).toBe(200)
    expect(ctx.supabase.tablesQueried).toContain(table)
  })

  // This probe is the ONLY thing binding a polymorphic reminder to a real row in
  // a workspace the caller belongs to — it must apply to every type, not just
  // the ones with an extra visibility rule.
  it.each([
    ['action', 'actions'],
    ['project', 'projects'],
    ['initiative', 'initiative'],
    ['capture', 'captures'],
    ['document', 'document'],
  ])('binds the %s existence probe to THIS request workspace', async (entityType, table) => {
    const ctx = makeAuthContext()
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(ctx)
    await POST(postReq({ entity_type: entityType, entity_id: ACTION_ID, remind_at: soon() }))
    const probe = ctx.supabase.reminderQueries.find((q) => q.verb === `entity:${table}`)
    expect(probe?.filters).toMatchObject({ id: ACTION_ID, workspace_id: 'workspace-1' })
  })
})

// ─── Identity consistency across verbs ──────────────────────────────────────
//
// GET, DELETE and POST's probe/update must address the SAME row, or a reminder
// becomes invisible to one verb and unclearable by another. The partial unique
// index is keyed (user_id, entity_type, entity_id) with no workspace column, so
// that is the identity all three adopt — workspace_id is a stamp POST refreshes,
// never a filter.

describe('reminder identity is (user_id, entity_type, entity_id)', () => {
  async function filtersFor(verb: string, run: (ctx: ReturnType<typeof makeAuthContext>) => Promise<unknown>) {
    const ctx = makeAuthContext()
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(ctx)
    await run(ctx)
    return ctx.supabase.reminderQueries.find((q) => q.verb === verb)?.filters
  }

  it('GET selects on the identity and does NOT filter workspace_id', async () => {
    const filters = await filtersFor('select', () =>
      GET(queryReq('GET', `entity_type=action&entity_id=${ACTION_ID}`)),
    )
    expect(filters).toEqual(PENDING_IDENTITY)
  })

  it('DELETE deletes on the same identity and does NOT filter workspace_id', async () => {
    const filters = await filtersFor('delete', () =>
      DELETE(queryReq('DELETE', `entity_type=action&entity_id=${ACTION_ID}`)),
    )
    expect(filters).toEqual(PENDING_IDENTITY)
  })

  it("POST's pending probe uses the same identity as GET and DELETE", async () => {
    const filters = await filtersFor('select', () =>
      POST(postReq({ entity_type: 'action', entity_id: ACTION_ID, remind_at: soon() })),
    )
    expect(filters).toEqual(PENDING_IDENTITY)
  })

  it("POST's reschedule update uses the same identity", async () => {
    const ctx = makeAuthContext({
      existingReminder: { id: REMINDER_ID, workspace_id: 'workspace-1' },
    })
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(ctx)
    await POST(postReq({ entity_type: 'action', entity_id: ACTION_ID, remind_at: soon() }))
    const update = ctx.supabase.reminderQueries.find((q) => q.verb === 'update')
    expect(update?.filters).toEqual(PENDING_IDENTITY)
  })
})

// ─── DELETE ─────────────────────────────────────────────────────────────────

describe('DELETE /api/account/reminders', () => {
  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(UNAUTHED_RESPONSE)
    const res = await DELETE(queryReq('DELETE', `entity_type=action&entity_id=${ACTION_ID}`))
    expect(res.status).toBe(401)
    expect(hoisted.reminderDelete).not.toHaveBeenCalled()
  })

  it('returns 400 for a non-uuid entity_id', async () => {
    const res = await DELETE(queryReq('DELETE', 'entity_type=action&entity_id=nope'))
    expect(res.status).toBe(400)
    expect(hoisted.reminderDelete).not.toHaveBeenCalled()
  })

  it('clears the pending reminder', async () => {
    const res = await DELETE(queryReq('DELETE', `entity_type=action&entity_id=${ACTION_ID}`))
    expect(res.status).toBe(200)
    const body = await readJson<{ ok: boolean }>(res)
    expect(body.ok).toBe(true)
    expect(hoisted.reminderDelete).toHaveBeenCalled()
  })

  it('succeeds when there was nothing to remove (idempotent)', async () => {
    const res = await DELETE(queryReq('DELETE', `entity_type=action&entity_id=${ACTION_ID}`))
    expect(res.status).toBe(200)
  })

  it('returns 500 when the delete errors', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValueOnce(
      makeAuthContext({ deleteError: { message: 'boom' } }),
    )
    const res = await DELETE(queryReq('DELETE', `entity_type=action&entity_id=${ACTION_ID}`))
    expect(res.status).toBe(500)
  })
})
