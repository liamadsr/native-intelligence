/**
 * Capture visibility on the UNATTENDED, workspace-readable claim paths.
 *
 * The pure rule (filterClaimsVisibleToNobody) is covered in
 * knowledge-weaver.test.ts; these tests cover the batched queries around it
 * and — the part that actually regressed — its application inside brief
 * compilation, where a private-sourced claim would otherwise be paraphrased
 * into a document every workspace member can open.
 * See docs/design-capture-visibility.md.
 */
import { describe, it, expect, vi } from 'vitest'
import { dedupeRequesterFor, excludePrivateSourcedClaims, provenanceLinksReachEveryone } from '../claim-visibility'

const WS = 'ws-1'

type SourceRow = { claim_id: string; source_type: string | null; source_id: string | null }

/** Minimal Supabase double covering the three query shapes the helper issues. */
function makeSupabase(opts: {
  sources: SourceRow[]
  /** capture id → visibility; anything absent is treated as a dangling ref. */
  captures: Record<string, 'workspace' | 'private'>
  /** attachment id → parent capture id (null = no parent); absent = dangling. */
  attachments?: Record<string, string | null>
  /** document id → visibility (369); absent = dangling. Defaults to every cited document being workspace-visible. */
  documents?: Record<string, 'workspace' | 'private'>
  onQuery?: (table: string) => void
  /** Force an error response from this table, to assert the fail-closed path. */
  errorOn?: 'claim_source' | 'captures' | 'attachments'
}) {
  const from = vi.fn((table: string) => {
    opts.onQuery?.(table)
    const state: {
      eqs: Record<string, unknown>
      ins: Record<string, unknown[]>
      range?: [number, number]
    } = { eqs: {}, ins: {} }

    const run = () => {
      if (opts.errorOn === table) return { data: null, error: { message: 'boom' } }
      if (table === 'claim_source') {
        const ids = state.ins['claim_id'] ?? []
        const matched = opts.sources.filter((s) => ids.includes(s.claim_id))
        // Model PostgREST's inclusive .range(from, to) so pagination is exercised.
        const [from_, to] = state.range ?? [0, matched.length - 1]
        return { data: matched.slice(from_, to + 1), error: null }
      }
      if (table === 'attachments') {
        const ids = (state.ins['id'] ?? []) as string[]
        const rows = opts.attachments ?? {}
        // An id with no row is simply absent from the result — the dangling case.
        const data = ids
          .filter((id) => id in rows)
          .map((id) => ({ id, note_id: rows[id] }))
        return { data, error: null }
      }
      if (table === 'captures') {
        const ids = (state.ins['id'] ?? []) as string[]
        const data = ids
          .filter((id) => opts.captures[id] === (state.eqs['visibility'] ?? opts.captures[id]))
          .filter((id) => opts.captures[id] !== undefined)
          .map((id) => ({ id }))
        return { data, error: null }
      }
      if (table === 'document') {
        const ids = (state.ins['id'] ?? []) as string[]
        const vis = (id: string) => (opts.documents ? opts.documents[id] : 'workspace')
        const data = ids
          .filter((id) => vis(id) !== undefined && vis(id) === (state.eqs['visibility'] ?? vis(id)))
          .map((id) => ({ id }))
        return { data, error: null }
      }
      return { data: [], error: null }
    }

    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    }
    const proxy: Record<string, unknown> = new Proxy(chain, {
      get(t, p: string) {
        if (p in t) return t[p]
        if (p === 'eq') return (col: string, val: unknown) => ((state.eqs[col] = val), proxy)
        if (p === 'in') return (col: string, vals: unknown[]) => ((state.ins[col] = vals), proxy)
        if (p === 'range') return (a: number, b: number) => ((state.range = [a, b]), proxy)
        return () => proxy
      },
    })
    return proxy
  })
  return { from } as never
}

