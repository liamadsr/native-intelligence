/**
 * A company's team-shared email (migration 680), the server half: every read
 * asks the database's fence (company_team_email_threads) with the CALLER's
 * own user id, and reads only what it answered. The SQL itself (consent,
 * private threads, stopped shares, other workspaces, the service-role path)
 * runs in supabase/tests/680_company_team_email.sql. Made-up people only.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  companySharingStatus,
  fencedTeamThreads,
  listCompanyTeamThreads,
  readCompanyTeamAttachment,
  readCompanyTeamThread,
  type CompanyTeamDeps,
  type TeamThreadRow,
} from '../company-team'

const WS = '11111111-1111-4111-8111-111111111111'
const CO = '22222222-2222-4222-8222-222222222222'
const BOB = '33333333-3333-4333-8333-333333333333'
const ALEX = '44444444-4444-4444-8444-444444444444'
const T1 = '55555555-5555-4555-8555-555555555555'
const T2 = '66666666-6666-4666-8666-666666666666'
const ACCT = '77777777-7777-4777-8777-777777777777'
const M_ALEX = '88888888-8888-4888-8888-888888888888'

const row = (id: string, over: Partial<TeamThreadRow & { thread_index_id: string }> = {}) => ({
  thread_index_id: id,
  owner_user_id: ALEX,
  owner_member_id: M_ALEX,
  account_id: ACCT,
  provider: 'google',
  provider_thread_id: `pt-${id.slice(0, 4)}`,
  provider_message_id: 'm-last',
  folder: 'inbox',
  last_message_at: '2026-11-20T10:00:00Z',
  from_email: 'pat@acme.example',
  message_count: 3,
  has_attachments: true,
  team_member_ids: [M_ALEX],
  ...over,
})

/** A service client whose fence answers `rows` (filtered by p_thread_index_id), recording every call. */
function svc(rows: ReturnType<typeof row>[], status: unknown = { enabled: true, my_consent: false, sharers: [] }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const client = {
    calls,
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      if (fn === 'company_email_sharing_status') return { data: status, error: null }
      if (fn !== 'company_team_email_threads') return { data: null, error: { message: 'unknown' } }
      const only = args.p_thread_index_id as string | null
      return { data: rows.filter((r) => !only || r.thread_index_id === only), error: null }
    }),
    from: vi.fn(() => {
      const q = { select: () => q, eq: () => q, in: async () => ({ data: [{ id: M_ALEX, display_name: 'Alex Example' }], error: null }) }
      return q
    }),
  }
  return client
}

function deps(over: Partial<CompanyTeamDeps> = {}): CompanyTeamDeps {
  return {
    mailbox: vi.fn(async () => ({ provider: 'google' as const, token: 'tok' })),
    provider: {
      threadIds: vi.fn(async () => ['m-1', 'm-last']),
      message: vi.fn(async (_m, id: string) => ({
        id,
        from: { name: 'Pat Example', email: 'pat@acme.example' },
        to: [],
        cc: [],
        date: '2026-11-20T10:00:00Z',
        subject: 'Renewal quote',
        bodyHtml: null,
        bodyText: 'Hello',
        attachments: [],
      })),
      attachment: vi.fn(async () => ({ name: 'quote.pdf', mimeType: 'application/pdf', size: 3, body: new Uint8Array([1, 2, 3]) })),
    },
    headers: vi.fn(async (_s: unknown, args: { rows: TeamThreadRow[] }) => args.rows.map((r: TeamThreadRow) => ({ ...r, subject: 'Renewal quote', snippet: 'Hi', from_name: 'Pat Example' }))),
    ...over,
  } as CompanyTeamDeps
}

const caller = { userId: BOB, workspaceId: WS }

