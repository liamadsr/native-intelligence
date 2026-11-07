/**
 * Briefs are workspace-readable documents compiled by unattended background
 * work, so a claim sourced solely from private captures must never reach the
 * brief prompt — otherwise the nightly weaver launders a private meeting into a
 * doc every member can open (docs/design-capture-visibility.md).
 *
 * These tests drive generateBriefForScope with the LLM mocked and assert on the
 * PROMPT it was handed: the private-sourced claim is absent, the mixed-source
 * one is present. Covers both claim read paths — the workspace/project branch
 * and the package branch (which delegates to fetchPackageClaims).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The brief's model call: one knowledge_brief task session on the eve utility
// agent (runUtilityTask). The test reads the `message` it was handed.
const generateText = vi.fn(async (_opts: { message: string }) => ({
  text: '## Overview\nbody',
  model: 'deepseek-v4-flash',
  usage: { inputTokens: 1, outputTokens: 1, costUsd: null, steps: 1 },
}))
vi.mock('@/lib/eve/utility/run-utility', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/eve/utility/run-utility')>()),
  runUtilityTask: (opts: { message: string }) => generateText(opts),
}))

import { generateBriefForScope } from '../brief'

const WS = 'ws-1'

type Claim = { id: string; text: string; confirmation: string }
type SourceRow = { claim_id: string; source_type: string | null; source_id: string | null }

/**
 * Supabase double covering the query shapes brief compilation issues. Claims
 * are returned confirmed-first; claim_source / captures back the visibility
 * filter; knowledge_brief returns no existing row so the fingerprint gate never
 * short-circuits.
 */
function makeSupabase(opts: {
  claims: Claim[]
  sources: SourceRow[]
  captures: Record<string, 'workspace' | 'private'>
  packageClaimIds?: string[]
  /** Called with the filters of every knowledge_brief delete. */
  onBriefDelete?: (eqs: Record<string, unknown>) => void
  /** Make the claim_source read fail. */
  sourcesError?: boolean
}) {
  const from = vi.fn((table: string) => {
    const state: {
      eqs: Record<string, unknown>
      ins: Record<string, unknown[]>
    } = { eqs: {}, ins: {} }

    const run = () => {
      if (table === 'claim') {
        let rows = opts.claims
        if (state.eqs['confirmation']) {
          rows = rows.filter((c) => c.confirmation === state.eqs['confirmation'])
        }
        const ids = state.ins['id']
        if (ids) rows = rows.filter((c) => ids.includes(c.id))
        return {
          data: rows.map((c) => ({
            id: c.id,
            text: c.text,
            type: 'fact',
            confidence: 0.9,
            confirmation: c.confirmation,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          })),
          error: null,
        }
      }
      if (table === 'claim_source') {
        if (opts.sourcesError) return { data: null, error: { message: 'boom' } }
        const ids = state.ins['claim_id'] ?? []
        return { data: opts.sources.filter((s) => ids.includes(s.claim_id)), error: null }
      }
      if (table === 'captures') {
        const ids = (state.ins['id'] ?? []) as string[]
        return {
          data: ids
            .filter((id) => opts.captures[id] === 'workspace')
            .map((id) => ({ id })),
          error: null,
        }
      }
      // The cited documents (migration 369): workspace-visible in these cases.
      if (table === 'document') {
        const ids = (state.ins['id'] ?? []) as string[]
        return { data: ids.map((id) => ({ id })), error: null }
      }
      if (table === 'knowledge_package_item') {
        return {
          data: (opts.packageClaimIds ?? []).map((id) => ({
            entity_type: 'claim',
            entity_id: id,
          })),
          error: null,
        }
      }
      if (table === 'knowledge_package') return { data: { rules: {} }, error: null }
      if (table === 'workspace') return { data: { name: 'Acme' }, error: null }
      return { data: [], error: null }
    }

    let deleting = false
    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) => {
        if (deleting) {
          opts.onBriefDelete?.({ table, ...state.eqs })
          return Promise.resolve({ error: null }).then(resolve)
        }
        return Promise.resolve(run()).then(resolve)
      },
      delete: () => ((deleting = true), proxy),
      maybeSingle: () => Promise.resolve(run()),
      upsert: () => ({
        then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r),
      }),
    }
    const proxy: Record<string, unknown> = new Proxy(chain, {
      get(t, p: string) {
        if (p in t) return t[p]
        if (p === 'eq') return (col: string, val: unknown) => ((state.eqs[col] = val), proxy)
        if (p === 'in') return (col: string, vals: unknown[]) => ((state.ins[col] = vals), proxy)
        return () => proxy
      },
    })
    return proxy
  })
  return { from } as never
}

