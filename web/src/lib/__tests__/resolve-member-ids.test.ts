/**
 * `resolveMemberIdsForUser` — the fence behind personal scope.
 *
 * "Personal scope" is any query that spans ALL of a user's workspaces instead
 * of the active one (My Actions across workspaces, the cross-workspace
 * notification feed). The whole safety of that idea rests here: the client
 * sends a scope FLAG, and this function — reading `member` on the caller's own
 * session client, where RLS applies — decides which workspaces the flag means.
 * A request body never names a workspace, so it can never name someone else's.
 *
 * What these tests pin, in order of how much a regression would cost:
 *
 *  1. THE QUERY IS THE FENCE. One read of `member`, filtered by `user_id` and
 *     nothing else. Adding a caller-supplied predicate here, or reading a
 *     different table, is how the flag turns into "read the workspace I name".
 *  2. ONE ENTRY PER MEMBERSHIP, paired. `member` is one row per (user_id,
 *     workspace_id) (migration 013), and callers filter BOTH by workspace id
 *     and by member id — a pairing that drifts hands one workspace's board
 *     another workspace's member id.
 *  3. A FAILED READ THROWS. Degrading to [] would read as "this user has no
 *     workspaces" and silently empty the list instead of reporting the failure.
 */
import { describe, it, expect, vi } from 'vitest'
import { resolveMemberIdsForUser, WorkspaceLookupError } from '@/lib/workspace'

type Call = { method: string; args: unknown[] }

/**
 * A Supabase stand-in that records the chain it was handed and resolves to
 * `result`. Local rather than `createSupabaseMock` because the ARGUMENTS are
 * the assertion here, not the rows.
 */
function makeSupabase(result: { data: unknown; error: unknown }) {
  const calls: Call[] = []
  const chain: Record<string, unknown> = {
    select: vi.fn((...args: unknown[]) => { calls.push({ method: 'select', args }); return chain }),
    eq: vi.fn((...args: unknown[]) => { calls.push({ method: 'eq', args }); return chain }),
    order: vi.fn((...args: unknown[]) => { calls.push({ method: 'order', args }); return chain }),
    then: (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb),
  }
  const from = vi.fn((table: string) => { calls.push({ method: 'from', args: [table] }); return chain })
  return { supabase: { from } as never, calls, from }
}

const rows = [
  { id: 'member-a', workspace_id: 'ws-a' },
  { id: 'member-b', workspace_id: 'ws-b' },
]

describe('resolveMemberIdsForUser', () => {
  it('returns one (memberId, workspaceId) pair per membership, in query order', async () => {
    const { supabase } = makeSupabase({ data: rows, error: null })
    await expect(resolveMemberIdsForUser(supabase, 'user-1')).resolves.toEqual([
      { memberId: 'member-a', workspaceId: 'ws-a' },
      { memberId: 'member-b', workspaceId: 'ws-b' },
    ])
  })

  it('reads `member` filtered by user_id ONLY — the caller cannot widen it', async () => {
    const { supabase, calls, from } = makeSupabase({ data: rows, error: null })
    await resolveMemberIdsForUser(supabase, 'user-1')

    expect(from).toHaveBeenCalledTimes(1)
    expect(from).toHaveBeenCalledWith('member')
    // Exactly one predicate. A second `eq`/`in` here would mean some other
    // input — a body-supplied workspace list — got a say in the scope.
    const predicates = calls.filter((c) => c.method === 'eq')
    expect(predicates).toEqual([{ method: 'eq', args: ['user_id', 'user-1'] }])
  })

  it('selects the two columns callers pair, and nothing else', async () => {
    const { supabase, calls } = makeSupabase({ data: rows, error: null })
    await resolveMemberIdsForUser(supabase, 'user-1')
    expect(calls.find((c) => c.method === 'select')?.args[0]).toBe('id, workspace_id')
  })

  it('orders by created_at asc — the same order getCurrentWorkspaceId falls back on', async () => {
    // Two surfaces that both walk "the user's workspaces" must walk them the
    // same way; without an ORDER BY, Postgres may return a different order per
    // plan and the two disagree about which workspace comes first.
    const { supabase, calls } = makeSupabase({ data: rows, error: null })
    await resolveMemberIdsForUser(supabase, 'user-1')
    expect(calls.find((c) => c.method === 'order')?.args).toEqual([
      'created_at',
      { ascending: true },
    ])
  })

  it('is one round trip', async () => {
    const { supabase, from } = makeSupabase({ data: rows, error: null })
    await resolveMemberIdsForUser(supabase, 'user-1')
    expect(from).toHaveBeenCalledTimes(1)
  })

  it('returns [] for a user with no memberships (and for a null data payload)', async () => {
    const empty = makeSupabase({ data: [], error: null })
    await expect(resolveMemberIdsForUser(empty.supabase, 'user-1')).resolves.toEqual([])
    const nullish = makeSupabase({ data: null, error: null })
    await expect(resolveMemberIdsForUser(nullish.supabase, 'user-1')).resolves.toEqual([])
  })

  it('throws rather than degrading to "no workspaces" when the read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { supabase } = makeSupabase({ data: null, error: { message: 'permission denied' } })
    await expect(resolveMemberIdsForUser(supabase, 'user-1')).rejects.toBeInstanceOf(
      WorkspaceLookupError,
    )
  })

  it('reports an expired JWT as session_expired, not a DB failure', async () => {
    // Half-expired session (dead cookie, stale Bearer): the caller maps this to
    // a 401 the client refreshes on, not a 500.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { supabase } = makeSupabase({ data: null, error: { code: 'PGRST303', message: 'JWT expired' } })
    await expect(resolveMemberIdsForUser(supabase, 'user-1')).rejects.toMatchObject({
      kind: 'session_expired',
    })
  })

  it('does not leak the upstream error text', async () => {
    // Generic messages only — ~20 legacy callers echo error.message into a 500
    // body, so DB internals must not reach it.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { supabase } = makeSupabase({
      data: null,
      error: { message: 'permission denied for table member' },
    })
    await expect(resolveMemberIdsForUser(supabase, 'user-1')).rejects.toThrow(
      'Membership query failed',
    )
  })
})
