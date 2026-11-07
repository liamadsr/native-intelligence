/**
 * Capture-visibility enforcement in the tool factories that read captures
 * INDIRECTLY — through a project, a contact, a comment thread, or the claim
 * graph. Direct capture reads are covered by captures.visibility.test.ts.
 *
 * These tools run on SERVICE-ROLE Supabase clients on the MCP / unattended
 * paths (RLS bypassed), so the filters asserted here — not RLS — are the real
 * enforcement. Both axes are covered per tool:
 *   1. Interactive (omitPrivateCaptures = false): the requester sees their own
 *      private captures, never someone else's.
 *   2. Unattended (omitPrivateCaptures = true): NO private capture is reachable.
 * See docs/design-capture-visibility.md.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createProjectTools } from '../projects'
import { createCommentTools } from '../comments'
import { createCrmTools } from '../crm'
import { createClaimTools } from '../claims'

const USER_ID = 'user-mine'
const OTHER_USER_ID = 'user-theirs'
const WORKSPACE_ID = 'ws-1'
const PROJECT_ID = 'proj-1'
const EXEC_OPTS = { toolCallId: 'c1', messages: [], context: {} } satisfies ToolExecutionOptions<
  Record<string, unknown>
>

type CaptureRow = {
  id: string
  workspace_id: string
  user_id: string
  visibility: string
  title: string
  ai_summary?: string | null
  started_at?: string | null
  created_at?: string
  status?: string | null
  project_id?: string | null
}

const capture = (p: Partial<CaptureRow> & { id: string }): CaptureRow => ({
  workspace_id: WORKSPACE_ID,
  user_id: USER_ID,
  visibility: 'workspace',
  title: `capture ${p.id}`,
  ai_summary: `summary ${p.id}`,
  started_at: '2026-06-01T00:00:00.000Z',
  created_at: '2026-06-01T00:00:00.000Z',
  status: 'ready',
  project_id: PROJECT_ID,
  ...p,
})

const PUBLIC_CAPTURE = capture({ id: 'cap-public', visibility: 'workspace', user_id: OTHER_USER_ID })
const MY_PRIVATE = capture({ id: 'cap-mine-private', visibility: 'private', user_id: USER_ID })
const THEIR_PRIVATE = capture({ id: 'cap-theirs-private', visibility: 'private', user_id: OTHER_USER_ID })
const ALL_CAPTURES = [PUBLIC_CAPTURE, MY_PRIVATE, THEIR_PRIVATE]

/**
 * Chainable `captures` double that EVALUATES the visibility predicate the tool
 * applies — `.or('visibility.eq.workspace,user_id.eq.<id>')` or
 * `.eq('visibility','workspace')` — so the tests assert on real filtering.
 * Mirrors captures.visibility.test.ts's chain double.
 */
function captureTableChain(rows: CaptureRow[]) {
  let filtered = [...rows]
  const chain: Record<string, unknown> = {}
  const self = () => chain

  chain.select = vi.fn(self)
  chain.order = vi.fn(self)
  chain.limit = vi.fn(self)
  chain.overrideTypes = vi.fn(self)
  chain.neq = vi.fn((col: string, val: unknown) => {
    filtered = filtered.filter((r) => (r as unknown as Record<string, unknown>)[col] !== val)
    return chain
  })
  chain.eq = vi.fn((col: string, val: unknown) => {
    filtered = filtered.filter((r) => (r as unknown as Record<string, unknown>)[col] === val)
    return chain
  })
  chain.in = vi.fn((col: string, vals: unknown[]) => {
    filtered = filtered.filter((r) => vals.includes((r as unknown as Record<string, unknown>)[col]))
    return chain
  })
  chain.or = vi.fn((filter: string) => {
    const clauses = filter.split(',').map((c) => c.split('.'))
    filtered = filtered.filter((r) =>
      clauses.some(([col, , val]) => (r as unknown as Record<string, unknown>)[col] === val),
    )
    return chain
  })
  chain.maybeSingle = vi.fn(async () => ({ data: filtered[0] ?? null, error: null }))
  chain.single = vi.fn(async () =>
    filtered[0]
      ? { data: filtered[0], error: null }
      : { data: null, error: { message: 'No rows found' } },
  )
  chain.then = (resolve: (r: unknown) => unknown) =>
    Promise.resolve({ data: filtered, error: null }).then(resolve)

  return chain
}

