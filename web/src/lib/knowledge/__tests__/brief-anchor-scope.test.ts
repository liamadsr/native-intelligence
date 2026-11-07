/**
 * "Anchors are configuration" generalizes brief compilation from a hardcoded
 * project scope to ANY anchor scope. The two things worth pinning:
 *
 *   1. A `company` scope behaves EXACTLY like a `project` scope — its claims
 *      are the ones carrying an `about` edge to it, resolved through the same
 *      entity_link query with the scope's own target_type, and its label comes
 *      from the entity registry rather than a hand-written per-type SELECT.
 *   2. Discovery loops the workspace's ACTIVE anchor types. An engineering
 *      workspace must not pay a company-edge query, and a sales workspace must
 *      not silently lose company briefs to a project-only loop.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The brief's model call: one knowledge_brief task session on the eve utility
// agent (runUtilityTask). The test reads the `message` it was handed.
const generateText = vi.fn(async (_opts: { message: string; [k: string]: unknown }) => ({
  text: '## Overview\nbody',
  model: 'deepseek-v4-flash',
  usage: { inputTokens: 1, outputTokens: 1, costUsd: null, steps: 1 },
}))
vi.mock('@/lib/eve/utility/run-utility', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/eve/utility/run-utility')>()),
  runUtilityTask: (opts: { message: string }) => generateText(opts),
}))
const logUsage = vi.hoisted(() => vi.fn())
vi.mock('@/lib/ai/auth', () => ({ logUsage }))

import { generateBriefForScope, regenerateWorkspaceBriefs } from '../brief'
import { UtilitySessionError } from '@/lib/eve/utility/run-utility'

const WS = 'ws-1'

type Link = { source_id: string; target_type: string; target_id: string }

/** Every entity_link query the brief path issues, and every upsert it writes. */
interface Calls {
  linkQueries: Array<Record<string, unknown>>
  upserts: Array<Record<string, unknown>>
}

function makeSupabase(opts: {
  links: Link[]
  claims: Array<{ id: string; text: string }>
  labels?: Record<string, Record<string, unknown>>
  /** The stored brief's fingerprint, when a brief already exists for the scope. */
  existingFingerprint?: string
}): { client: never; calls: Calls } {
  const calls: Calls = { linkQueries: [], upserts: [] }

  const from = vi.fn((table: string) => {
    const eqs: Record<string, unknown> = {}
    const ins: Record<string, unknown[]> = {}

    const run = () => {
      if (table === 'entity_link') {
        calls.linkQueries.push({ ...eqs })
        let rows = opts.links
        if (eqs.target_type) rows = rows.filter((l) => l.target_type === eqs.target_type)
        if (eqs.target_id) rows = rows.filter((l) => l.target_id === eqs.target_id)
        return { data: rows, error: null }
      }
      if (table === 'claim') {
        // Confirmed-only; the suggested pass returns nothing.
        if (eqs.confirmation !== 'confirmed') return { data: [], error: null }
        let rows = opts.claims
        const ids = ins['id']
        if (ids) rows = rows.filter((c) => ids.includes(c.id))
        return {
          data: rows.map((c) => ({
            ...c,
            type: 'fact',
            confidence: 0.9,
            confirmation: 'confirmed',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          })),
          error: null,
        }
      }
      // No sources → nothing is private-sourced, so the visibility filter is a
      // pass-through here (it has its own test file).
      if (table === 'claim_source') return { data: [], error: null }
      if (table === 'workspace') return { data: { name: 'Acme' }, error: null }
      if (table === 'knowledge_brief') {
        return {
          data: opts.existingFingerprint ? { id: 'kb-1', source_fingerprint: opts.existingFingerprint } : null,
          error: null,
        }
      }
      if (table === 'knowledge_package') return { data: [], error: null }
      const label = opts.labels?.[table]
      if (label) return { data: label, error: null }
      return { data: [], error: null }
    }

    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
      maybeSingle: () => Promise.resolve(run()),
      upsert: (row: Record<string, unknown>) => {
        calls.upserts.push(row)
        return {
          then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r),
        }
      },
    }
    const proxy: Record<string, unknown> = new Proxy(chain, {
      get(t, p: string) {
        if (p in t) return t[p]
        if (p === 'eq') return (col: string, val: unknown) => ((eqs[col] = val), proxy)
        if (p === 'in') return (col: string, vals: unknown[]) => ((ins[col] = vals), proxy)
        return () => proxy
      },
    })
    return proxy
  })

  return { client: { from } as never, calls }
}

