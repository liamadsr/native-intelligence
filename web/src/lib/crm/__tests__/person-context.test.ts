/**
 * gatherPersonContext / renderPersonContextBlock — the single fence behind the
 * @-mentioned-person card and get_contact_details.
 *
 * The helper runs on SERVICE-ROLE clients (eve/MCP/device-token paths), so the
 * fences asserted here — workspace, merge tombstones, contact_visible_to, own
 * mailbox — are the real enforcement, not RLS.
 */
import { wrapUntrusted } from '@/lib/email/untrusted'
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  gatherPersonContext,
  renderPersonContextBlock,
  type PersonContext,
} from '../person-context'

const WS = 'ws-1'
const USER = 'user-1'
const OTHER_USER = 'user-2'

type Row = Record<string, unknown>
type Call = { table: string; method: string; args: unknown[] }

/**
 * Recording chain double. `.eq/.neq/.in/.is` are EVALUATED against the table's
 * rows (so the workspace fence and tombstone hops actually filter); every other
 * builder method is recorded and passes through. Thenable → { data, error }.
 */
function makeSupabase(
  tables: Record<string, Row[]>,
  opts: { rpc?: boolean | Error; fail?: string[] } = {},
) {
  const calls: Call[] = []
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
  const rpc = vi.fn(async () => {
    if (opts.rpc instanceof Error) return { data: null, error: { message: opts.rpc.message } }
    return { data: opts.rpc ?? true, error: null }
  })
  return { client: { from, rpc } as never, calls, rpc, from }
}

const CONTACT: Row = {
  id: 'c1',
  workspace_id: WS,
  full_name: 'Maya Chen',
  email: 'Maya@Acme.com',
  secondary_emails: ['m.chen@acme.com'],
  job_title: 'VP Eng',
  member_id: null,
  visibility: 'workspace',
  relationship_type: 'customer',
  relationship_strength: 'strong',
  last_interaction_at: '2026-08-10T12:00:00Z',
  interaction_count: 7,
  enrichment_status: 'enriched',
  merged_into_contact_id: null,
  company: { id: 'co1', name: 'Acme', domain: 'acme.com' },
}

const orClauses = (calls: Call[], table: string) =>
  calls.filter((c) => c.table === table && c.method === 'or').map((c) => c.args)

afterEach(() => vi.restoreAllMocks())

describe('gatherPersonContext — fences', () => {
  it('returns null for a contact in another workspace (never leaks existence)', async () => {
    const sb = makeSupabase({ contact: [{ ...CONTACT, workspace_id: 'ws-other' }] })
    const ctx = await gatherPersonContext(sb.client, {
      workspaceId: WS, userId: USER, contactId: 'c1', requester: USER,
    })
    expect(ctx).toBeNull()
    expect(sb.rpc).not.toHaveBeenCalled()
  })

  it('follows a merge tombstone to the canonical contact and records canonical_of', async () => {
    const sb = makeSupabase({
      contact: [
        { ...CONTACT, id: 'c-old', merged_into_contact_id: 'c1' },
        CONTACT,
      ],
    })
    const ctx = await gatherPersonContext(sb.client, {
      workspaceId: WS, userId: USER, contactId: 'c-old', requester: USER,
    })
    expect(ctx?.contact.id).toBe('c1')
    expect(ctx?.canonical_of).toBe('c-old')
    // The visibility check runs against the CANONICAL row.
    expect(sb.rpc).toHaveBeenCalledWith('contact_visible_to', { p_contact_id: 'c1', p_user_id: USER })
  })

  it('gives up on a tombstone chain longer than 3 hops', async () => {
    const sb = makeSupabase({
      contact: [
        { ...CONTACT, id: 'a', merged_into_contact_id: 'b' },
        { ...CONTACT, id: 'b', merged_into_contact_id: 'c' },
        { ...CONTACT, id: 'c', merged_into_contact_id: 'd' },
        { ...CONTACT, id: 'd', merged_into_contact_id: 'e' },
        { ...CONTACT, id: 'e', merged_into_contact_id: null },
      ],
    })
    const ctx = await gatherPersonContext(sb.client, {
      workspaceId: WS, userId: USER, contactId: 'a', requester: USER,
    })
    expect(ctx).toBeNull()
  })

  it('returns null when contact_visible_to is not exactly true', async () => {
    const sb = makeSupabase({ contact: [CONTACT] }, { rpc: false })
    expect(
      await gatherPersonContext(sb.client, { workspaceId: WS, userId: USER, contactId: 'c1', requester: USER }),
    ).toBeNull()
    // RPC error → also null (fail closed), with a warning.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sb2 = makeSupabase({ contact: [CONTACT] }, { rpc: new Error('no such function') })
    expect(
      await gatherPersonContext(sb2.client, { workspaceId: WS, userId: USER, contactId: 'c1', requester: USER }),
    ).toBeNull()
    expect(warn).toHaveBeenCalled()
  })

  it('passes the requester (not the user) to contact_visible_to — null on unattended runs', async () => {
    const sb = makeSupabase({ contact: [CONTACT] })
    await gatherPersonContext(sb.client, { workspaceId: WS, userId: USER, contactId: 'c1', requester: null })
    expect(sb.rpc).toHaveBeenCalledWith('contact_visible_to', { p_contact_id: 'c1', p_user_id: null })
  })
})

