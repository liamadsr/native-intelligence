import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for getWorkspaceEmailAccountIds — the inbox account-scope resolver.
 *
 * Invariant locked in (the cross-workspace contact-leak fix): the self-heal
 * links ONLY accounts that were never linked to ANY workspace (true onboarding
 * orphans). An account already linked to some other workspace is deliberately
 * scoped and must never be auto-inherited by a brand-new workspace.
 */

// getServiceClient returns a per-test fake. The same fake also stands in for the
// request-scoped (RLS) client passed as the first arg — every from() call builds
// a fresh stateless builder, so sharing it is fine.
let dbFake: unknown = null
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => dbFake,
}))

const { getWorkspaceEmailAccountIds } = await import('@/lib/email/account-scope')

/**
 * Fake honoring the exact query shapes the resolver issues:
 *   connected_account_workspace (workspace read):
 *     .select('account_id').eq('workspace_id', ws) → thenable
 *   connected_account:
 *     .select('id').eq('user_id',..).eq('capability',..).eq('is_enabled',..) → thenable
 *   connected_account_workspace (linked-anywhere read):
 *     .select('account_id').in('account_id', ids) → thenable
 *   connected_account_workspace (upsert): .upsert(rows, opts) (awaited)
 */
function makeDb(opts: {
  junctionForWorkspace: Array<{ account_id: string }>
  enabledAccounts: Array<{ id: string }>
  linkedAnywhere: Array<{ account_id: string }>
}) {
  const upserted: Array<Array<{ account_id: string; workspace_id: string }>> = []
  const reconciled: string[] = []

  function cawBuilder() {
    let mode: 'workspace' | 'linked' | 'upsert' = 'workspace'
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string) => {
        if (col === 'workspace_id') mode = 'workspace'
        return api
      },
      in: () => {
        mode = 'linked'
        return api
      },
      upsert: (rows: Array<{ account_id: string; workspace_id: string }>) => {
        mode = 'upsert'
        upserted.push(rows)
        return api
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (mode === 'workspace') {
          return Promise.resolve({ data: opts.junctionForWorkspace, error: null }).then(resolve)
        }
        if (mode === 'linked') {
          return Promise.resolve({ data: opts.linkedAnywhere, error: null }).then(resolve)
        }
        return Promise.resolve({ data: null, error: null }).then(resolve)
      },
    }
    return api
  }

  function caBuilder() {
    const api: Record<string, unknown> = {
      select: () => api,
      eq: () => api,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: opts.enabledAccounts, error: null }).then(resolve),
    }
    return api
  }

  const client = {
    from: (table: string) => {
      if (table === 'connected_account_workspace') return cawBuilder()
      return caBuilder()
    },
    rpc: async (fn: string, args: { p_account_id: string }) => {
      if (fn === 'reconcile_email_thread_copies') reconciled.push(args.p_account_id)
      return { data: null, error: null }
    },
  }
  return { client, upserted, reconciled }
}

beforeEach(() => {
  dbFake = null
})

describe('getWorkspaceEmailAccountIds', () => {
  it('returns the existing junction rows without self-healing', async () => {
    const db = makeDb({
      junctionForWorkspace: [{ account_id: 'a1' }, { account_id: 'a2' }],
      enabledAccounts: [],
      linkedAnywhere: [],
    })
    dbFake = db.client
    const client = db.client as never
    const ids = await getWorkspaceEmailAccountIds(client, 'user-1', 'ws-1')
    expect(ids).toEqual(['a1', 'a2'])
    expect(db.upserted).toHaveLength(0)
  })

  it('links a never-linked (orphan) account when the workspace is empty', async () => {
    const db = makeDb({
      junctionForWorkspace: [],
      enabledAccounts: [{ id: 'orphan' }],
      linkedAnywhere: [], // orphan carries no junction row anywhere
    })
    dbFake = db.client
    const ids = await getWorkspaceEmailAccountIds(db.client as never, 'user-1', 'ws-new')
    expect(ids).toEqual(['orphan'])
    expect(db.upserted).toEqual([[{ account_id: 'orphan', workspace_id: 'ws-new' }]])
    // Its threads, indexed wherever its sync ran, get this workspace's copies.
    expect(db.reconciled).toEqual(['orphan'])
  })

  it('does NOT link an account already linked to another workspace', async () => {
    const db = makeDb({
      junctionForWorkspace: [],
      enabledAccounts: [{ id: 'a1' }],
      linkedAnywhere: [{ account_id: 'a1' }], // a1 is deliberately scoped elsewhere
    })
    dbFake = db.client
    const ids = await getWorkspaceEmailAccountIds(db.client as never, 'user-1', 'ws-new')
    expect(ids).toEqual([])
    expect(db.upserted).toHaveLength(0)
    expect(db.reconciled).toHaveLength(0)
  })

  it('links only the orphan in a mix of orphan + already-linked accounts', async () => {
    const db = makeDb({
      junctionForWorkspace: [],
      enabledAccounts: [{ id: 'orphan' }, { id: 'linked' }],
      linkedAnywhere: [{ account_id: 'linked' }],
    })
    dbFake = db.client
    const ids = await getWorkspaceEmailAccountIds(db.client as never, 'user-1', 'ws-new')
    expect(ids).toEqual(['orphan'])
    expect(db.upserted).toEqual([[{ account_id: 'orphan', workspace_id: 'ws-new' }]])
    // Its threads, indexed wherever its sync ran, get this workspace's copies.
    expect(db.reconciled).toEqual(['orphan'])
  })

  it('returns [] when the user has no enabled email accounts', async () => {
    const db = makeDb({ junctionForWorkspace: [], enabledAccounts: [], linkedAnywhere: [] })
    dbFake = db.client
    const ids = await getWorkspaceEmailAccountIds(db.client as never, 'user-1', 'ws-new')
    expect(ids).toEqual([])
    expect(db.upserted).toHaveLength(0)
    expect(db.reconciled).toHaveLength(0)
  })
})