/** Generic chain returning a fixed row set, ignoring filters. */
function staticChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {}
  const self = () => chain
  for (const m of [
    'select', 'eq', 'in', 'neq', 'is', 'or', 'contains', 'overlaps', 'gte', 'lte', 'not',
    'order', 'limit', 'overrideTypes',
  ]) {
    chain[m] = vi.fn(self)
  }
  chain.single = vi.fn(async () => ({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'none' } }))
  chain.maybeSingle = vi.fn(async () => ({ data: rows[0] ?? null, error: null }))
  chain.then = (resolve: (r: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(resolve)
  return chain
}

// ── get_project_context ──────────────────────────────────────────────────────

describe('get_project_context', () => {
  const run = async (omitPrivateCaptures: boolean) => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'captures') return captureTableChain(ALL_CAPTURES)
        if (table === 'projects') {
          return staticChain([{ id: PROJECT_ID, workspace_id: WORKSPACE_ID, name: 'P' }])
        }
        return staticChain([])
      }),
    }
    const t = createProjectTools(USER_ID, supabase as never, WORKSPACE_ID, false, omitPrivateCaptures)
    const parsed = (
      t.get_project_context.inputSchema as unknown as { parse: (v: unknown) => unknown }
    ).parse({ project_id: PROJECT_ID })
    return (await t.get_project_context.execute!(parsed as never, EXEC_OPTS)) as {
      success: boolean
      recent_notes: Array<{ id: string }>
    }
  }

  it("keeps the requester's own private capture but drops another user's", async () => {
    const result = await run(false)
    const ids = result.recent_notes.map((n) => n.id)
    expect(ids).toContain(PUBLIC_CAPTURE.id)
    expect(ids).toContain(MY_PRIVATE.id)
    expect(ids).not.toContain(THEIR_PRIVATE.id)
  })

  it('drops EVERY private capture under omitPrivateCaptures', async () => {
    const result = await run(true)
    expect(result.recent_notes.map((n) => n.id)).toEqual([PUBLIC_CAPTURE.id])
  })
})

// ── comment tools ────────────────────────────────────────────────────────────

