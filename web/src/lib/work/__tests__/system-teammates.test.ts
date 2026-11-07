import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  emailPassTeammateId,
  flowSkillIds,
  flowTeammateKey,
  systemKeyForFlow,
  systemTeammateId,
  SYSTEM_TEAMMATE_BLURBS,
  SYSTEM_TEAMMATE_KEYS,
} from '../system-teammates'
import { makeFakeSupabase } from './fake-supabase'
import { migrationsInOrder } from '@/test/migration-sql'

/** A `recipe` table read the way flowTeammateKey issues it (in / eq / or, awaited as a list). */
function recipeClient(opts: {
  recipes?: Array<{ id: string; workspace_id: string | null; is_system?: boolean; category?: string; agent_config: unknown }>
  error?: string
}) {
  const reads: Array<{ table: string; ids: string[]; or: string | null }> = []
  const client = {
    from(table: string) {
      let ids: string[] = []
      let category: string | null = null
      let or: string | null = null
      const chain: Record<string, unknown> = {
        select: () => chain,
        in: (_col: string, vals: string[]) => {
          ids = vals
          return chain
        },
        eq: (col: string, val: string) => {
          if (col === 'category') category = val
          return chain
        },
        or: (filter: string) => {
          or = filter
          return chain
        },
        then: (resolve: (v: unknown) => unknown) => {
          reads.push({ table, ids, or })
          if (opts.error) return Promise.resolve({ data: null, error: { message: opts.error } }).then(resolve)
          const ws = /workspace_id\.eq\.([^,]+)/.exec(or ?? '')?.[1]
          const data = (opts.recipes ?? []).filter(
            (r) =>
              ids.includes(r.id) &&
              (r.category ?? 'skill') === category &&
              (r.workspace_id === ws || r.is_system === true),
          )
          return Promise.resolve({ data, error: null }).then(resolve)
        },
      }
      return chain
    },
  }
  return { client: client as unknown as SupabaseClient, reads }
}

function skillAction(skillId: string, over: Record<string, unknown> = {}) {
  return { type: 'run_skill', enabled: true, config: { skill_id: skillId, mode: 'act' }, ...over }
}

describe('flowTeammateKey (bots v3 1a: a verdict loop with no bot is Captures’ (Triage’s until 318))', () => {
  const recipes = [
    { id: 'skill-verdict', workspace_id: 'ws-1', agent_config: { output_contract: 'verdict' } },
    { id: 'skill-prose', workspace_id: 'ws-1', agent_config: { output_contract: 'prose' } },
    { id: 'skill-legacy', workspace_id: 'ws-1', agent_config: null },
    { id: 'skill-other-ws', workspace_id: 'ws-2', agent_config: { output_contract: 'verdict' } },
    { id: 'skill-system', workspace_id: null, is_system: true, agent_config: { output_contract: 'verdict' } },
  ]

  it('gives Captures to a user-built loop running a verdict skill', async () => {
    const { client, reads } = recipeClient({ recipes })
    expect(await flowTeammateKey(client, 'ws-1', { seed_key: null, actions: [skillAction('skill-verdict')] })).toBe('captures')
    expect(reads).toEqual([{ table: 'recipe', ids: ['skill-verdict'], or: 'workspace_id.eq.ws-1,is_system.eq.true' }])
  })

  it('gives Captures to a loop running a system verdict skill', async () => {
    const { client } = recipeClient({ recipes })
    expect(await flowTeammateKey(client, 'ws-1', { actions: [skillAction('skill-system')] })).toBe('captures')
  })

  it('gives null to a prose loop and to a legacy skill with no contract', async () => {
    const { client } = recipeClient({ recipes })
    expect(await flowTeammateKey(client, 'ws-1', { actions: [skillAction('skill-prose')] })).toBeNull()
    expect(await flowTeammateKey(client, 'ws-1', { actions: [skillAction('skill-legacy')] })).toBeNull()
  })

  it('gives Captures when any one of several skills is a verdict', async () => {
    const { client } = recipeClient({ recipes })
    expect(
      await flowTeammateKey(client, 'ws-1', { actions: [skillAction('skill-prose'), skillAction('skill-verdict')] }),
    ).toBe('captures')
  })

  it('never reads another workspace’s skill as this loop’s', async () => {
    const { client } = recipeClient({ recipes })
    expect(await flowTeammateKey(client, 'ws-1', { actions: [skillAction('skill-other-ws')] })).toBeNull()
  })

  it('lets seed_key win, with no skill read', async () => {
    const { client, reads } = recipeClient({ recipes })
    expect(await flowTeammateKey(client, 'ws-1', { seed_key: 'seed:reconcile', actions: [skillAction('skill-verdict')] })).toBe(
      'captures',
    )
    expect(await flowTeammateKey(client, 'ws-1', { seed_key: 'seed:triage', actions: [] })).toBe('captures')
    expect(reads).toEqual([])
  })

  it('skips the read for a loop with no enabled run_skill action', async () => {
    const { client, reads } = recipeClient({ recipes })
    expect(
      await flowTeammateKey(client, 'ws-1', {
        actions: [skillAction('skill-verdict', { enabled: false }), { type: 'http_post', config: {} }],
      }),
    ).toBeNull()
    expect(await flowTeammateKey(client, 'ws-1', {})).toBeNull()
    expect(reads).toEqual([])
  })

  it('is fail-soft: a failed read gives null and a log line, never an error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client } = recipeClient({ error: 'boom' })
    expect(await flowTeammateKey(client, 'ws-1', { actions: [skillAction('skill-verdict')] })).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0].join(' ')).toContain('boom')
    warn.mockRestore()
  })

  it('flowSkillIds lists each enabled skill once', () => {
    expect(
      flowSkillIds([
        skillAction('a'),
        skillAction('a'),
        skillAction('b', { enabled: false }),
        skillAction('c', { enabled: undefined }),
        { type: 'run_agent', config: { skill_id: 'd' } },
        { type: 'run_skill', config: null },
      ]),
    ).toEqual(['a', 'c'])
    expect(flowSkillIds(null)).toEqual([])
  })
})