describe('gatherPersonContext — member bridge', () => {
  it('adds assignee_id / assignee_member_id / member_id clauses when the contact mirrors a member', async () => {
    const sb = makeSupabase({ contact: [{ ...CONTACT, member_id: 'm-maya' }] })
    const ctx = await gatherPersonContext(sb.client, {
      workspaceId: WS, userId: USER, contactId: 'c1', requester: USER,
    })
    expect(ctx?.is_teammate).toBe(true)

    const actionsOr = orClauses(sb.calls, 'actions').map((a) => a[0] as string)
    expect(actionsOr.some((f) => f.includes('assignee_contact_id.eq.c1') && f.includes('assignee_id.eq.m-maya'))).toBe(true)

    const proposalOr = orClauses(sb.calls, 'proposed_change').map((a) => a[0] as string)
    expect(
      proposalOr.some((f) => f.includes('assignee_contact_id.eq.c1') && f.includes('assignee_member_id.eq.m-maya')),
    ).toBe(true)

    const cpOr = orClauses(sb.calls, 'captures').find((a) => (a[1] as { referencedTable?: string })?.referencedTable === 'cp')
    expect(cpOr).toBeDefined()
    expect(cpOr![0]).toContain('contact_id.eq.c1')
    expect(cpOr![0]).toContain('member_id.eq.m-maya')
    expect(cpOr![0]).toContain('external_email.eq."maya@acme.com"')
  })

  it('omits the member clauses for an external contact', async () => {
    const sb = makeSupabase({ contact: [CONTACT] })
    const ctx = await gatherPersonContext(sb.client, {
      workspaceId: WS, userId: USER, contactId: 'c1', requester: USER,
    })
    expect(ctx?.is_teammate).toBe(false)
    const all = sb.calls.filter((c) => c.method === 'or').map((c) => c.args[0] as string).join('\n')
    expect(all).not.toContain('assignee_id.eq.')
    expect(all).not.toContain('assignee_member_id.eq.')
    expect(all).not.toContain('member_id.eq.')
  })
})

