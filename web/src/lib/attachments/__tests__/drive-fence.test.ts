/**
 * The Drive upload rule for a service-role reader (migration 709,
 * drive_upload_visible_to): its uploader always; another non-guest member
 * only while it is filed in a folder; a guest never; no person never. Before
 * 709 (no column) there are no Drive uploads; any other failed read hides.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { driveFence, filterVisibleAttachments } from '../visibility'

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'

function client(opts: { rows?: unknown[]; rowsError?: { code?: string; message: string }; filed?: string[]; role?: string | null }) {
  return {
    from: (table: string) => {
      const q: Record<string, (...a: unknown[]) => unknown> = {}
      for (const m of ['select', 'eq', 'in']) q[m] = () => q
      q.maybeSingle = async () => ({ data: opts.role === null ? null : { role: opts.role ?? 'member' }, error: null })
      ;(q as { then?: unknown }).then = (resolve: (v: unknown) => void) => {
        if (table === 'attachments') return resolve(opts.rowsError ? { data: null, error: opts.rowsError } : { data: opts.rows ?? [], error: null })
        if (table === 'drive_folder_item') return resolve({ data: (opts.filed ?? []).map((item_id) => ({ item_id })), error: null })
        return resolve({ data: [], error: null })
      }
      return q
    },
  } as unknown as SupabaseClient
}

const rows = [
  { id: 'unfiled', user_id: A, drive_upload: true },
  { id: 'filed', user_id: A, drive_upload: true },
  { id: 'project', user_id: A, drive_upload: false },
]
const asked = rows.map((r) => ({ id: r.id, note_id: null }))

describe('driveFence', () => {
  it('hides another’s unfiled upload from a member, and shows a filed one', async () => {
    expect([...(await driveFence(client({ rows, filed: ['filed'] }), { workspaceId: 'ws', userId: B }, asked))]).toEqual(['unfiled'])
  })

  it('shows the uploader both', async () => {
    expect((await driveFence(client({ rows, filed: [] }), { workspaceId: 'ws', userId: A }, asked)).size).toBe(0)
  })

  it('hides both from a guest, and from someone not a member', async () => {
    expect([...(await driveFence(client({ rows, filed: ['filed'], role: 'guest' }), { workspaceId: 'ws', userId: B }, asked))].sort()).toEqual(['filed', 'unfiled'])
    expect([...(await driveFence(client({ rows, filed: ['filed'], role: null }), { workspaceId: 'ws', userId: B }, asked))].sort()).toEqual(['filed', 'unfiled'])
  })

  it('hides every Drive upload with no person', async () => {
    expect([...(await driveFence(client({ rows, filed: ['filed'] }), { workspaceId: 'ws', userId: null }, asked))].sort()).toEqual(['filed', 'unfiled'])
  })

  it('before 709 there are no Drive uploads; any other failed read hides what it was about', async () => {
    expect((await driveFence(client({ rowsError: { code: '42703', message: 'no column' } }), { workspaceId: 'ws', userId: B }, asked)).size).toBe(0)
    expect((await driveFence(client({ rowsError: { code: '500', message: 'down' } }), { workspaceId: 'ws', userId: B }, asked)).size).toBe(3)
  })

  it('asks nothing about a file on a capture', async () => {
    expect((await driveFence(client({ rowsError: { message: 'should not be read' } }), { workspaceId: 'ws', userId: B }, [{ id: 'x', note_id: 'cap' }])).size).toBe(0)
  })

  it('filterVisibleAttachments drops another member’s unfiled Drive upload', async () => {
    const visible = await filterVisibleAttachments(client({ rows, filed: ['filed'] }), { workspaceId: 'ws', userId: B }, rows.map((r) => ({ id: r.id, user_id: r.user_id, note_id: null, data_row_id: null })))
    expect(visible.map((r) => r.id)).toEqual(['filed', 'project'])
  })
})
