/**
 * gatherCompanyContext / renderCompanyContextBlock — the single fence behind
 * the @-mentioned-company card and get_company_overview.
 *
 * The helper runs on SERVICE-ROLE clients (eve/MCP/device-token paths), so the
 * fences asserted here — workspace, company_visible_to, PER-CONTACT
 * contact_visible_to, own mailbox — are the real enforcement, not RLS.
 */
import { wrapUntrusted } from '@/lib/email/untrusted'
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  gatherCompanyContext,
  renderCompanyContextBlock,
  type CompanyContext,
} from '../company-context'

const WS = 'ws-1'
const USER = 'user-1'
const OTHER_USER = 'user-2'

type Row = Record<string, unknown>
type Call = { table: string; method: string; args: unknown[] }
type RpcCall = { fn: string; args: Record<string, unknown> }

/**
 * Recording chain double. `.eq/.neq/.in/.is` are EVALUATED against the table's
 * rows (so the workspace fence actually filters); every other builder method is
 * recorded and passes through. Thenable → { data, error }.
 *
 * `rpc` answers company_visible_to with `opts.company` (default true) and
 * contact_visible_to per contact id via `opts.contacts` (default: all true).
 */
function makeSupabase(
  tables: Record<string, Row[]>,
  opts: {
    company?: boolean | Error
    contacts?: Record<string, boolean | Error>
    fail?: string[]
  } = {},
) {
  const calls: Call[] = []
  const rpcCalls: RpcCall[] = []
  const from = vi.fn((table: string) => {
    let filtered = [...(tables[table] ?? [])]
    const chain: Record<string, unknown> = {}
    const rec = (method: string) =>
      vi.fn((...args: unknown[]) => {
        calls.push({ table, method, args })
        return chain
      })
    for (const m of ['select', 'or', 'not', 'order', 'limit', 'overlaps', 'contains']) chain[m] = rec(m)
    chain.eq = vi.fn((col: string, val: unknown) => {
      calls.push({ table, method: 'eq', args: [col, val] })
      filtered = filtered.filter((r) => r[col] === val)
      return chain
    })
    chain.neq = vi.fn((col: string, val: unknown) => {
      calls.push({ table, method: 'neq', args: [col, val] })
      filtered = filtered.filter((r) => r[col] !== val)
      return chain
    })
    chain.in = vi.fn((col: string, vals: unknown[]) => {
      calls.push({ table, method: 'in', args: [col, vals] })
      filtered = filtered.filter((r) => vals.includes(r[col]))
      return chain
    })
    chain.is = vi.fn((col: string, val: unknown) => {
      calls.push({ table, method: 'is', args: [col, val] })
      filtered = filtered.filter((r) => r[col] === val)
      return chain
    })
    const result = () =>
      opts.fail?.includes(table)
        ? { data: null, error: { message: `boom ${table}` } }
        : { data: filtered, error: null }
    chain.maybeSingle = vi.fn(async () => {
      const r = result()
      return { data: r.data ? (r.data[0] ?? null) : null, error: r.error }
    })
    chain.then = (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject)
    return chain
  })
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args })
    let v: boolean | Error | undefined
    if (fn === 'company_visible_to') v = opts.company ?? true
    else if (fn === 'contact_visible_to') v = opts.contacts?.[args.p_contact_id as string] ?? true
    if (v instanceof Error) return { data: null, error: { message: v.message } }
    return { data: v ?? false, error: null }
  })
  return { client: { from, rpc } as never, calls, rpcCalls, rpc, from }
}

const COMPANY: Row = {
  id: 'co1',
  workspace_id: WS,
  name: 'Acme',
  domain: 'acme.com',
  website: 'https://acme.com',
  industry: 'Software',
  description: null,
  employee_count_range: '51-200',
  annual_revenue_range: null,
  city: 'Austin',
  state: 'TX',
  country: 'US',
  tags: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
}

