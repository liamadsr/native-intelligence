import { describe, it, expect, vi, beforeEach } from 'vitest'
import { withMemberSchema } from '@/test/member-schema'

/**
 * Tests for ensureContactsForCalendarEvents — contact creation at calendar
 * FETCH time.
 *
 * Invariants locked in:
 *   - an external attendee of a real meeting becomes a contact (the bug: a
 *     synced Google meeting left nikhil.rao@… with no CRM row at all)
 *   - workspace members, the user's own connected/auth addresses, and anyone
 *     already in the CRM are never re-created
 *   - only real meetings count: all-day, cancelled, and 1-attendee events are
 *     ignored
 *   - the per-workspace throttle stops a re-fetching calendar view from
 *     redoing the sweep
 *   - a non-member writes NOTHING: the route takes workspaceId from the query
 *     string, so this function is the only membership boundary
 *   - a large-audience event (all-hands, webinar) is not a relationship
 *   - declined attendees, and events the user declined, are skipped
 *   - it NEVER throws — a CRM side effect must not break the calendar
 */

const hoisted = vi.hoisted(() => ({
  // Return type mirrors the real findOrCreateContact ({id} | null) so the
  // noise-filter-refusal case can be mocked without a cast.
  findOrCreateContact: vi.fn(
    async (): Promise<{ id: string } | null> => ({ id: 'contact-new' }),
  ),
}))

vi.mock('@/lib/crm/contacts', () => ({
  findOrCreateContact: hoisted.findOrCreateContact,
}))

let dbFake: unknown = null
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => dbFake,
}))

const { ensureContactsForCalendarEvents, _resetThrottleForTests } = await import(
  '@/lib/crm/calendar-contacts'
)
const { _resetMemberEmailCacheForTests } = await import('@/lib/workspace-member-emails')

type Row = Record<string, string | null>

/**
 * Fake honoring the reads the sweep issues, with the member table's REAL
 * columns: withMemberSchema answers a member query naming a column the table
 * lacks with PostgREST's error, as production answered `select('email, …')`.
 *   member:            .select('user_id').eq('workspace_id', …)          → the guard
 *                      .select('id, user_id, display_name').eq(…)        → teammates
 *   connected_account: .select('account_email').eq('user_id', …)
 *   contact:           .select('email').eq(…).in('email', […])
 *   auth.admin.getUserById(id) → that user's sign-in email (`users`)
 *
 * `members` defaults to a row for user-1 so the membership guard passes; pass
 * an explicit list (or []) to exercise the guard itself.
 */
function makeDb(opts: {
  members?: Row[]
  /** Sign-in emails by user id; user-1's is `authEmail`. */
  users?: Record<string, string>
  accounts?: Row[]
  contacts?: Row[]
  authEmail?: string | null
  throwOn?: string
}) {
  const members = opts.members ?? [{ id: 'member-1', user_id: 'user-1' }]
  const users: Record<string, string> = { 'user-1': opts.authEmail ?? 'me@dial8.ai', ...opts.users }
  /** Every getUserById call, in order. */
  const lookups: string[] = []
  function builder(rows: Row[], table: string) {
    const api: Record<string, unknown> = {
      select: () => api,
      eq: () => api,
      in: () => api,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        // Throw synchronously rather than returning a rejected promise: a
        // rejected thenable inside the sweep's Promise.all surfaces as an
        // unhandled rejection in the test runner, which is a mock artifact,
        // not the behavior under test.
        if (opts.throwOn === table) throw new Error('boom')
        return Promise.resolve({ data: rows, error: null }).then(resolve)
      },
    }
    return api
  }
  return withMemberSchema({
    lookups,
    from(table: string) {
      if (table === 'member') return builder(members, 'member')
      if (table === 'connected_account') return builder(opts.accounts ?? [], 'connected_account')
      if (table === 'contact') return builder(opts.contacts ?? [], 'contact')
      return builder([], table)
    },
    auth: {
      admin: {
        getUserById: async (id: string) => {
          lookups.push(id)
          return { data: { user: { id, email: users[id] ?? null } }, error: null }
        },
      },
    },
  })
}

