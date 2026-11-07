import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withMemberSchema } from '@/test/member-schema'

/**
 * Members' sign-in emails, resolved from `member.user_id` through the admin
 * API: there is no member.email column, and reading one made PostgREST reject
 * the whole query. The fake refuses any member column the migrations don't
 * define, so the helper's own read is pinned to real columns.
 */

let service: unknown = null
vi.mock('@/lib/admin', () => ({ getServiceClient: () => service }))

const { listMemberEmails, findMembersByEmail, findMemberByEmail, _resetMemberEmailCacheForTests } = await import(
  '@/lib/workspace-member-emails'
)

type MemberRow = { id: string; user_id: string; display_name: string | null }

function makeService(opts: {
  members: MemberRow[]
  /** user_id → email; an Error makes that lookup fail. */
  users: Record<string, string | null | Error>
  memberError?: string
}) {
  const calls = { memberReads: 0, lookups: [] as string[] }
  const fake = {
    from(table: string) {
      const query: Record<string, unknown> = {}
      query.select = () => query
      query.eq = () => query
      query.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'member') calls.memberReads++
        const result = opts.memberError
          ? { data: null, error: { message: opts.memberError } }
          : { data: table === 'member' ? opts.members : [], error: null }
        return Promise.resolve(result).then(resolve)
      }
      return query
    },
    auth: {
      admin: {
        getUserById: async (id: string) => {
          calls.lookups.push(id)
          const user = opts.users[id]
          if (user instanceof Error) return { data: { user: null }, error: { message: user.message } }
          return { data: { user: user === undefined ? null : { id, email: user } }, error: null }
        },
      },
    },
  }
  service = withMemberSchema(fake)
  return calls
}

const ADA: MemberRow = { id: 'm-ada', user_id: 'u-ada', display_name: 'Ada' }
const BO: MemberRow = { id: 'm-bo', user_id: 'u-bo', display_name: 'Bo' }
const CY: MemberRow = { id: 'm-cy', user_id: 'u-cy', display_name: null }

beforeEach(() => {
  _resetMemberEmailCacheForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('listMemberEmails', () => {
  it("resolves each member's sign-in email through the admin API, lower-cased", async () => {
    const calls = makeService({ members: [ADA, BO, CY], users: { 'u-ada': 'Ada@Acme.com', 'u-bo': 'bo@acme.com', 'u-cy': null } })

    expect(await listMemberEmails('ws-1')).toEqual([
      { id: 'm-ada', userId: 'u-ada', displayName: 'Ada', email: 'ada@acme.com' },
      { id: 'm-bo', userId: 'u-bo', displayName: 'Bo', email: 'bo@acme.com' },
    ])
    expect(calls.lookups).toEqual(['u-ada', 'u-bo', 'u-cy'])
  })

  it("keeps a workspace's list for a minute", async () => {
    vi.useFakeTimers()
    const calls = makeService({ members: [ADA], users: { 'u-ada': 'ada@acme.com' } })

    await listMemberEmails('ws-1')
    await listMemberEmails('ws-1')
    expect(calls.memberReads).toBe(1)
    expect(calls.lookups).toHaveLength(1)

    vi.advanceTimersByTime(61_000)
    await listMemberEmails('ws-1')
    expect(calls.memberReads).toBe(2)
  })

  it('leaves out a member whose lookup failed, and does not keep that list', async () => {
    const calls = makeService({ members: [ADA, BO], users: { 'u-ada': 'ada@acme.com', 'u-bo': new Error('rate limited') } })

    expect((await listMemberEmails('ws-1')).map((m) => m.email)).toEqual(['ada@acme.com'])
    await listMemberEmails('ws-1')
    expect(calls.memberReads).toBe(2)
  })

  it('is empty, and not kept, when the member read fails', async () => {
    const calls = makeService({ members: [ADA], users: { 'u-ada': 'ada@acme.com' }, memberError: 'boom' })

    expect(await listMemberEmails('ws-1')).toEqual([])
    await listMemberEmails('ws-1')
    expect(calls.memberReads).toBe(2)
    expect(calls.lookups).toEqual([])
  })
})

describe('findMembersByEmail / findMemberByEmail', () => {
  it('matches case-insensitively and returns only the members asked for', async () => {
    makeService({ members: [ADA, BO], users: { 'u-ada': 'ada@acme.com', 'u-bo': 'bo@acme.com' } })

    const found = await findMembersByEmail('ws-1', ['ADA@acme.com', 'stranger@x.com', null])
    expect([...found.keys()]).toEqual(['ada@acme.com'])
    expect(found.get('ada@acme.com')?.id).toBe('m-ada')

    expect((await findMemberByEmail('ws-1', ' Bo@Acme.com '))?.id).toBe('m-bo')
    expect(await findMemberByEmail('ws-1', 'stranger@x.com')).toBeNull()
  })

  it('reads nothing when there is no email to look for', async () => {
    const calls = makeService({ members: [ADA], users: { 'u-ada': 'ada@acme.com' } })

    expect((await findMembersByEmail('ws-1', [])).size).toBe(0)
    expect(await findMemberByEmail('ws-1', '  ')).toBeNull()
    expect(calls.memberReads).toBe(0)
    expect(calls.lookups).toEqual([])
  })
})