describe('excludePrivateSourcedClaims', () => {
  it('drops a claim whose sources are exclusively private captures', async () => {
    const supabase = makeSupabase({
      sources: [{ claim_id: 'c-private', source_type: 'capture', source_id: 'cap-priv' }],
      captures: { 'cap-priv': 'private' },
    })
    const kept = await excludePrivateSourcedClaims(supabase, WS, [{ id: 'c-private' }])
    expect(kept).toEqual([])
  })

  it('keeps a claim with mixed sources (one private capture, one workspace capture)', async () => {
    const supabase = makeSupabase({
      sources: [
        { claim_id: 'c-mixed', source_type: 'capture', source_id: 'cap-priv' },
        { claim_id: 'c-mixed', source_type: 'capture', source_id: 'cap-pub' },
      ],
      captures: { 'cap-priv': 'private', 'cap-pub': 'workspace' },
    })
    const kept = await excludePrivateSourcedClaims(supabase, WS, [{ id: 'c-mixed' }])
    expect(kept.map((c) => c.id)).toEqual(['c-mixed'])
  })

  it('keeps claims with no sources and claims sourced from non-captures', async () => {
    const supabase = makeSupabase({
      sources: [{ claim_id: 'c-doc', source_type: 'document', source_id: 'doc-1' }],
      captures: {},
    })
    const kept = await excludePrivateSourcedClaims(supabase, WS, [
      { id: 'c-none' },
      { id: 'c-doc' },
    ])
    expect(kept.map((c) => c.id)).toEqual(['c-none', 'c-doc'])
  })

  it('short-circuits with zero queries on an empty claim list', async () => {
    const tables: string[] = []
    const supabase = makeSupabase({ sources: [], captures: {}, onQuery: (t) => tables.push(t) })
    expect(await excludePrivateSourcedClaims(supabase, WS, [])).toEqual([])
    expect(tables).toEqual([])
  })

  it('skips the attachments query entirely when no source is an attachment', async () => {
    const tables: string[] = []
    const supabase = makeSupabase({
      sources: [
        { claim_id: 'c1', source_type: 'capture', source_id: 'cap-a' },
        { claim_id: 'c2', source_type: 'capture', source_id: 'cap-b' },
        { claim_id: 'c3', source_type: 'capture', source_id: 'cap-c' },
      ],
      captures: { 'cap-a': 'workspace', 'cap-b': 'private', 'cap-c': 'workspace' },
      onQuery: (t) => tables.push(t),
    })
    const kept = await excludePrivateSourcedClaims(supabase, WS, [
      { id: 'c1' },
      { id: 'c2' },
      { id: 'c3' },
    ])
    expect(kept.map((c) => c.id)).toEqual(['c1', 'c3'])
    expect(tables).toEqual(['claim_source', 'captures'])
  })

  it('pages claim_source until exhaustion instead of truncating', async () => {
    // A full first page must NOT end the sweep: the private-sourced claim's only
    // source row sits past the page boundary, and treating it as source-less
    // would classify it visible — the fail-OPEN this pagination closes.
    const filler: SourceRow[] = Array.from({ length: 1000 }, (_, i) => ({
      claim_id: 'c-doc',
      source_type: 'document',
      source_id: `doc-${i}`,
    }))
    const tables: string[] = []
    const supabase = makeSupabase({
      sources: [...filler, { claim_id: 'c-private', source_type: 'capture', source_id: 'cap-priv' }],
      captures: { 'cap-priv': 'private' },
      onQuery: (t) => tables.push(t),
    })
    const kept = await excludePrivateSourcedClaims(supabase, WS, [
      { id: 'c-doc' },
      { id: 'c-private' },
    ])
    expect(kept.map((c) => c.id)).toEqual(['c-doc'])
    expect(tables).toEqual(['claim_source', 'claim_source', 'captures', 'document'])
  })

  it('fails CLOSED when the claim_source fetch errors', async () => {
    const supabase = makeSupabase({
      sources: [{ claim_id: 'c-doc', source_type: 'document', source_id: 'doc-1' }],
      captures: {},
      errorOn: 'claim_source',
    })
    expect(await excludePrivateSourcedClaims(supabase, WS, [{ id: 'c-doc' }])).toEqual([])
  })

  it('fails CLOSED when the captures fetch errors', async () => {
    const supabase = makeSupabase({
      sources: [{ claim_id: 'c-cap', source_type: 'capture', source_id: 'cap-pub' }],
      captures: { 'cap-pub': 'workspace' },
      errorOn: 'captures',
    })
    expect(await excludePrivateSourcedClaims(supabase, WS, [{ id: 'c-cap' }])).toEqual([])
  })
})

