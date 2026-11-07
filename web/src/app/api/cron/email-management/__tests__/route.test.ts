import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { withMemberSchema } from '@/test/member-schema'
import type { DraftOptions, DraftProgressEvent } from '@/lib/crm/email-drafts'

/**
 * Tests for GET /api/cron/email-management — the daily CRM/email housekeeping.
 *
 * Invariant locked in (the cross-workspace contact-leak fix): syncAllUsersEmail
 * drives the per-user sync from each enabled email connected_account's own
 * workspace_id, NOT from an arbitrary (unordered) membership. So:
 *  - a user with accounts in two workspaces is synced into BOTH, each with its
 *    own workspace id;
 *  - two accounts in the same workspace collapse to one sync (deduped);
 *  - an account with a NULL workspace_id is skipped, never falling back to a
 *    membership lookup;
 *  - the drafting pass's ledger item belongs to the (user_id, workspace_id)
 *    member row, read with columns member really has (the db double answers
 *    member queries the way PostgREST does, so a nonexistent column fails here
 *    as it did in production);
 *  - the item is attributed to the workspace's Correspondent (the role's oldest
 *    holder) when it has one, else to the Mail face (Email drafts until 318). The
 *    real resolvers run against the db double's ai_team_member rows.
 */

const hoisted = vi.hoisted(() => ({
  syncEmailThreads: vi.fn(async () => ({ synced: 0 })),
  linkThreadsToContacts: vi.fn(async () => undefined),
  generateEmailDrafts: vi.fn(async () => ({ count: 0 })),
  decayRelationshipStrength: vi.fn(async () => undefined),
  runContactDeduplication: vi.fn(async () => ({ merged: 0 })),
  createNotification: vi.fn(async () => undefined),
  getMemberByUserId: vi.fn(async () => ({ id: 'member-rec' })),
  recordDraftPassEvents: vi.fn(async (..._args: unknown[]) => 0),
  draftingBlocked: vi.fn(async (..._args: unknown[]): Promise<'dormant' | 'usage' | null> => null),
  remainingAutoDrafts: vi.fn(async (..._args: unknown[]) => 20),
  capCheck: vi.fn(async () => true),
}))

vi.mock('@/lib/crm/email-sync', () => ({
  syncEmailThreads: hoisted.syncEmailThreads,
  linkThreadsToContacts: hoisted.linkThreadsToContacts,
}))
vi.mock('@/lib/crm/email-drafts', () => ({
  generateEmailDrafts: hoisted.generateEmailDrafts,
  REPLY_DRAFT_LABEL: 'Reply draft',
}))
vi.mock('@/lib/crm/contacts', () => ({
  decayRelationshipStrength: hoisted.decayRelationshipStrength,
}))
vi.mock('@/lib/crm/contact-dedup', () => ({
  runContactDeduplication: hoisted.runContactDeduplication,
}))
vi.mock('@/lib/agent-events/email', () => ({
  recordDraftPassEvents: hoisted.recordDraftPassEvents,
}))
vi.mock('@/lib/email/arrival-drafts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email/arrival-drafts')>()
  return {
    SAFETY_NET_MARGIN_MS: actual.SAFETY_NET_MARGIN_MS,
    SAFETY_NET_LOOKBACK_MS: actual.SAFETY_NET_LOOKBACK_MS,
    askedThreads: actual.askedThreads,
    unsureReasons: actual.unsureReasons,
    draftingBlocked: hoisted.draftingBlocked,
    remainingAutoDrafts: hoisted.remainingAutoDrafts,
    dailyCapCheck: () => hoisted.capCheck,
  }
})
vi.mock('@/lib/notifications', () => ({
  createNotification: hoisted.createNotification,
  getMemberByUserId: hoisted.getMemberByUserId,
}))

let dbFake: unknown = null
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => dbFake,
}))
// The real recorder, spied on so a test can see the pass open its item.
vi.mock('@/lib/work/recorder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/work/recorder')>()
  return { ...actual, startWork: vi.fn(actual.startWork) }
})

const { GET } = await import('@/app/api/cron/email-management/route')
const { startWork } = await import('@/lib/work/recorder')

type Account = { user_id: string; workspace_id: string | null }
type Teammate = Record<string, unknown>

/** A workspace's seeded system teammates (migration 318): role NULL, is_system,
 *  older than any role teammate. The Mail one is `tm-mail-<ws>`. */
