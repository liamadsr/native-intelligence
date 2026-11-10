/**
 * POST /api/internal/chat/tool runs the REAL contact tools on a SERVICE-ROLE
 * client, where the contact table's RLS (mig 058 contact_select_visibility)
 * does not apply. The contact tools fence each row through
 * contact_visible_to(contact, token user) themselves, so another member's
 * private contact never leaves this route: not in list_contacts, not via
 * get_contact, not in find / search contact hits, not as a traverse neighbor's
 * label, and update_contact / update_crm_contact never write it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The run-token DB binding (src/lib/chat/surface-run-guard.ts) has its own
// tests; this file's fake database holds no conversation / member rows.
vi.mock('@/lib/chat/surface-run-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/surface-run-guard')>()),
  chatRunBindingRefusal: async () => null,
}))

const SECRET = 'test-chat-internal-secret-abcdefghij'

// These pin the route's other fences, with the reviewer in shadow as they were
// written: its modes (L5) are pinned in route.review-blocking.test.ts.
beforeEach(() => {
  vi.stubEnv('ACTION_REVIEW_MODE', 'shadow')
})
afterEach(() => {
  vi.unstubAllEnvs()
})
const USER = 'user-1'
const WS = 'ws-1'

type Row = Record<string, unknown>
const db: { contacts: Row[]; edges: Row[]; hidden: Set<string>; grantOnly: Set<string>; updates: Row[]; rpcUsers: unknown[] } = {
  contacts: [],
  edges: [],
  hidden: new Set(),
  // Readable only through a per-item grant (migration 492): contact_visible_to
  // says yes, contact_visible_to_ungranted (495, the write gate) says no.
  grantOnly: new Set(),
  updates: [],
  rpcUsers: [],
}

function chain(table: string) {
  const preds: Array<(r: Row) => boolean> = []
  let patch: Row | null = null
  let limitN = Infinity
  const rows = (): Row[] => {
    if (table === 'contact') return db.contacts
    if (table === 'entity_link') return db.edges
    if (table === 'member') return [{ id: 'm-1', user_id: USER, workspace_id: WS }]
    if (table === 'workspace') return [{ id: WS, settings: null }]
    return []
  }
  const run = () => {
    const matched = rows().filter((r) => preds.every((p) => p(r)))
    if (patch) {
      for (const r of matched) Object.assign(r, patch)
      db.updates.push(patch)
    }
    return matched.slice(0, limitN)
  }
  const c: Record<string, unknown> = {}
  c.select = () => c
  c.order = () => c
  c.or = (expr: string) => {
    const m = /ilike\.%(.*?)%/.exec(expr)
    const needle = (m?.[1] ?? '').toLowerCase()
    preds.push((r) => String(r.full_name ?? '').toLowerCase().includes(needle))
    return c
  }
  c.ilike = (col: string, pat: string) => {
    const needle = pat.replace(/%/g, '').toLowerCase()
    preds.push((r) => String(r[col] ?? '').toLowerCase().includes(needle))
    return c
  }
  c.eq = (col: string, v: unknown) => {
    preds.push((r) => r[col] === v)
    return c
  }
  c.is = (col: string, v: unknown) => {
    preds.push((r) => (r[col] ?? null) === v)
    return c
  }
  c.in = (col: string, vs: unknown[]) => {
    preds.push((r) => vs.includes(r[col]))
    return c
  }
  c.overrideTypes = () => c
  c.limit = (n: number) => {
    limitN = n
    return c
  }
  c.update = (p: Row) => {
    patch = p
    return c
  }
  c.maybeSingle = async () => ({ data: run()[0] ?? null, error: null })
  c.single = async () => {
    const r = run()
    return r[0] ? { data: r[0], error: null } : { data: null, error: { message: 'no rows' } }
  }
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(resolve)
  return c
}

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: (t: string) => chain(t),
    rpc: async (fn: string, args: { p_contact_id: string; p_user_id: string }) => {
      if (fn !== 'contact_visible_to' && fn !== 'contact_visible_to_ungranted') {
        return { data: null, error: { message: `unexpected rpc ${fn}` } }
      }
      db.rpcUsers.push(args.p_user_id)
      const hidden = db.hidden.has(args.p_contact_id) || (fn === 'contact_visible_to_ungranted' && db.grantOnly.has(args.p_contact_id))
      return { data: !hidden, error: null }
    },
  }),
}))

// createTools → the REAL contact, CRM and search tools over the route's service client.
vi.mock('@/lib/ai/tools', async () => {
  const { createContactTools } = await import('@/lib/ai/tools/contacts')
  const { createCrmTools } = await import('@/lib/ai/tools/crm')
  const { createSearchTools } = await import('@/lib/ai/tools/search')
  const { createClaimTools } = await import('@/lib/ai/tools/claims')
  return {
    createTools: (userId: string, supabase: never, workspaceId: string) => ({
      ...createClaimTools(userId, supabase, workspaceId),
      ...createContactTools(userId, supabase, workspaceId),
      ...createCrmTools(userId, supabase, workspaceId),
      ...createSearchTools(userId, supabase, workspaceId),
    }),
  }
})
// find/search load the embedding + email modules; contact-only queries never call them.
vi.mock('@/lib/ai/embeddings', () => ({ embed: vi.fn(async () => { throw new Error('no embeddings in this test') }) }))
vi.mock('@/lib/ai/gemini-embeddings', () => ({ embedQuery: vi.fn(async () => { throw new Error('no embeddings in this test') }) }))
vi.mock('@/lib/email/email-search-service', () => ({ searchEmails: vi.fn(async () => ({ results: [], source: 'fts' })) }))
vi.mock('@/lib/email/email-context-service', () => ({ searchEmailsWithContext: vi.fn(async () => []) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => {}) } }))
vi.mock('@/lib/mcp-client/adapter', () => ({
  createExternalMcpTools: async () => ({ tools: {}, meta: new Map(), servers: [] }),
}))

import { POST } from '@/app/api/internal/chat/tool/route'
import { mintChatRunToken, CHAT_RUN_SECRET_HEADER, CHAT_RUN_TOKEN_HEADER } from '@/lib/chat/chat-run-token'

async function call(toolName: string, input: unknown) {
  const token = mintChatRunToken({ conversationId: 'c', workspaceId: WS, userId: USER })
  const res = await POST(
    new Request('http://localhost/api/internal/chat/tool', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CHAT_RUN_SECRET_HEADER]: SECRET, [CHAT_RUN_TOKEN_HEADER]: token },
      body: JSON.stringify({ toolName, input }),
    }),
  )
  return { status: res.status, body: (await res.json()) as { output?: Record<string, unknown> } }
}

describe('chat tool route: contact tools never leak another member’s private contact', () => {
  beforeEach(() => {
    process.env.CHAT_INTERNAL_SECRET = SECRET
    db.contacts = [
      { id: 'ct-private', workspace_id: WS, full_name: 'Ana Private', email: 'p@x.com', merged_into_contact_id: null },
      { id: 'ct-shared', workspace_id: WS, full_name: 'Ana Shared', email: 's@x.com', merged_into_contact_id: null },
    ]
    db.edges = [
      { workspace_id: WS, source_type: 'project', source_id: 'prj-1', target_type: 'contact', target_id: 'ct-private', relation: 'related_to' },
      { workspace_id: WS, source_type: 'project', source_id: 'prj-1', target_type: 'contact', target_id: 'ct-shared', relation: 'related_to' },
    ]
    db.hidden = new Set(['ct-private'])
    db.grantOnly = new Set()
    db.updates = []
    db.rpcUsers = []
  })
  afterEach(() => {
    delete process.env.CHAT_INTERNAL_SECRET
  })

  it('list_contacts drops it, fenced against the TOKEN user', async () => {
    const res = await call('list_contacts', {})
    expect(res.status).toBe(200)
    expect((res.body.output?.contacts as Row[]).map((c) => c.id)).toEqual(['ct-shared'])
    expect(new Set(db.rpcUsers)).toEqual(new Set([USER]))
  })

  it('get_contact by id is not-found; by name returns the visible match', async () => {
    expect((await call('get_contact', { contact_id: 'ct-private' })).body.output).toEqual({
      success: false,
      error: 'Contact not found',
    })
    const byName = await call('get_contact', { name: 'Ana' })
    expect((byName.body.output?.contact as Row).id).toBe('ct-shared')
  })

  it('find (contact hits) drops it, fenced against the TOKEN user', async () => {
    const res = await call('find', { query: 'Ana', types: ['contact'] })
    expect(res.status).toBe(200)
    const results = res.body.output?.results as Row[]
    expect(results.map((r) => r.result_id)).toEqual(['ct-shared'])
    expect(JSON.stringify(res.body)).not.toContain('Ana Private')
    expect(new Set(db.rpcUsers)).toEqual(new Set([USER]))
  })

  it('search (contact hits) drops it, fenced against the TOKEN user', async () => {
    const res = await call('search', { query: 'Ana', types: ['contact'] })
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body)).toContain('ct-shared')
    expect(JSON.stringify(res.body)).not.toContain('ct-private')
    expect(JSON.stringify(res.body)).not.toContain('Ana Private')
    expect(new Set(db.rpcUsers)).toEqual(new Set([USER]))
  })

  it("traverse keeps its node but labels it as private, fenced against the TOKEN user", async () => {
    const res = await call('traverse', { entity_type: 'project', entity_id: 'prj-1', direction: 'outbound' })
    expect(res.status).toBe(200)
    const outbound = res.body.output?.outbound as Row[]
    expect(outbound.map((e) => [e.target_id, e.label])).toEqual([
      ['ct-private', 'Contact (private)'],
      ['ct-shared', 'Ana Shared'],
    ])
    expect(JSON.stringify(res.body)).not.toContain('Ana Private')
    expect(new Set(db.rpcUsers)).toEqual(new Set([USER]))
  })

  it('update_contact and update_crm_contact never write it', async () => {
    expect((await call('update_contact', { contact_id: 'ct-private', notes: 'x' })).body.output).toEqual({
      success: false,
      error: 'Contact not found',
    })
    expect(
      (await call('update_crm_contact', { contact_id: 'ct-private', relationship_type: 'customer' })).body.output,
    ).toEqual({ success: false, error: 'Contact not found' })
    expect(db.updates).toEqual([])
  })

  it('a contact a per-item grant opens to read is still never written (migration 495)', async () => {
    db.grantOnly = new Set(['ct-shared'])
    expect((await call('update_contact', { contact_id: 'ct-shared', notes: 'x' })).body.output).toEqual({
      success: false,
      error: 'Contact not found',
    })
    expect(
      (await call('update_crm_contact', { contact_id: 'ct-shared', relationship_type: 'customer' })).body.output,
    ).toEqual({ success: false, error: 'Contact not found' })
    expect(db.updates).toEqual([])
  })
})
