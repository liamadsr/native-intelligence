/**
 * GET /api/account/knowledge: the Knowledge graph's one payload.
 *
 * Migration 341: a claim is readable only when one of its sources is, so a
 * claim taken only from another person's private capture is not in the graph
 * either (the reader's own private captures still count).
 *
 * Native Intelligence doesn't learn from mail (2026-10-15, migration 341): a claim learned
 * from mail is in no one's graph, not even the person whose mail it came from.
 * The route drops it with its edges and sources, never makes an email a node,
 * and never reads email_message (it used to join it by workspace only, so any
 * member could read another's subject lines). It fails closed when the mail
 * check can't be read. The database here is pre-341 (RLS still shows the rows).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  queried: [] as string[],
  failMailCheck: false,
}))

vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))

function makeClient() {
  return {
    from: (table: string) => {
      hoisted.queried.push(table)
      const preds: Array<(r: Record<string, unknown>) => boolean> = []
      let range: [number, number] | null = null
      let mailCheck = false
      const run = () => {
        if (mailCheck && hoisted.failMailCheck) return { data: null, error: { message: 'boom' } }
        let out = (hoisted.tables[table] ?? []).filter((r) => preds.every((p) => p(r)))
        if (range) out = out.slice(range[0], range[1] + 1)
        return { data: out, error: null }
      }
      const api: Record<string, unknown> = {
        select: () => api,
        eq: (k: string, v: unknown) => {
          if (table === 'claim_source' && k === 'source_type') mailCheck = true
          preds.push((r) => r[k] === v)
          return api
        },
        neq: (k: string, v: unknown) => (preds.push((r) => r[k] !== v), api),
        in: (k: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[k])), api),
        or: () => api,
        order: () => api,
        range: (a: number, b: number) => ((range = [a, b]), api),
        limit: () => api,
        overrideTypes: () => api,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
      }
      return api
    },
  }
}

const { GET } = await import('../route')
const WS = 'ws-1'

const claim = (id: string) => ({
  id,
  workspace_id: WS,
  text: `text of ${id}`,
  type: 'fact',
  confidence: 0.9,
  confirmation: 'confirmed',
  status: 'active',
  scope: 'workspace',
  subject_member_id: null,
  auto_accepted: false,
  created_at: '2026-10-01T00:00:00Z',
  last_verified_at: null,
})

beforeEach(() => {
  hoisted.queried = []
  hoisted.failMailCheck = false
  hoisted.requireWorkspace.mockResolvedValue({ supabase: makeClient(), user: { id: 'user-1' }, workspaceId: WS })
  hoisted.tables = {
    claim: [claim('from-meeting'), claim('from-mail'), claim('mail-and-meeting'), claim('their-private'), claim('my-private')],
    claim_source: [
      { claim_id: 'from-meeting', workspace_id: WS, source_type: 'capture', source_id: 'cap-1', source_uri: null, excerpt: 'meeting words' },
      { claim_id: 'from-mail', workspace_id: WS, source_type: 'email', source_id: 'msg-1', source_uri: null, excerpt: 'private mail words' },
      { claim_id: 'mail-and-meeting', workspace_id: WS, source_type: 'capture', source_id: 'cap-1', source_uri: null, excerpt: 'meeting words' },
      { claim_id: 'mail-and-meeting', workspace_id: null, source_type: 'email', source_id: 'msg-2', source_uri: null, excerpt: 'more mail' },
      { claim_id: 'their-private', workspace_id: WS, source_type: 'capture', source_id: 'cap-theirs', source_uri: null, excerpt: 'their private words' },
      { claim_id: 'my-private', workspace_id: WS, source_type: 'capture', source_id: 'cap-mine', source_uri: null, excerpt: 'my words' },
    ],
    entity_link: [
      { id: 'e1', workspace_id: WS, source_type: 'claim', source_id: 'from-meeting', target_type: 'capture', target_id: 'cap-1', relation: 'cites', weight: null },
      { id: 'e2', workspace_id: WS, source_type: 'claim', source_id: 'from-meeting', target_type: 'email', target_id: 'msg-1', relation: 'cites', weight: null },
      { id: 'e3', workspace_id: WS, source_type: 'claim', source_id: 'from-mail', target_type: 'email', target_id: 'msg-1', relation: 'cites', weight: null },
      { id: 'e4', workspace_id: WS, source_type: 'claim', source_id: 'from-meeting', target_type: 'claim', target_id: 'from-mail', relation: 'related_to', weight: null },
    ],
    captures: [
      { id: 'cap-1', workspace_id: WS, title: 'Standup', visibility: 'workspace', user_id: 'someone', is_eval: false },
      { id: 'cap-theirs', workspace_id: WS, title: 'Their 1:1', visibility: 'private', user_id: 'someone', is_eval: false },
      { id: 'cap-mine', workspace_id: WS, title: 'My notes', visibility: 'private', user_id: 'user-1', is_eval: false },
    ],
    email_message: [{ id: 'msg-1', workspace_id: WS, subject: 'Their private subject' }],
  }
})

const get = () => GET(new NextRequest('https://dial8.ai/api/account/knowledge'))

describe('GET /api/account/knowledge: mail is shown to no one', () => {
  it('drops claims learned from mail, with their sources and edges, and never makes an email a node', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      claims: Array<{ id: string }>
      edges: Array<{ id: string }>
      sources: Array<{ claim_id: string; source_type: string }>
      entities: Record<string, unknown>
    }
    // Never mail; never a claim taken only from someone else's private capture;
    // the reader's own private capture still counts.
    expect(body.claims.map((c) => c.id)).toEqual(['from-meeting', 'my-private'])
    expect(body.edges.map((e) => e.id)).toEqual(['e1'])
    expect(body.sources.map((s) => s.claim_id).sort()).toEqual(['from-meeting', 'my-private'])
    expect(Object.keys(body.entities).sort()).toEqual(['capture:cap-1', 'capture:cap-mine'])
    expect(JSON.stringify(body)).not.toMatch(/private mail|their private|Their 1:1|more mail|msg-/)
  })

  it('never reads email_message', async () => {
    await get()
    expect(hoisted.queried).not.toContain('email_message')
  })

  it('fails closed when the mail check cannot be read', async () => {
    hoisted.failMailCheck = true
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('text of')
  })
})
