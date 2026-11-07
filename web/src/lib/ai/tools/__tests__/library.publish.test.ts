/**
 * Publishing to Discover from CHAT is owner/admin only, as on the HTTP routes
 * (skills POST / PATCH) and over MCP (library-lockdown.test.ts).
 *
 * visibility 'public' puts a skill in front of every Dial8 user. These tools
 * run on the SERVICE client (the chat, skill-run and work-run tool routes), so
 * no RLS applies and the role check is the only fence:
 *   - create_skill reads the caller's role in the TARGET workspace (the one
 *     resolveCreateWorkspace picked), never the session's;
 *   - update_skill reads it in the row's resolved workspace, and gates only the
 *     TRANSITION to public: a creator re-saving an already-public skill is fine.
 * A refusal is `{ success: false, error: PUBLISH_ROLE_ERROR, code: 'PUBLISH_FORBIDDEN' }`
 * and writes nothing.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PUBLISH_ROLE_ERROR } from '@/lib/library/queries'
import { createLibraryTools } from '../library'

const ME = 'user-me'
const OTHER = 'user-other'
const WS = 'ws-session'
const WS2 = 'ws-other'

const EXEC = { toolCallId: 'c', messages: [], context: {} } as never

type Row = Record<string, unknown>
type Role = 'owner' | 'admin' | 'member'

const FORBIDDEN = { success: false, error: PUBLISH_ROLE_ERROR, code: 'PUBLISH_FORBIDDEN' }

const skill = (id: string, fields: Row): Row => ({
  id,
  name: id,
  slug: id,
  category: 'skill',
  is_system: false,
  workspace_id: WS,
  created_by: ME,
  visibility: 'personal',
  ...fields,
})

/**
 * An in-memory service client: `eq` / `neq` filter, every other builder step
 * passes through (the slug probe's `or` then counts every row as taken, which
 * only suffixes). Inserts and updates are recorded and echoed.
 */
function fakeDb(roles: Partial<Record<string, Role>>, recipes: Row[] = []) {
  const tables: Record<string, Row[]> = {
    recipe: recipes.map((r) => ({ ...r })),
    member: Object.entries(roles).map(([workspace_id, role]) => ({ id: `m-${workspace_id}`, user_id: ME, workspace_id, role })),
  }
  const writes: Array<{ op: 'insert' | 'update'; payload: Row }> = []

  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let write: { op: 'insert' | 'update'; payload: Row } | null = null
    const settle = (): Row[] => {
      const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
      if (!write) return rows
      writes.push(write)
      return write.op === 'insert' ? [{ id: 'new-skill', ...write.payload }] : rows.map((r) => ({ ...r, ...write!.payload }))
    }
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (payload: Row) => ((write = { op: 'insert', payload }), b),
      update: (payload: Row) => ((write = { op: 'update', payload }), b),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
      or: () => b,
      not: () => b,
      order: () => b,
      limit: () => b,
      single: async () => {
        const rows = settle()
        return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } }
      },
      maybeSingle: async () => ({ data: settle()[0] ?? null, error: null }),
      then: (resolve: (r: unknown) => unknown) => Promise.resolve({ data: settle(), error: null }).then(resolve),
    }
    return b
  }
  return { supabase: { from } as unknown as SupabaseClient, writes }
}

const DRAFT = { name: 'Weekly brief', description: 'When the user wants the weekly brief.', system_prompt: 'Write the brief.' }

async function create(db: ReturnType<typeof fakeDb>, args: Row) {
  return (await createLibraryTools(ME, db.supabase, WS).create_skill.execute!({ ...DRAFT, ...args } as never, EXEC)) as Row
}

async function update(db: ReturnType<typeof fakeDb>, args: Row) {
  return (await createLibraryTools(ME, db.supabase, WS).update_skill.execute!({ id: 'rec-1', ...args } as never, EXEC)) as Row
}