function systemTeammates(workspaceId: string): Teammate[] {
  return ['captures', 'mail', 'prospecting', 'evals', 'crm', 'assistant'].map((key) => ({
    id: `tm-${key}-${workspaceId}`,
    workspace_id: workspaceId,
    name: key,
    role: null,
    is_system: true,
    system_key: key,
    autonomy: 'propose',
    created_at: '2026-01-01T00:00:00.000Z',
  }))
}

/** A role teammate (migration 284 seeds one per role; an admin may add more). */
function roleTeammate(id: string, workspaceId: string, over: Teammate = {}): Teammate {
  return {
    id,
    workspace_id: workspaceId,
    name: id,
    role: 'correspondent',
    is_system: false,
    system_key: null,
    autonomy: 'attempt',
    created_at: '2026-09-01T00:00:00.000Z',
    ...over,
  }
}

/** Wrap one ai_team_member query so a read filtered on `role` fails (the
 *  Correspondent lookup), while the system_key read still answers. */
function failRoleReads(inner: Record<string, unknown>, message: string): Record<string, unknown> {
  let roleRead = false
  const proxy: Record<string, unknown> = new Proxy(inner, {
    get(target, prop) {
      if (prop === 'then' && roleRead) {
        return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({ data: null, error: { message } }).then(resolve, reject)
      }
      const value = target[prop as string]
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (prop === 'eq' && args[0] === 'role') roleRead = true
        const out = (value as (...a: unknown[]) => unknown)(...args)
        return out === target ? proxy : out
      }
    },
  })
  return proxy
}

/**
 * Fake honoring the query shapes syncAllUsersEmail (and its housekeeping
 * siblings) issue:
 *   connected_account: .select(..).eq('capability','email').eq('is_enabled',true) → thenable
 *   member:            .select('id').eq('user_id',u).eq('workspace_id',w).maybeSingle()
 *   tracked_job:       the work ledger — the stateful fake the recorder tests use
 *   ai_team_member:    the same fake, seeded with each account workspace's
 *                      system teammates plus `teammates`; `teammateFailure`
 *                      fails every read filtered on role with that message
 *   contact:           dedupe/followups reads → thenable resolving []
 * The member id is `member:${user}:${workspace}`; `noMember` lists the
 * `${user}:${workspace}` pairs with no member row, and `memberFailure` makes
 * every member read fail with that message. Wrapped in withMemberSchema, so a
 * member read naming a column the table lacks fails the way PostgREST fails it.
 */
function makeDb(opts: {
  accounts: Account[]
  noMember?: string[]
  memberFailure?: string
  ledger?: FakeSupabase
  teammates?: Teammate[]
  teammateFailure?: string
  /** Workspaces whose autonomy is off (the kill switch, A5). */
  paused?: string[]
}) {
  const ledger = opts.ledger ?? makeFakeSupabase()
  const workspaces = [...new Set(opts.accounts.map((a) => a.workspace_id).filter((w): w is string => !!w))]
  ledger.seed('ai_team_member', [...workspaces.flatMap(systemTeammates), ...(opts.teammates ?? [])])
  function accountBuilder() {
    const api: Record<string, unknown> = {
      select: () => api,
      eq: () => api,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: opts.accounts, error: null }).then(resolve),
    }
    return api
  }
  function memberBuilder() {
    let userId = ''
    let ws = ''
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (k: string, v: string) => {
        if (k === 'user_id') userId = v
        if (k === 'workspace_id') ws = v
        return api
      },
      maybeSingle: async () => {
        if (opts.memberFailure) return { data: null, error: { message: opts.memberFailure } }
        if (opts.noMember?.includes(`${userId}:${ws}`)) return { data: null, error: null }
        return { data: { id: `member:${userId}:${ws}` }, error: null }
      },
    }
    return api
  }
  function contactBuilder() {
    // Covers both dedupeAllWorkspaces (.select().is()) and checkContactFollowups
    // (.select().lte().gte()) — both awaited, both fine with an empty set.
    const api: Record<string, unknown> = {
      select: () => api,
      is: () => api,
      lte: () => api,
      gte: () => api,
      limit: () => api,
      order: () => api,
      range: () => api,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
    }
    return api
  }
  function workspaceBuilder() {
    let id = ''
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (k: string, v: string) => {
        if (k === 'id') id = v
        return api
      },
      maybeSingle: async () => ({
        data: { settings: opts.paused?.includes(id) ? { agent_autonomy: { mode: 'off' } } : {} },
        error: null,
      }),
    }
    return api
  }
  return withMemberSchema({
    from: (table: string) => {
      if (table === 'connected_account') return accountBuilder()
      if (table === 'workspace') return workspaceBuilder()
      if (table === 'member') return memberBuilder()
      if (table === 'tracked_job') return ledger.from(table)
      if (table === 'ai_team_member') {
        const query = ledger.from(table)
        return opts.teammateFailure ? failRoleReads(query, opts.teammateFailure) : query
      }
      return contactBuilder()
    },
  })
}

