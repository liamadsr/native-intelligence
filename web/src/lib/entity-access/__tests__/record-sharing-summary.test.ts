/**
 * loadRecordSharing (docs/plans/record-sharing.md, Phase 3): what a record's
 * header says about its sharing, under the viewer's RLS, never throwing.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadRecordSharing } from '../store'

function client(opts: { canShare?: boolean; onlyByGrant?: boolean; count?: number; fail?: boolean }) {
  const counted = vi.fn()
  const rpc = vi.fn(async (name: string) => {
    if (opts.fail) throw new Error('down')
    if (name === 'entity_access_can_share') return { data: opts.canShare ?? false, error: null }
    if (name === 'entity_grant_only') return { data: opts.onlyByGrant ?? false, error: null }
    return { data: null, error: { message: 'no' } }
  })
  const chain = {
    select: (_c: string, o: unknown) => (counted(o), chain),
    eq: () => chain,
    then: (resolve: (v: unknown) => void) => resolve({ count: opts.count ?? 0, error: null }),
  }
  return { db: { rpc, from: vi.fn(() => chain) } as unknown as SupabaseClient, counted }
}

describe('loadRecordSharing', () => {
  it('for its owner: may share, and how many it is shared with', async () => {
    const { db, counted } = client({ canShare: true, count: 2 })
    expect(await loadRecordSharing(db, 'ws', 'canvas', 'c')).toEqual({ can_share: true, held: false, grant_count: 2, shared_with_me: false })
    expect(counted).toHaveBeenCalledWith({ count: 'exact', head: true })
  })

  it('for someone it was shared with: shared with them, and no count', async () => {
    const { db } = client({ canShare: false, onlyByGrant: true, count: 5 })
    expect(await loadRecordSharing(db, 'ws', 'spreadsheet', 's')).toEqual({ can_share: false, held: false, grant_count: 0, shared_with_me: true })
  })

  it('for a member of a workspace record: nothing to say', async () => {
    const { db } = client({})
    expect(await loadRecordSharing(db, 'ws', 'document', 'd')).toEqual({ can_share: false, held: false, grant_count: 0, shared_with_me: false })
  })

  it('never throws', async () => {
    const { db } = client({ fail: true })
    expect(await loadRecordSharing(db, 'ws', 'canvas', 'c')).toEqual({ can_share: false, held: false, grant_count: 0, shared_with_me: false })
  })
})