describe('gatherPersonContext — sections', () => {
  const CAPTURES: Row[] = [
    { id: 'cap-ws', workspace_id: WS, user_id: OTHER_USER, visibility: 'workspace', title: 'Sync', ai_summary: 'S', started_at: '2026-08-01T00:00:00Z', status: 'ready' },
    { id: 'cap-their-private', workspace_id: WS, user_id: OTHER_USER, visibility: 'private', title: 'Secret', ai_summary: 'S', started_at: '2026-08-02T00:00:00Z', status: 'ready' },
    { id: 'cap-foreign', workspace_id: 'ws-other', user_id: USER, visibility: 'workspace', title: 'Leak', ai_summary: 'S', started_at: '2026-08-03T00:00:00Z', status: 'ready' },
  ]

  it('omits email threads entirely when there is no requester, includes them (own mailbox only) otherwise', async () => {
    const unattended = makeSupabase({ contact: [CONTACT], email_thread_index: [{ id: 't1' }] })
    const ctx1 = await gatherPersonContext(unattended.client, {
      workspaceId: WS, userId: USER, contactId: 'c1', requester: null,
    })
    expect(ctx1).not.toBeNull()
    expect('recent_email_threads' in ctx1!).toBe(false)
    expect(unattended.from).not.toHaveBeenCalledWith('email_thread_index')

    const attended = makeSupabase({
      contact: [CONTACT],
      email_thread_index: [{ id: 't1', user_id: USER, workspace_id: WS, subject: 'Hi', last_message_at: '2026-08-01', needs_reply: true, from_email: 'maya@acme.com', message_count: 2 }],
    })
    const ctx2 = await gatherPersonContext(attended.client, {
      workspaceId: WS, userId: USER, contactId: 'c1', requester: USER,
    })
    expect(ctx2?.recent_email_threads?.map((t) => t.id)).toEqual(['t1'])
    // Fenced to the requester's own mailbox + the contact's (lower-cased) emails.
    expect(attended.calls).toContainEqual({ table: 'email_thread_index', method: 'eq', args: ['user_id', USER] })
    expect(attended.calls).toContainEqual({
      table: 'email_thread_index',
      method: 'overlaps',
      args: ['participant_emails', ['maya@acme.com', 'm.chen@acme.com']],
    })
  })

  it('re-checks capture workspace + visibility in TS even when the DB filter leaks', async () => {
    // The stub ignores top-level .or(), so every row comes back — the TS fence must drop them.
    const sb = makeSupabase({ contact: [CONTACT], captures: CAPTURES })
    const ctx = await gatherPersonContext(sb.client, {
      workspaceId: WS, userId: USER, contactId: 'c1', requester: USER,
    })
    expect(ctx?.recent_captures.map((c) => c.id)).toEqual(['cap-ws'])
  })

  it('keeps my-actions empty when there is no member row for the user, and skips the email/member lookups when userId is null', async () => {
    const sb = makeSupabase({ contact: [CONTACT], captures: CAPTURES })
    const ctx = await gatherPersonContext(sb.client, {
      workspaceId: WS, userId: null, contactId: 'c1', requester: null,
    })
    expect(ctx?.my_open_actions_from_their_meetings).toEqual([])
    expect(sb.from).not.toHaveBeenCalledWith('member')
    expect(sb.from).not.toHaveBeenCalledWith('email_thread_index')
  })

  it('turns a failing section into [] and warns, without failing the whole context', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sb = makeSupabase(
      { contact: [CONTACT], captures: CAPTURES, actions: [{ id: 'a1', title: 'T', workflow_state: null }] },
      { fail: ['actions'] },
    )
    const ctx = await gatherPersonContext(sb.client, {
      workspaceId: WS, userId: USER, contactId: 'c1', requester: USER,
    })
    expect(ctx).not.toBeNull()
    expect(ctx?.open_actions).toEqual([])
    expect(ctx?.recent_captures.map((c) => c.id)).toEqual(['cap-ws'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('actions(open)'), 'boom actions')
  })

  it('drops completed/canceled actions in TS and tags assigned_via', async () => {
    const sb = makeSupabase({
      contact: [{ ...CONTACT, member_id: 'm-maya' }],
      actions: [
        { id: 'a-open', workspace_id: WS, identifier: 'ENG-1', title: 'Open', assignee_contact_id: 'c1', assignee_id: null, workflow_state: { name: 'Todo', category: 'unstarted' }, confirmation: 'confirmed' },
        { id: 'a-member', workspace_id: WS, identifier: 'ENG-2', title: 'Mine via member', assignee_contact_id: null, assignee_id: 'm-maya', workflow_state: null, confirmation: 'suggested' },
        { id: 'a-done', workspace_id: WS, identifier: 'ENG-3', title: 'Done', assignee_contact_id: 'c1', workflow_state: { name: 'Done', category: 'completed' } },
      ],
    })
    const ctx = await gatherPersonContext(sb.client, {
      workspaceId: WS, userId: USER, contactId: 'c1', requester: USER,
    })
    expect(ctx?.open_actions.map((a) => [a.id, a.assigned_via])).toEqual([
      ['a-open', 'contact'],
      ['a-member', 'member'],
    ])
  })
})

// ── renderPersonContextBlock ─────────────────────────────────────────────────

const baseCtx = (over: Partial<PersonContext> = {}): PersonContext => ({
  contact: {
    id: 'c1',
    workspace_id: WS,
    full_name: 'Maya Chen',
    email: 'maya@acme.com',
    secondary_emails: null,
    job_title: 'VP Eng',
    member_id: null,
    visibility: 'workspace',
    relationship_type: 'customer',
    relationship_strength: 'strong',
    last_interaction_at: '2026-08-10T12:00:00Z',
    interaction_count: 7,
    enrichment_status: 'enriched',
    company: { id: 'co1', name: 'Acme', domain: 'acme.com' },
  },
  is_teammate: false,
  open_actions: [],
  pending_commitments: [],
  recent_captures: [],
  my_open_actions_from_their_meetings: [],
  decisions: [],
  ...over,
})

