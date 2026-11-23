/**
 * The attachment hits `find` and `deep_search` keep (../search.ts,
 * keptAttachmentIds), on top of the RPCs' own fence (migration 708: the
 * attachments table's read rule for the requester, every parent kind):
 *   - an interactive turn keeps what the RPC returned;
 *   - an unattended run keeps only what every member reads: no private
 *     capture's file, no table row's file (attachment_rag_search is keyed to
 *     the run's creator, so its fence answers for them);
 *   - a guest's or a linked agent's turn drops what only a grant opens.
 * Made-up people and files.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'

vi.mock('@/lib/ai/embeddings', () => ({ embed: vi.fn(async () => [0.1, 0.2, 0.3]) }))
vi.mock('@/lib/ai/gemini-embeddings', () => ({ embedQuery: vi.fn(async () => [0.4, 0.5, 0.6]) }))
vi.mock('@/lib/email/email-search-service', () => ({ searchEmails: vi.fn(async () => ({ results: [], source: 'fts' })) }))
vi.mock('@/lib/email/email-context-service', () => ({ searchEmailsWithContext: vi.fn(async () => []) }))

import { createSearchTools, keptAttachmentIds } from '../search'

const EXEC = { toolCallId: 'c1', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
const WS = '11111111-1111-4111-8111-111111111111'
const ANA = '22222222-2222-4222-8222-aaaaaaaaaaaa'
const BEN = '22222222-2222-4222-8222-bbbbbbbbbbbb'
const ANA_MEMBER = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const OPEN_CALL = 'c0000000-0000-4000-8000-000000000001'
const ANA_PRIVATE = 'c0000000-0000-4000-8000-000000000002'
const BEN_SHARED = 'c0000000-0000-4000-8000-000000000003'
const ANA_TABLE = 'd0000000-0000-4000-8000-000000000001'
const BEN_TABLE_SHARED = 'd0000000-0000-4000-8000-000000000002'
const ANA_ROW = 'e0000000-0000-4000-8000-000000000001'
const SHARED_ROW = 'e0000000-0000-4000-8000-000000000002'

const f = (n: number) => `f0000000-0000-4000-8000-00000000000${n}`
const ON_TASK = f(1)
const ON_OPEN_CALL = f(2)
const ON_ANA_PRIVATE = f(3)
const ON_BEN_SHARED = f(4)
const ON_ANA_ROW = f(5)
const ON_SHARED_ROW = f(6)
const ALL = [ON_TASK, ON_OPEN_CALL, ON_ANA_PRIVATE, ON_BEN_SHARED, ON_ANA_ROW, ON_SHARED_ROW]

/** What 708's RPCs return for Ana: everything she may read (her own private capture, a shared one, her table, a shared table). */
function client() {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    member: [{ id: ANA_MEMBER, user_id: ANA, workspace_id: WS, role: 'member', workspace: { id: WS, name: 'Team' } }],
    workspace: [{ id: WS, name: 'Team' }],
    captures: [
      { id: OPEN_CALL, workspace_id: WS, visibility: 'workspace', user_id: BEN, is_eval: false },
      { id: ANA_PRIVATE, workspace_id: WS, visibility: 'private', user_id: ANA, is_eval: false },
      { id: BEN_SHARED, workspace_id: WS, visibility: 'private', user_id: BEN, is_eval: false },
    ],
    entity_access: [
      { workspace_id: WS, entity_type: 'capture', entity_id: BEN_SHARED, grantee_kind: 'member', grantee_member_id: ANA_MEMBER, level: 'view' },
    ],
    data_row: [
      { id: ANA_ROW, workspace_id: WS, table_id: ANA_TABLE },
      { id: SHARED_ROW, workspace_id: WS, table_id: BEN_TABLE_SHARED },
    ],
    attachments: [
      { id: ON_TASK, workspace_id: WS, user_id: BEN, note_id: null, data_row_id: null },
      { id: ON_OPEN_CALL, workspace_id: WS, user_id: BEN, note_id: OPEN_CALL, data_row_id: null },
      { id: ON_ANA_PRIVATE, workspace_id: WS, user_id: ANA, note_id: ANA_PRIVATE, data_row_id: null },
      { id: ON_BEN_SHARED, workspace_id: WS, user_id: BEN, note_id: BEN_SHARED, data_row_id: null },
      { id: ON_ANA_ROW, workspace_id: WS, user_id: null, note_id: null, data_row_id: ANA_ROW },
      { id: ON_SHARED_ROW, workspace_id: WS, user_id: null, note_id: null, data_row_id: SHARED_ROW },
    ],
  }
  const db = memoryDb(tables)
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'visible_data_table_ids') {
      // Ana owns ANA_TABLE; BEN_TABLE_SHARED reaches her only through a grant.
      const ids = args.p_ids as string[]
      return { data: args.p_user_id === ANA ? ids.filter((id) => id === ANA_TABLE || (args.p_grants !== false && id === BEN_TABLE_SHARED)) : [], error: null }
    }
    if (fn === 'hybrid_search_attachments') {
      return {
        data: ALL.map((id, i) => ({ result_type: 'attachment', result_id: id, title: `file ${i}`, score: 1 - i / 10, excerpt: 'text', metadata: { storage_path: `p/${id}` } })),
        error: null,
      }
    }
    if (fn === 'attachment_rag_search') {
      return {
        data: ALL.map((id, i) => ({ attachment_id: id, file_name: `file ${i}`, chunk_text: 'text', similarity: 0.9, storage_path: `p/${id}`, parent_capture_id: null })),
        error: null,
      }
    }
    return { data: [], error: null }
  })
  const supabase = {
    from: db.from.bind(db),
    rpc,
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://signed.example/x' } }) }) },
  } as unknown as SupabaseClient
  return { supabase, rpc }
}