// ── Attachment sources resolve through their parent capture ──────────────────
//
// A file dropped on a private capture is as private as the capture: the SQL
// twin (public.claim_visible_to, migration 223) resolves an 'attachment' source
// through attachments.note_id, and this module must agree or the weaver/brief
// path launders a private meeting's attachment into a workspace document.
// Posture, matching the SQL exactly: NULL note_id => visible (no parent capture
// to inherit from); an attachment id that matches no row => hidden.
describe('excludePrivateSourcedClaims — attachment sources', () => {
  it("drops a claim sourced only from a private capture's attachment", async () => {
    const supabase = makeSupabase({
      sources: [{ claim_id: 'c-att-priv', source_type: 'attachment', source_id: 'att-1' }],
      attachments: { 'att-1': 'cap-priv' },
      captures: { 'cap-priv': 'private' },
    })
    expect(await excludePrivateSourcedClaims(supabase, WS, [{ id: 'c-att-priv' }])).toEqual([])
  })

  it("keeps a claim sourced from a workspace capture's attachment", async () => {
    const supabase = makeSupabase({
      sources: [{ claim_id: 'c-att-pub', source_type: 'attachment', source_id: 'att-2' }],
      attachments: { 'att-2': 'cap-pub' },
      captures: { 'cap-pub': 'workspace' },
    })
    const kept = await excludePrivateSourcedClaims(supabase, WS, [{ id: 'c-att-pub' }])
    expect(kept.map((c) => c.id)).toEqual(['c-att-pub'])
  })

  it('keeps a claim whose attachment has a NULL note_id (no parent capture)', async () => {
    const supabase = makeSupabase({
      sources: [{ claim_id: 'c-att-orphan', source_type: 'attachment', source_id: 'att-3' }],
      attachments: { 'att-3': null },
      captures: {},
    })
    const kept = await excludePrivateSourcedClaims(supabase, WS, [{ id: 'c-att-orphan' }])
    expect(kept.map((c) => c.id)).toEqual(['c-att-orphan'])
  })

  it('fails closed on a dangling attachment id (no matching row)', async () => {
    const supabase = makeSupabase({
      sources: [{ claim_id: 'c-att-gone', source_type: 'attachment', source_id: 'att-missing' }],
      attachments: {},
      captures: {},
    })
    expect(await excludePrivateSourcedClaims(supabase, WS, [{ id: 'c-att-gone' }])).toEqual([])
  })

  it('keeps a mixed claim: private-capture attachment plus a document source', async () => {
    const supabase = makeSupabase({
      sources: [
        { claim_id: 'c-mixed-att', source_type: 'attachment', source_id: 'att-1' },
        { claim_id: 'c-mixed-att', source_type: 'document', source_id: 'doc-1' },
      ],
      attachments: { 'att-1': 'cap-priv' },
      captures: { 'cap-priv': 'private' },
    })
    const kept = await excludePrivateSourcedClaims(supabase, WS, [{ id: 'c-mixed-att' }])
    expect(kept.map((c) => c.id)).toEqual(['c-mixed-att'])
  })

  it('resolves both source kinds in THREE batched queries — never N+1', async () => {
    // The attachment's parent capture must be folded into the SAME captures
    // fetch as the direct capture sources, not a fourth query.
    const tables: string[] = []
    const supabase = makeSupabase({
      sources: [
        { claim_id: 'c1', source_type: 'capture', source_id: 'cap-pub' },
        { claim_id: 'c2', source_type: 'attachment', source_id: 'att-priv' },
        { claim_id: 'c3', source_type: 'attachment', source_id: 'att-pub' },
      ],
      attachments: { 'att-priv': 'cap-priv', 'att-pub': 'cap-pub' },
      captures: { 'cap-pub': 'workspace', 'cap-priv': 'private' },
      onQuery: (t) => tables.push(t),
    })
    const kept = await excludePrivateSourcedClaims(supabase, WS, [
      { id: 'c1' },
      { id: 'c2' },
      { id: 'c3' },
    ])
    expect(kept.map((c) => c.id)).toEqual(['c1', 'c3'])
    expect(tables).toEqual(['claim_source', 'attachments', 'captures'])
  })

  it('fails CLOSED when the attachments fetch errors', async () => {
    const supabase = makeSupabase({
      sources: [{ claim_id: 'c-att', source_type: 'attachment', source_id: 'att-1' }],
      attachments: { 'att-1': null },
      captures: {},
      errorOn: 'attachments',
    })
    expect(await excludePrivateSourcedClaims(supabase, WS, [{ id: 'c-att' }])).toEqual([])
  })
})