/** Drive the drafting pass's progress beats the way generateEmailDrafts does. */
function draftingPass(events: DraftProgressEvent[], count: number) {
  return async (_userId: string, _workspaceId: string, options: DraftOptions) => {
    for (const event of events) await options.onProgress?.(event)
    return { count }
  }
}

function request(bearer?: string): NextRequest {
  return new NextRequest('https://dial8.ai/api/cron/email-management', {
    headers: bearer !== undefined ? { authorization: bearer } : {},
  })
}

beforeEach(() => {
  Object.values(hoisted).forEach((fn) => fn.mockClear())
  vi.mocked(startWork).mockClear()
  hoisted.syncEmailThreads.mockResolvedValue({ synced: 0 })
  hoisted.generateEmailDrafts.mockResolvedValue({ count: 0 })
  hoisted.getMemberByUserId.mockResolvedValue({ id: 'member-rec' })
  hoisted.draftingBlocked.mockResolvedValue(null)
  hoisted.remainingAutoDrafts.mockResolvedValue(20)
  vi.stubEnv('CRON_SECRET', 'test-secret')
  dbFake = null
})
afterEach(() => {
  vi.unstubAllEnvs()
  dbFake = null
})

describe('GET /api/cron/email-management — the kill switch (A5)', () => {
  it('a paused workspace still syncs and links its mail, but drafts nothing; others draft', async () => {
    dbFake = makeDb({
      accounts: [
        { user_id: 'u1', workspace_id: 'ws-off' },
        { user_id: 'u1', workspace_id: 'ws-on' },
      ],
      paused: ['ws-off'],
    })
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body.email_sync).toMatchObject({ users_synced: 2 })
    expect(hoisted.syncEmailThreads).toHaveBeenCalledWith('u1', 'ws-off', false)
    expect(hoisted.linkThreadsToContacts).toHaveBeenCalledWith('u1', 'ws-off')
    expect(hoisted.generateEmailDrafts).toHaveBeenCalledTimes(1)
    expect(hoisted.generateEmailDrafts).toHaveBeenCalledWith('u1', 'ws-on', expect.anything())
  })
})

