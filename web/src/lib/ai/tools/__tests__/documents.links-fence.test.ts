/**
 * get_document lists a document's backlinks and outbound links. It runs on a
 * SERVICE-ROLE client, where RLS hides no edge, so each far end of a fenced
 * kind is asked of entity_refs_hidden (migration 500: an edge is readable
 * only when both its ends are): someone else's private capture, a contact
 * hidden from the person, is left out, id and all. Fixtures are made up.
 */
import { describe, expect, it } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import { createDocumentTools } from '../documents'

const USER = 'user-1'
const WS = 'ws-1'
const DOC = '11111111-1111-4111-8111-111111111111'
const OPTS = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Result = { success: boolean; backlinks: Array<{ source_id: string }>; outbound_links: Array<{ target_id: string }> }

function run(hidden: Array<{ entity_type: string; entity_id: string }> | 'error', omitPrivate = false) {
  const fake = createFakeSupabase((q: FakeQuery): FakeResult => {
    if (q.op === 'rpc' && q.table === 'rpc:entity_refs_hidden') {
      return hidden === 'error' ? { data: null, error: { message: 'down' } } : { data: hidden, error: null }
    }
    if (q.table === 'member') return { data: { id: 'mem-1', workspace_id: WS }, error: null }
    if (q.table === 'document') {
      return { data: { id: DOC, workspace_id: WS, title: 'Plan', content: '# Plan', frontmatter: {}, tags: [], revision: 1, project: null, author: null }, error: null }
    }
    if (q.table === 'entity_link') {
      const inbound = q.filters.some(([m, col]) => m === 'eq' && col === 'target_type')
      return inbound
        ? {
            data: [
              { id: 'e1', source_type: 'capture', source_id: 'cap-private', relation: 'cites' },
              { id: 'e2', source_type: 'action', source_id: 'act-1', relation: 'related_to' },
            ],
            error: null,
          }
        : { data: [{ id: 'e3', target_type: 'contact', target_id: 'ct-hidden', relation: 'about' }], error: null }
    }
    return { data: null, error: null }
  })
  const res = createDocumentTools(USER, fake.client, WS, false, 'session', omitPrivate).get_document.execute!({ document_id: DOC } as never, OPTS) as unknown as Promise<Result>
  return { res, fake }
}

describe('get_document — links follow both ends', () => {
  it('leaves out a hidden capture and contact, ids and all; an open kind stays', async () => {
    const { res, fake } = run([
      { entity_type: 'capture', entity_id: 'cap-private' },
      { entity_type: 'contact', entity_id: 'ct-hidden' },
    ])
    const r = await res
    expect(r.backlinks.map((l) => l.source_id)).toEqual(['act-1'])
    expect(r.outbound_links).toEqual([])
    expect(JSON.stringify(r)).not.toContain('cap-private')
    const fence = fake.log.find((q) => q.op === 'rpc' && q.table === 'rpc:entity_refs_hidden')
    expect(fence?.payload).toMatchObject({ p_user: USER, p_workspace: WS, p_types: ['capture', 'contact'], p_ids: ['cap-private', 'ct-hidden'] })
  })

  it('fails closed: a failed fence hides every fenced end', async () => {
    const r = await run('error').res
    expect(r.backlinks.map((l) => l.source_id)).toEqual(['act-1'])
    expect(r.outbound_links).toEqual([])
  })

  it('an unattended run asks for no one in particular', async () => {
    const { res, fake } = run([])
    await res
    expect(fake.log.find((q) => q.table === 'rpc:entity_refs_hidden')?.payload).toMatchObject({ p_user: USER })
    const unattended = run([], true)
    await unattended.res
    expect(unattended.fake.log.find((q) => q.table === 'rpc:entity_refs_hidden')?.payload).toMatchObject({ p_user: null })
  })
})