describe('publishing to Discover from chat is owner/admin only', () => {
  it('create_skill: a member cannot create as public, and nothing is written', async () => {
    const db = fakeDb({ [WS]: 'member' })
    expect(await create(db, { visibility: 'public' })).toEqual(FORBIDDEN)
    expect(db.writes).toEqual([])
  })

  it('create_skill: a caller with no member row is never an admin', async () => {
    const db = fakeDb({})
    expect(await create(db, { visibility: 'public' })).toEqual(FORBIDDEN)
    expect(db.writes).toEqual([])
  })

  it('create_skill: an owner or admin can publish', async () => {
    for (const role of ['owner', 'admin'] as const) {
      const db = fakeDb({ [WS]: role })
      const res = await create(db, { visibility: 'public' })
      expect(res.success, role).toBe(true)
      expect(db.writes.map((w) => w.op), role).toEqual(['insert'])
      expect(db.writes[0].payload, role).toMatchObject({ visibility: 'public', workspace_id: WS, created_by: ME })
    }
  })

  it('create_skill: the role is read in the TARGET workspace, not the session’s', async () => {
    // An admin of the target, a plain member of the session's workspace: allowed.
    const allowed = fakeDb({ [WS]: 'member', [WS2]: 'admin' })
    const ok = await create(allowed, { visibility: 'public', workspace_id: WS2 })
    expect(ok.success).toBe(true)
    expect(allowed.writes[0].payload).toMatchObject({ visibility: 'public', workspace_id: WS2 })

    // An admin of the session's workspace, a plain member of the target: refused.
    const refused = fakeDb({ [WS]: 'admin', [WS2]: 'member' })
    expect(await create(refused, { visibility: 'public', workspace_id: WS2 })).toEqual(FORBIDDEN)
    expect(refused.writes).toEqual([])
  })

  it('create_skill: personal and workspace visibility need no role', async () => {
    for (const visibility of [undefined, 'personal', 'workspace']) {
      const db = fakeDb({ [WS]: 'member' })
      const res = await create(db, visibility ? { visibility } : {})
      expect(res.success, String(visibility)).toBe(true)
    }
  })

  it('update_skill: a member cannot flip their own skill to public, and nothing is written', async () => {
    const db = fakeDb({ [WS]: 'member' }, [skill('rec-1', {})])
    expect(await update(db, { visibility: 'public' })).toEqual(FORBIDDEN)
    expect(db.writes).toEqual([])
  })

  it('update_skill: a creator re-saving an already-public skill is fine (only the transition is gated)', async () => {
    const db = fakeDb({ [WS]: 'member' }, [skill('rec-1', { visibility: 'public' })])
    const res = await update(db, { visibility: 'public', name: 'Still public' })
    expect(res.success).toBe(true)
    expect(db.writes).toEqual([{ op: 'update', payload: { name: 'Still public', visibility: 'public' } }])
  })

  it('update_skill: an admin can publish their own skill or a teammate’s shared one', async () => {
    for (const row of [skill('rec-1', {}), skill('rec-1', { created_by: OTHER, visibility: 'workspace' })]) {
      const db = fakeDb({ [WS]: 'admin' }, [row])
      const res = await update(db, { visibility: 'public' })
      expect(res.success, String(row.created_by)).toBe(true)
      expect(db.writes).toEqual([{ op: 'update', payload: { visibility: 'public' } }])
    }
  })

  it('update_skill: the role is read in the row’s own workspace, not the session’s', async () => {
    // The row lives in WS2; the session is WS.
    const row = skill('rec-1', { workspace_id: WS2 })
    const allowed = fakeDb({ [WS]: 'member', [WS2]: 'admin' }, [row])
    expect((await update(allowed, { visibility: 'public' })).success).toBe(true)
    expect(allowed.writes.map((w) => w.op)).toEqual(['update'])

    const refused = fakeDb({ [WS]: 'admin', [WS2]: 'member' }, [row])
    expect(await update(refused, { visibility: 'public' })).toEqual(FORBIDDEN)
    expect(refused.writes).toEqual([])
  })

  it('update_skill: a member can still edit or narrow their own skill', async () => {
    const db = fakeDb({ [WS]: 'member' }, [skill('rec-1', { visibility: 'public' })])
    const res = await update(db, { visibility: 'workspace' })
    expect(res.success).toBe(true)
    expect(db.writes).toEqual([{ op: 'update', payload: { visibility: 'workspace' } }])
  })
})
