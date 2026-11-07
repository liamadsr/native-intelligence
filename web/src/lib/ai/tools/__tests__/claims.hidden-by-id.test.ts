/**
 * Security review of the mail/private-claims fix (migration 341): every
 * service-role path that returns claim text applies the claim rule. A claim is
 * readable only when one of its sources is, and never when one is mail.
 *
 *   - confirm_claim / dismiss_claim / supersede_claim answer a hidden claim
 *     with the same not-found as a missing one, and never write or echo it.
 *   - get_claim drops an attachment excerpt whose parent is someone else's
 *     private capture.
 *   - get_package and get_meeting_prep never list a hidden claim.
 *
 * The database is a pre-341 one: claim_visible_to still says visible for mail.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createClaimTools } from '../claims'
import { createPackageTools } from '../packages'
import { createCalendarCaptureTools } from '../calendar-capture'

vi.mock('@/lib/ai/embeddings', () => ({ embed: vi.fn(async () => [0.1, 0.2, 0.3]) }))
vi.mock('@/lib/ai/claim-provenance', () => ({ attachClaimProvenance: vi.fn(async () => ({ errors: [] })) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => {}) } }))
vi.mock('@/lib/workspace-member-emails', () => ({ findMembersByEmail: vi.fn(async () => new Map()) }))
vi.mock('@/lib/crm/contact-visibility', () => ({
  filterVisibleContacts: vi.fn(async (_s: unknown, _u: unknown, rows: unknown[]) => rows),
  filterVisibleCompanies: vi.fn(async (_s: unknown, _u: unknown, rows: unknown[]) => rows),
}))

const ME = 'user-1'
const WS = 'ws-1'
const EXEC_OPTS = { toolCallId: 'c1', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>

/** In-memory tables with eq / neq / in / or / order / limit / range, and recorded writes. */
function makeDb(tables: Record<string, Row[]>, rpcs: Record<string, unknown> = {}) {
  const writes: Array<{ table: string; op: string }> = []
  const from = vi.fn((table: string) => {
    const preds: Array<(r: Row) => boolean> = []
    let limitN = Infinity
    const rows = () => (tables[table] ?? []).filter((r) => preds.every((p) => p(r))).slice(0, limitN)
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (k: string, v: unknown) => (preds.push((r) => r[k] === v), api),
      neq: (k: string, v: unknown) => (preds.push((r) => r[k] !== v), api),
      in: (k: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[k])), api),
      // `a.eq.x,b.eq.y` (the capture-visibility filter); anything else passes.
      or: (f: string) => {
        const clauses = f.split(',').map((c) => c.split('.'))
        if (clauses.every((c) => c.length === 3 && c[1] === 'eq')) preds.push((r) => clauses.some(([k, , v]) => String(r[k]) === v))
        return api
      },
      is: () => api,
      gte: () => api,
      order: () => api,
      contains: () => api,
      range: () => api,
      limit: (n: number) => ((limitN = n), api),
      update: () => (writes.push({ table, op: 'update' }), api),
      insert: () => (writes.push({ table, op: 'insert' }), api),
      upsert: () => (writes.push({ table, op: 'upsert' }), api),
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rows()[0] ?? null, error: rows()[0] ? null : { message: 'not found' } }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve),
    }
    return api
  })
  const rpc = vi.fn(async (name: string) => ({ data: rpcs[name] ?? null, error: null }))
  return { client: { from, rpc } as never, writes }
}

const claim = (id: string, extra: Row = {}): Row => ({
  id, workspace_id: WS, text: `TEXT_OF_${id}`, type: 'fact', confidence: 0.9, confirmation: 'suggested', status: 'active',
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', event_at: null, subject_member_id: null, ...extra,
})

function world() {
  return {
    claim: [claim('ok'), claim('mail'), claim('their-private'), claim('att-claim')],
    claim_source: [
      { id: 's1', claim_id: 'ok', source_type: 'document', source_id: 'doc-1', source_uri: null, excerpt: 'doc words', created_at: 't' },
      { id: 's2', claim_id: 'mail', source_type: 'email', source_id: 'msg-1', source_uri: null, excerpt: 'MAIL_WORDS', created_at: 't' },
      { id: 's3', claim_id: 'their-private', source_type: 'capture', source_id: 'cap-theirs', source_uri: null, excerpt: 'PRIVATE_WORDS', created_at: 't' },
      { id: 's4', claim_id: 'att-claim', source_type: 'document', source_id: 'doc-1', source_uri: null, excerpt: 'doc words', created_at: 't' },
      { id: 's5', claim_id: 'att-claim', source_type: 'attachment', source_id: 'att-1', source_uri: null, excerpt: 'PRIVATE_ATTACHMENT_WORDS', created_at: 't' },
    ],
    captures: [{ id: 'cap-theirs', workspace_id: WS, visibility: 'private', user_id: 'them', is_eval: false }],
    attachments: [{ id: 'att-1', workspace_id: WS, note_id: 'cap-theirs' }],
    // The cited document, workspace-visible (migration 369).
    document: [{ id: 'doc-1', workspace_id: WS, title: 'Spec', visibility: 'workspace' }],
    entity_link: [] as Row[],
    member: [{ id: 'm-1', user_id: ME, workspace_id: WS }],
  }
}