describe('GET /api/cron/email-management — syncAllUsersEmail account scoping', () => {
  it('syncs into the connected_account.workspace_id, not an arbitrary membership', async () => {
    dbFake = makeDb({ accounts: [{ user_id: 'u1', workspace_id: 'ws-linked' }] })
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.email_sync).toMatchObject({ users_synced: 1 })
    expect(hoisted.syncEmailThreads).toHaveBeenCalledWith('u1', 'ws-linked', false)
    expect(hoisted.linkThreadsToContacts).toHaveBeenCalledWith('u1', 'ws-linked')
  })

  it('syncs a user with accounts in two workspaces into BOTH', async () => {
    dbFake = makeDb({
      accounts: [
        { user_id: 'u1', workspace_id: 'ws-a' },
        { user_id: 'u1', workspace_id: 'ws-b' },
      ],
    })
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body.email_sync).toMatchObject({ users_synced: 2 })
    expect(hoisted.syncEmailThreads).toHaveBeenCalledWith('u1', 'ws-a', false)
    expect(hoisted.syncEmailThreads).toHaveBeenCalledWith('u1', 'ws-b', false)
  })

  it('dedupes two accounts sharing a (user, workspace) into one sync', async () => {
    dbFake = makeDb({
      accounts: [
        { user_id: 'u1', workspace_id: 'ws-shared' },
        { user_id: 'u1', workspace_id: 'ws-shared' },
      ],
    })
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body.email_sync).toMatchObject({ users_synced: 1 })
    expect(hoisted.syncEmailThreads).toHaveBeenCalledTimes(1)
    expect(hoisted.syncEmailThreads).toHaveBeenCalledWith('u1', 'ws-shared', false)
  })

  it('skips an account with a NULL workspace_id (no membership fallback)', async () => {
    dbFake = makeDb({
      accounts: [
        { user_id: 'u1', workspace_id: null },
        { user_id: 'u2', workspace_id: 'ws-ok' },
      ],
    })
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body.email_sync).toMatchObject({ users_synced: 1 })
    expect(hoisted.syncEmailThreads).toHaveBeenCalledTimes(1)
    expect(hoisted.syncEmailThreads).toHaveBeenCalledWith('u2', 'ws-ok', false)
  })

  it('drafts in every (user, workspace) pass, in the person\'s own style: no tone is passed (there is no per-member setting)', async () => {
    dbFake = makeDb({
      accounts: [
        { user_id: 'u1', workspace_id: 'ws-a' },
        { user_id: 'u1', workspace_id: 'ws-b' },
      ],
    })
    hoisted.generateEmailDrafts.mockImplementation(
      draftingPass(
        [
          { kind: 'start', total: 1 },
          { kind: 'drafted', index: 0, total: 1, draftId: 'd-1' },
        ],
        1,
      ) as never,
    )

    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body.email_sync).toMatchObject({ users_synced: 2, drafts_generated: 2 })
    expect(hoisted.generateEmailDrafts).toHaveBeenCalledTimes(2)
    for (const ws of ['ws-a', 'ws-b']) {
      expect(hoisted.generateEmailDrafts).toHaveBeenCalledWith(
        'u1',
        ws,
        expect.objectContaining({ max_drafts: 5 }),
      )
    }
    for (const call of hoisted.generateEmailDrafts.mock.calls) expect((call as unknown[])[2]).not.toHaveProperty('tone')
    // Each pass settles done with its drafts: no ready-to-review push (bots-v4.md Phase 3).
    expect(hoisted.createNotification).not.toHaveBeenCalled()
  })

  it('returns zeros with no accounts', async () => {
    dbFake = makeDb({ accounts: [] })
    const res = await GET(request('Bearer test-secret'))
    const body = await res.json()
    expect(body.email_sync).toMatchObject({ users_synced: 0, drafts_generated: 0 })
    expect(hoisted.syncEmailThreads).not.toHaveBeenCalled()
  })
})