// ---- Dedupe audience: attaching a source never widens a claim ---------------

describe('dedupeRequesterFor', () => {
  const OWNER = 'u-owner'
  const project = { entity_type: 'project', relation: 'about' }
  const company = { entity_type: 'company', relation: 'about' }
  const contact = { entity_type: 'contact', relation: 'about' }
  const action = { entity_type: 'action', relation: 'about' }
  const member = { entity_type: 'member', relation: 'committed_to' }
  const decision = { entity_type: 'decision', relation: 'about' }

  const cases: Array<[string, Parameters<typeof dedupeRequesterFor>[0], string | null]> = [
    ['workspace capture', { sourceType: 'capture', ownerUserId: OWNER, captureVisibility: 'workspace' }, null],
    ['private capture', { sourceType: 'capture', ownerUserId: OWNER, captureVisibility: 'private' }, OWNER],
    ['private capture, no owner', { sourceType: 'capture', ownerUserId: null, captureVisibility: 'private' }, null],
    ['private capture, empty owner', { sourceType: 'capture', ownerUserId: '', captureVisibility: 'private' }, null],
    ['capture, unknown visibility (failed read)', { sourceType: 'capture', ownerUserId: OWNER, captureVisibility: null }, null],
    ['capture, unexpected visibility value', { sourceType: 'capture', ownerUserId: OWNER, captureVisibility: 'team' }, null],
    ['conversation', { sourceType: 'conversation', ownerUserId: OWNER }, OWNER],
    ['conversation, unknown owner', { sourceType: 'conversation', ownerUserId: null }, null],
    ['document', { sourceType: 'document', ownerUserId: OWNER }, null],
    ['external_url', { sourceType: 'external_url', ownerUserId: OWNER }, null],
    ['attachment, no parent capture', { sourceType: 'attachment', ownerUserId: null }, null],
    ['attachment on a private capture', { sourceType: 'attachment', ownerUserId: OWNER, parentCaptureVisibility: 'private' }, OWNER],
    ['attachment on a workspace capture', { sourceType: 'attachment', ownerUserId: OWNER, parentCaptureVisibility: 'workspace' }, null],
    ['attachment, parent read failed', { sourceType: 'attachment', ownerUserId: null, parentCaptureVisibility: null }, null],
    ['unknown source type', { sourceType: 'manual', ownerUserId: OWNER }, null],
    ['private capture + project link', { sourceType: 'capture', ownerUserId: OWNER, captureVisibility: 'private', links: [project] }, null],
    ['private capture + company link', { sourceType: 'capture', ownerUserId: OWNER, captureVisibility: 'private', links: [company] }, null],
    ['private capture + contact link', { sourceType: 'capture', ownerUserId: OWNER, captureVisibility: 'private', links: [member, contact] }, null],
    ['private capture + action link', { sourceType: 'capture', ownerUserId: OWNER, captureVisibility: 'private', links: [action] }, null],
    ['private capture + member committed_to', { sourceType: 'capture', ownerUserId: OWNER, captureVisibility: 'private', links: [member] }, OWNER],
    ['private capture + decision link (not citable)', { sourceType: 'capture', ownerUserId: OWNER, captureVisibility: 'private', links: [decision] }, OWNER],
    ['private chat + project link', { sourceType: 'conversation', ownerUserId: OWNER, links: [project] }, null],
    ['private-parent attachment + project link', { sourceType: 'attachment', ownerUserId: OWNER, parentCaptureVisibility: 'private', links: [project] }, null],
    // A call's capture: private to its owner, its words anyone's in the call: shared claims only.
    ['a call’s capture (private)', { sourceType: 'capture', ownerUserId: OWNER, captureVisibility: 'private', callCapture: true }, null],
    ['a call’s capture + member committed_to', { sourceType: 'capture', ownerUserId: OWNER, captureVisibility: 'private', callCapture: true, links: [member] }, null],
    ['an attachment on a call’s capture', { sourceType: 'attachment', ownerUserId: OWNER, parentCaptureVisibility: 'private', parentCallCapture: true }, null],
  ]

  it.each(cases)('%s', (_label, args, expected) => {
    expect(dedupeRequesterFor(args)).toBe(expected)
  })
})