const MAYA: Row = {
  id: 'c-maya',
  workspace_id: WS,
  company_id: 'co1',
  full_name: 'Maya Chen',
  email: 'Maya@Acme.com',
  secondary_emails: ['m.chen@acme.com'],
  job_title: 'VP Eng',
  relationship_strength: 'strong',
  interaction_count: 7,
  last_interaction_at: '2026-08-10T12:00:00Z',
  member_id: null,
  merged_into_contact_id: null,
}
const RAJ: Row = {
  id: 'c-raj',
  workspace_id: WS,
  company_id: 'co1',
  full_name: 'Raj Patel',
  email: 'raj@acme.com',
  secondary_emails: null,
  job_title: 'CTO',
  relationship_strength: null,
  interaction_count: 2,
  last_interaction_at: '2026-08-12T12:00:00Z',
  member_id: 'm-raj',
  merged_into_contact_id: null,
}

const orClauses = (calls: Call[], table: string) =>
  calls.filter((c) => c.table === table && c.method === 'or').map((c) => c.args)

const run = (sb: ReturnType<typeof makeSupabase>, over: Partial<Parameters<typeof gatherCompanyContext>[1]> = {}) =>
  gatherCompanyContext(sb.client, { workspaceId: WS, userId: USER, companyId: 'co1', requester: USER, ...over })

afterEach(() => vi.restoreAllMocks())

describe('gatherCompanyContext — fences', () => {
  it('returns null for a company in another workspace (never leaks existence)', async () => {
    const sb = makeSupabase({ company: [{ ...COMPANY, workspace_id: 'ws-other' }], contact: [MAYA] })
    expect(await run(sb)).toBeNull()
    expect(sb.rpc).not.toHaveBeenCalled()
    expect(sb.from).not.toHaveBeenCalledWith('contact')
  })

  it('returns null when company_visible_to is not exactly true (false or error → fail closed)', async () => {
    const sb = makeSupabase({ company: [COMPANY], contact: [MAYA] }, { company: false })
    expect(await run(sb)).toBeNull()
    expect(sb.rpc).toHaveBeenCalledWith('company_visible_to', { p_company_id: 'co1', p_user_id: USER })
    expect(sb.from).not.toHaveBeenCalledWith('contact')

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sb2 = makeSupabase({ company: [COMPANY], contact: [MAYA] }, { company: new Error('no such function') })
    expect(await run(sb2)).toBeNull()
    expect(warn).toHaveBeenCalled()
  })

  it('passes the requester (not the user) to company_visible_to — null on unattended runs', async () => {
    const sb = makeSupabase({ company: [COMPANY] })
    await run(sb, { requester: null })
    expect(sb.rpc).toHaveBeenCalledWith('company_visible_to', { p_company_id: 'co1', p_user_id: null })
  })

  it('filters people PER CONTACT through contact_visible_to and drives every downstream section from the visible ids only', async () => {
    const sb = makeSupabase(
      { company: [COMPANY], contact: [MAYA, RAJ] },
      { contacts: { 'c-maya': true, 'c-raj': false } },
    )
    const ctx = await run(sb)
    expect(ctx).not.toBeNull()
    expect(ctx!.people.map((p) => p.id)).toEqual(['c-maya'])
    expect(ctx!.people_on_record).toBe(2)
    expect(ctx!.people_visible).toBe(1)
    // One RPC per contact on record, with the requester.
    expect(sb.rpcCalls.filter((r) => r.fn === 'contact_visible_to').map((r) => r.args)).toEqual([
      { p_contact_id: 'c-maya', p_user_id: USER },
      { p_contact_id: 'c-raj', p_user_id: USER },
    ])

    const all = sb.calls.filter((c) => c.method === 'or').map((c) => c.args[0] as string).join('\n')
    expect(all).toContain('c-maya')
    expect(all).not.toContain('c-raj')
    // Raj is a teammate (member m-raj) but invisible → no member bridge for him.
    expect(all).not.toContain('m-raj')

    const cpOr = orClauses(sb.calls, 'captures').find((a) => (a[1] as { referencedTable?: string })?.referencedTable === 'cp')
    expect(cpOr).toBeDefined()
    expect(cpOr![0]).toContain('contact_id.in.(c-maya)')
    expect(cpOr![0]).toContain('external_email.in.("maya@acme.com","m.chen@acme.com")')
    expect(cpOr![0]).not.toContain('raj@acme.com')

    expect(sb.calls).toContainEqual({
      table: 'email_thread_index',
      method: 'overlaps',
      args: ['participant_emails', ['maya@acme.com', 'm.chen@acme.com']],
    })
  })

  it('treats a contact_visible_to RPC error as NOT visible (fail closed, warn)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sb = makeSupabase(
      { company: [COMPANY], contact: [MAYA, RAJ] },
      { contacts: { 'c-maya': new Error('boom'), 'c-raj': true } },
    )
    const ctx = await run(sb)
    expect(ctx!.people.map((p) => p.id)).toEqual(['c-raj'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('contact_visible_to'), 'boom')
  })

  it('adds the member bridge (assignee_id / assignee_member_id / member_id) for visible teammates', async () => {
    const sb = makeSupabase({ company: [COMPANY], contact: [MAYA, RAJ] })
    const ctx = await run(sb)
    expect(ctx!.people.find((p) => p.id === 'c-raj')?.is_teammate).toBe(true)
    const actionsOr = orClauses(sb.calls, 'actions').map((a) => a[0] as string)
    expect(actionsOr.some((f) => f.includes('assignee_contact_id.in.(c-maya,c-raj)') && f.includes('assignee_id.in.(m-raj)'))).toBe(true)
    const proposalOr = orClauses(sb.calls, 'proposed_change').map((a) => a[0] as string)
    expect(proposalOr.some((f) => f.includes('assignee_member_id.in.(m-raj)'))).toBe(true)
    const cpOr = orClauses(sb.calls, 'captures').find((a) => (a[1] as { referencedTable?: string })?.referencedTable === 'cp')
    expect(cpOr![0]).toContain('member_id.in.(m-raj)')
  })

  it('skips every downstream query when no contact is visible, but still returns the company', async () => {
    const sb = makeSupabase({ company: [COMPANY], contact: [MAYA] }, { contacts: { 'c-maya': false } })
    const ctx = await run(sb)
    expect(ctx).not.toBeNull()
    expect(ctx!.people).toEqual([])
    expect(ctx!.people_visible).toBe(0)
    expect(ctx!.open_actions).toEqual([])
    expect(ctx!.recent_email_threads).toEqual([])
    for (const t of ['actions', 'proposed_change', 'captures', 'email_thread_index', 'decision']) {
      expect(sb.from).not.toHaveBeenCalledWith(t)
    }
  })
})