type Mode = { omitPrivateCaptures?: boolean; omitGrants?: boolean }
const tools = (supabase: SupabaseClient, m: Mode) =>
  createSearchTools(ANA, supabase, WS, m.omitPrivateCaptures ?? false, 'all_time', false, false, m.omitGrants ?? false)

async function findIds(m: Mode): Promise<string[]> {
  const { supabase } = client()
  const t = tools(supabase, m)
  const args = (t.find.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse({ query: 'quote', types: ['attachment'] })
  const out = (await t.find.execute!(args as never, EXEC)) as { results?: Array<{ result_type: string; result_id: string }> }
  return (out.results ?? []).filter((r) => r.result_type === 'attachment').map((r) => r.result_id).sort()
}

async function deepIds(m: Mode): Promise<string[]> {
  const { supabase } = client()
  const t = tools(supabase, m)
  const args = (t.deep_search.inputSchema as unknown as { parse: (v: unknown) => unknown }).parse({ query: 'quote', types: ['attachments'] })
  const out = (await t.deep_search.execute!(args as never, EXEC)) as { attachments?: Array<{ attachment_id: string }> }
  return (out.attachments ?? []).map((r) => r.attachment_id).sort()
}

const sorted = (ids: string[]) => [...ids].sort()
const EVERY_MEMBERS = sorted([ON_TASK, ON_OPEN_CALL])
const WITHOUT_GRANTS = sorted([ON_TASK, ON_OPEN_CALL, ON_ANA_PRIVATE, ON_ANA_ROW])

describe('keptAttachmentIds', () => {
  it('an interactive turn keeps every hit (the RPC fenced them)', async () => {
    const { supabase } = client()
    expect(await keptAttachmentIds(supabase, WS, ALL, { userId: ANA, omitPrivateCaptures: false, omitGrants: false })).toBeNull()
  })

  it('an unattended run keeps only what every member reads: no private capture’s file, no row’s file', async () => {
    const { supabase, rpc } = client()
    const kept = await keptAttachmentIds(supabase, WS, ALL, { userId: ANA, omitPrivateCaptures: true, omitGrants: false })
    expect(sorted([...kept!])).toEqual(EVERY_MEMBERS)
    // No table rule is asked for no one.
    expect(rpc.mock.calls.filter((c) => c[0] === 'visible_data_table_ids')).toHaveLength(0)
  })

  it('a guest’s turn drops what only a grant opens, a capture’s or a table’s', async () => {
    const { supabase, rpc } = client()
    const kept = await keptAttachmentIds(supabase, WS, ALL, { userId: ANA, omitPrivateCaptures: false, omitGrants: true })
    expect(sorted([...kept!])).toEqual(WITHOUT_GRANTS)
    expect(rpc.mock.calls.find((c) => c[0] === 'visible_data_table_ids')?.[1]).toMatchObject({ p_user_id: ANA, p_grants: false })
  })
})

describe('find’s attachment stream', () => {
  it('interactive: what hybrid_search_attachments returned', async () => {
    expect(await findIds({})).toEqual(sorted(ALL))
  })
  it('unattended: only every member’s files', async () => {
    expect(await findIds({ omitPrivateCaptures: true })).toEqual(EVERY_MEMBERS)
  })
  it('a guest’s turn: no grant-only file', async () => {
    expect(await findIds({ omitGrants: true })).toEqual(WITHOUT_GRANTS)
  })
})

describe('deep_search’s attachments', () => {
  it('interactive: what attachment_rag_search returned', async () => {
    expect(await deepIds({})).toEqual(sorted(ALL))
  })
  it('unattended: the creator’s own private capture and table files are dropped', async () => {
    expect(await deepIds({ omitPrivateCaptures: true })).toEqual(EVERY_MEMBERS)
  })
  it('a guest’s turn: no grant-only file', async () => {
    expect(await deepIds({ omitGrants: true })).toEqual(WITHOUT_GRANTS)
  })
})
