/**
 * "Make a task from this": the record a task is about is checked like a
 * mention (in this workspace, readable by the person) and linked 'about'.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const visible = vi.hoisted(() => ({ refs: [] as Array<{ type: string; id: string }>, scope: null as unknown }))
vi.mock('@/lib/entity-links/mentions', () => ({
  visibleMentionTargets: vi.fn(async (_s: unknown, scope: unknown, refs: Array<{ type: string; id: string }>) => {
    visible.scope = scope
    return refs.filter((r) => visible.refs.some((v) => v.type === r.type && v.id === r.id))
  }),
}))

import { canMakeTaskAbout, linkTaskAbout, parseTaskAbout } from '../task-about'

const DOC_ID = '0f8fad5b-d9cb-469f-a165-70867728950e'

beforeEach(() => {
  visible.refs = []
  visible.scope = null
})

describe('parseTaskAbout', () => {
  it('reads a record a task can be about', () => {
    expect(parseTaskAbout(undefined)).toBeNull()
    expect(parseTaskAbout({ type: 'document', id: DOC_ID.toUpperCase() })).toEqual({ type: 'document', id: DOC_ID })
    expect(parseTaskAbout({ type: 'team_chat_message', id: DOC_ID })).toEqual({ type: 'team_chat_message', id: DOC_ID })
  })

  it('refuses a kind no task is made from, a non-uuid, or junk', () => {
    expect(parseTaskAbout({ type: 'action', id: DOC_ID })).toBe('invalid')
    expect(parseTaskAbout({ type: 'claim', id: DOC_ID })).toBe('invalid')
    expect(parseTaskAbout({ type: 'document', id: 'doc-1' })).toBe('invalid')
    expect(parseTaskAbout('document')).toBe('invalid')
  })
})

describe('canMakeTaskAbout', () => {
  it("is the mention fence, for the person in this workspace", async () => {
    const supabase = {} as SupabaseClient
    expect(await canMakeTaskAbout(supabase, { workspaceId: 'ws-1', userId: 'u-1' }, { type: 'document', id: DOC_ID })).toBe(false)
    expect(visible.scope).toEqual({ workspaceId: 'ws-1', userId: 'u-1' })
    visible.refs = [{ type: 'document', id: DOC_ID }]
    expect(await canMakeTaskAbout(supabase, { workspaceId: 'ws-1', userId: 'u-1' }, { type: 'document', id: DOC_ID })).toBe(true)
  })
})

describe('linkTaskAbout', () => {
  it("writes one action → record edge, relation 'about'", async () => {
    const upsert = vi.fn(async () => ({ error: null }))
    const supabase = { from: vi.fn(() => ({ upsert })) } as unknown as SupabaseClient
    expect(await linkTaskAbout(supabase, { workspaceId: 'ws-1', actionId: 'a-1', ref: { type: 'document', id: DOC_ID }, memberId: 'm-1' })).toBe(true)
    expect(supabase.from).toHaveBeenCalledWith('entity_link')
    expect(upsert).toHaveBeenCalledWith(
      {
        workspace_id: 'ws-1',
        source_type: 'action',
        source_id: 'a-1',
        target_type: 'document',
        target_id: DOC_ID,
        relation: 'about',
        created_by: 'm-1',
      },
      expect.objectContaining({ ignoreDuplicates: true }),
    )
  })

  it('says so when the edge was not written', async () => {
    const supabase = { from: () => ({ upsert: async () => ({ error: { message: 'denied' } }) }) } as unknown as SupabaseClient
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await linkTaskAbout(supabase, { workspaceId: 'ws-1', actionId: 'a-1', ref: { type: 'document', id: DOC_ID }, memberId: null })).toBe(false)
    warn.mockRestore()
  })
})
