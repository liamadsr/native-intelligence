/**
 * The agent's path to a company's team-shared email (migration 680): the
 * company overview (get_company_overview, the @-mentioned company card, MCP)
 * runs on a SERVICE-ROLE client, so it names the requester to the database's
 * fence (company_team_email_threads) and gets the same answer a person would.
 * It reads metadata only: no mailbox, no subject, no body. Made-up people.
 */
import { describe, expect, it, vi } from 'vitest'
import { gatherCompanyContext, renderCompanyContextBlock } from '../company-context'

const WS = 'ws-1'
const USER = 'user-bob'

type Row = Record<string, unknown>

function makeSupabase(tables: Record<string, Row[]>, teamRows: Row[] = []) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const from = vi.fn((table: string) => {
    let rows = [...(tables[table] ?? [])]
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'or', 'not', 'order', 'limit', 'overlaps', 'contains', 'neq']) chain[m] = () => chain
    chain.eq = (c: string, v: unknown) => ((rows = rows.filter((r) => !(c in r) || r[c] === v)), chain)
    chain.in = (c: string, v: unknown[]) => ((rows = rows.filter((r) => !(c in r) || v.includes(r[c]))), chain)
    chain.is = () => chain
    chain.maybeSingle = async () => ({ data: rows[0] ?? null, error: null })
    chain.then = (res: (r: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res)
    return chain
  })
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args })
    if (fn === 'company_team_email_threads') return { data: teamRows, error: null }
    return { data: true, error: null }
  })
  return { client: { from, rpc } as never, rpcCalls, from }
}

const COMPANY = (on: boolean): Row => ({
  id: 'co1',
  workspace_id: WS,
  name: 'Acme Example',
  domain: 'acme.example',
  share_email_with_team: on,
  stage: { name: 'Demo' },
  owner: { display_name: 'Alex Example' },
  owner_member_id: 'm-alex',
  revenue: { amount: 120000, currency: 'USD' },
})
const PAT: Row = { id: 'c-pat', workspace_id: WS, company_id: 'co1', full_name: 'Pat Example', email: 'pat@acme.example', merged_into_contact_id: null }
const MEMBERS: Row[] = [
  { id: 'm-alex', workspace_id: WS, display_name: 'Alex Example' },
  { id: 'm-bob', workspace_id: WS, display_name: 'Bob Example' },
]
const TEAM_ROW: Row = {
  thread_index_id: 't-1',
  owner_member_id: 'm-alex',
  owner_user_id: 'user-alex',
  last_message_at: '2026-11-20T10:00:00Z',
  message_count: 4,
  has_attachments: true,
  team_member_ids: ['m-alex', 'm-bob'],
  provider_thread_id: 'secret-provider-id',
}

const teamCall = (calls: Array<{ fn: string; args: Record<string, unknown> }>) => calls.find((c) => c.fn === 'company_team_email_threads')

describe('company overview: team-shared email for the agent', () => {
  it('asks the fence for the requester, with the turn’s grants, and keeps metadata only', async () => {
    const sb = makeSupabase({ company: [COMPANY(true)], contact: [PAT], member: MEMBERS }, [TEAM_ROW])
    const ctx = await gatherCompanyContext(sb.client, { workspaceId: WS, userId: USER, companyId: 'co1', requester: USER, grants: false })
    expect(teamCall(sb.rpcCalls)?.args).toMatchObject({ p_company_id: 'co1', p_user_id: USER, p_grants: false })
    expect(ctx?.team_email_threads).toEqual([
      { thread_id: 't-1', last_message_at: '2026-11-20T10:00:00Z', shared_by: 'Alex Example', team: ['Alex Example', 'Bob Example'], message_count: 4, has_attachments: true },
    ])
    // No mailbox is read for it, and nothing of the mail travels.
    expect(JSON.stringify(ctx?.team_email_threads)).not.toMatch(/subject|snippet|body|secret-provider-id/)
    const text = renderCompanyContextBlock(ctx!)
    expect(text).toContain('Email the team shared on this account (1')
    expect(text).toContain('shared by Alex Example · team on it: Alex Example, Bob Example · 4 messages · attachments')
    expect(text).toContain('stage: Demo · owner: Alex Example · revenue $120,000.00')
  })

  it('asks nothing with sharing off', async () => {
    const sb = makeSupabase({ company: [COMPANY(false)], contact: [PAT], member: MEMBERS }, [TEAM_ROW])
    const ctx = await gatherCompanyContext(sb.client, { workspaceId: WS, userId: USER, companyId: 'co1', requester: USER })
    expect(teamCall(sb.rpcCalls)).toBeUndefined()
    expect(ctx && 'team_email_threads' in ctx).toBe(false)
  })

  it('asks nothing on an unattended run (no requester)', async () => {
    const sb = makeSupabase({ company: [COMPANY(true)], contact: [PAT], member: MEMBERS }, [TEAM_ROW])
    const ctx = await gatherCompanyContext(sb.client, { workspaceId: WS, userId: USER, companyId: 'co1', requester: null })
    expect(teamCall(sb.rpcCalls)).toBeUndefined()
    expect(ctx && 'team_email_threads' in ctx).toBe(false)
  })

  it('an empty answer from the fence (no one agreed, private, another workspace) is an empty list', async () => {
    const sb = makeSupabase({ company: [COMPANY(true)], contact: [PAT], member: MEMBERS }, [])
    const ctx = await gatherCompanyContext(sb.client, { workspaceId: WS, userId: USER, companyId: 'co1', requester: USER })
    expect(ctx?.team_email_threads).toEqual([])
  })
})
