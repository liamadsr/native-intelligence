/**
 * skillRunBinding / skillRunBindingRefusal — the DB binding fence the internal
 * skill-run routes apply to run tokens (2026-10-31 security review, P0-1): the
 * run-as user must be a member of the workspace, the skill a real recipe of it
 * (or a system skill), and a carried workItemId / chat teammateId must name
 * rows of that workspace. A lookup error is 'unknown' (503, soft); a genuine
 * mismatch is 'unbound' (403 RUN_TOKEN_UNBOUND).
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    throw new Error('the default service client must not be reached in these tests')
  },
}))

import { skillRunBinding, skillRunBindingRefusal, RUN_TOKEN_UNBOUND, RUN_BINDING_UNVERIFIED } from '../skill-run-binding'
import type { RunTokenClaims } from '../skill-run-token'

const base: RunTokenClaims = {
  workspaceId: 'ws-1',
  runAsUserId: 'user-1',
  skillId: 'skill-1',
  mode: 'act',
  hasCapture: false,
  outputContract: 'prose',
  model: 'm',
  exp: Date.now() + 60_000,
}

const MEMBER = { data: { id: 'member-1' }, error: null }
const WS_SKILL = { data: { id: 'skill-1', workspace_id: 'ws-1', is_system: false }, error: null }
const SYSTEM_SKILL = { data: { id: 'skill-1', workspace_id: null, is_system: true }, error: null }
const NONE = { data: null, error: null }
const ERR = { data: null, error: { message: 'boom' } }

type TableResult = { data: unknown; error: unknown } | 'throw'

function client(results: Record<string, TableResult>) {
  const eqs: Record<string, Array<[string, unknown]>> = {}
  const supabase = {
    from: (t: string) => {
      eqs[t] = []
      const c: Record<string, unknown> = {
        select: () => c,
        eq: (col: string, v: unknown) => {
          eqs[t].push([col, v])
          return c
        },
        maybeSingle: async () => {
          const result = results[t]
          if (result === undefined) throw new Error(`unexpected table ${t}`)
          if (result === 'throw') throw new Error('network')
          return result
        },
      }
      return c
    },
  } as unknown as SupabaseClient
  return { supabase, eqs }
}

describe('skillRunBinding', () => {
  it('bound: member + workspace skill — probed by the right keys', async () => {
    const { supabase, eqs } = client({ member: MEMBER, recipe: WS_SKILL })
    expect(await skillRunBinding(base, supabase)).toBe('bound')
    expect(eqs.member).toEqual([
      ['user_id', 'user-1'],
      ['workspace_id', 'ws-1'],
    ])
    expect(eqs.recipe).toEqual([
      ['id', 'skill-1'],
      ['category', 'skill'],
    ])
  })

  it('bound: a system skill binds in any workspace', async () => {
    const { supabase } = client({ member: MEMBER, recipe: SYSTEM_SKILL })
    expect(await skillRunBinding(base, supabase)).toBe('bound')
  })

  it('unbound: not a member, no such skill, or a skill of another workspace', async () => {
    expect(await skillRunBinding(base, client({ member: NONE, recipe: WS_SKILL }).supabase)).toBe('unbound')
    expect(await skillRunBinding(base, client({ member: MEMBER, recipe: NONE }).supabase)).toBe('unbound')
    const foreign = { data: { id: 'skill-1', workspace_id: 'ws-2', is_system: false }, error: null }
    expect(await skillRunBinding(base, client({ member: MEMBER, recipe: foreign }).supabase)).toBe('unbound')
  })

  it('a workItemId must be a tracked_job of the workspace; a chat teammateId an ai_team_member of it', async () => {
    const withWork = { ...base, workItemId: 'work-1' }
    const { supabase, eqs } = client({ member: MEMBER, recipe: WS_SKILL, tracked_job: { data: { id: 'work-1' }, error: null } })
    expect(await skillRunBinding(withWork, supabase)).toBe('bound')
    expect(eqs.tracked_job).toEqual([
      ['id', 'work-1'],
      ['workspace_id', 'ws-1'],
    ])
    expect(await skillRunBinding(withWork, client({ member: MEMBER, recipe: WS_SKILL, tracked_job: NONE }).supabase)).toBe('unbound')

    const withChat = { ...base, chat: { teammateId: 'bot-1' } }
    expect(
      await skillRunBinding(withChat, client({ member: MEMBER, recipe: WS_SKILL, ai_team_member: { data: { id: 'bot-1' }, error: null } }).supabase),
    ).toBe('bound')
    expect(await skillRunBinding(withChat, client({ member: MEMBER, recipe: WS_SKILL, ai_team_member: NONE }).supabase)).toBe('unbound')
  })

  it('a lookup error or a throw on any read is UNKNOWN — never mistaken for unbound', async () => {
    expect(await skillRunBinding(base, client({ member: ERR, recipe: WS_SKILL }).supabase)).toBe('unknown')
    expect(await skillRunBinding(base, client({ member: MEMBER, recipe: 'throw' }).supabase)).toBe('unknown')
    expect(
      await skillRunBinding({ ...base, workItemId: 'work-1' }, client({ member: MEMBER, recipe: WS_SKILL, tracked_job: ERR }).supabase),
    ).toBe('unknown')
  })
})

describe('skillRunBindingRefusal', () => {
  it('null (proceed) when bound', async () => {
    expect(await skillRunBindingRefusal(base, client({ member: MEMBER, recipe: WS_SKILL }).supabase)).toBeNull()
  })

  it('403 RUN_TOKEN_UNBOUND on a genuine binding failure', async () => {
    const res = await skillRunBindingRefusal(base, client({ member: NONE, recipe: WS_SKILL }).supabase)
    expect(res?.status).toBe(403)
    expect(await res?.json()).toMatchObject({ code: RUN_TOKEN_UNBOUND })
  })

  it('503 RUN_BINDING_UNVERIFIED on a lookup failure (refused, but soft)', async () => {
    const res = await skillRunBindingRefusal(base, client({ member: ERR, recipe: WS_SKILL }).supabase)
    expect(res?.status).toBe(503)
    expect(await res?.json()).toMatchObject({ code: RUN_BINDING_UNVERIFIED })
  })
})
