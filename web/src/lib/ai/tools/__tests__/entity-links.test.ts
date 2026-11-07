/**
 * Tests for link_entities / unlink_entities / list_entity_links in entity-links.ts.
 *
 * Vitest unit tests (no network, no DB). Run via `npm test`.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createSupabaseMock } from '@/test/supabase-mock'
import { createEntityLinkTools } from '../entity-links'
// link_entities lives in claims.ts (the canonical, workspace-verified version);
// entity-links.ts owns unlink_entities / list_entity_links.
import { createClaimTools } from '../claims'

const USER_ID = 'user-uuid-1'
const WORKSPACE_ID = 'workspace-uuid-1'
const DOCUMENT_ID = 'doc-uuid-1'
const ACTION_ID = 'action-uuid-1'
const PROJECT_ID = 'project-uuid-1'
const MEMBER_ID = 'member-uuid-1'
const LINK_ID = 'link-uuid-1'

const EXEC_OPTS = {
  toolCallId: 'test-call-id',
  messages: [],
  context: {},
} satisfies ToolExecutionOptions<Record<string, unknown>>

// ─── link_entities (canonical implementation in claims.ts) ────────────────────

describe('link_entities', () => {
  it('creates an entity_link record for document → action', async () => {
    const supabase = createSupabaseMock({
      tables: {
        member: { data: { id: MEMBER_ID }, error: null },
        document: { data: { id: DOCUMENT_ID }, error: null },
        actions: { data: { id: ACTION_ID }, error: null },
        entity_link: {
          data: {
            id: LINK_ID,
            source_type: 'document',
            source_id: DOCUMENT_ID,
            target_type: 'action',
            target_id: ACTION_ID,
            relation: 'related_to',
          },
          error: null,
        },
      },
    })

    const tools = createClaimTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = (await tools.link_entities.execute!(
      {
        source_type: 'document',
        source_id: DOCUMENT_ID,
        target_type: 'action',
        target_id: ACTION_ID,
        relation: 'related_to',
      },
      EXEC_OPTS,
    )) as Record<string, unknown>

    expect(result.success).toBe(true)
    expect(supabase.from).toHaveBeenCalledWith('entity_link')
  })

  it('creates an entity_link record for document → project with default relation', async () => {
    const supabase = createSupabaseMock({
      tables: {
        member: { data: { id: MEMBER_ID }, error: null },
        document: { data: { id: DOCUMENT_ID }, error: null },
        projects: { data: { id: PROJECT_ID }, error: null },
        entity_link: {
          data: {
            id: LINK_ID,
            source_type: 'document',
            source_id: DOCUMENT_ID,
            target_type: 'project',
            target_id: PROJECT_ID,
            relation: 'mentions',
          },
          error: null,
        },
      },
    })

    const tools = createClaimTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = (await tools.link_entities.execute!(
      {
        source_type: 'document',
        source_id: DOCUMENT_ID,
        target_type: 'project',
        target_id: PROJECT_ID,
        relation: 'mentions',
      },
      EXEC_OPTS,
    )) as Record<string, unknown>

    expect(result.success).toBe(true)
  })

  it('returns error when source entity is not found in workspace', async () => {
    const supabase = createSupabaseMock({
      tables: {
        member: { data: { id: MEMBER_ID }, error: null },
        document: { data: null, error: null },
      },
    })

    const tools = createClaimTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = (await tools.link_entities.execute!(
      {
        source_type: 'document',
        source_id: DOCUMENT_ID,
        target_type: 'action',
        target_id: ACTION_ID,
        relation: 'related_to',
      },
      EXEC_OPTS,
    )) as Record<string, unknown>

    expect(result.success).toBe(false)
    expect(result.error as string).toContain('not found')
    // Should NOT attempt to insert into entity_link
    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0])
    expect(fromCalls).not.toContain('entity_link')
  })

  it('returns error when target entity is not found in workspace', async () => {
    const supabase = createSupabaseMock({
      tables: {
        member: { data: { id: MEMBER_ID }, error: null },
        document: { data: { id: DOCUMENT_ID }, error: null },
        actions: { data: null, error: null },
      },
    })

    const tools = createClaimTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = (await tools.link_entities.execute!(
      {
        source_type: 'document',
        source_id: DOCUMENT_ID,
        target_type: 'action',
        target_id: ACTION_ID,
        relation: 'about',
      },
      EXEC_OPTS,
    )) as Record<string, unknown>

    expect(result.success).toBe(false)
    expect(result.error as string).toContain('not found')
  })

  it('treats an existing link (23505 duplicate) as idempotent success', async () => {
    function makeChainFor(result: { data: unknown; error: { code?: string; message: string } | null }) {
      const chain: Record<string, unknown> = {
        then: (resolve: (r: unknown) => unknown) => Promise.resolve(result).then(resolve),
      }
      const proxy: typeof chain = new Proxy(chain, {
        get(_t, prop: string) {
          if (prop in chain) return chain[prop]
          if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(result)
          const fn = () => proxy
          chain[prop as string] = fn
          return fn
        },
      })
      return proxy
    }

    const supabase = createSupabaseMock({
      tableHandler: (table: string) => {
        if (table === 'member') return makeChainFor({ data: { id: MEMBER_ID }, error: null })
        if (table === 'document') return makeChainFor({ data: { id: DOCUMENT_ID }, error: null })
        if (table === 'actions') return makeChainFor({ data: { id: ACTION_ID }, error: null })
        if (table === 'entity_link') {
          // Simulate unique constraint violation on .single()
          return makeChainFor({ data: null, error: { code: '23505', message: 'duplicate key' } })
        }
        return makeChainFor({ data: null, error: null })
      },
    })

    const tools = createClaimTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = (await tools.link_entities.execute!(
      {
        source_type: 'document',
        source_id: DOCUMENT_ID,
        target_type: 'action',
        target_id: ACTION_ID,
        relation: 'related_to',
      },
      EXEC_OPTS,
    )) as Record<string, unknown>

    // claims.ts treats a duplicate edge as an idempotent success.
    expect(result.success).toBe(true)
    expect(result.message as string).toMatch(/already exists/)
  })
})

// ─── unlink_entities ─────────────────────────────────────────────────────────

describe('unlink_entities', () => {
  // unlink_entities now resolves the SOURCE entity's own workspace via
  // resolveEntityWorkspace before deleting (see routing.entity-links.test.ts
  // for the cross-workspace / strictWorkspace cases) — so every case here
  // needs the source `document` row to resolve in the active workspace.
  const IN_WORKSPACE = { document: { data: { workspace_id: WORKSPACE_ID }, error: null } }

  it('deletes the entity_link record for a document → action pair', async () => {
    const supabase = createSupabaseMock({
      tables: {
        ...IN_WORKSPACE,
        entity_link: { data: null, error: null },
      },
    })

    const tools = createEntityLinkTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.unlink_entities.execute!(
      {
        source_type: 'document',
        source_id: DOCUMENT_ID,
        target_type: 'action',
        target_id: ACTION_ID,
      },
      EXEC_OPTS,
    ) as Record<string, unknown>

    expect(result.success).toBe(true)
    expect(supabase.from).toHaveBeenCalledWith('entity_link')
  })

  it('passes relation filter when provided', async () => {
    const supabase = createSupabaseMock({
      tables: {
        ...IN_WORKSPACE,
        entity_link: { data: null, error: null },
      },
    })

    const tools = createEntityLinkTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.unlink_entities.execute!(
      {
        source_type: 'document',
        source_id: DOCUMENT_ID,
        target_type: 'action',
        target_id: ACTION_ID,
        relation: 'mentions',
      },
      EXEC_OPTS,
    ) as Record<string, unknown>

    expect(result.success).toBe(true)
  })

  it('asks for an exact count on the delete and reports the rows it removed', async () => {
    const supabase = createSupabaseMock({
      tables: {
        ...IN_WORKSPACE,
        entity_link: { data: null, error: null, count: 1 } as never,
      },
    })

    const tools = createEntityLinkTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.unlink_entities.execute!(
      {
        source_type: 'document',
        source_id: DOCUMENT_ID,
        target_type: 'action',
        target_id: ACTION_ID,
      },
      EXEC_OPTS,
    ) as Record<string, unknown>

    // supabase-js leaves `count` null on a delete unless it is asked for.
    const idx = supabase.from.mock.calls.findIndex((c: unknown[]) => c[0] === 'entity_link')
    const chain = supabase.from.mock.results[idx].value as { delete: { mock: { calls: unknown[][] } } }
    expect(chain.delete.mock.calls[0][0]).toEqual({ count: 'exact' })
    expect(result.deleted_count).toBe(1)
    expect(result.message).toMatch(/Removed 1 link/)
  })

  it('returns success with deleted_count 0 when no links exist', async () => {
    const supabase = createSupabaseMock({
      tables: {
        ...IN_WORKSPACE,
        entity_link: { data: null, error: null },
      },
    })

    const tools = createEntityLinkTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.unlink_entities.execute!(
      {
        source_type: 'document',
        source_id: 'nonexistent-id',
        target_type: 'action',
        target_id: 'also-nonexistent',
      },
      EXEC_OPTS,
    ) as Record<string, unknown>

    expect(result.success).toBe(true)
  })
})

// ─── list_entity_links ───────────────────────────────────────────────────────

describe('list_entity_links', () => {
  it('returns outbound and inbound links for an entity', async () => {
    const outboundLink = {
      id: 'link-1',
      target_type: 'action',
      target_id: ACTION_ID,
      relation: 'related_to',
      created_at: new Date().toISOString(),
    }
    const inboundLink = {
      id: 'link-2',
      source_type: 'capture',
      source_id: 'capture-uuid-1',
      relation: 'mentions',
      created_at: new Date().toISOString(),
    }

    // entity_link is queried twice (outbound + inbound) — use tableHandler
    // to return distinct shapes for each call based on call count.
    let callCount = 0
    const supabase = createSupabaseMock({
      tableHandler: (table: string) => {
        if (table !== 'entity_link') return { data: null, error: null }
        callCount++
        const data = callCount === 1 ? [outboundLink] : [inboundLink]
        const result = { data, error: null }
        const chain: Record<string, unknown> = {}
        const proxy: typeof chain = new Proxy(chain, {
          get(_t, prop: string) {
            if (prop === 'then') return (resolve: (r: unknown) => unknown) => Promise.resolve(result).then(resolve)
            return () => proxy
          },
        })
        return proxy
      },
    })

    const tools = createEntityLinkTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.list_entity_links.execute!(
      { entity_type: 'document', entity_id: DOCUMENT_ID, direction: 'both' },
      EXEC_OPTS,
    ) as Record<string, unknown>

    expect(result.success).toBe(true)
    expect(Array.isArray(result.outbound)).toBe(true)
    expect(Array.isArray(result.inbound)).toBe(true)
  })

  it('only queries outbound when direction is "outbound"', async () => {
    const supabase = createSupabaseMock({
      tables: {
        entity_link: { data: [], error: null },
      },
    })

    const tools = createEntityLinkTools(USER_ID, supabase as never, WORKSPACE_ID)
    const result = await tools.list_entity_links.execute!(
      { entity_type: 'document', entity_id: DOCUMENT_ID, direction: 'outbound' },
      EXEC_OPTS,
    ) as Record<string, unknown>

    expect(result.success).toBe(true)
    // Inbound array should be empty (never queried)
    expect(result.inbound).toEqual([])
  })
})

// ─── the vocabulary drift these tools used to have ───────────────────────────
//
// entity-links.ts carried its own 7-type / 8-relation copies of the vocabulary,
// so an edge link_entities had just created could not be listed or removed: zod
// rejected a claim / email / attachment / member / conversation endpoint, and
// the `owns` / `committed_to` relations, before either tool ran. Both files now
// read the same registry.

describe('unlink/list accept everything link_entities can create', () => {
  const tools = createEntityLinkTools(USER_ID, createSupabaseMock({}) as never, WORKSPACE_ID)
  const linkTools = createClaimTools(USER_ID, createSupabaseMock({}) as never, WORKSPACE_ID)

  const accepts = (schema: unknown, value: Record<string, unknown>) =>
    (schema as { safeParse: (v: unknown) => { success: boolean } }).safeParse(value).success

  const WAS_REJECTED = [
    'claim',
    'email',
    'attachment',
    'member',
    'conversation',
    'company',
    'milestone',
  ]

  it.each(WAS_REJECTED)('unlink_entities accepts a %s endpoint', (type) => {
    expect(
      accepts(tools.unlink_entities.inputSchema, {
        source_type: type,
        source_id: DOCUMENT_ID,
        target_type: 'document',
        target_id: DOCUMENT_ID,
      }),
    ).toBe(true)
  })

  it.each(['owns', 'committed_to'])('unlink_entities accepts the %s relation', (relation) => {
    expect(
      accepts(tools.unlink_entities.inputSchema, {
        source_type: 'document',
        source_id: DOCUMENT_ID,
        target_type: 'action',
        target_id: ACTION_ID,
        relation,
      }),
    ).toBe(true)
  })

  it.each(WAS_REJECTED)('list_entity_links accepts a %s entity', (type) => {
    expect(
      accepts(tools.list_entity_links.inputSchema, {
        entity_type: type,
        entity_id: DOCUMENT_ID,
      }),
    ).toBe(true)
  })

  it('still rejects a type that is in no vocabulary', () => {
    expect(
      accepts(tools.list_entity_links.inputSchema, {
        entity_type: 'not_a_thing',
        entity_id: DOCUMENT_ID,
      }),
    ).toBe(false)
    expect(
      accepts(linkTools.link_entities.inputSchema, {
        source_type: 'not_a_thing',
        source_id: DOCUMENT_ID,
        target_type: 'document',
        target_id: DOCUMENT_ID,
      }),
    ).toBe(false)
  })
})
