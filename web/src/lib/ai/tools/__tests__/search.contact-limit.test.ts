/**
 * find / search contact hits cost one contact_visible_to RPC per fetched row
 * (no batch form of the check exists), so the contact limit is CLAMPED to
 * MAX_CONTACT_SEARCH_LIMIT and the fetch bounded at 2x that. A request above
 * the max is clamped visibly — the response carries `contact_limit_clamped_to`
 * — never silently cut short.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { clampContactLimit, createSearchTools, MAX_CONTACT_SEARCH_LIMIT } from '../search'

vi.mock('@/lib/ai/embeddings', () => ({ embed: vi.fn(async () => { throw new Error('no embeddings in this test') }) }))
vi.mock('@/lib/ai/gemini-embeddings', () => ({ embedQuery: vi.fn(async () => { throw new Error('no embeddings in this test') }) }))
vi.mock('@/lib/email/email-search-service', () => ({ searchEmails: vi.fn(async () => ({ results: [], source: 'fts' })) }))
vi.mock('@/lib/email/email-context-service', () => ({ searchEmailsWithContext: vi.fn(async () => []) }))

const USER = 'user-1'
const WS = 'ws-1'
const EXEC = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

const CONTACTS = Array.from({ length: 300 }, (_, i) => ({
  id: `ct-${i}`,
  workspace_id: WS,
  full_name: `Bulk Person ${i}`,
  email: `p${i}@example.com`,
}))

function db() {
  const contactFetchLimits: number[] = []
  let visibilityRpcs = 0
  const from = (table: string) => {
    let limitN = Infinity
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'or', 'order', 'in', 'is', 'ilike']) c[m] = () => c
    c.limit = (n: number) => {
      limitN = n
      if (table === 'contact') contactFetchLimits.push(n)
      return c
    }
    const rows = () => (table === 'contact' ? CONTACTS.slice(0, limitN) : table === 'workspace' ? [{ id: WS, name: 'WS' }] : [])
    c.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null })
    c.single = async () => ({ data: rows()[0] ?? null, error: null })
    c.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve)
    return c
  }
  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'contact_visible_to') {
      visibilityRpcs++
      return { data: true, error: null }
    }
    return { data: [], error: null }
  })
  return {
    client: { from, rpc } as never,
    contactFetchLimits,
    rpcCount: () => visibilityRpcs,
  }
}

describe('clampContactLimit', () => {
  it('clamps into [1, MAX_CONTACT_SEARCH_LIMIT]', () => {
    expect(MAX_CONTACT_SEARCH_LIMIT).toBe(50)
    expect(clampContactLimit(20)).toBe(20)
    expect(clampContactLimit(50)).toBe(50)
    expect(clampContactLimit(51)).toBe(50)
    expect(clampContactLimit(10_000)).toBe(50)
    expect(clampContactLimit(0)).toBe(1)
    expect(clampContactLimit(-3)).toBe(1)
    expect(clampContactLimit(Number.NaN)).toBe(1)
    expect(clampContactLimit(7.9)).toBe(7)
  })
})

describe.each(['find', 'search'] as const)('%s — contact limit is clamped, not silently cut', (toolName) => {
  it('a limit above the max returns the max, says so, and bounds the fetch + visibility RPCs', async () => {
    const fake = db()
    const res = (await createSearchTools(USER, fake.client, WS)[toolName].execute!(
      { query: 'Bulk', types: ['contact'], limit: 500 } as never,
      EXEC,
    )) as { results: unknown[]; contact_limit_clamped_to?: number }

    expect(res.results).toHaveLength(MAX_CONTACT_SEARCH_LIMIT)
    expect(res.contact_limit_clamped_to).toBe(MAX_CONTACT_SEARCH_LIMIT)
    expect(fake.contactFetchLimits).toEqual([MAX_CONTACT_SEARCH_LIMIT * 2])
    expect(fake.rpcCount()).toBe(MAX_CONTACT_SEARCH_LIMIT * 2)
  })

  it('a limit within the max is honored with no clamp note', async () => {
    const fake = db()
    const res = (await createSearchTools(USER, fake.client, WS)[toolName].execute!(
      { query: 'Bulk', types: ['contact'], limit: 5 } as never,
      EXEC,
    )) as { results: unknown[]; contact_limit_clamped_to?: number }

    expect(res.results).toHaveLength(5)
    expect(res).not.toHaveProperty('contact_limit_clamped_to')
    expect(fake.contactFetchLimits).toEqual([10])
  })
})