describe('gatherCompanyContext — sections', () => {
  const CAPTURES: Row[] = [
    { id: 'cap-ws', workspace_id: WS, user_id: OTHER_USER, visibility: 'workspace', title: 'Sync', ai_summary: 'S', started_at: '2026-08-01T00:00:00Z', status: 'ready' },
    // Same capture returned twice (two company participants matched the !inner embed).
    { id: 'cap-ws', workspace_id: WS, user_id: OTHER_USER, visibility: 'workspace', title: 'Sync', ai_summary: 'S', started_at: '2026-08-01T00:00:00Z', status: 'ready' },
    { id: 'cap-their-private', workspace_id: WS, user_id: OTHER_USER, visibility: 'private', title: 'Secret', ai_summary: 'S', started_at: '2026-08-02T00:00:00Z', status: 'ready' },
    { id: 'cap-foreign', workspace_id: 'ws-other', user_id: USER, visibility: 'workspace', title: 'Leak', ai_summary: 'S', started_at: '2026-08-03T00:00:00Z', status: 'ready' },
  ]

  it('omits email threads entirely when there is no requester, includes them (own mailbox only) otherwise', async () => {
    const unattended = makeSupabase({ company: [COMPANY], contact: [MAYA], email_thread_index: [{ id: 't1' }] })
    const ctx1 = await run(unattended, { requester: null })
    expect(ctx1).not.toBeNull()
    expect('recent_email_threads' in ctx1!).toBe(false)
    expect(unattended.from).not.toHaveBeenCalledWith('email_thread_index')

    const attended = makeSupabase({
      company: [COMPANY],
      contact: [MAYA],
      email_thread_index: [{ id: 't1', user_id: USER, workspace_id: WS, subject: 'Hi', last_message_at: '2026-08-01', needs_reply: true, from_email: 'maya@acme.com', message_count: 2 }],
    })
    const ctx2 = await run(attended)
    expect(ctx2?.recent_email_threads?.map((t) => t.id)).toEqual(['t1'])
    expect(attended.calls).toContainEqual({ table: 'email_thread_index', method: 'eq', args: ['user_id', USER] })
  })

  it('dedupes captures by id and re-checks workspace + visibility in TS even when the DB filter leaks', async () => {
    const sb = makeSupabase({ company: [COMPANY], contact: [MAYA], captures: CAPTURES })
    const ctx = await run(sb)
    expect(ctx?.recent_captures.map((c) => c.id)).toEqual(['cap-ws'])
    // Decisions are fenced to the deduped, visible capture ids.
    expect(sb.calls).toContainEqual({ table: 'decision', method: 'in', args: ['capture_id', ['cap-ws']] })
  })

  it('turns a failing section into [] and warns, without failing the whole context', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sb = makeSupabase(
      { company: [COMPANY], contact: [MAYA], captures: CAPTURES, actions: [{ id: 'a1', title: 'T', workflow_state: null }] },
      { fail: ['actions'] },
    )
    const ctx = await run(sb)
    expect(ctx).not.toBeNull()
    expect(ctx?.open_actions).toEqual([])
    expect(ctx?.recent_captures.map((c) => c.id)).toEqual(['cap-ws'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('actions(open)'), 'boom actions')
  })

  it('drops completed/canceled actions in TS, tags assigned_via and resolves the assignee name', async () => {
    const sb = makeSupabase({
      company: [COMPANY],
      contact: [MAYA, RAJ],
      actions: [
        { id: 'a-open', workspace_id: WS, identifier: 'ENG-1', title: 'Open', assignee_contact_id: 'c-maya', assignee_id: null, workflow_state: { name: 'Todo', category: 'unstarted' }, confirmation: 'confirmed' },
        { id: 'a-member', workspace_id: WS, identifier: 'ENG-2', title: 'Via member', assignee_contact_id: null, assignee_id: 'm-raj', workflow_state: null, confirmation: 'suggested' },
        { id: 'a-done', workspace_id: WS, identifier: 'ENG-3', title: 'Done', assignee_contact_id: 'c-maya', workflow_state: { name: 'Done', category: 'completed' } },
      ],
    })
    const ctx = await run(sb)
    expect(ctx?.open_actions.map((a) => [a.id, a.assigned_via, a.assignee_name])).toEqual([
      ['a-open', 'contact', 'Maya Chen'],
      ['a-member', 'member', 'Raj Patel'],
    ])
    expect(ctx?.last_interaction_at).toBe('2026-08-12T12:00:00Z')
  })
})