describe('provenanceLinksReachEveryone', () => {
  it.each([
    [[], false],
    [null, false],
    [[{ entity_type: 'member', relation: 'committed_to' }], false],
    [[{ entity_type: 'decision', relation: 'about' }], false],
    // A non-evidence relation to a citable entity is not mirrored into claim_source.
    [[{ entity_type: 'project', relation: 'related_to' }], false],
    [[{ entity_type: 'project' }], true], // relation defaults to 'about', as in attachClaimProvenance
    [[{ entity_type: 'company', relation: 'about' }], true],
    [[{ entity_type: 'contact', relation: 'cites' }], true],
    [[{ entity_type: 'action', relation: 'about' }], true],
  ] as const)('%j → %s', (links, expected) => {
    expect(provenanceLinksReachEveryone(links)).toBe(expected)
  })
})

describe('private documents (migration 369): a claim known only from one is no one\'s on an unattended read', () => {
  it('drops a claim whose only source is a private document; keeps one with a workspace document too', async () => {
    const supabase = makeSupabase({
      sources: [
        { claim_id: 'c-private-doc', source_type: 'document', source_id: 'doc-priv' },
        { claim_id: 'c-both', source_type: 'document', source_id: 'doc-priv' },
        { claim_id: 'c-both', source_type: 'document', source_id: 'doc-pub' },
        { claim_id: 'c-gone', source_type: 'document', source_id: 'doc-deleted' },
      ],
      captures: {},
      documents: { 'doc-priv': 'private', 'doc-pub': 'workspace' },
    })
    const kept = await excludePrivateSourcedClaims(supabase, WS, [{ id: 'c-private-doc' }, { id: 'c-both' }, { id: 'c-gone' }])
    expect(kept.map((c) => c.id)).toEqual(['c-both'])
  })

  it('a private document is its creator\'s: dedupe stays in their audience', () => {
    expect(dedupeRequesterFor({ sourceType: 'document', ownerUserId: 'u-owner', documentVisibility: 'private' })).toBe('u-owner')
    expect(dedupeRequesterFor({ sourceType: 'document', ownerUserId: 'u-owner', documentVisibility: 'workspace' })).toBeNull()
  })
})
