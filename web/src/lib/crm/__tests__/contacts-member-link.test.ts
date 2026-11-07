import { describe, it, expect, vi, beforeEach } from 'vitest'
import { withMemberSchema } from '@/test/member-schema'

/**
 * A teammate who turns up as a meeting attendee is linked to their member:
 * findOrCreateContact sets the new contact's member_id, and
 * seedCaptureParticipants sets the participant row's. Both matched members by
 * email, which member doesn't have (`.eq('email', …)`, and an auth.users embed
 * PostgREST can't resolve), so neither ever linked anyone. The double answers
 * member queries with the table's real columns, as PostgREST does.
 */

vi.mock('@/lib/oauth/token-manager', () => ({ getValidTokenForAccount: vi.fn() }))
vi.mock('@/lib/email/account-scope', () => ({ getWorkspaceEmailAccountIds: vi.fn() }))

let db: unknown = null
vi.mock('@/lib/admin', () => ({ getServiceClient: () => db }))

const { findOrCreateContact, seedCaptureParticipants } = await import('@/lib/crm/contacts')
const { _resetMemberEmailCacheForTests } = await import('@/lib/workspace-member-emails')

type Row = Record<string, unknown>

const DANA = { id: 'member-dana', user_id: 'user-dana', display_name: 'Dana Scully' }

/** Tables that remember their inserts; member rows and auth users as given. */
function useDb(opts: { members: Row[]; users: Record<string, string> }) {
  const inserts: Record<string, Row[]> = {}
  let seq = 0
  db = withMemberSchema({
    from(table: string) {
      const filters: Record<string, unknown> = {}
      let inserted: Row | null = null
      const query: Record<string, unknown> = {}
      for (const method of ['select', 'is', 'or', 'in', 'limit', 'order', 'neq']) query[method] = () => query
      query.eq = (column: string, value: unknown) => ((filters[column] = value), query)
      query.insert = (values: Row) => {
        inserted = { id: `${table}-${++seq}`, ...values }
        ;(inserts[table] ??= []).push(inserted)
        return query
      }
      const result = () => {
        if (table === 'member') return { data: opts.members, error: null }
        if (inserted) return { data: inserted, error: null }
        if (filters.id) return { data: (inserts[table] ?? []).find((r) => r.id === filters.id) ?? null, error: null }
        return { data: null, error: null }
      }
      query.maybeSingle = async () => result()
      query.single = async () => result()
      query.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve)
      return query
    },
    auth: {
      admin: {
        getUserById: async (id: string) => ({ data: { user: { id, email: opts.users[id] ?? null } }, error: null }),
      },
    },
  })
  return inserts
}

beforeEach(() => {
  _resetMemberEmailCacheForTests()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('findOrCreateContact — the teammate link', () => {
  it("links a new contact to the teammate whose sign-in email it is", async () => {
    const inserts = useDb({ members: [DANA], users: { 'user-dana': 'Dana@Dial8.ai' } })

    await findOrCreateContact('ws-1', { email: 'dana@dial8.ai', fullName: 'Dana Scully', source: 'calendar_sync' })

    expect(inserts.contact).toEqual([expect.objectContaining({ email: 'dana@dial8.ai', member_id: 'member-dana' })])
  })

  it('leaves anyone else unlinked', async () => {
    const inserts = useDb({ members: [DANA], users: { 'user-dana': 'dana@dial8.ai' } })

    await findOrCreateContact('ws-1', { email: 'nikhil.rao@pagetrail.ai', fullName: 'Nikhil Rao', source: 'calendar_sync' })

    expect(inserts.contact).toEqual([expect.objectContaining({ email: 'nikhil.rao@pagetrail.ai', member_id: null })])
  })
})

describe('seedCaptureParticipants — the teammate link', () => {
  it("gives a teammate attendee's participant row their member id", async () => {
    const inserts = useDb({ members: [DANA], users: { 'user-dana': 'dana@dial8.ai' } })

    await seedCaptureParticipants('capture-1', 'ws-1', [
      { email: 'Dana@dial8.ai', name: 'Dana Scully' },
      { email: 'nikhil.rao@pagetrail.ai', name: 'Nikhil Rao' },
    ])

    expect(inserts.capture_participant).toEqual([
      expect.objectContaining({ capture_id: 'capture-1', external_email: 'dana@dial8.ai', member_id: 'member-dana' }),
      expect.objectContaining({ capture_id: 'capture-1', external_email: 'nikhil.rao@pagetrail.ai', member_id: null }),
    ])
  })
})
