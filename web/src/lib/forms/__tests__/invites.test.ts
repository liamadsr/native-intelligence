/**
 * Personal links (../invites.ts): made with their secret shown once and only
 * its hash stored; good while unused and not lapsed, for their own form only;
 * claimed by one submission even when two arrive side by side; given back
 * when the write fails; pruned a month after.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  claimInvite,
  createInvites,
  deleteOldFormInvites,
  findInvite,
  generateInviteToken,
  hashInviteToken,
  inviteDays,
  inviteIsGood,
  isInviteTokenShape,
  markInviteStored,
  releaseInvite,
} from '../invites'

type Row = Record<string, unknown>

/**
 * data_form_invite in memory, through the calls the store makes. An update
 * re-reads its filters under one lock, as Postgres does: of two claims sent
 * side by side, the second finds the row already used.
 */
function inviteDb(rows: Row[] = []) {
  let n = 0
  const filterable = (run: (match: (r: Row) => boolean) => unknown) => {
    const filters: Array<(r: Row) => boolean> = []
    const match = (r: Row) => filters.every((f) => f(r))
    const q = {
      eq(col: string, v: unknown) {
        filters.push((r) => r[col] === v)
        return q
      },
      is(col: string, v: unknown) {
        filters.push((r) => (r[col] ?? null) === v)
        return q
      },
      gt(col: string, v: string) {
        filters.push((r) => String(r[col]) > v)
        return q
      },
      lt(col: string, v: string) {
        filters.push((r) => r[col] !== null && r[col] !== undefined && String(r[col]) < v)
        return q
      },
      select: () => q,
      maybeSingle: async () => run(match),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(run(match)).then(resolve),
    }
    return q
  }
  const client = {
    from: () => ({
      insert: (list: Row[]) => ({
        select: async () => {
          const made = list.map((r) => ({ id: `inv-${++n}`, created_at: '2026-11-15T12:00:00.000Z', used_at: null, row_id: null, ...r }))
          rows.push(...made)
          return { data: made, error: null }
        },
      }),
      select: () => filterable((match) => ({ data: rows.find(match) ?? null, error: null })),
      update: (patch: Row) =>
        filterable(async (match) => {
          await Promise.resolve()
          const row = rows.find(match)
          if (row) Object.assign(row, patch)
          return { data: row ? { ...row } : null, error: null }
        }),
      delete: () =>
        filterable((match) => {
          for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i])) rows.splice(i, 1)
          return { error: null }
        }),
    }),
  } as unknown as SupabaseClient
  return { client, rows }
}