// MIN_CLAIMS is 3.
const CLAIMS = [
  { id: 'c1', text: 'NORTHWIND_RENEWAL' },
  { id: 'c2', text: 'NORTHWIND_PRICING' },
  { id: 'c3', text: 'NORTHWIND_CONTACT' },
]

beforeEach(() => {
  generateText.mockClear()
})

describe('company brief scope', () => {
  const links: Link[] = CLAIMS.map((c) => ({
    source_id: c.id,
    target_type: 'company',
    target_id: 'co-1',
  }))

  it('resolves its claims through the about edge, exactly like a project scope', async () => {
    const { client, calls } = makeSupabase({
      links,
      claims: CLAIMS,
      labels: { company: { name: 'Northwind' } },
    })

    const result = await generateBriefForScope(client, WS, { type: 'company', id: 'co-1' })

    expect(result).toBe('updated')
    // The scope query used the SCOPE'S type, not a hardcoded 'project'.
    expect(calls.linkQueries[0]).toMatchObject({
      source_type: 'claim',
      target_type: 'company',
      target_id: 'co-1',
    })
    expect(generateText.mock.calls.at(-1)?.[0]?.message).toContain('NORTHWIND_RENEWAL')
  })

  it('labels the scope from the entity registry (company.name, not projects.name)', async () => {
    const { client } = makeSupabase({
      links,
      claims: CLAIMS,
      labels: { company: { name: 'Northwind' } },
    })

    await generateBriefForScope(client, WS, { type: 'company', id: 'co-1' })

    expect(generateText.mock.calls.at(-1)?.[0]?.message).toContain('company "Northwind"')
  })

  it('writes scope_type=company (the value migration 265 widens the CHECK for)', async () => {
    const { client, calls } = makeSupabase({
      links,
      claims: CLAIMS,
      labels: { company: { name: 'Northwind' } },
    })

    await generateBriefForScope(client, WS, { type: 'company', id: 'co-1' })

    expect(calls.upserts.at(-1)).toMatchObject({
      scope_type: 'company',
      scope_id: 'co-1',
    })
  })

  it('compiles through ONE knowledge_brief task session with the pre-port prompt, byte-identical, and logs no usage', async () => {
    const { client } = makeSupabase({ links, claims: CLAIMS, labels: { company: { name: 'Northwind' } } })

    await generateBriefForScope(client, WS, { type: 'company', id: 'co-1' })

    expect(generateText).toHaveBeenCalledOnce()
    const args = generateText.mock.calls[0][0]
    // Workspace-scoped background work: no user to attribute.
    expect(args).toMatchObject({ kind: 'knowledge_brief', workspaceId: WS, userId: null })
    expect(args.message).toBe(
      'Scope: company "Northwind"\n\nClaims (ranked, confirmed first):\n' +
        '- [fact, conf 0.9, confirmed] NORTHWIND_RENEWAL\n' +
        '- [fact, conf 0.9, confirmed] NORTHWIND_PRICING\n' +
        '- [fact, conf 0.9, confirmed] NORTHWIND_CONTACT',
    )
    expect(logUsage).not.toHaveBeenCalled()
  })

  it('an UNCHANGED scope is skipped by the fingerprint gate before any eve call', async () => {
    const first = makeSupabase({ links, claims: CLAIMS, labels: { company: { name: 'Northwind' } } })
    await generateBriefForScope(first.client, WS, { type: 'company', id: 'co-1' })
    const fingerprint = first.calls.upserts.at(-1)?.source_fingerprint as string
    expect(fingerprint).toBeTruthy()
    generateText.mockClear()

    const again = makeSupabase({
      links,
      claims: CLAIMS,
      labels: { company: { name: 'Northwind' } },
      existingFingerprint: fingerprint,
    })
    expect(await generateBriefForScope(again.client, WS, { type: 'company', id: 'co-1' })).toBe('skipped')
    expect(generateText).not.toHaveBeenCalled()
    expect(again.calls.upserts).toEqual([])
  })

  it('a failed compile throws out (the weaver step retries), with nothing written', async () => {
    const { client, calls } = makeSupabase({ links, claims: CLAIMS, labels: { company: { name: 'Northwind' } } })
    generateText.mockRejectedValueOnce(new Error('[utility] knowledge_brief timed out after 120000ms'))
    await expect(generateBriefForScope(client, WS, { type: 'company', id: 'co-1' })).rejects.toThrow(/knowledge_brief/)
    expect(calls.upserts).toEqual([])
  })

  it('a model that spends the whole 1600-token cap reasoning returns no text → empty, nothing written (as generateText\'s "" did)', async () => {
    const { client, calls } = makeSupabase({ links, claims: CLAIMS, labels: { company: { name: 'Northwind' } } })
    generateText.mockRejectedValueOnce(
      new UtilitySessionError('knowledge_brief', 'failed', 'MODEL_CALL_FAILED', 'empty-model-response'),
    )
    expect(await generateBriefForScope(client, WS, { type: 'company', id: 'co-1' })).toBe('empty')
    expect(calls.upserts).toEqual([])
  })

  it('any OTHER failed session still throws', async () => {
    const { client, calls } = makeSupabase({ links, claims: CLAIMS, labels: { company: { name: 'Northwind' } } })
    generateText.mockRejectedValueOnce(
      new UtilitySessionError('knowledge_brief', 'failed', 'MODEL_CALL_FAILED', 'provider-error'),
    )
    await expect(generateBriefForScope(client, WS, { type: 'company', id: 'co-1' })).rejects.toThrow(
      /knowledge_brief session failed/,
    )
    expect(calls.upserts).toEqual([])
  })

  it('is empty (no LLM call) when nothing is anchored to the company', async () => {
    const { client } = makeSupabase({ links: [], claims: CLAIMS })

    expect(await generateBriefForScope(client, WS, { type: 'company', id: 'co-1' })).toBe(
      'empty',
    )
    expect(generateText).not.toHaveBeenCalled()
  })
})

