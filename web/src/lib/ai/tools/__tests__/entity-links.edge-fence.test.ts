/**
 * Migration 500: an edge is readable only when both its ends are. The agent's
 * graph tools run on a SERVICE-ROLE client, where RLS hides no edge, so they
 * ask entity_refs_hidden (the policy's own SQL rule) about every end of a
 * fenced kind: someone else's private document or capture, a contact hidden
 * from the person. A hidden end is never listed, not even by id, and its
 * edges are not theirs to remove. (traverse and get_context_bundle: the
 * contact and company label tests, claims.*-labels.test.ts.) Fixtures are
 * made up.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { memoryDb } from '@/test/memory-db'
import { createEntityLinkTools } from '../entity-links'

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

const WS = 'aaaaaaaa-0000-4000-8000-000000000001'
const ANA = 'uuuuuuuu-0000-4000-8000-00000000000a'
const BEN = 'uuuuuuuu-0000-4000-8000-00000000000b'
const EXEC = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>

/** Ben's private document and a contact only Ben sees: hidden from Ana, by the SQL rule (stubbed). */
const HIDDEN_FROM: Record<string, string[]> = {
  [ANA]: ['document:doc-ben-private', 'contact:ct-ben'],
  [BEN]: [],
}

function client() {
  const t: Record<string, Row[]> = {
    member: [
      { id: 'm-ana', user_id: ANA, workspace_id: WS, display_name: 'Ana Ruiz' },
      { id: 'm-ben', user_id: BEN, workspace_id: WS, display_name: 'Ben Okafor' },
    ],
    deal: [{ id: 'deal-1', workspace_id: WS, name: 'Fernhill renewal' }],
    document: [
      { id: 'doc-ben-private', workspace_id: WS, title: 'Ben notes', visibility: 'private' },
      { id: 'doc-open', workspace_id: WS, title: 'Pricing', visibility: 'workspace' },
    ],
    contact: [{ id: 'ct-ben', workspace_id: WS, full_name: 'Rae Hidden' }],
    entity_link: [
      { id: 'e1', workspace_id: WS, source_type: 'document', source_id: 'doc-ben-private', target_type: 'deal', target_id: 'deal-1', relation: 'mentions', created_at: '2026-11-09T10:00:00Z' },
      { id: 'e2', workspace_id: WS, source_type: 'document', source_id: 'doc-open', target_type: 'deal', target_id: 'deal-1', relation: 'mentions', created_at: '2026-11-09T11:00:00Z' },
      { id: 'e3', workspace_id: WS, source_type: 'deal', source_id: 'deal-1', target_type: 'contact', target_id: 'ct-ben', relation: 'related_to', created_at: '2026-11-09T12:00:00Z' },
    ],
  }
  const db = memoryDb(t)
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn !== 'entity_refs_hidden') return { data: null, error: { message: `unexpected rpc ${fn}` } }
    const hidden = HIDDEN_FROM[args.p_user as string] ?? []
    const types = args.p_types as string[]
    const ids = args.p_ids as string[]
    return {
      data: types.map((type, i) => ({ entity_type: type, entity_id: ids[i] })).filter((r) => hidden.includes(`${r.entity_type}:${r.entity_id}`)),
      error: null,
    }
  })
  return { supabase: Object.assign(db, { rpc }) as never, rpc, t }
}

type Listed = { success: boolean; inbound: Array<{ source_id: string }>; outbound: Array<{ target_id: string }>; total: number }

describe('list_entity_links — an edge follows both its ends', () => {
  it("leaves out Ben's private document and the contact hidden from Ana, ids and all; Ben sees them", async () => {
    const { supabase, rpc } = client()
    const ana = (await createEntityLinkTools(ANA, supabase, WS).list_entity_links.execute!(
      { entity_type: 'deal', entity_id: 'deal-1', direction: 'both' } as never,
      EXEC,
    )) as Listed
    expect(ana.inbound.map((e) => e.source_id)).toEqual(['doc-open'])
    expect(ana.outbound).toEqual([])
    expect(JSON.stringify(ana)).not.toContain('doc-ben-private')
    expect(JSON.stringify(ana)).not.toContain('ct-ben')
    // One batched question, as the person, in the workspace.
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_user: ANA, p_workspace: WS })

    const ben = (await createEntityLinkTools(BEN, client().supabase, WS).list_entity_links.execute!(
      { entity_type: 'deal', entity_id: 'deal-1', direction: 'both' } as never,
      EXEC,
    )) as Listed
    expect(ben.inbound.map((e) => e.source_id).sort()).toEqual(['doc-ben-private', 'doc-open'])
    expect(ben.outbound.map((e) => e.target_id)).toEqual(['ct-ben'])
  })

  it('a hidden centre lists nothing', async () => {
    const { supabase } = client()
    const ana = (await createEntityLinkTools(ANA, supabase, WS).list_entity_links.execute!(
      { entity_type: 'document', entity_id: 'doc-ben-private', direction: 'both' } as never,
      EXEC,
    )) as Listed
    expect(ana.total).toBe(0)
  })

  it('an unattended run asks for no one in particular (null user)', async () => {
    const { supabase, rpc } = client()
    await createEntityLinkTools(BEN, supabase, WS, false, true).list_entity_links.execute!(
      { entity_type: 'deal', entity_id: 'deal-1', direction: 'both' } as never,
      EXEC,
    )
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_user: null })
  })
})

describe('unlink_entities — an edge follows both its ends', () => {
  it("refuses Ana an edge of Ben's private document, and leaves it in place", async () => {
    const { supabase, t } = client()
    const res = (await createEntityLinkTools(ANA, supabase, WS).unlink_entities.execute!(
      { source_type: 'document', source_id: 'doc-ben-private', target_type: 'deal', target_id: 'deal-1' } as never,
      EXEC,
    )) as { success: boolean; error?: string }
    expect(res).toMatchObject({ success: false, error: 'Entity not found' })
    expect(t.entity_link.some((e) => e.id === 'e1')).toBe(true)
  })
})