const exec = async (tool: { execute?: unknown }, input: Record<string, unknown>) =>
  (await (tool.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, EXEC_OPTS)) as Record<string, unknown>

describe('by-id claim tools refuse a hidden claim', () => {
  for (const name of ['confirm_claim', 'dismiss_claim', 'supersede_claim'] as const) {
    it(`${name}: not found, nothing written, no text back`, async () => {
      for (const id of ['mail', 'their-private']) {
        // A pre-341 claim_visible_to says the mail claim is visible: the app rule still refuses it.
        const { client, writes } = makeDb(world(), { claim_visible_to: id === 'mail' })
        const res = await exec(createClaimTools(ME, client, WS)[name], { claim_id: id, new_text: 'x' })
        expect(res).toEqual({ success: false, error: 'Claim not found' })
        expect(writes).toEqual([])
      }
    })
  }

  it('confirm_claim still works on a readable claim', async () => {
    const { client, writes } = makeDb(world(), { claim_visible_to: true })
    const res = await exec(createClaimTools(ME, client, WS).confirm_claim, { claim_id: 'ok' })
    expect(res.success).toBe(true)
    expect(writes).toEqual([{ table: 'claim', op: 'update' }])
  })
})

describe('get_claim drops an attachment excerpt whose parent capture is hidden', () => {
  it('keeps the claim (it has a document source) but not the private attachment', async () => {
    const { client } = makeDb(world(), { claim_visible_to: true })
    const res = await exec(createClaimTools(ME, client, WS).get_claim, { claim_id: 'att-claim' })
    expect(res.success).toBe(true)
    expect(JSON.stringify(res)).not.toContain('PRIVATE_ATTACHMENT_WORDS')
    expect(JSON.stringify(res)).toContain('doc words')
  })
})

describe('get_package never lists a hidden claim', () => {
  it('drops mail and private-only claims from a package over MCP (service-role)', async () => {
    const tables = {
      ...world(),
      knowledge_package: [{ id: 'pkg-1', workspace_id: WS, name: 'P', slug: 'p', description: null, visibility: 'workspace', rules: {}, created_by: 'm-1', team_id: null }],
      knowledge_package_item: ['ok', 'mail', 'their-private'].map((id) => ({ package_id: 'pkg-1', workspace_id: WS, entity_type: 'claim', entity_id: id, created_at: 't' })),
      knowledge_brief: [] as Row[],
      team_member: [] as Row[],
    }
    const { client } = makeDb(tables)
    const res = await exec(createPackageTools(ME, client, WS).get_package, { package_id: 'pkg-1' })
    expect(res.success).toBe(true)
    expect((res.claims as Row[]).map((c) => c.id)).toEqual(['ok'])
  })
})

describe('get_meeting_prep never lists a hidden claim as attendee knowledge', () => {
  it('drops mail and private-only claims linked to an attendee', async () => {
    const tables = {
      ...world(),
      contact: [{ id: 'ct-1', workspace_id: WS, full_name: 'Bob', email: 'bob@acme.com' }],
      entity_link: ['ok', 'mail', 'their-private'].map((id) => ({
        workspace_id: WS, source_type: 'claim', source_id: id, target_type: 'contact', target_id: 'ct-1',
      })),
      capture_participant: [] as Row[],
      actions: [] as Row[],
    }
    const { client } = makeDb(tables)
    const res = await exec(createCalendarCaptureTools(ME, client, WS).get_meeting_prep, { participant_email: 'bob@acme.com' })
    expect(res.success).toBe(true)
    expect((res.attendee_knowledge as Row[]).map((c) => c.claim_id)).toEqual(['ok'])
    expect(JSON.stringify(res)).not.toMatch(/TEXT_OF_mail|TEXT_OF_their-private/)
  })
})