/** A real meeting: timed, 2 attendees, not cancelled. */
function meeting(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    title: 'Nikhil & Liam',
    start: '2026-09-03T10:00:00Z',
    end: '2026-09-03T10:30:00Z',
    attendees: ['me@dial8.ai', 'nikhil.rao@pagetrail.ai'],
    attendeeDetails: [
      { email: 'me@dial8.ai' },
      { email: 'nikhil.rao@pagetrail.ai' },
    ],
    ...overrides,
  } as never
}

beforeEach(() => {
  hoisted.findOrCreateContact.mockClear()
  hoisted.findOrCreateContact.mockResolvedValue({ id: 'contact-new' })
  _resetThrottleForTests()
  _resetMemberEmailCacheForTests()
  dbFake = makeDb({})
})

describe('ensureContactsForCalendarEvents', () => {
  it('creates a contact for an unknown external attendee', async () => {
    const res = await ensureContactsForCalendarEvents('ws-1', 'user-1', [meeting()])

    expect(res.created).toBe(1)
    expect(hoisted.findOrCreateContact).toHaveBeenCalledTimes(1)
    expect(hoisted.findOrCreateContact).toHaveBeenCalledWith('ws-1', {
      email: 'nikhil.rao@pagetrail.ai',
      fullName: '',
      source: 'calendar_sync',
    })
  })

  it('passes the provider display name through when there is one', async () => {
    await ensureContactsForCalendarEvents('ws-1', 'user-1', [
      meeting({
        attendeeDetails: [
          { email: 'me@dial8.ai' },
          { email: 'nikhil.rao@pagetrail.ai', name: 'Nikhil Rao' },
        ],
      }),
    ])

    expect(hoisted.findOrCreateContact).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ fullName: 'Nikhil Rao' }),
    )
  })

  it('excludes workspace members, by the sign-in email on their auth user', async () => {
    // member has no email column: a teammate's address is resolved from their
    // user id. Selecting member.email made PostgREST refuse the guard's read,
    // so every sweep was refused as a non-member's.
    const db = makeDb({
      members: [
        { id: 'member-1', user_id: 'user-1' },
        { id: 'member-2', user_id: 'user-2' },
      ],
      users: { 'user-2': 'Nikhil.Rao@pagetrail.ai' },
    })
    dbFake = db

    const res = await ensureContactsForCalendarEvents('ws-1', 'user-1', [meeting()])

    expect(res.created).toBe(0)
    expect(hoisted.findOrCreateContact).not.toHaveBeenCalled()
    expect(db.lookups).toContain('user-2')
  })

  it('does not look teammates up when every address is already known', async () => {
    const db = makeDb({
      members: [
        { id: 'member-1', user_id: 'user-1' },
        { id: 'member-2', user_id: 'user-2' },
      ],
      users: { 'user-2': 'dana@dial8.ai' },
      contacts: [{ email: 'nikhil.rao@pagetrail.ai' }],
    })
    dbFake = db

    const res = await ensureContactsForCalendarEvents('ws-1', 'user-1', [meeting()])

    expect(res).toEqual({ created: 0, skipped: 2 })
    // Only the user's own auth lookup: no teammate list was needed.
    expect(db.lookups).toEqual(['user-1'])
  })

  it('excludes contacts that already exist', async () => {
    dbFake = makeDb({ contacts: [{ email: 'nikhil.rao@pagetrail.ai' }] })

    const res = await ensureContactsForCalendarEvents('ws-1', 'user-1', [meeting()])

    expect(res.created).toBe(0)
    expect(hoisted.findOrCreateContact).not.toHaveBeenCalled()
  })

  it("excludes the user's own connected-account and auth addresses", async () => {
    dbFake = makeDb({
      accounts: [{ account_email: 'nikhil.rao@pagetrail.ai' }],
      authEmail: 'me@dial8.ai',
    })

    const res = await ensureContactsForCalendarEvents('ws-1', 'user-1', [meeting()])

    expect(res.created).toBe(0)
    // me@dial8.ai was excluded too — no call at all.
    expect(hoisted.findOrCreateContact).not.toHaveBeenCalled()
  })

  it('skips all-day, cancelled, and single-attendee events', async () => {
    const res = await ensureContactsForCalendarEvents('ws-1', 'user-1', [
      meeting({ id: 'a', isAllDay: true }),
      meeting({ id: 'b', status: 'cancelled' }),
      meeting({
        id: 'c',
        attendees: ['solo@acme.com'],
        attendeeDetails: [{ email: 'solo@acme.com' }],
      }),
    ])

    expect(res.created).toBe(0)
    expect(hoisted.findOrCreateContact).not.toHaveBeenCalled()
  })

  it('falls back to the bare attendees array when attendeeDetails is absent', async () => {
    const res = await ensureContactsForCalendarEvents('ws-1', 'user-1', [
      meeting({ attendeeDetails: undefined }),
    ])

    expect(res.created).toBe(1)
    expect(hoisted.findOrCreateContact).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ email: 'nikhil.rao@pagetrail.ai' }),
    )
  })

  it('throttles repeat sweeps for the same workspace', async () => {
    const first = await ensureContactsForCalendarEvents('ws-1', 'user-1', [meeting()])
    expect(first.created).toBe(1)

    const second = await ensureContactsForCalendarEvents('ws-1', 'user-1', [meeting()])
    expect(second.created).toBe(0)
    expect(hoisted.findOrCreateContact).toHaveBeenCalledTimes(1)

    // A DIFFERENT workspace is not throttled by the first one's run.
    const other = await ensureContactsForCalendarEvents('ws-2', 'user-1', [meeting()])
    expect(other.created).toBe(1)
  })

  it('counts a noise-filtered attendee as skipped, not created', async () => {
    hoisted.findOrCreateContact.mockResolvedValue(null)

    const res = await ensureContactsForCalendarEvents('ws-1', 'user-1', [meeting()])

    expect(res.created).toBe(0)
    expect(res.skipped).toBeGreaterThan(0)
  })

  it('never throws when the database read fails', async () => {
    dbFake = makeDb({ throwOn: 'member' })

    await expect(
      ensureContactsForCalendarEvents('ws-1', 'user-1', [meeting()]),
    ).resolves.toEqual({ created: 0, skipped: 0 })
  })

  it('never throws when an individual creation fails', async () => {
    hoisted.findOrCreateContact.mockRejectedValue(new Error('insert failed'))

    const res = await ensureContactsForCalendarEvents('ws-1', 'user-1', [meeting()])

    expect(res.created).toBe(0)
    expect(res.skipped).toBeGreaterThan(0)
  })

  it('writes NOTHING when the user is not a member of the workspace', async () => {
    // The route takes workspaceId from the query string and nothing downstream
    // validates it, so without this guard any authenticated user could push
    // their own calendar's attendees into a foreign workspace's CRM.
    dbFake = makeDb({ members: [{ id: 'member-999', user_id: 'user-999' }] })

    const res = await ensureContactsForCalendarEvents('ws-foreign', 'user-1', [meeting()])

    expect(res).toEqual({ created: 0, skipped: 0 })
    expect(hoisted.findOrCreateContact).not.toHaveBeenCalled()
  })

  it('writes nothing when the workspace has no members at all', async () => {
    dbFake = makeDb({ members: [] })

    const res = await ensureContactsForCalendarEvents('ws-empty', 'user-1', [meeting()])

    expect(res).toEqual({ created: 0, skipped: 0 })
    expect(hoisted.findOrCreateContact).not.toHaveBeenCalled()
  })

  it('a refused non-member sweep does NOT claim the throttle window', async () => {
    // Otherwise a single probe with a foreign workspace id would suppress that
    // workspace's own legitimate sweep for the next five minutes.
    dbFake = makeDb({ members: [{ id: 'member-999', user_id: 'user-999' }] })
    await ensureContactsForCalendarEvents('ws-1', 'attacker', [meeting()])

    // The real member's sweep still runs.
    dbFake = makeDb({})
    const res = await ensureContactsForCalendarEvents('ws-1', 'user-1', [meeting()])

    expect(res.created).toBe(1)
  })

  it('skips a large-audience event — an all-hands is not a relationship', async () => {
    const audience = Array.from({ length: 31 }, (_, i) => ({ email: `person${i}@acme.com` }))
    const res = await ensureContactsForCalendarEvents('ws-1', 'user-1', [
      meeting({ attendees: audience.map((a) => a.email), attendeeDetails: audience }),
    ])

    expect(res.created).toBe(0)
    expect(hoisted.findOrCreateContact).not.toHaveBeenCalled()
  })

  it('still processes an event exactly at the attendee cap', async () => {
    const attendees = [
      { email: 'me@dial8.ai' },
      ...Array.from({ length: 29 }, (_, i) => ({ email: `person${i}@acme.com` })),
    ]
    const res = await ensureContactsForCalendarEvents('ws-1', 'user-1', [
      meeting({ attendees: attendees.map((a) => a.email), attendeeDetails: attendees }),
    ])

    expect(res.created).toBe(29)
  })

  it('applies the audience cap to the bare attendees array too', async () => {
    const audience = Array.from({ length: 31 }, (_, i) => `person${i}@acme.com`)
    const res = await ensureContactsForCalendarEvents('ws-1', 'user-1', [
      meeting({ attendees: audience, attendeeDetails: undefined }),
    ])

    expect(res.created).toBe(0)
  })

  it('skips attendees who declined (Google and Graph both send "declined")', async () => {
    const res = await ensureContactsForCalendarEvents('ws-1', 'user-1', [
      meeting({
        attendeeDetails: [
          { email: 'me@dial8.ai', responseStatus: 'accepted' },
          { email: 'nikhil.rao@pagetrail.ai', responseStatus: 'declined' },
          { email: 'maya.singh@acme.com', responseStatus: 'accepted' },
        ],
      }),
    ])

    expect(res.created).toBe(1)
    expect(hoisted.findOrCreateContact).toHaveBeenCalledTimes(1)
    expect(hoisted.findOrCreateContact).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ email: 'maya.singh@acme.com' }),
    )
  })

  it('matches "declined" case-insensitively', async () => {
    const res = await ensureContactsForCalendarEvents('ws-1', 'user-1', [
      meeting({
        attendeeDetails: [
          { email: 'me@dial8.ai' },
          { email: 'nikhil.rao@pagetrail.ai', responseStatus: 'Declined' },
        ],
      }),
    ])

    expect(res.created).toBe(0)
  })

  it('skips the WHOLE event when the user themselves declined', async () => {
    // The user won't be in the room, so they won't meet these people.
    const res = await ensureContactsForCalendarEvents('ws-1', 'user-1', [
      meeting({
        attendeeDetails: [
          { email: 'me@dial8.ai', responseStatus: 'declined' },
          { email: 'nikhil.rao@pagetrail.ai', responseStatus: 'accepted' },
          { email: 'maya.singh@acme.com', responseStatus: 'accepted' },
        ],
      }),
    ])

    expect(res.created).toBe(0)
    expect(hoisted.findOrCreateContact).not.toHaveBeenCalled()
  })

  it('recognises the user by a connected-account address, not just auth email', async () => {
    dbFake = makeDb({
      accounts: [{ account_email: 'liam@work.com' }],
      authEmail: 'me@dial8.ai',
    })

    const res = await ensureContactsForCalendarEvents('ws-1', 'user-1', [
      meeting({
        attendeeDetails: [
          { email: 'liam@work.com', responseStatus: 'declined' },
          { email: 'nikhil.rao@pagetrail.ai', responseStatus: 'accepted' },
        ],
      }),
    ])

    expect(res.created).toBe(0)
    expect(hoisted.findOrCreateContact).not.toHaveBeenCalled()
  })

  it('still creates when someone ELSE declined but the user accepted', async () => {
    const res = await ensureContactsForCalendarEvents('ws-1', 'user-1', [
      meeting({
        attendeeDetails: [
          { email: 'me@dial8.ai', responseStatus: 'accepted' },
          { email: 'nikhil.rao@pagetrail.ai', responseStatus: 'tentative' },
        ],
      }),
    ])

    expect(res.created).toBe(1)
  })

  it('no-ops on missing workspace, user, or events', async () => {
    const empty = { created: 0, skipped: 0 }
    await expect(ensureContactsForCalendarEvents('', 'user-1', [meeting()])).resolves.toEqual(empty)
    await expect(ensureContactsForCalendarEvents('ws-1', '', [meeting()])).resolves.toEqual(empty)
    await expect(ensureContactsForCalendarEvents('ws-1', 'user-1', [])).resolves.toEqual(empty)
    expect(hoisted.findOrCreateContact).not.toHaveBeenCalled()
  })
})
