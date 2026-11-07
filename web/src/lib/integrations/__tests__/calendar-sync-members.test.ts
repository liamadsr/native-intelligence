import { describe, it, expect, vi, beforeEach } from 'vitest'
import { withMemberSchema } from '@/test/member-schema'

/**
 * syncCalendarToCaptures seeds a pending capture's participants from the
 * invite, and a teammate among them is linked to their member. It matched
 * members with `.eq('email', …)`, a column member doesn't have, so PostgREST
 * refused the read and no participant was ever linked. The double answers
 * member queries with the table's real columns, as PostgREST does.
 */

vi.mock('@/lib/integrations/calendar', () => ({
  getCalendarProvider: vi.fn(async () => 'google'),
  listCalendarEvents: vi.fn(async () => [
    {
      id: 'evt-1',
      title: 'Roadmap review',
      start: '2026-10-01T16:00:00.000Z',
      end: '2026-10-01T16:45:00.000Z',
      organizer: 'me@dial8.ai',
      attendees: ['me@dial8.ai', 'Dana@dial8.ai', 'nikhil.rao@pagetrail.ai'],
    },
  ]),
}))
vi.mock('@/lib/oauth/token-manager', () => ({ getValidToken: vi.fn() }))
vi.mock('@/lib/crm/calendar-contacts', () => ({ ensureContactsForCalendarEvents: vi.fn(async () => ({ created: 0, skipped: 0 })) }))
vi.mock('@/lib/crm/contacts', () => ({ findOrCreateContact: vi.fn(async () => null) }))

let db: unknown = null
vi.mock('@/lib/admin', () => ({ getServiceClient: () => db }))

const { syncCalendarToCaptures } = await import('@/lib/integrations/calendar-sync')
const { _resetMemberEmailCacheForTests } = await import('@/lib/workspace-member-emails')

type Row = Record<string, unknown>

const MEMBERS = [
  { id: 'member-me', user_id: 'user-1', display_name: 'Liam' },
  { id: 'member-dana', user_id: 'user-dana', display_name: 'Dana Scully' },
]
const USERS: Record<string, string> = { 'user-1': 'me@dial8.ai', 'user-dana': 'dana@dial8.ai' }

function useDb() {
  const inserts: Record<string, Row[]> = {}
  const lookups: string[] = []
  db = withMemberSchema({
    from(table: string) {
      let inserted: Row | null = null
      const query: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'neq', 'is', 'limit', 'update']) query[method] = () => query
      query.insert = (values: Row) => {
        inserted = { id: `${table}-1`, ...values }
        ;(inserts[table] ??= []).push(inserted)
        return query
      }
      const result = () => ({ data: table === 'member' ? MEMBERS : inserted, error: null })
      query.maybeSingle = async () => result()
      query.single = async () => result()
      query.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve)
      return query
    },
    auth: {
      admin: {
        getUserById: async (id: string) => {
          lookups.push(id)
          return { data: { user: { id, email: USERS[id] ?? null } }, error: null }
        },
      },
    },
  })
  return { inserts, lookups }
}

beforeEach(() => {
  _resetMemberEmailCacheForTests()
})

describe('syncCalendarToCaptures — participants', () => {
  it('links teammates on the invite to their members, by sign-in email', async () => {
    const { inserts, lookups } = useDb()

    const res = await syncCalendarToCaptures('user-1', 'ws-1')

    expect(res).toEqual({ synced: 1, total: 1 })
    expect(inserts.capture_participant).toEqual([
      expect.objectContaining({ external_email: 'me@dial8.ai', member_id: 'member-me', role: 'organizer' }),
      expect.objectContaining({ external_email: 'dana@dial8.ai', member_id: 'member-dana' }),
      expect.objectContaining({ external_email: 'nikhil.rao@pagetrail.ai', member_id: null }),
    ])
    // One admin lookup per member for the whole sync, not one per attendee.
    expect(lookups.sort()).toEqual(['user-1', 'user-dana'])
  })
})