describe('GET /api/cron/email-management — the drafting pass in the work ledger', () => {
  it('records one email_drafts item per pass that finishes done with its drafts', async () => {
    const ledger = makeFakeSupabase()
    dbFake = makeDb({ accounts: [{ user_id: 'u1', workspace_id: 'ws-a' }], ledger })
    hoisted.generateEmailDrafts.mockImplementation(
      draftingPass(
        [
          { kind: 'start', total: 3 },
          { kind: 'thread', index: 0, total: 3 },
          { kind: 'drafted', index: 0, total: 3, draftId: 'd-1' },
          { kind: 'thread', index: 1, total: 3 },
          { kind: 'skipped', index: 1, total: 3 },
          { kind: 'thread', index: 2, total: 3 },
          { kind: 'drafted', index: 2, total: 3, draftId: 'd-2' },
        ],
        2,
      ) as never,
    )

    const res = await GET(request('Bearer test-secret'))
    expect((await res.json()).email_sync).toMatchObject({ drafts_generated: 2 })

    const rows = ledger.rows('tracked_job')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      workspace_id: 'ws-a',
      member_id: 'member:u1:ws-a',
      kind: 'email_drafts',
      actor: 'loop',
      title: 'Reply drafts for 3 threads',
      ai_team_member_id: 'tm-mail-ws-a',
      // bots-v4.md Phase 3: done with its drafts, no review to wait on.
      status: 'done',
      result_summary: '2 drafts ready to review',
      needs: null,
      deliverables: [
        { type: 'email_draft', id: 'd-1', label: 'Reply draft' },
        { type: 'email_draft', id: 'd-2', label: 'Reply draft' },
      ],
      current_step: null,
    })
    // The live steps were written as the pass went (counts, never mail content).
    // A burst inside the recorder's 2s coalescing window trails the latest
    // text, so the log keeps the first step and the last, not every beat.
    const progress = rows[0].progress as { steps: Array<{ text: string }>; done: number; total: number }
    expect(progress.done).toBe(2)
    expect(progress.total).toBe(3)
    const texts = progress.steps.map((s) => s.text)
    expect(texts[0]).toBe('Reading 3 threads that need a reply')
    expect(texts[texts.length - 1]).toBe('Drafted reply 3 of 3')
    expect(texts).not.toContain('Re: Pricing')
    // A routine done sends no notice: the drafts come through its bot's peek
    // (peek.ts, the done tier), and wait in Mail's Drafts.
    expect(hoisted.createNotification).not.toHaveBeenCalled()
  })

  // bots-v4.md Phase 3 (v3's decision 5, changed by #614): Jev is in front of
  // every automatic pass, so the quiet flag goes. The pass finishes done with
  // its drafts as deliverables, waits on no review, and sends no notice.
  it("a pass that drafted something finishes done with its drafts, no flag, no review, no notice", async () => {
    const ledger = makeFakeSupabase()
    dbFake = makeDb({ accounts: [{ user_id: 'u1', workspace_id: 'ws-a' }], ledger })
    hoisted.generateEmailDrafts.mockImplementation(
      draftingPass(
        [
          { kind: 'start', total: 1 },
          { kind: 'drafted', index: 0, total: 1, draftId: 'd-1' },
        ],
        1,
      ) as never,
    )
    await GET(request('Bearer test-secret'))

    const started = (startWork as unknown as { mock: { calls: Array<[unknown, Record<string, unknown>]> } }).mock.calls[0][1]
    expect(started.source).toBeUndefined()
    const rows = ledger.rows('tracked_job')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      status: 'done',
      needs: null,
      deliverables: [{ type: 'email_draft', id: 'd-1', label: 'Reply draft' }],
    })
    expect((rows[0].source as { bot_still?: boolean } | null)?.bot_still).toBeUndefined()
    expect(hoisted.createNotification).not.toHaveBeenCalled()
  })

  it('a pass that drafted nothing settles done, quietly; no thread at all → no row', async () => {
    const ledger = makeFakeSupabase()
    dbFake = makeDb({ accounts: [{ user_id: 'u1', workspace_id: 'ws-a' }], ledger })
    hoisted.generateEmailDrafts.mockImplementation(
      draftingPass([{ kind: 'start', total: 1 }, { kind: 'thread', index: 0, total: 1 }, { kind: 'skipped', index: 0, total: 1 }], 0) as never,
    )
    await GET(request('Bearer test-secret'))
    expect(ledger.rows('tracked_job')).toHaveLength(1)
    expect(ledger.rows('tracked_job')[0]).toMatchObject({
      status: 'done',
      result_summary: 'Nothing needed a draft',
      deliverables: [],
      needs: null,
    })
    expect(hoisted.createNotification).not.toHaveBeenCalled()

    const empty = makeFakeSupabase()
    dbFake = makeDb({ accounts: [{ user_id: 'u1', workspace_id: 'ws-a' }], ledger: empty })
    hoisted.generateEmailDrafts.mockImplementation(draftingPass([], 0) as never)
    await GET(request('Bearer test-secret'))
    expect(empty.rows('tracked_job')).toHaveLength(0)
  })

  it('reads the owner with columns member has, so the pass opens its item as the Mail face', async () => {
    // Production regression: the member read selected `metadata`, which member
    // doesn't have. PostgREST refused it on every run, the member came back
    // null, and no pass ever wrote its ledger row (nor sent its push).
    const ledger = makeFakeSupabase()
    dbFake = makeDb({ accounts: [{ user_id: 'u1', workspace_id: 'ws-a' }], ledger })
    hoisted.generateEmailDrafts.mockImplementation(
      draftingPass([{ kind: 'start', total: 2 }], 0) as never,
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await GET(request('Bearer test-secret'))
    const logged = error.mock.calls.map((call) => call.join(' '))
    error.mockRestore()

    expect(logged.filter((line) => line.includes('member lookup failed'))).toEqual([])
    expect(startWork).toHaveBeenCalledTimes(1)
    expect(startWork).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: 'ws-a',
        memberId: 'member:u1:ws-a',
        aiTeamMemberId: 'tm-mail-ws-a',
        kind: 'email_drafts',
        actor: 'loop',
        title: 'Reply drafts for 2 threads',
      }),
    )
    expect(ledger.rows('tracked_job')).toHaveLength(1)
    expect(ledger.rows('tracked_job')[0]).toMatchObject({ kind: 'email_drafts', ai_team_member_id: 'tm-mail-ws-a' })
  })

  it('a failed member lookup is logged with its error, and drafting still runs without an item', async () => {
    const ledger = makeFakeSupabase()
    dbFake = makeDb({ accounts: [{ user_id: 'u1', workspace_id: 'ws-a' }], ledger, memberFailure: 'connection reset' })
    hoisted.generateEmailDrafts.mockImplementation(
      draftingPass([{ kind: 'start', total: 1 }, { kind: 'drafted', index: 0, total: 1, draftId: 'd-1' }], 1) as never,
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await GET(request('Bearer test-secret'))
    const logged = error.mock.calls.map((call) => call.join(' '))
    error.mockRestore()

    expect(logged).toContainEqual(expect.stringContaining('member lookup failed for user u1 / workspace ws-a: connection reset'))
    expect((await res.json()).email_sync).toMatchObject({ users_synced: 1, drafts_generated: 1 })
    expect(startWork).not.toHaveBeenCalled()
    expect(ledger.rows('tracked_job')).toHaveLength(0)
  })

  it('a missing member row skips the item quietly', async () => {
    const ledger = makeFakeSupabase()
    dbFake = makeDb({ accounts: [{ user_id: 'u1', workspace_id: 'ws-a' }], ledger, noMember: ['u1:ws-a'] })
    hoisted.generateEmailDrafts.mockImplementation(draftingPass([{ kind: 'start', total: 1 }], 0) as never)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await GET(request('Bearer test-secret'))
    const calls = error.mock.calls.length
    error.mockRestore()

    expect(calls).toBe(0)
    expect(hoisted.generateEmailDrafts).toHaveBeenCalledTimes(1)
    expect(startWork).not.toHaveBeenCalled()
    expect(ledger.rows('tracked_job')).toHaveLength(0)
  })

  it('a pass that throws mid-way fails its item with the error', async () => {
    const ledger = makeFakeSupabase()
    dbFake = makeDb({ accounts: [{ user_id: 'u1', workspace_id: 'ws-a' }], ledger })
    hoisted.generateEmailDrafts.mockImplementation((async (_u: string, _w: string, options: DraftOptions) => {
      await options.onProgress?.({ kind: 'start', total: 2 })
      throw new Error('Gateway timed out')
    }) as never)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await GET(request('Bearer test-secret'))
    error.mockRestore()
    expect(res.status).toBe(200)
    expect(ledger.rows('tracked_job')[0]).toMatchObject({ status: 'failed', error_message: 'Gateway timed out' })
  })
})

