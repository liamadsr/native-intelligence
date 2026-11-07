/**
 * loadHeldContacts — the review card's list of contacts a run created that are
 * still held from HubSpot (Sequence step 2, plan A.1): work_touch `created`
 * contact rows joined to the contact rows that carry the hold, in the ledger's
 * order; a released contact drops out; any read error is an empty list.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadHeldContacts } from '../held-contacts'

const HOLD = { hubspot_push_hold: { at: '2026-09-01T00:00:00.000Z', by: 'unattended' } }

function fakeDb(args: {
  touches?: Array<{ entity_id: string }>
  contacts?: Array<Record<string, unknown>>
  touchError?: { message: string }
  contactError?: { message: string }
}) {
  const calls: Array<[string, unknown[]]> = []
  const db = {
    from(table: string) {
      if (table === 'work_touch') {
        const chain = {
          select: () => chain,
          eq: (...a: unknown[]) => {
            calls.push(['touch.eq', a])
            return chain
          },
          limit: () => Promise.resolve({ data: args.touches ?? [], error: args.touchError ?? null }),
        }
        return chain
      }
      if (table === 'contact') {
        const chain = {
          select: () => chain,
          in: (...a: unknown[]) => {
            calls.push(['contact.in', a])
            return chain
          },
          eq: (...a: unknown[]) => {
            calls.push(['contact.eq', a])
            return Promise.resolve({ data: args.contacts ?? [], error: args.contactError ?? null })
          },
        }
        return chain
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { db: db as unknown as SupabaseClient, calls }
}

const ITEM = { id: 'job-1', workspace_id: 'ws-1' }

describe('loadHeldContacts', () => {
  it('returns the held contacts the run created, in ledger order, fenced on the workspace', async () => {
    const { db, calls } = fakeDb({
      touches: [{ entity_id: 'c-2' }, { entity_id: 'c-1' }, { entity_id: 'c-2' }],
      contacts: [
        { id: 'c-1', full_name: 'Ada', email: 'ada@example.com', metadata: HOLD },
        { id: 'c-2', full_name: 'Bob', email: null, metadata: { ...HOLD, enrichment: {} } },
      ],
    })
    const out = await loadHeldContacts(db, ITEM)
    expect(out).toEqual([
      { id: 'c-2', full_name: 'Bob', email: null, held_at: '2026-09-01T00:00:00.000Z' },
      { id: 'c-1', full_name: 'Ada', email: 'ada@example.com', held_at: '2026-09-01T00:00:00.000Z' },
    ])
    expect(calls).toEqual([
      ['touch.eq', ['work_item_id', 'job-1']],
      ['touch.eq', ['entity_type', 'contact']],
      ['touch.eq', ['verb', 'created']],
      ['contact.in', ['id', ['c-2', 'c-1']]],
      ['contact.eq', ['workspace_id', 'ws-1']],
    ])
  })

  it('a released contact (no marker) drops out; no touches means no contact read at all', async () => {
    const released = fakeDb({
      touches: [{ entity_id: 'c-1' }],
      contacts: [{ id: 'c-1', full_name: 'Ada', email: 'a@x.io', metadata: { enrichment: {} } }],
    })
    expect(await loadHeldContacts(released.db, ITEM)).toEqual([])
    const none = fakeDb({ touches: [] })
    expect(await loadHeldContacts(none.db, ITEM)).toEqual([])
    expect(none.calls.some(([k]) => k.startsWith('contact.'))).toBe(false)
  })

  it('a read error is an empty list, never a throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await loadHeldContacts(fakeDb({ touchError: { message: 'boom' } }).db, ITEM)).toEqual([])
    expect(
      await loadHeldContacts(fakeDb({ touches: [{ entity_id: 'c-1' }], contactError: { message: 'boom' } }).db, ITEM),
    ).toEqual([])
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