/** A client with one `ai_team_member` table keyed by (workspace_id, system_key)
 *  and the seed RPC, recording every call. */
function fakeClient(opts: {
  rows?: Array<{ id: string; workspace_id: string; system_key: string }>
  seedRows?: Array<{ id: string; workspace_id: string; system_key: string }>
  readError?: string
  rpcError?: string
}) {
  const rows = [...(opts.rows ?? [])]
  const calls: string[] = []
  const client = {
    from(table: string) {
      const filters: Record<string, string> = {}
      const chain = {
        select() {
          return chain
        },
        eq(col: string, val: string) {
          filters[col] = val
          return chain
        },
        async maybeSingle() {
          calls.push(`read:${table}:${filters.workspace_id}:${filters.system_key}`)
          if (opts.readError) return { data: null, error: { message: opts.readError } }
          const hit = rows.find((r) => r.workspace_id === filters.workspace_id && r.system_key === filters.system_key)
          return { data: hit ? { id: hit.id } : null, error: null }
        },
      }
      return chain
    },
    async rpc(fn: string, args: { p_workspace_id: string }) {
      calls.push(`rpc:${fn}:${args.p_workspace_id}`)
      if (opts.rpcError) return { data: null, error: { message: opts.rpcError } }
      rows.push(...(opts.seedRows ?? []).filter((r) => r.workspace_id === args.p_workspace_id))
      return { data: (opts.seedRows ?? []).length, error: null }
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}

describe('systemKeyForFlow', () => {
  it('maps the seeded Triage and Commitment reconciler loops to Captures (migration 318), and nothing else', () => {
    expect(systemKeyForFlow({ seed_key: 'seed:triage' })).toBe('captures')
    expect(systemKeyForFlow({ seed_key: 'seed:reconcile' })).toBe('captures')
    // Groom and Brief are the user's own report loops; a user-built flow has no seed key.
    expect(systemKeyForFlow({ seed_key: 'seed:groom' })).toBeNull()
    expect(systemKeyForFlow({ seed_key: 'seed:brief' })).toBeNull()
    expect(systemKeyForFlow({ seed_key: null })).toBeNull()
    expect(systemKeyForFlow({})).toBeNull()
  })

  it('names exactly the keys the newest system-key CHECK admits: 318’s area faces and the Assistant', () => {
    expect([...SYSTEM_TEAMMATE_KEYS]).toEqual(['captures', 'mail', 'prospecting', 'evals', 'crm', 'assistant'])
    const newest = [...migrationsInOrder()].reverse().find((m) => /add constraint ai_team_member_system_key_check/i.test(m.sql))!
    const list = /add constraint ai_team_member_system_key_check[\s\S]*?system_key in \(([^)]*)\)/i.exec(newest.sql)?.[1] ?? ''
    expect(list.split(',').map((k) => k.trim().replace(/'/g, ''))).toEqual([...SYSTEM_TEAMMATE_KEYS])
    expect(newest.file).toBe('318_area_faces.sql')
  })

  it('gives every key its roster blurb', () => {
    expect(Object.keys(SYSTEM_TEAMMATE_BLURBS).sort()).toEqual([...SYSTEM_TEAMMATE_KEYS].sort())
    expect(SYSTEM_TEAMMATE_BLURBS.assistant).toBe('Brings you the AI work that belongs to no area')
    expect(SYSTEM_TEAMMATE_BLURBS.captures).toContain('capture')
  })
})

describe('systemTeammateId', () => {
  it('returns the seeded teammate with one read and no seed call', async () => {
    const { client, calls } = fakeClient({
      rows: [
        { id: 'tm-triage', workspace_id: 'ws-1', system_key: 'captures' },
        { id: 'tm-other-ws', workspace_id: 'ws-2', system_key: 'mail' },
      ],
    })
    expect(await systemTeammateId(client, 'ws-1', 'captures')).toBe('tm-triage')
    expect(calls).toEqual(['read:ai_team_member:ws-1:captures'])
  })

  it('never returns another workspace\'s teammate', async () => {
    const { client } = fakeClient({ rows: [{ id: 'tm-other-ws', workspace_id: 'ws-2', system_key: 'mail' }] })
    expect(await systemTeammateId(client, 'ws-1', 'mail')).toBeNull()
  })

  it('self-heals a workspace that lost its set: seeds once, then reads again', async () => {
    const { client, calls } = fakeClient({
      seedRows: [{ id: 'tm-new', workspace_id: 'ws-1', system_key: 'prospecting' }],
    })
    expect(await systemTeammateId(client, 'ws-1', 'prospecting')).toBe('tm-new')
    expect(calls).toEqual([
      'read:ai_team_member:ws-1:prospecting',
      'rpc:seed_system_teammates:ws-1',
      'read:ai_team_member:ws-1:prospecting',
    ])
  })

  it('returns null (never throws) when the seed cannot place one — a workspace with no team', async () => {
    const { client, calls } = fakeClient({ seedRows: [] })
    expect(await systemTeammateId(client, 'ws-1', 'captures')).toBeNull()
    expect(calls).toHaveLength(3)
  })

  it('is fail-soft on a read error and on a seed error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const readFails = fakeClient({ readError: 'boom' })
    expect(await systemTeammateId(readFails.client, 'ws-1', 'captures')).toBeNull()
    expect(readFails.calls).toEqual(['read:ai_team_member:ws-1:captures'])

    const seedFails = fakeClient({ rpcError: 'permission denied' })
    expect(await systemTeammateId(seedFails.client, 'ws-1', 'captures')).toBeNull()
    expect(seedFails.calls).toEqual(['read:ai_team_member:ws-1:captures', 'rpc:seed_system_teammates:ws-1'])
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})

describe('emailPassTeammateId', () => {
  // Email has one face: the Correspondent (the role's oldest holder) where the
  // workspace has one, else the Mail area face (Email drafts until 318). Attribution only.
  function teammate(id: string, over: Record<string, unknown> = {}) {
    return {
      id,
      workspace_id: 'ws-1',
      role: 'correspondent',
      is_system: false,
      system_key: null,
      autonomy: 'attempt',
      created_at: '2026-09-01T00:00:00.000Z',
      ...over,
    }
  }
  const emailDrafts = teammate('tm-email-drafts', {
    role: null,
    is_system: true,
    system_key: 'mail',
    autonomy: 'propose',
    created_at: '2026-01-01T00:00:00.000Z',
  })

  it("is the workspace's Correspondent when it has one", async () => {
    const fake = makeFakeSupabase()
    fake.seed('ai_team_member', [emailDrafts, teammate('correspondent'), teammate('elsewhere', { workspace_id: 'ws-2', created_at: '2026-08-01T00:00:00.000Z' })])
    expect(await emailPassTeammateId(fake as never, 'ws-1')).toBe('correspondent')
    // One read: the Email drafts teammate is never looked up (nor seeded).
    expect(fake.calls.filter((c) => c.table === 'ai_team_member')).toHaveLength(1)
    expect(fake.rpcCalls).toEqual([])
  })

  it('is the oldest of two Correspondents, even one switched off (autonomy does not gate the pass)', async () => {
    const fake = makeFakeSupabase()
    fake.seed('ai_team_member', [
      emailDrafts,
      teammate('newer', { created_at: '2026-09-02T00:00:00.000Z' }),
      teammate('oldest', { autonomy: 'off', created_at: '2026-09-01T00:00:00.000Z' }),
    ])
    expect(await emailPassTeammateId(fake as never, 'ws-1')).toBe('oldest')
  })

  it('is the Mail system teammate with no Correspondent; that system row (role null) never matches the role', async () => {
    const fake = makeFakeSupabase()
    fake.seed('ai_team_member', [emailDrafts, teammate('writer', { role: 'writer' })])
    expect(await emailPassTeammateId(fake as never, 'ws-1')).toBe('tm-email-drafts')
  })

  it('falls back to Mail on a failed Correspondent read and logs it; null when neither is there', async () => {
    /** The Correspondent read is awaited as a list (then); the system read ends in maybeSingle. */
    function client(systemRead: { data: unknown; error: { message: string } | null }) {
      return {
        from: () => {
          const chain: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = () => chain
          chain.then = (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve)
          chain.maybeSingle = async () => systemRead
          return chain
        },
        rpc: async () => ({ data: null, error: { message: 'down' } }),
      }
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await emailPassTeammateId(client({ data: { id: 'tm-email-drafts' }, error: null }) as never, 'ws-1')).toBe('tm-email-drafts')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0].join(' ')).toContain('correspondent lookup failed (ws-1)')
    expect(warn.mock.calls[0].join(' ')).toContain('boom')

    // Neither: the Correspondent read and the system read both fail.
    expect(await emailPassTeammateId(client({ data: null, error: { message: 'down' } }) as never, 'ws-1')).toBeNull()
    warn.mockRestore()
  })
})