describe('GET /api/cron/email-management — the agent inbox (A6 mail seam)', () => {
  it('records each draft and each older thread still waiting on a reply, through the shared recorder', async () => {
    dbFake = makeDb({ accounts: [{ user_id: 'u1', workspace_id: 'ws-a' }] })
    const drafts = [{ id: 'd1', subject: 'Re: Pricing', created_at: '2026-10-14T05:00:00.000Z', email_thread_id: 'th-1' }]
    hoisted.generateEmailDrafts.mockResolvedValueOnce({ count: 1, drafts } as never)
    await GET(request('Bearer test-secret'))
    expect(hoisted.recordDraftPassEvents).toHaveBeenCalledTimes(1)
    expect(hoisted.recordDraftPassEvents).toHaveBeenCalledWith(dbFake, {
      userId: 'u1',
      workspaceId: 'ws-a',
      drafts,
      lastMessageBefore: expect.any(String),
    })
  })
})

describe('GET /api/cron/email-management — threads the gate asks about (E3)', () => {
  it('reports them as unsure, so the agent asks the person first; the rest keep the pass\'s reason', async () => {
    dbFake = makeDb({ accounts: [{ user_id: 'u1', workspace_id: 'ws-a' }] })
    hoisted.generateEmailDrafts.mockResolvedValue({ count: 0, drafts: [], skipped: { 'p-ask': 'ask', 'p-no': 'no_reply' } } as never)
    await GET(request('Bearer test-secret'))
    const calls = hoisted.recordDraftPassEvents.mock.calls.map((c) => c[1] as { reasons?: Record<string, string> })
    expect(calls.at(-1)?.reasons).toEqual({ 'p-ask': 'unsure' })
  })
})