/** The claims text handed to the LLM on the most recent call (the eve task message). */
function lastPrompt(): string {
  return generateText.mock.calls.at(-1)?.[0]?.message ?? ''
}

// MIN_CLAIMS is 3, so the VISIBLE set must stay at/above 3 after filtering —
// otherwise the scope short-circuits as 'empty' and the assertion about the
// prompt would pass vacuously.
const CLAIMS: Claim[] = [
  { id: 'c-private', text: 'PRIVATE_ONLY_CLAIM', confirmation: 'confirmed' },
  { id: 'c-mixed', text: 'MIXED_SOURCE_CLAIM', confirmation: 'confirmed' },
  { id: 'c-doc', text: 'DOCUMENT_CLAIM', confirmation: 'confirmed' },
  { id: 'c-none', text: 'SOURCELESS_CLAIM', confirmation: 'confirmed' },
]
const SOURCES: SourceRow[] = [
  { claim_id: 'c-private', source_type: 'capture', source_id: 'cap-priv' },
  { claim_id: 'c-mixed', source_type: 'capture', source_id: 'cap-priv' },
  { claim_id: 'c-mixed', source_type: 'capture', source_id: 'cap-pub' },
  { claim_id: 'c-doc', source_type: 'document', source_id: 'doc-1' },
]
const CAPTURES = { 'cap-priv': 'private', 'cap-pub': 'workspace' } as const

beforeEach(() => {
  generateText.mockClear()
})

describe('brief compilation excludes private-sourced claims', () => {
  it('omits an only-private-sourced claim from the workspace brief, keeping mixed-source ones', async () => {
    const supabase = makeSupabase({ claims: CLAIMS, sources: SOURCES, captures: { ...CAPTURES } })

    const result = await generateBriefForScope(supabase, WS, { type: 'workspace' })

    expect(result).toBe('updated')
    expect(lastPrompt()).not.toContain('PRIVATE_ONLY_CLAIM')
    expect(lastPrompt()).toContain('MIXED_SOURCE_CLAIM')
    expect(lastPrompt()).toContain('DOCUMENT_CLAIM')
  })

  it('applies the same filter on the package branch (fetchPackageClaims delegation)', async () => {
    const supabase = makeSupabase({
      claims: CLAIMS,
      sources: SOURCES,
      captures: { ...CAPTURES },
      packageClaimIds: ['c-private', 'c-mixed', 'c-doc', 'c-none'],
    })

    const result = await generateBriefForScope(supabase, WS, { type: 'package', id: 'pkg-1' })

    expect(result).toBe('updated')
    expect(lastPrompt()).not.toContain('PRIVATE_ONLY_CLAIM')
    expect(lastPrompt()).toContain('MIXED_SOURCE_CLAIM')
  })

  it('returns empty (no LLM call) when the filter drops the scope below MIN_CLAIMS', async () => {
    const supabase = makeSupabase({
      claims: [CLAIMS[0], CLAIMS[1]],
      sources: SOURCES,
      captures: { ...CAPTURES },
    })

    const result = await generateBriefForScope(supabase, WS, { type: 'workspace' })

    expect(result).toBe('empty')
    expect(generateText).not.toHaveBeenCalled()
  })

  it('deletes the scope\'s stale brief when too little is left to say (mail hidden, a capture made private)', async () => {
    const deletes: Array<Record<string, unknown>> = []
    const supabase = makeSupabase({
      claims: [CLAIMS[0], CLAIMS[1]],
      sources: SOURCES,
      captures: { ...CAPTURES },
      onBriefDelete: (eqs) => deletes.push(eqs),
    })

    expect(await generateBriefForScope(supabase, WS, { type: 'package', id: 'pkg-1' })).toBe('empty')
    expect(deletes).toEqual([{ table: 'knowledge_brief', workspace_id: WS, scope_type: 'package', scope_id: 'pkg-1' }])
  })

  it('never deletes a brief on a failed read: it skips and keeps the old one', async () => {
    const deletes: Array<Record<string, unknown>> = []
    const supabase = makeSupabase({
      claims: CLAIMS,
      sources: SOURCES,
      captures: { ...CAPTURES },
      sourcesError: true,
      onBriefDelete: (eqs) => deletes.push(eqs),
    })

    expect(await generateBriefForScope(supabase, WS, { type: 'workspace' })).toBe('skipped')
    expect(deletes).toEqual([])
    expect(generateText).not.toHaveBeenCalled()
  })
})
