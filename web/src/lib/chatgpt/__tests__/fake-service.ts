/**
 * An in-memory stand-in for the service-role Supabase client, just wide
 * enough for src/lib/chatgpt: the chatgpt_connection table (select / eq / or /
 * maybeSingle, update [+ select], upsert), the email-lookup RPC, and the
 * auth admin calls account.ts makes. Filters behave like PostgREST's, so a
 * conditional update really only matches the rows it should (the refresh
 * lease depends on that).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

type Row = Record<string, unknown>
type Filter = (row: Row) => boolean

export interface FakeService {
  client: SupabaseClient
  rows: Map<string, Row>
  /** `unconfirmed`: an account whose email was never confirmed (the email lookup skips it). */
  users: Map<string, { id: string; email: string; unconfirmed?: boolean }>
  createUser: (attrs: { email: string; user_metadata?: Row; app_metadata?: Row }) => { error: { message: string; code?: string } | null }
  calls: { createUser: Row[]; generateLink: Row[] }
}

export function fakeService(): FakeService {
  const rows = new Map<string, Row>()
  const users = new Map<string, { id: string; email: string; unconfirmed?: boolean }>()
  const calls = { createUser: [] as Row[], generateLink: [] as Row[] }
  const state: FakeService = {
    client: null as unknown as SupabaseClient,
    rows,
    users,
    calls,
    createUser: () => ({ error: null }),
  }

  function query(table: string) {
    if (table !== 'chatgpt_connection') throw new Error(`fake: unexpected table ${table}`)
    const filters: Filter[] = []
    let op: 'select' | 'update' = 'select'
    let patch: Row = {}
    let returning = false
    const matching = () => [...rows.values()].filter((r) => filters.every((f) => f(r)))
    const run = () => {
      if (op === 'update') {
        const hit = matching()
        for (const r of hit) Object.assign(r, patch)
        return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null }
      }
      return { data: matching().map((r) => ({ ...r })), error: null }
    }
    const builder = {
      select() {
        if (op === 'update') returning = true
        return builder
      },
      eq(col: string, value: unknown) {
        filters.push((r) => r[col] === value)
        return builder
      },
      or(expr: string) {
        // Only the lease form: "<col>.is.null,<col>.lt.<iso>"
        const m = expr.match(/^(\w+)\.is\.null,(\w+)\.lt\.(.+)$/)
        if (!m) throw new Error(`fake: unsupported or(${expr})`)
        const [, a, b, iso] = m
        filters.push((r) => r[a] == null || (typeof r[b] === 'string' && Date.parse(r[b] as string) < Date.parse(iso)))
        return builder
      },
      update(values: Row) {
        op = 'update'
        patch = values
        return builder
      },
      async upsert(values: Row) {
        const key = values.user_id as string
        rows.set(key, { ...(rows.get(key) ?? {}), ...values })
        return { data: null, error: null }
      },
      async maybeSingle() {
        const { data } = run()
        return { data: (data as Row[] | null)?.[0] ?? null, error: null }
      },
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        return Promise.resolve(run()).then(resolve, reject)
      },
    }
    return builder
  }

  state.client = {
    from: query,
    async rpc(name: string, args: { p_email: string }) {
      if (name !== 'chatgpt_user_id_by_email') throw new Error(`fake: unexpected rpc ${name}`)
      const hit = [...users.values()].find((u) => !u.unconfirmed && u.email.toLowerCase() === args.p_email.trim().toLowerCase())
      return { data: hit?.id ?? null, error: null }
    },
    auth: {
      admin: {
        async getUserById(id: string) {
          const u = users.get(id)
          return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: 'not found' } }
        },
        async createUser(attrs: { email: string; user_metadata?: Row; app_metadata?: Row }) {
          calls.createUser.push(attrs as Row)
          const { error } = state.createUser(attrs)
          if (error) return { data: { user: null }, error }
          // As Supabase: an address any account holds, confirmed or not, can't be created again.
          if ([...users.values()].some((u) => u.email.toLowerCase() === attrs.email.toLowerCase())) {
            return { data: { user: null }, error: { message: 'A user with this email address has already been registered', code: 'email_exists' } }
          }
          const user = { id: `user-${users.size + 1}`, email: attrs.email }
          users.set(user.id, user)
          return { data: { user }, error: null }
        },
        async generateLink(params: Row) {
          calls.generateLink.push(params)
          return { data: { properties: { hashed_token: `hash-for-${params.email}` } }, error: null }
        },
      },
    },
  } as unknown as SupabaseClient

  return state
}
