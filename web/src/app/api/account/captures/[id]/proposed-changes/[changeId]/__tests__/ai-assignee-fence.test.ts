/**
 * PATCH /api/account/captures/[id]/proposed-changes/[changeId] — editing a
 * proposal's agent assignee is fenced to the workspace (Sequence step 1): the
 * id rides in `extra`, so no FK ever checked it, and the apply engine would
 * later have written whatever was staged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { FOREIGN_AI_MEMBER_ERROR } from '@/lib/workspace-fences'

const hoisted = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  teammates: ['ai-here'] as string[],
  existing: { status: 'pending', change_type: 'create', entity_type: 'action', result_entity_id: null, extra: { note: 1 } } as Record<string, unknown>,
}))

vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: (table: string) => {
      const eqs: Record<string, unknown> = {}
      let payload: Record<string, unknown> | null = null
      const b: Record<string, unknown> = {}
      Object.assign(b, {
        select: () => b,
        eq: (col: string, val: unknown) => ((eqs[col] = val), b),
        update: (p: Record<string, unknown>) => ((payload = p), b),
        single: async () => {
          if (table === 'proposed_change') {
            if (payload) {
              hoisted.updates.push(payload)
              return { data: { id: 'pc-1', ...payload }, error: null }
            }
            return { data: hoisted.existing, error: null }
          }
          return { data: null, error: null }
        },
        maybeSingle: async () => {
          if (table === 'ai_team_member' && eqs.workspace_id === 'ws-1' && hoisted.teammates.includes(eqs.id as string)) {
            return { data: { id: eqs.id }, error: null }
          }
          return { data: null, error: null }
        },
      })
      return b
    },
  }),
}))

const { PATCH } = await import('../route')
const params = Promise.resolve({ id: 'cap-1', changeId: 'pc-1' })
const req = (body: unknown) => buildRequest({ body }) as unknown as NextRequest

beforeEach(() => {
  hoisted.updates.length = 0
  hoisted.existing = { status: 'pending', change_type: 'create', entity_type: 'action', result_entity_id: null, extra: { note: 1 } }
})

describe('PATCH proposed change — assignee_ai_member_id fence', () => {
  it('a foreign teammate is a 400 and the proposal is not touched', async () => {
    const res = await PATCH(req({ assignee_ai_member_id: 'ai-foreign' }), { params })
    expect(res.status).toBe(400)
    expect(await readJson<{ error: string }>(res)).toEqual({ error: FOREIGN_AI_MEMBER_ERROR })
    expect(hoisted.updates).toEqual([])
  })

  it('an in-workspace teammate is staged in extra as the delegate, keeping the member (decision 9)', async () => {
    hoisted.existing = { ...hoisted.existing, assignee_member_id: 'mem-1', assignee_contact_id: null }
    const res = await PATCH(req({ assignee_ai_member_id: 'ai-here' }), { params })
    expect(res.status).toBe(200)
    expect(hoisted.updates).toEqual([{ extra: { note: 1, assignee_ai_member_id: 'ai-here' } }])
  })

  it('an external contact gives way to the agent', async () => {
    hoisted.existing = { ...hoisted.existing, assignee_member_id: null, assignee_contact_id: 'contact-1' }
    const res = await PATCH(req({ assignee_ai_member_id: 'ai-here' }), { params })
    expect(res.status).toBe(200)
    expect(hoisted.updates).toEqual([
      { extra: { note: 1, assignee_ai_member_id: 'ai-here' }, assignee_contact_id: null, assignee_name: null },
    ])
  })

  it('clearing the teammate needs no fence', async () => {
    const res = await PATCH(req({ assignee_ai_member_id: null }), { params })
    expect(res.status).toBe(200)
    expect(hoisted.updates[0]).toEqual({ extra: { note: 1, assignee_ai_member_id: null } })
  })
})
