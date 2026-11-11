/**
 * hiddenGraphRefs: migration 500's edge rule for the service-role graph
 * readers. The non-private fenced kinds go to ONE entity_refs_hidden call
 * (the SQL rule the entity_link SELECT policy uses); the private graph kinds
 * through this file's own fences; open kinds never. Every failure fails
 * closed. Fixtures are made up.
 */
import { describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { hiddenGraphRefs, isLinkFencedKind } from '../entity-fences'

const WS = 'aaaaaaaa-0000-4000-8000-000000000001'
const ANA = 'uuuuuuuu-0000-4000-8000-00000000000a'
const DOC_PRIVATE = 'dddddddd-0000-4000-8000-000000000001'
const DOC_OPEN = 'dddddddd-0000-4000-8000-000000000002'
const CO = 'cccccccc-0000-4000-8000-000000000001'
const PROJECT = 'pppppppp-0000-4000-8000-000000000001'

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>

function client(rpc: Rpc) {
  const spy = vi.fn(rpc)
  return { supabase: { rpc: spy, from: vi.fn() } as never, rpc: spy }
}

describe('hiddenGraphRefs', () => {
  it('asks entity_refs_hidden once for the fenced kinds, never for an open kind', async () => {
    const { supabase, rpc } = client(async () => ({ data: [{ entity_type: 'document', entity_id: DOC_PRIVATE }], error: null }))
    const hidden = await hiddenGraphRefs(
      supabase,
      [
        { type: 'document', id: DOC_PRIVATE },
        { type: 'document', id: DOC_OPEN },
        { type: 'company', id: CO },
        { type: 'project', id: PROJECT },
      ],
      ANA,
      WS,
    )
    expect([...hidden]).toEqual([`document:${DOC_PRIVATE}`])
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('entity_refs_hidden', {
      p_user: ANA,
      p_workspace: WS,
      p_types: ['document', 'document', 'company'],
      p_ids: [DOC_PRIVATE, DOC_OPEN, CO],
    })
  })

  it('makes no call when only open kinds are asked about', async () => {
    const { supabase, rpc } = client(async () => ({ data: [], error: null }))
    expect(await hiddenGraphRefs(supabase, [{ type: 'project', id: PROJECT }, { type: 'deal', id: PROJECT }], ANA, WS)).toEqual(new Set())
    expect(rpc).not.toHaveBeenCalled()
  })

  it('passes no user through as null (an unattended run: only what every member reads)', async () => {
    const { supabase, rpc } = client(async () => ({ data: [], error: null }))
    await hiddenGraphRefs(supabase, [{ type: 'capture', id: DOC_OPEN }], null)
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_user: null, p_workspace: null })
  })

  it('matches ids whatever their case (Postgres answers in lower case), keeping the caller keys', async () => {
    const upper = DOC_PRIVATE.toUpperCase()
    const { supabase } = client(async () => ({ data: [{ entity_type: 'document', entity_id: DOC_PRIVATE }], error: null }))
    expect([...(await hiddenGraphRefs(supabase, [{ type: 'document', id: upper }], ANA, WS))]).toEqual([`document:${upper}`])
  })

  it.each([
    ['an error', async () => ({ data: null, error: { message: 'down' } })],
    ['a throw', async () => { throw new Error('network') }],
    ['a malformed answer', async () => ({ data: { nope: true }, error: null })],
  ] as Array<[string, Rpc]>)('fails closed on %s: every fenced ref it asked about is hidden', async (_label, rpc) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { supabase } = client(rpc)
    const hidden = await hiddenGraphRefs(
      supabase,
      [{ type: 'document', id: DOC_OPEN }, { type: 'claim', id: DOC_PRIVATE }, { type: 'project', id: PROJECT }],
      ANA,
      WS,
    )
    expect(hidden).toEqual(new Set([`document:${DOC_OPEN}`, `claim:${DOC_PRIVATE}`]))
  })

  it("routes the private graph kinds through this file's fences: someone else's calendar event is hidden", async () => {
    const db = memoryDb({
      member: [{ id: 'm-ana', user_id: ANA, workspace_id: WS, display_name: 'Ana Ruiz' }],
      local_calendar_event: [
        { id: 'ev-ana', user_id: ANA, workspace_id: WS, title: 'Ana sync' },
        { id: 'ev-ben', user_id: 'someone-else', workspace_id: WS, title: 'Ben dentist' },
      ],
    })
    const rpc = vi.fn(async () => ({ data: [], error: null }))
    const supabase = Object.assign(db, { rpc }) as never
    const hidden = await hiddenGraphRefs(
      supabase,
      [{ type: 'calendar_event', id: 'ev-ana' }, { type: 'calendar_event', id: 'ev-ben' }],
      ANA,
      WS,
    )
    expect([...hidden]).toEqual(['calendar_event:ev-ben'])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('knows which kinds are fenced', () => {
    expect(isLinkFencedKind('document')).toBe(true)
    expect(isLinkFencedKind('team_chat_message')).toBe(true)
    expect(isLinkFencedKind('project')).toBe(false)
  })
})