describe('GET /api/cron/email-management — the safety net (arrival drafts new mail)', () => {
  const HOUR = 60 * 60_000

  it('drafts only threads whose newest message is older than the 2 h margin, within the shared cap', async () => {
    dbFake = makeDb({ accounts: [{ user_id: 'u1', workspace_id: 'ws-a' }] })
    const before = Date.now()
    await GET(request('Bearer test-secret'))
    const options = (hoisted.generateEmailDrafts.mock.calls[0] as unknown as [string, string, DraftOptions])[2]
    const cutoff = Date.parse(options.lastMessageBefore!)
    expect(cutoff).toBeLessThanOrEqual(Date.now() - 2 * HOUR)
    expect(cutoff).toBeGreaterThanOrEqual(before - 2 * HOUR - 1000)
    // Nor anything older than two days: old mail is the person's call, not the safety net's.
    const oldest = Date.parse(options.lastMessageAfter!)
    expect(oldest).toBeLessThanOrEqual(Date.now() - 48 * HOUR)
    expect(oldest).toBeGreaterThanOrEqual(before - 48 * HOUR - 1000)
    expect(options).toMatchObject({ replyIntent: 'automatic', max_drafts: 5, review: false })
    // The cap is re-read before each model call and insert.
    expect(await options.allowAnother!()).toBe(true)
    // The events skip fresh threads too: arrival is still on them.
    const eventArgs = hoisted.recordDraftPassEvents.mock.calls[0][1] as { lastMessageBefore: string }
    expect(eventArgs.lastMessageBefore).toBe(options.lastMessageBefore)
  })

  it('shares the daily cap with arrival: max_drafts is what today has left; none left → no pass, a cap event', async () => {
    dbFake = makeDb({ accounts: [{ user_id: 'u1', workspace_id: 'ws-a' }, { user_id: 'u1', workspace_id: 'ws-b' }] })
    hoisted.remainingAutoDrafts.mockImplementation(async (...args: unknown[]) => (args[2] === 'ws-a' ? 2 : 0))
    await GET(request('Bearer test-secret'))
    expect(hoisted.generateEmailDrafts).toHaveBeenCalledTimes(1)
    expect(hoisted.generateEmailDrafts).toHaveBeenCalledWith('u1', 'ws-a', expect.objectContaining({ max_drafts: 2 }))
    expect(hoisted.recordDraftPassEvents).toHaveBeenCalledWith(dbFake, expect.objectContaining({ workspaceId: 'ws-b', drafts: [], reason: 'cap' }))
  })

  it('a dormant workspace or a person over their usage limit gets no draft, and the events name the gate', async () => {
    dbFake = makeDb({ accounts: [{ user_id: 'u1', workspace_id: 'ws-dormant' }, { user_id: 'u2', workspace_id: 'ws-over' }] })
    hoisted.draftingBlocked.mockImplementation(async (...args: unknown[]) => (args[2] === 'ws-dormant' ? 'dormant' : 'usage'))
    await GET(request('Bearer test-secret'))
    expect(hoisted.generateEmailDrafts).not.toHaveBeenCalled()
    expect(hoisted.recordDraftPassEvents).toHaveBeenCalledWith(dbFake, expect.objectContaining({ workspaceId: 'ws-dormant', reason: 'dormant' }))
    expect(hoisted.recordDraftPassEvents).toHaveBeenCalledWith(dbFake, expect.objectContaining({ workspaceId: 'ws-over', reason: 'usage' }))
  })

  it('a paused workspace drafts nothing and reports its waiting threads as paused', async () => {
    dbFake = makeDb({ accounts: [{ user_id: 'u1', workspace_id: 'ws-off' }], paused: ['ws-off'] })
    await GET(request('Bearer test-secret'))
    expect(hoisted.generateEmailDrafts).not.toHaveBeenCalled()
    expect(hoisted.draftingBlocked).not.toHaveBeenCalled()
    expect(hoisted.recordDraftPassEvents).toHaveBeenCalledWith(dbFake, expect.objectContaining({ workspaceId: 'ws-off', drafts: [], reason: 'paused' }))
  })

  it('a pass the cap stopped mid-way reports the rest as cap', async () => {
    dbFake = makeDb({ accounts: [{ user_id: 'u1', workspace_id: 'ws-a' }] })
    hoisted.generateEmailDrafts.mockResolvedValueOnce({ count: 0, drafts: [], stoppedBy: 'allowance' } as never)
    await GET(request('Bearer test-secret'))
    expect(hoisted.recordDraftPassEvents).toHaveBeenCalledWith(dbFake, expect.objectContaining({ reason: 'cap' }))
  })
})