describe('renderPersonContextBlock', () => {
  it('renders the header and the two always-on sections as "none on record" when empty, omitting the rest', () => {
    const out = renderPersonContextBlock(baseCtx())
    expect(out.startsWith('### Maya Chen — VP Eng @ Acme · external contact · maya@acme.com · contact_id: c1\n')).toBe(true)
    expect(out).toContain('relationship: strong · 7 interactions · last interaction 2026-08-10')
    expect(out).toContain('Open actions they own — what you are waiting on from them (0):\n- none on record')
    expect(out).toContain('Suggested commitments not yet accepted (AI-extracted, pending your review) (0):\n- none on record')
    expect(out).not.toContain('Your open actions from meetings with them')
    expect(out).not.toContain('Recent meetings with them')
    expect(out).not.toContain('Recent email threads')
    expect(out).not.toContain('Decisions from meetings')
  })

  it('renders populated sections in the documented shape', () => {
    const out = renderPersonContextBlock(
      baseCtx({
        is_teammate: true,
        open_actions: [
          { id: 'a1', identifier: 'ENG-1', title: 'Ship it', status: 'In Progress', status_category: 'started', due_at: '2026-09-01T00:00:00Z', priority: 'high', confirmation: 'suggested', assigned_via: 'contact' },
        ],
        pending_commitments: [
          { proposed_change_id: 'p1', display_text: 'Maya to send the deck', title: null, due_date: '2026-08-20', change_type: 'create', capture_id: 'cap1', capture_title: 'Kickoff', capture_date: '2026-08-12T00:00:00Z' },
        ],
        my_open_actions_from_their_meetings: [
          { id: 'a2', identifier: 'ENG-2', title: 'Reply to Maya', status: 'Todo', due_at: null, source_capture_title: 'Kickoff' },
        ],
        recent_captures: Array.from({ length: 6 }, (_, i) => ({ id: `cap${i}`, title: `Meeting ${i}`, started_at: '2026-08-0' + (i + 1) + 'T00:00:00Z', ai_summary: 'Talked about things' })),
        recent_email_threads: [{ id: 't1', subject: 'Contract', last_message_at: '2026-08-11T00:00:00Z', needs_reply: true, from_email: 'maya@acme.com', message_count: 3 }],
        decisions: [{ id: 'd1', content: 'Go with plan B', capture_title: 'Kickoff', created_at: '2026-08-12' }],
      }),
    )
    expect(out).toContain('· teammate ·')
    expect(out).toContain('Open actions they own — what you are waiting on from them (1):\n- ENG-1 · Ship it · In Progress · due 2026-09-01 · (suggested, unconfirmed)')
    expect(out).toContain('Suggested commitments not yet accepted (AI-extracted, pending your review) (1):\n- "Maya to send the deck" · from Kickoff (2026-08-12) · due 2026-08-20')
    expect(out).toContain('Your open actions from meetings with them (1):\n- ENG-2 · Reply to Maya · Todo · no due date')
    expect(out).toContain('Recent meetings with them (4 of 6):')
    expect(out).toContain('- Meeting 0 · 2026-08-01 · capture_id: cap0 — Talked about things')
    expect(out).not.toContain('Meeting 4')
    // The live subject is marked as data; the sender's address names who.
    expect(out).toContain('Recent email threads with them (your mailbox) (1):\n- ' + wrapUntrusted('Contract') + ' · from maya@acme.com · 2026-08-11 · needs reply · thread_id: t1')
    expect(out).toContain('Decisions from meetings with them (1):\n- "Go with plan B" — Kickoff')
  })

  it('hard-caps at maxChars by dropping optional sections from the tail, then cutting', () => {
    const big = baseCtx({
      open_actions: Array.from({ length: 8 }, (_, i) => ({
        id: `a${i}`, identifier: `ENG-${i}`, title: 'x'.repeat(200), status: 'Todo', status_category: 'unstarted', due_at: null, priority: null, confirmation: 'confirmed', assigned_via: 'contact' as const,
      })),
      recent_captures: Array.from({ length: 4 }, (_, i) => ({ id: `cap${i}`, title: 'Meeting', started_at: '2026-08-01T00:00:00Z', ai_summary: 'y'.repeat(300) })),
      decisions: Array.from({ length: 3 }, (_, i) => ({ id: `d${i}`, content: 'z'.repeat(200), capture_title: 'M', created_at: null })),
    })
    const out = renderPersonContextBlock(big)
    expect(out.length).toBeLessThanOrEqual(3000)
    expect(out.endsWith('…[truncated]')).toBe(true)
    // The always-on sections survive; decisions (lowest priority) go first.
    expect(out).toContain('Open actions they own')
    expect(out).toContain('Suggested commitments not yet accepted')
    expect(out).not.toContain('Decisions from meetings')

    // Even with only the always-on sections, the cap holds.
    const tiny = renderPersonContextBlock(big, { maxChars: 400 })
    expect(tiny.length).toBeLessThanOrEqual(400)
    expect(tiny.endsWith('…[truncated]')).toBe(true)

    // Under the cap → untouched.
    expect(renderPersonContextBlock(baseCtx()).endsWith('…[truncated]')).toBe(false)
  })
})