describe('regenerateWorkspaceBriefs anchor discovery', () => {
  const links: Link[] = [
    { source_id: 'c1', target_type: 'project', target_id: 'p-1' },
    { source_id: 'c2', target_type: 'company', target_id: 'co-1' },
  ]

  /** target_type values the discovery loop asked entity_link about. */
  const discovered = (calls: Calls) =>
    calls.linkQueries.filter((q) => !q.target_id).map((q) => q.target_type)

  it('loops the workspace ANCHOR TYPES it is handed', async () => {
    const { client, calls } = makeSupabase({ links, claims: CLAIMS })

    await regenerateWorkspaceBriefs(client, WS, ['project', 'company'])

    expect(discovered(calls)).toEqual(['project', 'company'])
  })

  it('an engineering workspace never pays the company query', async () => {
    const { client, calls } = makeSupabase({ links, claims: CLAIMS })

    await regenerateWorkspaceBriefs(client, WS, ['project'])

    expect(discovered(calls)).toEqual(['project'])
  })

  it('defaults to project-only, so an un-migrated caller behaves as before', async () => {
    const { client, calls } = makeSupabase({ links, claims: CLAIMS })

    await regenerateWorkspaceBriefs(client, WS)

    expect(discovered(calls)).toEqual(['project'])
  })

  it('ignores an anchor type that is not a brief scope', async () => {
    const { client, calls } = makeSupabase({ links, claims: CLAIMS })

    // `contact` is an anchor descriptor in the registry but is NOT a brief
    // scope (contacts carry committed_to edges, not about edges) — compiling a
    // brief for one would write a scope_type the CHECK rejects.
    await regenerateWorkspaceBriefs(client, WS, ['project', 'contact'])

    expect(discovered(calls)).toEqual(['project'])
  })
})
