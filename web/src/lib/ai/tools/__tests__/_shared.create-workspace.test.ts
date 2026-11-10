/**
 * Create-time workspace routing — `resolveCreateWorkspace` / `workspaceEcho`.
 *
 * `resolveEntityWorkspace` already routes writes to things that EXIST. A create
 * has no target to route by, so it landed wherever the session pointed: read
 * ENG-42 out of Engineering, file the follow-up in Marketing, discover it days
 * later. This helper is the protocol that replaces that default, and the matrix
 * below is the whole contract the create tools will be built on.
 *
 * What is pinned here:
 *   1. policy 'session' with no `workspace_id` is byte-identical to today —
 *      the session workspace, and NOT ONE QUERY issued;
 *   2. policy 'explicit' defaults only when the default cannot be wrong (the
 *      user has exactly one workspace), and otherwise REFUSES with
 *      `needs_workspace` + candidates rather than guessing a tenant;
 *   3. an explicit id is membership-checked, and a non-member gets the same
 *      flat 'Workspace not found' as a nonexistent id — never a different
 *      shape, which would make every create tool an existence oracle;
 *   4. under `strictWorkspace` a foreign explicit id is not-found with NO
 *      member probe issued at all (the probe's existence is itself a signal).
 *
 * The Supabase double records every `.from()/.select()/.eq()` so "no query was
 * issued" is an assertion, not an assumption.
 */
import { describe, it, expect } from 'vitest'
import { resolveCreateWorkspace, workspaceEcho } from '../_shared'

const USER = 'user-1'
const WS_ACTIVE = 'ws-1'
const WS_OTHER = 'ws-2'
const WS_THIRD = 'ws-3'
const WS_UNKNOWN = 'ws-nope'

const WORKSPACES = [
  { id: WS_ACTIVE, name: 'Native Intelligence Marketing' },
  { id: WS_OTHER, name: 'Engineering' },
  { id: WS_THIRD, name: 'Personal' },
]

type Row = Record<string, unknown>
type Query = { table: string; select: string; eq: Record<string, unknown> }

/**
 * One `member` row per workspace, shaped for BOTH reads the helper makes:
 * the `{ id, workspace: { name } }` probe on an explicit id, and the
 * `{ workspace: { id, name } }` embed `getUserWorkspaces` awaits.
 */
function makeSupabase(memberOf: string[]) {
  const rows: Row[] = memberOf.map((id) => ({
    id: `member-${id}`,
    user_id: USER,
    workspace_id: id,
    workspace: WORKSPACES.find((w) => w.id === id) ?? { id, name: id },
  }))
  const queries: Query[] = []

  const from = (table: string) => {
    const q: Query = { table, select: '', eq: {} }
    const preds: Array<(r: Row) => boolean> = []
    const chain: Record<string, unknown> = {}
    chain.select = (s: string) => {
      q.select = s
      queries.push(q)
      return chain
    }
    chain.eq = (col: string, val: unknown) => {
      q.eq[col] = val
      preds.push((r) => r[col] === val)
      return chain
    }
    const run = () => (table === 'member' ? rows : []).filter((r) => preds.every((p) => p(r)))
    chain.maybeSingle = async () => ({ data: run()[0] ?? null, error: null })
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: run(), error: null }).then(resolve)
    return chain
  }

  return { supabase: { from } as never, queries }
}

const resolve = (
  supabase: never,
  explicit: string | undefined,
  opts: { strictWorkspace?: boolean; policy: 'session' | 'explicit' },
) =>
  resolveCreateWorkspace(supabase, USER, WS_ACTIVE, explicit, {
    strictWorkspace: opts.strictWorkspace ?? false,
    policy: opts.policy,
  })

describe("policy 'session' — today's behaviour, unchanged", () => {
  it('falls back to the session workspace with no workspace_id', async () => {
    const { supabase, queries } = makeSupabase([WS_ACTIVE, WS_OTHER, WS_THIRD])
    const res = await resolve(supabase, undefined, { policy: 'session' })

    expect(res).toEqual({
      ok: true,
      workspaceId: WS_ACTIVE,
      workspaceName: null,
      crossWorkspace: false,
    })
    // The in-app path must not pay a round-trip for a default it already knows.
    expect(queries).toHaveLength(0)
  })

  it('still routes an explicit foreign id — the policy governs the FALLBACK only', async () => {
    const { supabase } = makeSupabase([WS_ACTIVE, WS_OTHER])
    const res = await resolve(supabase, WS_OTHER, { policy: 'session' })

    expect(res).toEqual({
      ok: true,
      workspaceId: WS_OTHER,
      workspaceName: 'Engineering',
      crossWorkspace: true,
    })
  })
})

