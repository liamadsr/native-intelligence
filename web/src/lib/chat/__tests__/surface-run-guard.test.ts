/**
 * chatRunBinding / chatRunBindingRefusal — the DB binding fence every internal
 * chat route applies to chat-run tokens (2026-10-31 security review, P0-1): the
 * token's conversation row must exist with exactly the token's (user_id,
 * workspace_id), and the user must still be a member of that workspace. A
 * forged token (minted by a compromised secret-holder) therefore needs a real,
 * live conversation uuid of its victim, not just the secret. A device_ask
 * token's conversation row doubles as its ephemeral ownership row, so its
 * binding failure keeps the old fatal code (403 SURFACE_RUN_ENDED); any other
 * token's is 403 RUN_TOKEN_UNBOUND. A lookup ERROR is 'unknown' (503
 * SURFACE_RUN_UNVERIFIED — still refused, but soft).
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    throw new Error('the default service client must not be reached in these tests')
  },
}))

import {
  chatRunBinding,
  chatRunBindingRefusal,
  RUN_TOKEN_UNBOUND,
  SURFACE_RUN_ENDED,
  SURFACE_RUN_UNVERIFIED,
} from '../surface-run-guard'
import type { ChatRunTokenClaims } from '../chat-run-token'

const base: ChatRunTokenClaims = { conversationId: 'conv-1', workspaceId: 'ws-1', userId: 'user-1', exp: Date.now() + 60_000 }
const device = { ...base, surface: 'device_ask' as const }

const CONV_ROW = { id: 'conv-1', user_id: 'user-1', workspace_id: 'ws-1' }
const MEMBER_ROW = { id: 'member-1' }

type TableResult = { data: unknown; error: unknown } | 'throw'

/** A fake service client answering per table, recording each table's eq filters. */
function client(results: Record<string, TableResult>) {
  const eqs: Record<string, Array<[string, unknown]>> = {}
  const tables: string[] = []
  const supabase = {
    from: (t: string) => {
      tables.push(t)
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
  return { supabase, eqs, tables }
}

const bound = () => client({ chat_conversations: { data: CONV_ROW, error: null }, member: { data: MEMBER_ROW, error: null } })

describe('chatRunBinding', () => {
  it('bound: the conversation row matches the claims and the member row exists — both probed by the right keys', async () => {
    const { supabase, eqs, tables } = bound()
    expect(await chatRunBinding(base, supabase)).toBe('bound')
    expect(tables.sort()).toEqual(['chat_conversations', 'member'])
    expect(eqs.chat_conversations).toEqual([['id', 'conv-1']])
    expect(eqs.member).toEqual([
      ['user_id', 'user-1'],
      ['workspace_id', 'ws-1'],
    ])
  })

  it('unbound: no conversation row', async () => {
    const { supabase } = client({ chat_conversations: { data: null, error: null }, member: { data: MEMBER_ROW, error: null } })
    expect(await chatRunBinding(base, supabase)).toBe('unbound')
  })

  it("unbound: the row is another user's or another workspace's — forged tenancy never binds", async () => {
    for (const row of [
      { ...CONV_ROW, user_id: 'user-2' },
      { ...CONV_ROW, workspace_id: 'ws-2' },
      { ...CONV_ROW, user_id: null },
      { ...CONV_ROW, workspace_id: null },
    ]) {
      const { supabase } = client({ chat_conversations: { data: row, error: null }, member: { data: MEMBER_ROW, error: null } })
      expect(await chatRunBinding(base, supabase)).toBe('unbound')
    }
  })

  it('unbound: the user is no longer a member of the workspace', async () => {
    const { supabase } = client({ chat_conversations: { data: CONV_ROW, error: null }, member: { data: null, error: null } })
    expect(await chatRunBinding(base, supabase)).toBe('unbound')
  })

  it('a lookup error or a throw on either read is UNKNOWN — never mistaken for unbound', async () => {
    const cases = [
      client({ chat_conversations: { data: null, error: { message: 'boom' } }, member: { data: MEMBER_ROW, error: null } }),
      client({ chat_conversations: { data: CONV_ROW, error: null }, member: { data: null, error: { message: 'boom' } } }),
      client({ chat_conversations: 'throw', member: { data: MEMBER_ROW, error: null } }),
    ]
    for (const c of cases) {
      expect(await chatRunBinding(base, c.supabase)).toBe('unknown')
    }
  })
})

describe('chatRunBindingRefusal — what the internal routes answer', () => {
  it('null (proceed) for a bound token, device_ask included', async () => {
    expect(await chatRunBindingRefusal(base, bound().supabase)).toBeNull()
    expect(await chatRunBindingRefusal(device, bound().supabase)).toBeNull()
  })

  it('an unbound ordinary token: 403 RUN_TOKEN_UNBOUND', async () => {
    const { supabase } = client({ chat_conversations: { data: null, error: null }, member: { data: MEMBER_ROW, error: null } })
    const res = await chatRunBindingRefusal(base, supabase)
    expect(res?.status).toBe(403)
    expect(await res?.json()).toMatchObject({ code: RUN_TOKEN_UNBOUND })
  })

  it('a device_ask token whose ownership row is gone: 403 SURFACE_RUN_ENDED (the usage gate makes it fatal)', async () => {
    const { supabase } = client({ chat_conversations: { data: null, error: null }, member: { data: MEMBER_ROW, error: null } })
    const res = await chatRunBindingRefusal(device, supabase)
    expect(res?.status).toBe(403)
    expect(await res?.json()).toMatchObject({ code: SURFACE_RUN_ENDED })
  })

  it('a DB blip: still refused (fail closed for this call) but as a transient 503 SURFACE_RUN_UNVERIFIED, never a fatal 403', async () => {
    for (const c of [
      client({ chat_conversations: { data: CONV_ROW, error: { message: 'timeout' } }, member: { data: MEMBER_ROW, error: null } }),
      client({ chat_conversations: 'throw', member: 'throw' }),
    ]) {
      const res = await chatRunBindingRefusal(device, c.supabase)
      expect(res?.status).toBe(503)
      const body = await res?.json()
      expect(body).toMatchObject({ code: SURFACE_RUN_UNVERIFIED })
    }
  })
})