describe('comment tools on a capture', () => {
  const COMMENT_ROWS = [
    { id: 'cmt-1', body: 'secret', author_id: 'm-1', parent_id: null, created_at: 't', edited_at: null, author: null },
  ]

  function makeSupabase() {
    return {
      from: vi.fn((table: string) => {
        if (table === 'captures') return captureTableChain(ALL_CAPTURES)
        if (table === 'comment') return staticChain(COMMENT_ROWS)
        if (table === 'member') return staticChain([{ id: 'm-1' }])
        return staticChain([])
      }),
    }
  }

  const tools = (omitPrivateCaptures = false) =>
    createCommentTools(USER_ID, makeSupabase() as never, WORKSPACE_ID, omitPrivateCaptures)

  const listOn = async (captureId: string, omitPrivateCaptures = false) => {
    const t = tools(omitPrivateCaptures)
    const parsed = (t.list_comments.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse({
      commentable_type: 'capture',
      commentable_id: captureId,
    })
    return (await t.list_comments.execute!(parsed as never, EXEC_OPTS)) as {
      success: boolean
      error?: string
      comments?: unknown[]
    }
  }

  it("refuses list_comments on another user's private capture with the not-found shape", async () => {
    const res = await listOn(THEIR_PRIVATE.id)
    expect(res.success).toBe(false)
    expect(res.error).toBe('capture not found')
    expect(res.comments).toBeUndefined()
  })

  it('lets the creator list comments on their own private capture', async () => {
    const res = await listOn(MY_PRIVATE.id)
    expect(res.success).toBe(true)
    expect(res.comments).toHaveLength(1)
  })

  it('refuses the run-as user their OWN private capture under omitPrivateCaptures', async () => {
    const res = await listOn(MY_PRIVATE.id, true)
    expect(res.success).toBe(false)
    expect(res.error).toBe('capture not found')
  })

  it('still serves a workspace capture under omitPrivateCaptures', async () => {
    const res = await listOn(PUBLIC_CAPTURE.id, true)
    expect(res.success).toBe(true)
  })

  it('gates add_comment on the same predicate', async () => {
    const t = tools()
    const parsed = (t.add_comment.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse({
      commentable_type: 'capture',
      commentable_id: THEIR_PRIVATE.id,
      body: 'hi',
    })
    const res = (await t.add_comment.execute!(parsed as never, EXEC_OPTS)) as {
      success: boolean
      error?: string
    }
    expect(res.success).toBe(false)
    expect(res.error).toBe('capture not found')
  })

  it('gates get_comment_replies through the parent comment\'s capture', async () => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'captures') return captureTableChain(ALL_CAPTURES)
        if (table === 'comment') {
          return staticChain([
            { commentable_type: 'capture', commentable_id: THEIR_PRIVATE.id },
          ])
        }
        return staticChain([])
      }),
    }
    const t = createCommentTools(USER_ID, supabase as never, WORKSPACE_ID)
    const parsed = (
      t.get_comment_replies.inputSchema as unknown as { parse: (v: unknown) => unknown }
    ).parse({ comment_id: 'cmt-1' })
    const res = (await t.get_comment_replies.execute!(parsed as never, EXEC_OPTS)) as {
      success: boolean
      error?: string
    }
    expect(res.success).toBe(false)
    // Same shape as a nonexistent comment — never leaks that the capture exists.
    expect(res.error).toBe('Comment not found')
  })
})

// ── get_contact_details ──────────────────────────────────────────────────────

describe('get_contact_details', () => {
  const CONTACT = { id: 'contact-1', workspace_id: WORKSPACE_ID, full_name: 'X', merged_into_contact_id: null }

  /**
   * `captures` double for the helper's participant-joined query: evaluates the
   * TOP-LEVEL visibility predicate (`.or('visibility.eq.workspace,user_id.eq.X')`
   * or `.eq('visibility','workspace')`) on the rows, and treats the embedded
   * `.or(…, { referencedTable: 'cp' })` participant filter as a match-all (the
   * !inner semantics are the DB's job; the TS re-check is what we assert).
   */
  function captureWithParticipantChain(rows: CaptureRow[]) {
    const base = captureTableChain(rows)
    const inner = base.or as (filter: string) => unknown
    base.not = vi.fn(() => base)
    base.or = vi.fn((filter: string, opts?: { referencedTable?: string }) => {
      if (opts?.referencedTable) {
        expect(opts).toEqual({ referencedTable: 'cp' })
        expect(filter).toContain(`contact_id.eq.${CONTACT.id}`)
        return base
      }
      return inner(filter)
    })
    return base
  }

  const run = async (omitPrivateCaptures: boolean, rows: CaptureRow[] = ALL_CAPTURES) => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'contact') return staticChain([CONTACT])
        if (table === 'captures') return captureWithParticipantChain(rows)
        return staticChain([])
      }),
      rpc: vi.fn(async () => ({ data: true, error: null })),
    }
    const t = createCrmTools(USER_ID, supabase as never, WORKSPACE_ID, omitPrivateCaptures)
    const parsed = (
      t.get_contact_details.inputSchema as unknown as { parse: (v: unknown) => unknown }
    ).parse({ contact_id: CONTACT.id })
    const res = (await t.get_contact_details.execute!(parsed as never, EXEC_OPTS)) as {
      success: boolean
      contact: { recent_captures: Array<{ id: string; ai_summary: string | null }> }
    }
    return { res, supabase }
  }

  it("returns the requester's own private capture but never another user's summary", async () => {
    const { res, supabase } = await run(false)
    const ids = res.contact.recent_captures.map((c) => c.id)
    expect(ids).toContain(PUBLIC_CAPTURE.id)
    expect(ids).toContain(MY_PRIVATE.id)
    expect(ids).not.toContain(THEIR_PRIVATE.id)
    // The contact itself is fenced through contact_visible_to with the requester.
    expect(supabase.rpc).toHaveBeenCalledWith('contact_visible_to', {
      p_contact_id: CONTACT.id,
      p_user_id: USER_ID,
    })
  })

  it('returns only workspace captures under omitPrivateCaptures', async () => {
    const { res, supabase } = await run(true)
    expect(res.contact.recent_captures.map((c) => c.id)).toEqual([PUBLIC_CAPTURE.id])
    // Unattended → null requester → workspace-visible contacts only.
    expect(supabase.rpc).toHaveBeenCalledWith('contact_visible_to', {
      p_contact_id: CONTACT.id,
      p_user_id: null,
    })
  })

  it('drops a capture from another workspace even if the embed leaks it', async () => {
    // Defense-in-depth: the service-role client bypasses RLS, so the TS re-check
    // must hold even when the DB-side filter is bypassed.
    const foreign = capture({ id: 'cap-foreign', workspace_id: 'ws-other' })
    const { res } = await run(false, [foreign])
    expect(res.contact.recent_captures).toEqual([])
  })
})