describe('the fence is the database’s, asked for the caller', () => {
  it('asks company_team_email_threads with the caller as the reader, and grants as the turn allows', async () => {
    const s = svc([row(T1)])
    await fencedTeamThreads(s as never, CO, caller)
    await fencedTeamThreads(s as never, CO, { ...caller, grants: false })
    expect(s.calls[0]).toEqual({ fn: 'company_team_email_threads', args: expect.objectContaining({ p_company_id: CO, p_user_id: BOB, p_grants: true }) })
    expect(s.calls[1].args.p_grants).toBe(false)
  })

  it('asks nothing for a malformed company or caller', async () => {
    const s = svc([row(T1)])
    expect(await fencedTeamThreads(s as never, 'not-a-uuid', caller)).toEqual([])
    expect(await fencedTeamThreads(s as never, CO, { ...caller, userId: 'x' })).toEqual([])
    expect(s.rpc).not.toHaveBeenCalled()
  })

  it('a fence error reads as nothing, never as everything', async () => {
    const s = { rpc: vi.fn(async () => ({ data: null, error: { message: 'boom' } })) }
    expect(await fencedTeamThreads(s as never, CO, caller)).toEqual([])
  })

  it('no status for a company the caller can’t see (the database answers null)', async () => {
    expect(await companySharingStatus(svc([], null) as never, CO, caller)).toBeNull()
  })
})

describe('the list', () => {
  it('lists what the fence answered, with live subjects from each owner’s mailbox', async () => {
    const d = deps()
    const out = await listCompanyTeamThreads(svc([row(T1)]) as never, CO, caller, d)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: T1, subject: 'Renewal quote', has_attachments: true, mine: false, shared_by: { name: 'Alex Example' } })
    // The OWNER's mailbox, never the reader's.
    expect(d.mailbox).toHaveBeenCalledWith(ALEX, ACCT, WS)
    expect(d.headers).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: ALEX }))
  })

  it('nothing from the fence: no mailbox is read at all (a member who didn’t agree, a private thread, a stopped share)', async () => {
    const d = deps()
    expect(await listCompanyTeamThreads(svc([]) as never, CO, caller, d)).toEqual([])
    expect(d.mailbox).not.toHaveBeenCalled()
    expect(d.headers).not.toHaveBeenCalled()
  })

  it('leaves out a thread whose owner’s mailbox no longer reads in this workspace', async () => {
    const d = deps({ mailbox: vi.fn(async () => null) })
    expect(await listCompanyTeamThreads(svc([row(T1)]) as never, CO, caller, d)).toEqual([])
    expect(d.headers).not.toHaveBeenCalled()
  })
})

describe('opening a thread and its attachments', () => {
  it('opens only a thread the fence lists for this reader, by its id', async () => {
    const s = svc([row(T1)])
    const read = await readCompanyTeamThread(s as never, CO, T1, caller, deps())
    expect(read.state).toBe('available')
    expect(s.calls[0].args).toMatchObject({ p_user_id: BOB, p_thread_index_id: T1 })
  })

  it('a thread the fence doesn’t list is not found, and no mailbox is touched', async () => {
    const d = deps()
    expect((await readCompanyTeamThread(svc([row(T1)]) as never, CO, T2, caller, d)).state).toBe('not_found')
    expect(d.mailbox).not.toHaveBeenCalled()
  })

  it('a gone mailbox is unavailable, never a partial read', async () => {
    expect((await readCompanyTeamThread(svc([row(T1)]) as never, CO, T1, caller, deps({ mailbox: vi.fn(async () => null) }))).state).toBe('unavailable')
  })

  it('an attachment only on a message the thread holds now, of a listed thread', async () => {
    const d = deps()
    const ok = await readCompanyTeamAttachment(svc([row(T1)]) as never, { companyId: CO, threadIndexId: T1, messageId: 'm-1', key: 'k' }, caller, d)
    expect(ok.state).toBe('file')
    const elsewhere = await readCompanyTeamAttachment(svc([row(T1)]) as never, { companyId: CO, threadIndexId: T1, messageId: 'm-other-thread', key: 'k' }, caller, d)
    expect(elsewhere.state).toBe('not_found')
    const unlisted = await readCompanyTeamAttachment(svc([row(T1)]) as never, { companyId: CO, threadIndexId: T2, messageId: 'm-1', key: 'k' }, caller, d)
    expect(unlisted.state).toBe('not_found')
    expect(d.provider.attachment).toHaveBeenCalledTimes(1)
  })
})