// ── renderCompanyContextBlock ────────────────────────────────────────────────

const baseCtx = (over: Partial<CompanyContext> = {}): CompanyContext => ({
  company: {
    id: 'co1',
    workspace_id: WS,
    name: 'Acme',
    domain: 'acme.com',
    website: null,
    industry: 'Software',
    description: null,
    employee_count_range: null,
    annual_revenue_range: null,
    city: null,
    state: null,
    country: null,
    tags: null,
    created_at: null,
    updated_at: null,
  },
  people: [],
  people_on_record: 0,
  people_visible: 0,
  last_interaction_at: null,
  open_actions: [],
  pending_commitments: [],
  recent_captures: [],
  decisions: [],
  ...over,
})

describe('renderCompanyContextBlock', () => {
  it('renders the header and the two always-on sections as "none on record" when empty, omitting the rest', () => {
    const out = renderCompanyContextBlock(baseCtx())
    expect(out.startsWith('### Acme — Software · acme.com · company_id: co1\n')).toBe(true)
    expect(out).toContain('0 people on record · 0 visible to you · no interactions on record')
    expect(out).toContain('People (0):\n- none on record')
    expect(out).toContain('Open actions across this account (0):\n- none on record')
    expect(out).not.toContain('Suggested commitments')
    expect(out).not.toContain('Recent meetings')
    expect(out).not.toContain('Recent email threads')
    expect(out).not.toContain('Decisions from meetings')
  })

  it('renders populated sections in the documented shape', () => {
    const out = renderCompanyContextBlock(
      baseCtx({
        people: [
          { id: 'c-maya', full_name: 'Maya Chen', email: 'maya@acme.com', job_title: 'VP Eng', relationship_strength: 'strong', interaction_count: 7, last_interaction_at: '2026-08-10T12:00:00Z', member_id: null, is_teammate: false },
        ],
        people_on_record: 3,
        people_visible: 2,
        last_interaction_at: '2026-08-10T12:00:00Z',
        open_actions: [
          { id: 'a1', identifier: 'ENG-1', title: 'Ship it', status: 'In Progress', status_category: 'started', due_at: '2026-09-01T00:00:00Z', priority: 'high', confirmation: 'suggested', assigned_via: 'contact', assignee_contact_id: 'c-maya', assignee_name: 'Maya Chen' },
        ],
        pending_commitments: [
          { proposed_change_id: 'p1', display_text: 'Maya to send the deck', title: null, due_date: '2026-08-20', change_type: 'create', assignee_name: 'Maya Chen', capture_id: 'cap1', capture_title: 'Kickoff', capture_date: '2026-08-12T00:00:00Z' },
        ],
        recent_captures: Array.from({ length: 6 }, (_, i) => ({ id: `cap${i}`, title: `Meeting ${i}`, started_at: '2026-08-0' + (i + 1) + 'T00:00:00Z', ai_summary: 'Talked about things' })),
        recent_email_threads: [{ id: 't1', subject: 'Contract', last_message_at: '2026-08-11T00:00:00Z', needs_reply: true, from_email: 'maya@acme.com', message_count: 3 }],
        decisions: [{ id: 'd1', content: 'Go with plan B', capture_title: 'Kickoff', created_at: '2026-08-12' }],
      }),
    )
    expect(out).toContain('3 people on record · 2 visible to you · last interaction 2026-08-10')
    expect(out).toContain('People (1 of 2):\n- Maya Chen · VP Eng · maya@acme.com · 7 interactions · last 2026-08-10 · contact_id: c-maya')
    expect(out).toContain('Open actions across this account (1):\n- ENG-1 · Ship it · owner: Maya Chen · In Progress · due 2026-09-01 · (suggested, unconfirmed)')
    expect(out).toContain('Suggested commitments not yet accepted (AI-extracted, pending your review) (1):\n- "Maya to send the deck" · owner: Maya Chen · from Kickoff (2026-08-12) · due 2026-08-20')
    expect(out).toContain('Recent meetings with this account (4 of 6):')
    expect(out).toContain('- Meeting 0 · 2026-08-01 · capture_id: cap0 — Talked about things')
    expect(out).not.toContain('Meeting 4')
    // The live subject is marked as data; the sender's address names who.
    expect(out).toContain('Recent email threads with this account (your mailbox) (1):\n- ' + wrapUntrusted('Contract') + ' · from maya@acme.com · 2026-08-11 · needs reply · thread_id: t1')
    expect(out).toContain('Decisions from meetings with this account (1):\n- "Go with plan B" — Kickoff')
  })

  it('hard-caps at maxChars by dropping optional sections from the tail, then cutting', () => {
    const big = baseCtx({
      open_actions: Array.from({ length: 8 }, (_, i) => ({
        id: `a${i}`, identifier: `ENG-${i}`, title: 'x'.repeat(200), status: 'Todo', status_category: 'unstarted', due_at: null, priority: null, confirmation: 'confirmed', assigned_via: 'contact' as const, assignee_contact_id: 'c1', assignee_name: 'Maya Chen',
      })),
      recent_captures: Array.from({ length: 4 }, (_, i) => ({ id: `cap${i}`, title: 'Meeting', started_at: '2026-08-01T00:00:00Z', ai_summary: 'y'.repeat(300) })),
      decisions: Array.from({ length: 3 }, (_, i) => ({ id: `d${i}`, content: 'z'.repeat(200), capture_title: 'M', created_at: null })),
    })
    const out = renderCompanyContextBlock(big)
    expect(out.length).toBeLessThanOrEqual(3000)
    expect(out.endsWith('…[truncated]')).toBe(true)
    expect(out).toContain('People (0)')
    expect(out).toContain('Open actions across this account')
    expect(out).not.toContain('Decisions from meetings')

    const tiny = renderCompanyContextBlock(big, { maxChars: 400 })
    expect(tiny.length).toBeLessThanOrEqual(400)
    expect(tiny.endsWith('…[truncated]')).toBe(true)

    expect(renderCompanyContextBlock(baseCtx()).endsWith('…[truncated]')).toBe(false)
  })
})