// ── claims: resolveLabels (traverse) + provenance ─────────────────────────────

describe('traverse label resolution', () => {
  const EDGES = ALL_CAPTURES.map((c) => ({
    target_type: 'capture',
    target_id: c.id,
    relation: 'cites',
  }))

  const run = async (omitPrivateCaptures: boolean) => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'captures') return captureTableChain(ALL_CAPTURES)
        if (table === 'entity_link') return staticChain(EDGES)
        return staticChain([])
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    }
    const t = createClaimTools(USER_ID, supabase as never, WORKSPACE_ID, false, omitPrivateCaptures)
    const parsed = (t.traverse.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse({
      entity_type: 'claim',
      entity_id: 'claim-1',
      direction: 'outbound',
    })
    return (await t.traverse.execute!(parsed as never, EXEC_OPTS)) as {
      success: boolean
      outbound: Array<{ target_id: string; label?: string | null }>
    }
  }

  it("resolves the requester's own private capture title, never another user's", async () => {
    const res = await run(false)
    const byId = Object.fromEntries(res.outbound.map((e) => [e.target_id, e.label]))
    expect(byId[PUBLIC_CAPTURE.id]).toBe(PUBLIC_CAPTURE.title)
    expect(byId[MY_PRIVATE.id]).toBe(MY_PRIVATE.title)
    // The edge itself may remain, but the private title must not be stamped on it.
    expect(byId[THEIR_PRIVATE.id]).toBeNull()
  })

  it('resolves no private capture title at all under omitPrivateCaptures', async () => {
    const res = await run(true)
    const byId = Object.fromEntries(res.outbound.map((e) => [e.target_id, e.label]))
    expect(byId[PUBLIC_CAPTURE.id]).toBe(PUBLIC_CAPTURE.title)
    expect(byId[MY_PRIVATE.id]).toBeNull()
    expect(byId[THEIR_PRIVATE.id]).toBeNull()
  })
})

// A workspace-visible document a claim cites (migration 369 checks it).
const PUBLIC_DOC = { id: 'doc-1', workspace_id: WORKSPACE_ID, title: 'Spec', visibility: 'workspace', owner: null }