const NOW = Date.parse('2026-11-15T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const tokenOf = (url: string) => url.split('/f/')[1]

describe('a personal link', () => {
  it('is fi_ and 32 random bytes, stored only as its SHA-256', () => {
    const token = generateInviteToken()
    expect(isInviteTokenShape(token)).toBe(true)
    expect(isInviteTokenShape(`fk_${token.slice(3)}`)).toBe(false)
    expect(hashInviteToken(token)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is made with its label and contact, lasting the days asked (14 by default, at most 90), the secret only in its link', async () => {
    const db = inviteDb()
    const made = await createInvites(db.client, { id: 'form-1' }, [{ label: 'Sam Rivera', contactId: 'c-1' }, { label: null, contactId: null }], { userId: 'u-1', origin: 'https://nativeintelligence.dev/', now: NOW })
    expect(made).toHaveLength(2)
    expect(made[0]).toMatchObject({ label: 'Sam Rivera', contactId: 'c-1', expiresAt: iso(NOW + 14 * 86_400_000) })
    expect(made[0].url).toMatch(/^https:\/\/nativeintelligence\.dev\/f\/fi_[A-Za-z0-9_-]{43}$/)
    const token = tokenOf(made[0].url)
    expect(db.rows[0]).toMatchObject({ form_id: 'form-1', token_hash: hashInviteToken(token), created_by: 'u-1' })
    expect(JSON.stringify(db.rows)).not.toContain(token)
    expect(inviteDays(undefined)).toBe(14)
    expect(inviteDays(500)).toBe(90)
    expect(inviteDays(0)).toBe(1)
  })

  it('is good unused and before it lapses; used, lapsed or another form\'s, it is not', async () => {
    expect(inviteIsGood({ usedAt: null, expiresAt: iso(NOW + 1) }, NOW)).toBe(true)
    expect(inviteIsGood({ usedAt: iso(NOW - 1), expiresAt: iso(NOW + 1) }, NOW)).toBe(false)
    expect(inviteIsGood({ usedAt: null, expiresAt: iso(NOW) }, NOW)).toBe(false)
    expect(inviteIsGood(null, NOW)).toBe(false)
    const db = inviteDb()
    const [made] = await createInvites(db.client, { id: 'form-1' }, [{ label: null, contactId: null }], { userId: 'u-1', origin: 'https://x.example', now: NOW })
    expect(await findInvite(db.client, 'form-1', tokenOf(made.url))).toMatchObject({ id: made.id, formId: 'form-1' })
    expect(await findInvite(db.client, 'form-2', tokenOf(made.url))).toBeNull()
    expect(await findInvite(db.client, 'form-1', generateInviteToken())).toBeNull()
    expect(await findInvite(db.client, 'form-1', 'not a token')).toBeNull()
  })

  it('is claimed by ONE of two submissions sent side by side, never by another form, never once lapsed', async () => {
    const db = inviteDb()
    const [made] = await createInvites(db.client, { id: 'form-1' }, [{ label: null, contactId: 'c-1' }], { userId: 'u-1', origin: 'https://x.example', now: NOW })
    const token = tokenOf(made.url)
    expect(await claimInvite(db.client, 'form-2', token, iso(NOW))).toBeNull()
    const [a, b] = await Promise.all([claimInvite(db.client, 'form-1', token, iso(NOW)), claimInvite(db.client, 'form-1', token, iso(NOW))])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    expect((a ?? b)!.contactId).toBe('c-1')
    expect(await claimInvite(db.client, 'form-1', token, iso(NOW))).toBeNull()

    const [late] = await createInvites(db.client, { id: 'form-1' }, [{ label: null, contactId: null }], { userId: 'u-1', origin: 'https://x.example', now: NOW, expiresInDays: 1 })
    expect(await claimInvite(db.client, 'form-1', tokenOf(late.url), iso(NOW + 2 * 86_400_000))).toBeNull()
  })

  it('is given back when its submission could not be stored, and kept once its row is stored', async () => {
    const db = inviteDb()
    const [made] = await createInvites(db.client, { id: 'form-1' }, [{ label: null, contactId: null }], { userId: 'u-1', origin: 'https://x.example', now: NOW })
    const token = tokenOf(made.url)
    const claimed = await claimInvite(db.client, 'form-1', token, iso(NOW))
    await releaseInvite(db.client, claimed!.id)
    const again = await claimInvite(db.client, 'form-1', token, iso(NOW))
    expect(again?.id).toBe(made.id)
    await markInviteStored(db.client, made.id, 'row-1')
    // A stored one stays used: giving it back is for a failed write only.
    await releaseInvite(db.client, made.id)
    expect(db.rows[0]).toMatchObject({ row_id: 'row-1', used_at: iso(NOW) })
    expect(await claimInvite(db.client, 'form-1', token, iso(NOW))).toBeNull()
  })

  it('is pruned once used or lapsed before the cut, never while it still works', async () => {
    const db = inviteDb([
      { id: 'old-used', used_at: iso(NOW - 40 * 86_400_000), expires_at: iso(NOW + 50 * 86_400_000) },
      { id: 'old-lapsed', used_at: null, expires_at: iso(NOW - 31 * 86_400_000) },
      { id: 'recent', used_at: iso(NOW - 86_400_000), expires_at: iso(NOW + 86_400_000) },
      { id: 'open', used_at: null, expires_at: iso(NOW + 86_400_000) },
    ])
    await deleteOldFormInvites(db.client, iso(NOW - 30 * 86_400_000))
    expect(db.rows.map((r) => r.id)).toEqual(['recent', 'open'])
  })
})