describe('GET /api/cron/email-management — who the drafting pass is attributed to', () => {
  // Email has one face (owner decision): the workspace's Correspondent where it
  // has one, else the Mail face (Email drafts until 318). Attribution only: nothing
  // about the pass itself changes (followups issue 27).
  function draftOne() {
    hoisted.generateEmailDrafts.mockImplementation(
      draftingPass(
        [
          { kind: 'start', total: 1 },
          { kind: 'drafted', index: 0, total: 1, draftId: 'd-1' },
        ],
        1,
      ) as never,
    )
  }

  it("goes to the workspace's Correspondent when it has one; the row is otherwise unchanged", async () => {
    const ledger = makeFakeSupabase()
    dbFake = makeDb({
      accounts: [{ user_id: 'u1', workspace_id: 'ws-a' }],
      ledger,
      teammates: [
        roleTeammate('correspondent-a', 'ws-a'),
        // Older, but another role, and another workspace's Correspondent.
        roleTeammate('writer-a', 'ws-a', { role: 'writer', created_at: '2026-08-01T00:00:00.000Z' }),
        roleTeammate('correspondent-b', 'ws-b', { created_at: '2026-08-01T00:00:00.000Z' }),
      ],
    })
    draftOne()
    await GET(request('Bearer test-secret'))

    expect(startWork).toHaveBeenCalledTimes(1)
    expect(startWork).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: 'ws-a',
        aiTeamMemberId: 'correspondent-a',
        kind: 'email_drafts',
        actor: 'loop',
      }),
    )
    const rows = ledger.rows('tracked_job')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ai_team_member_id: 'correspondent-a', status: 'done' })
  })

  it('goes to the oldest of two Correspondents, whatever its autonomy', async () => {
    const ledger = makeFakeSupabase()
    dbFake = makeDb({
      accounts: [{ user_id: 'u1', workspace_id: 'ws-a' }],
      ledger,
      teammates: [
        roleTeammate('newer', 'ws-a', { created_at: '2026-09-02T00:00:00.000Z' }),
        // Switched off, and still the face: autonomy does not gate the pass yet.
        roleTeammate('oldest', 'ws-a', { autonomy: 'off', created_at: '2026-09-01T00:00:00.000Z' }),
      ],
    })
    draftOne()
    await GET(request('Bearer test-secret'))

    expect(startWork).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ aiTeamMemberId: 'oldest' }))
    expect(ledger.rows('tracked_job')[0]).toMatchObject({ ai_team_member_id: 'oldest' })
  })

  it('goes to the Mail face (Email drafts until 318) with no Correspondent; a system row (role null) never stands in', async () => {
    // The system teammates are older than every role teammate and hold no role.
    const ledger = makeFakeSupabase()
    dbFake = makeDb({
      accounts: [{ user_id: 'u1', workspace_id: 'ws-a' }],
      ledger,
      teammates: [roleTeammate('writer-a', 'ws-a', { role: 'writer' })],
    })
    draftOne()
    await GET(request('Bearer test-secret'))

    expect(startWork).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ aiTeamMemberId: 'tm-mail-ws-a' }))
    expect(ledger.rows('tracked_job')[0]).toMatchObject({ ai_team_member_id: 'tm-mail-ws-a', status: 'done' })
  })

  it('falls back to the Mail face when the Correspondent lookup fails, and logs it', async () => {
    const ledger = makeFakeSupabase()
    dbFake = makeDb({
      accounts: [{ user_id: 'u1', workspace_id: 'ws-a' }],
      ledger,
      teammates: [roleTeammate('correspondent-a', 'ws-a')],
      teammateFailure: 'connection reset',
    })
    draftOne()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await GET(request('Bearer test-secret'))
    const logged = warn.mock.calls.map((call) => call.join(' '))
    warn.mockRestore()

    expect(logged).toContainEqual(expect.stringContaining('correspondent lookup failed (ws-a)'))
    expect(logged).toContainEqual(expect.stringContaining('connection reset'))
    expect(startWork).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ aiTeamMemberId: 'tm-mail-ws-a' }))
    expect(ledger.rows('tracked_job')[0]).toMatchObject({ ai_team_member_id: 'tm-mail-ws-a', status: 'done' })
  })
})