describe('get_claim provenance redaction', () => {
  const CLAIM_ID = 'claim-1'
  const SOURCES = [
    { id: 's-doc', source_type: 'document', source_id: 'doc-1', source_uri: null, excerpt: 'public evidence', created_at: 't' },
    { id: 's-priv', source_type: 'capture', source_id: THEIR_PRIVATE.id, source_uri: null, excerpt: 'verbatim private line', created_at: 't' },
    { id: 's-pub', source_type: 'capture', source_id: PUBLIC_CAPTURE.id, source_uri: null, excerpt: 'shared line', created_at: 't' },
  ]
  const OUTBOUND = [
    { id: 'l-1', target_type: 'capture', target_id: THEIR_PRIVATE.id, relation: 'cites', weight: 1 },
  ]

  const run = async (omitPrivateCaptures: boolean) => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'captures') return captureTableChain(ALL_CAPTURES)
        if (table === 'claim') {
          return staticChain([{ id: CLAIM_ID, workspace_id: WORKSPACE_ID, text: 'a claim' }])
        }
        if (table === 'claim_source') return staticChain(SOURCES)
        if (table === 'entity_link') return staticChain(OUTBOUND)
        // The cited document is workspace-visible (migration 369).
        if (table === 'document') return staticChain([PUBLIC_DOC])
        return staticChain([])
      }),
      // claim_visible_to passes: the claim has a non-capture source.
      rpc: vi.fn(async () => ({ data: true, error: null })),
    }
    const t = createClaimTools(USER_ID, supabase as never, WORKSPACE_ID, false, omitPrivateCaptures)
    const parsed = (t.get_claim.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse({
      claim_id: CLAIM_ID,
    })
    return (await t.get_claim.execute!(parsed as never, EXEC_OPTS)) as {
      success: boolean
      provenance: Array<{ entity_type: string; entity_id: string | null; excerpt: string | null }>
      sources: Array<{ id: string }>
      outbound_links: Array<{ id: string }>
    }
  }

  it("drops a hidden capture's excerpt and id from provenance, sources, and links", async () => {
    const res = await run(false)
    expect(res.success).toBe(true)
    const excerpts = res.provenance.map((p) => p.excerpt)
    expect(excerpts).toContain('public evidence')
    expect(excerpts).toContain('shared line')
    expect(excerpts).not.toContain('verbatim private line')
    expect(res.provenance.map((p) => p.entity_id)).not.toContain(THEIR_PRIVATE.id)
    expect(res.sources.map((s) => s.id)).toEqual(['s-doc', 's-pub'])
    expect(res.outbound_links).toEqual([])
  })

  it('drops every capture-sourced excerpt under omitPrivateCaptures', async () => {
    const res = await run(true)
    expect(res.sources.map((s) => s.id)).toEqual(['s-doc', 's-pub'])
    expect(res.provenance.map((p) => p.excerpt)).not.toContain('verbatim private line')
  })
})

describe('list_claims include_provenance redaction', () => {
  it('never returns a hidden capture excerpt, even with no claim-level gate', async () => {
    const CLAIM_ID = 'claim-1'
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'captures') return captureTableChain(ALL_CAPTURES)
        if (table === 'claim') {
          return staticChain([
            {
              id: CLAIM_ID,
              text: 'a claim',
              confirmation: 'confirmed',
              status: 'active',
              created_at: '2026-06-01T00:00:00.000Z',
              updated_at: '2026-06-01T00:00:00.000Z',
            },
          ])
        }
        if (table === 'claim_source') {
          return staticChain([
            { claim_id: CLAIM_ID, source_type: 'document', source_id: 'doc-1', source_uri: null, excerpt: 'public evidence' },
            { claim_id: CLAIM_ID, source_type: 'capture', source_id: THEIR_PRIVATE.id, source_uri: null, excerpt: 'verbatim private line' },
          ])
        }
        if (table === 'document') return staticChain([PUBLIC_DOC])
        return staticChain([])
      }),
      rpc: vi.fn(async () => ({ data: [], error: null })),
    }
    const t = createClaimTools(USER_ID, supabase as never, WORKSPACE_ID)
    const parsed = (t.list_claims.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse({
      include_provenance: true,
    })
    const res = (await t.list_claims.execute!(parsed as never, EXEC_OPTS)) as {
      success: boolean
      claims: Array<{ provenance?: Array<{ entity_id: string | null; excerpt: string | null }> }>
    }
    expect(res.success).toBe(true)
    const prov = res.claims[0]?.provenance ?? []
    expect(prov.map((p) => p.excerpt)).toEqual(['public evidence'])
    expect(prov.map((p) => p.entity_id)).not.toContain(THEIR_PRIVATE.id)
  })
})