describe("policy 'explicit' — the MCP bridge", () => {
  it('defaults silently when the user has exactly ONE workspace', async () => {
    const { supabase } = makeSupabase([WS_ACTIVE])
    const res = await resolve(supabase, undefined, { policy: 'explicit' })

    expect(res).toEqual({
      ok: true,
      workspaceId: WS_ACTIVE,
      workspaceName: 'Native Intelligence Marketing',
      crossWorkspace: false,
    })
  })

  it('refuses with needs_workspace + candidates when there are several', async () => {
    const { supabase } = makeSupabase([WS_ACTIVE, WS_OTHER, WS_THIRD])
    const res = await resolve(supabase, undefined, { policy: 'explicit' })

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    const err = res.error as {
      success: false
      error: string
      error_type: string
      candidates: Array<{ id: string; name: string; is_active: boolean }>
    }

    expect(err.success).toBe(false)
    expect(err.error_type).toBe('needs_workspace')
    // Active first, so a client that truncates still shows the likely answer.
    expect(err.candidates).toEqual([
      { id: WS_ACTIVE, name: 'Native Intelligence Marketing', is_active: true },
      { id: WS_OTHER, name: 'Engineering', is_active: false },
      { id: WS_THIRD, name: 'Personal', is_active: false },
    ])
    // Plenty of clients surface only the message string, so it has to be
    // answerable on its own: how many, which, and where to find the id.
    expect(err.error).toBe(
      'Specify workspace_id: you belong to 3 workspaces ' +
        '(Native Intelligence Marketing [active], Engineering, Personal). ' +
        'Use the workspace_id from the rows you read, or active_workspace.',
    )
  })

  it('fails SOFT to the session workspace when the membership read comes back empty', async () => {
    // Zero rows means the read failed or raced — the caller is demonstrably
    // mid-call in the session workspace. Blocking a create on that would be a
    // worse failure than the one this policy exists to prevent.
    const { supabase } = makeSupabase([])
    const res = await resolve(supabase, undefined, { policy: 'explicit' })

    expect(res).toEqual({
      ok: true,
      workspaceId: WS_ACTIVE,
      workspaceName: null,
      crossWorkspace: false,
    })
  })

  it('never asks a fenced run to disambiguate — strictWorkspace short-circuits to the session', async () => {
    const { supabase, queries } = makeSupabase([WS_ACTIVE, WS_OTHER, WS_THIRD])
    const res = await resolve(supabase, undefined, { policy: 'explicit', strictWorkspace: true })

    expect(res).toEqual({
      ok: true,
      workspaceId: WS_ACTIVE,
      workspaceName: null,
      crossWorkspace: false,
    })
    expect(queries).toHaveLength(0)
  })
})

describe('an explicit workspace_id', () => {
  it('takes the no-probe fast path when it IS the session workspace', async () => {
    const { supabase, queries } = makeSupabase([WS_ACTIVE, WS_OTHER])
    const res = await resolve(supabase, WS_ACTIVE, { policy: 'explicit' })

    expect(res).toEqual({
      ok: true,
      workspaceId: WS_ACTIVE,
      workspaceName: null,
      crossWorkspace: false,
    })
    expect(queries).toHaveLength(0)
  })

  it('routes to a foreign workspace the user belongs to, and flags the crossing', async () => {
    const { supabase, queries } = makeSupabase([WS_ACTIVE, WS_OTHER])
    const res = await resolve(supabase, WS_OTHER, { policy: 'explicit' })

    expect(res).toEqual({
      ok: true,
      workspaceId: WS_OTHER,
      workspaceName: 'Engineering',
      crossWorkspace: true,
    })
    // Membership — not RLS — is the fence: these tools run service-role.
    expect(queries).toEqual([
      {
        table: 'member',
        select: 'id, workspace:workspace_id(name)',
        eq: { user_id: USER, workspace_id: WS_OTHER },
      },
    ])
  })

  it('is flat not-found for a workspace the user is not a member of', async () => {
    const { supabase } = makeSupabase([WS_ACTIVE, WS_OTHER])
    const res = await resolve(supabase, WS_THIRD, { policy: 'explicit' })

    expect(res).toEqual({ ok: false, error: { success: false, error: 'Workspace not found' } })
  })

  it('gives a nonexistent workspace the SAME answer as a forbidden one', async () => {
    // Identical shape, identical string: distinguishing them would turn every
    // create tool into a workspace-existence oracle for the whole install.
    const { supabase } = makeSupabase([WS_ACTIVE])
    const forbidden = await resolve(supabase, WS_OTHER, { policy: 'explicit' })
    const missing = await resolve(supabase, WS_UNKNOWN, { policy: 'explicit' })

    expect(missing).toEqual(forbidden)
  })

  it('is not-found under strictWorkspace — and issues NO member probe', async () => {
    const { supabase, queries } = makeSupabase([WS_ACTIVE, WS_OTHER])
    const res = await resolve(supabase, WS_OTHER, { policy: 'explicit', strictWorkspace: true })

    expect(res).toEqual({ ok: false, error: { success: false, error: 'Workspace not found' } })
    // The probe's very existence (timing, shape) would be an existence oracle
    // for workspaces a fenced run must not reach.
    expect(queries).toHaveLength(0)
  })

  it('is not-found under strictWorkspace regardless of policy', async () => {
    const { supabase } = makeSupabase([WS_ACTIVE, WS_OTHER])
    const res = await resolve(supabase, WS_OTHER, { policy: 'session', strictWorkspace: true })

    expect(res).toEqual({ ok: false, error: { success: false, error: 'Workspace not found' } })
  })
})

describe('workspaceEcho', () => {
  it('is a spreadable block naming the workspace the create landed in', () => {
    expect({ success: true, ...workspaceEcho(WS_OTHER, 'Engineering') }).toEqual({
      success: true,
      workspace: { id: WS_OTHER, name: 'Engineering' },
    })
  })

  it('reports a null name rather than displayName\'s "(unnamed)" placeholder', () => {
    // Null here means "the resolver never had to read the name" (session fast
    // path) — a different fact from a workspace row whose name is blank, and
    // one a caller can tell apart.
    expect(workspaceEcho(WS_ACTIVE)).toEqual({ workspace: { id: WS_ACTIVE, name: null } })
    expect(workspaceEcho(WS_ACTIVE, null)).toEqual({ workspace: { id: WS_ACTIVE, name: null } })
    expect(workspaceEcho(WS_ACTIVE, '   ')).toEqual({ workspace: { id: WS_ACTIVE, name: null } })
  })

  it('trims the name', () => {
    expect(workspaceEcho(WS_ACTIVE, '  Native Intelligence Marketing ')).toEqual({
      workspace: { id: WS_ACTIVE, name: 'Native Intelligence Marketing' },
    })
  })
})
