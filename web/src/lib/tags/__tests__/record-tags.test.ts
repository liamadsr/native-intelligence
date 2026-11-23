/**
 * lib/tags/record-tags.ts on a fake client that behaves like row-level
 * security: rows the caller may not see are simply absent, and a refused
 * insert is error 42501. Ids are made up.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { addRecordTags, listRecordTags, removeRecordTags, setRecordTags } from '../record-tags'

const WS = 'a0000000-0000-4000-8000-000000000001'
const DOC = 'd0000000-0000-4000-8000-000000000001'
const T1 = 'b0000000-0000-4000-8000-000000000001'
const T2 = 'b0000000-0000-4000-8000-000000000002'
const OTHER_WS_TAG = 'b0000000-0000-4000-8000-000000000003'
const THEIR_PERSONAL = 'b0000000-0000-4000-8000-000000000004'

interface Db {
  records: Record<string, { id: string; workspace_id: string }[]>
  labels: { id: string; name: string; color: string; owner_user_id: string | null; workspace_id: string }[]
  joins: Record<string, Record<string, string>[]>
  refuseInsert?: boolean
  /** label ids hidden from the caller (another person's personal tags) */
  hidden: Set<string>
}

function fake(db: Db): SupabaseClient {
  const from = (table: string) => {
    const filters: Array<(r: Record<string, unknown>) => boolean> = []
    let op: 'select' | 'delete' = 'select'
    const rows = (): Record<string, unknown>[] => {
      if (table === 'label') return db.labels.filter((l) => !db.hidden.has(l.id))
      if (db.records[table]) return db.records[table]
      const j = db.joins[table] ?? []
      return j
        .filter((r) => !db.hidden.has(r.label_id))
        .map((r) => ({ ...r, label: db.labels.find((l) => l.id === r.label_id) ?? null }))
    }
    const run = () => {
      const hit = rows().filter((r) => filters.every((f) => f(r)))
      if (op === 'delete') {
        const j = db.joins[table]
        db.joins[table] = j.filter((r) => !hit.some((h) => h.label_id === r.label_id && Object.keys(r).every((k) => h[k] === r[k])))
      }
      return hit
    }
    const q = {
      select: () => q,
      delete: () => {
        op = 'delete'
        return q
      },
      eq: (c: string, v: unknown) => {
        filters.push((r) => r[c] === v)
        return q
      },
      in: (c: string, v: unknown[]) => {
        filters.push((r) => v.includes(r[c]))
        return q
      },
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      upsert: async (values: Record<string, string>[]) => {
        if (db.refuseInsert) return { error: { code: '42501', message: 'rls' } }
        const j = (db.joins[table] ??= [])
        for (const v of values) if (!j.some((r) => r.label_id === v.label_id && Object.keys(v).every((k) => r[k] === v[k]))) j.push(v)
        return { error: null }
      },
      then: (res: (v: { data: unknown; error: null }) => unknown) => res({ data: run(), error: null }),
    }
    return q
  }
  return { from } as unknown as SupabaseClient
}

function db(): Db {
  return {
    records: { document: [{ id: DOC, workspace_id: WS }] },
    labels: [
      { id: T1, name: 'Renewal', color: '#22c55e', owner_user_id: null, workspace_id: WS },
      { id: T2, name: 'Mine', color: '#ef4444', owner_user_id: 'me', workspace_id: WS },
      { id: OTHER_WS_TAG, name: 'Elsewhere', color: '#000000', owner_user_id: null, workspace_id: 'other' },
      { id: THEIR_PERSONAL, name: 'Theirs', color: '#111111', owner_user_id: 'them', workspace_id: WS },
    ],
    joins: { document_label: [{ document_id: DOC, label_id: THEIR_PERSONAL }] },
    hidden: new Set([THEIR_PERSONAL]),
  }
}

describe('record tags', () => {
  it('lists what the caller may see, marking personal tags', async () => {
    const d = db()
    d.joins.document_label.push({ document_id: DOC, label_id: T2 })
    const r = await listRecordTags(fake(d), 'document', DOC)
    expect(r).toEqual({ ok: true, value: [{ id: T2, name: 'Mine', color: '#ef4444', personal: true }] })
  })

  it('a record the caller cannot read is not found', async () => {
    const r = await listRecordTags(fake(db()), 'document', 'd0000000-0000-4000-8000-000000000009')
    expect(r).toMatchObject({ ok: false, status: 404 })
    expect(await listRecordTags(fake(db()), 'document', 'nope')).toMatchObject({ ok: false, status: 400 })
  })

  it('refuses a tag from another workspace or one the caller cannot see', async () => {
    expect(await addRecordTags(fake(db()), 'document', DOC, [OTHER_WS_TAG])).toMatchObject({ ok: false, status: 404 })
    expect(await addRecordTags(fake(db()), 'document', DOC, [THEIR_PERSONAL])).toMatchObject({ ok: false, status: 404 })
  })

  it('reports a policy refusal as forbidden', async () => {
    const d = db()
    d.refuseInsert = true
    expect(await addRecordTags(fake(d), 'document', DOC, [T1])).toMatchObject({ ok: false, status: 403 })
  })

  it('replaces the visible set and leaves another person’s personal tag', async () => {
    const d = db()
    d.joins.document_label.push({ document_id: DOC, label_id: T2 })
    const r = await setRecordTags(fake(d), 'document', DOC, [T1])
    expect(r.ok && r.value.map((t) => t.id)).toEqual([T1])
    expect(d.joins.document_label.map((j) => j.label_id).sort()).toEqual([T1, THEIR_PERSONAL].sort())
  })

  it('removes one', async () => {
    const d = db()
    d.joins.document_label.push({ document_id: DOC, label_id: T1 })
    expect(await removeRecordTags(fake(d), 'document', DOC, [T1])).toEqual({ ok: true, value: 1 })
    expect(d.joins.document_label.map((j) => j.label_id)).toEqual([THEIR_PERSONAL])
  })
})
