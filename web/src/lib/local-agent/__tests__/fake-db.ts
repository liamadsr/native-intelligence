/**
 * An in-memory stand-in for the service-role Supabase client, enough of
 * PostgREST for the local-agent library: filters (eq, neq, in, is, gt, lt,
 * gte, lte), order, limit, insert / update / upsert (onConflict,
 * ignoreDuplicates) / delete (with its count), select-after-write, and the two embeds the
 * store reads (a session's folder and device, a folder's device). Migration
 * 410's uniques are enforced where the code relies on them, and so is 419's
 * one-live-session-per-folder index (`not(…, 'is', null)` reads too), and
 * 420's one environment per Mac and one default per (person, workspace,
 * project).
 */
import { randomUUID } from 'crypto'

export type Row = Record<string, unknown>

const UNIQUES: Record<string, string[][]> = {
  user_device: [['user_id', 'id']],
  device_folder: [['id'], ['user_id', 'device_id', 'grant_id']],
  local_agent_session: [['id'], ['user_id', 'idempotency_key']],
  local_agent_message: [['id'], ['session_id', 'idempotency_key']],
  local_agent_event: [['id'], ['session_id', 'run_id', 'seq']],
  tracked_job: [['id']],
  environment: [['id'], ['owner_user_id', 'device_id']],
  device_folder_setting: [['device_folder_id']],
  environment_default: [['id']],
}

/** Migration 419's partial unique index: one live session per folder. */
const FOLDER_HOLDING = ['queued', 'starting', 'running', 'waiting', 'interrupted']

const DEFAULTS: Record<string, () => Row> = {
  device_folder: () => ({ id: randomUUID(), revoked_at: null, mode: 'read', is_git: false }),
  local_agent_session: () => ({
    id: randomUUID(),
    status: 'queued',
    current_turn: 1,
    current_tracked_job_id: null,
    tracked_job_id: null,
    eve_session_id: null,
    stream_index: null,
    run_id: null,
    last_seq: null,
    last_seq_run_id: null,
    claimed_at: null,
    lease_expires_at: null,
    stop_requested_at: null,
    last_signal: null,
    last_signal_text: null,
    branch: null,
    commit_sha: null,
    error: null,
    ended_at: null,
    idempotency_key: null,
    expires_at: new Date(Date.now() + 6 * 3600_000).toISOString(),
  }),
  local_agent_message: () => ({ id: randomUUID(), status: 'pending', error: null, delivered_at: null }),
  environment: () => ({
    id: randomUUID(),
    owner_user_id: null,
    device_id: null,
    workspace_id: null,
    created_by: null,
    shared: null,
    network_access: null,
    env_vars: null,
    setup_script: null,
    archived_at: null,
  }),
  device_folder_setting: () => ({ base_branch: null, repo_full_name: null }),
  environment_default: () => ({ id: randomUUID(), project_id: null }),
}

function keyOf(row: Row, cols: string[]): string | null {
  const vals = cols.map((c) => row[c])
  // NULLs are distinct in a unique constraint.
  if (vals.some((v) => v === null || v === undefined)) return null
  return JSON.stringify(vals)
}

export interface FakeDb {
  tables: Record<string, Row[]>
  from: (table: string) => unknown
  rpc: (name: string, args?: unknown) => Promise<{ data: unknown; error: null }>
  channel: (topic: string, opts?: unknown) => { send: (msg: unknown) => Promise<string> }
  removeChannel: (ch: unknown) => Promise<string>
  rings: Array<{ topic: string; msg: unknown }>
  writes: Array<{ table: string; op: string; values: unknown; filters: string[] }>
  /**
   * A race, in order: run `action` once, just before the first query `when`
   * matches executes (its table, op, and the insert's values or the update's
   * patch). The query then runs against whatever `action` left.
   */
  interleave: (when: (q: { table: string; op: string; values: unknown }) => boolean, action: () => Promise<unknown>) => void
}

export function fakeDb(seed: Record<string, Row[]> = {}): FakeDb {
  const tables: Record<string, Row[]> = {}
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }))
  let eventId = 0
  const rings: FakeDb['rings'] = []
  const writes: FakeDb['writes'] = []
  const now = () => new Date().toISOString()
  const hooks: Array<{ when: Parameters<FakeDb['interleave']>[0]; action: () => Promise<unknown>; done: boolean }> = []

  const embed = (table: string, row: Row, projection: string): Row => {
    const out = { ...row }
    if (table === 'local_agent_session' && projection.includes('folder:device_folder')) {
      const f = (tables.device_folder ?? []).find((x) => x.id === row.folder_id)
      out.folder = f ? { label: f.label, grant_id: f.grant_id, revoked_at: f.revoked_at ?? null } : null
    }
    if ((table === 'local_agent_session' || table === 'device_folder') && projection.includes('device:user_device')) {
      const d = (tables.user_device ?? []).find((x) => x.user_id === row.user_id && x.id === row.device_id)
      out.device = d ? { name: d.name, last_seen_at: d.last_seen_at, removed_at: d.removed_at ?? null, capabilities: d.capabilities ?? [] } : null
    }
    return out
  }

  const from = (table: string) => {
    tables[table] ??= []
    const filters: Array<{ desc: string; fn: (r: Row) => boolean }> = []
    let op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select'
    let values: Row[] = []
    let patch: Row = {}
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {}
    let projection: string | null = null
    let sort: { key: string; ascending: boolean } | null = null
    let max = Infinity

    const run = async (): Promise<{ data: Row[] | null; error: { message: string; code?: string } | null; count?: number }> => {
      const hook = hooks.find((h) => !h.done && h.when({ table, op, values: op === 'update' ? patch : values }))
      if (hook) {
        hook.done = true
        await hook.action()
      }
      const rows = tables[table]
      if (op === 'select') {
        let out = rows.filter((r) => filters.every((f) => f.fn(r)))
        if (sort) {
          const { key, ascending } = sort
          out = [...out].sort((a, b) => {
            const av = a[key] as number | string
            const bv = b[key] as number | string
            return (av < bv ? -1 : av > bv ? 1 : 0) * (ascending ? 1 : -1)
          })
        }
        out = out.slice(0, max)
        return { data: out.map((r) => embed(table, r, projection ?? '')), error: null }
      }
      if (op === 'insert' || op === 'upsert') {
        const conflictCols = upsertOpts.onConflict?.split(',').map((s) => s.trim())
        const inserted: Row[] = []
        for (const v of values) {
          const row: Row = { ...(DEFAULTS[table]?.() ?? {}), created_at: now(), updated_at: now(), ...v }
          if (table === 'local_agent_event' && row.id === undefined) row.id = ++eventId
          const existing = conflictCols
            ? rows.find((r) => keyOf(r, conflictCols) !== null && keyOf(r, conflictCols) === keyOf(row, conflictCols))
            : undefined
          if (existing && op === 'upsert') {
            if (upsertOpts.ignoreDuplicates) continue
            Object.assign(existing, v, { updated_at: now() })
            inserted.push(existing)
            continue
          }
          for (const cols of UNIQUES[table] ?? []) {
            const k = keyOf(row, cols)
            if (k !== null && rows.some((r) => keyOf(r, cols) === k)) {
              return { data: null, error: { message: `duplicate key (${cols.join(',')})`, code: '23505' } }
            }
          }
          // Migration 420's environment_default_one: (user, workspace, coalesce(project_id, zero)).
          if (
            table === 'environment_default' &&
            rows.some((r) => r.user_id === row.user_id && r.workspace_id === row.workspace_id && (r.project_id ?? null) === (row.project_id ?? null))
          ) {
            return { data: null, error: { message: 'duplicate key value violates unique constraint "environment_default_one"', code: '23505' } }
          }
          if (
            table === 'local_agent_session' &&
            FOLDER_HOLDING.includes(row.status as string) &&
            rows.some((r) => r.folder_id === row.folder_id && FOLDER_HOLDING.includes(r.status as string))
          ) {
            return {
              data: null,
              error: { message: 'duplicate key value violates unique constraint "local_agent_session_one_live_per_folder"', code: '23505' },
            }
          }
          rows.push(row)
          inserted.push(row)
        }
        writes.push({ table, op, values, filters: [] })
        return { data: inserted.map((r) => embed(table, r, projection ?? '')), error: null }
      }
      if (op === 'update') {
        const hit = rows.filter((r) => filters.every((f) => f.fn(r)))
        for (const r of hit) Object.assign(r, patch, { updated_at: now() })
        writes.push({ table, op, values: patch, filters: filters.map((f) => f.desc) })
        return { data: hit.map((r) => embed(table, r, projection ?? '')), error: null }
      }
      // delete
      const keep = rows.filter((r) => !filters.every((f) => f.fn(r)))
      const gone = rows.length - keep.length
      tables[table] = keep
      writes.push({ table, op, values: gone, filters: filters.map((f) => f.desc) })
      return { data: [], error: null, count: gone }
    }

    const cmp = (a: unknown, b: unknown) => (typeof a === 'number' ? a - (b as number) : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)
    const chain: Record<string, unknown> = {
      select: (p?: string) => ((projection = p ?? '*'), chain),
      insert: (v: Row | Row[]) => ((op = 'insert'), (values = Array.isArray(v) ? v : [v]), chain),
      upsert: (v: Row | Row[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) => (
        (op = 'upsert'), (values = Array.isArray(v) ? v : [v]), (upsertOpts = o ?? {}), chain
      ),
      update: (p: Row) => ((op = 'update'), (patch = p), chain),
      // `{ count: 'exact' }` is accepted; a delete always reports its count.
      delete: (_opts?: { count?: 'exact' }) => ((op = 'delete'), chain),
      eq: (k: string, v: unknown) => (filters.push({ desc: `${k}=${String(v)}`, fn: (r) => r[k] === v }), chain),
      neq: (k: string, v: unknown) => (filters.push({ desc: `${k}!=${String(v)}`, fn: (r) => r[k] !== v }), chain),
      in: (k: string, vs: unknown[]) => (filters.push({ desc: `${k} in`, fn: (r) => vs.includes(r[k]) }), chain),
      is: (k: string, v: unknown) => (filters.push({ desc: `${k} is ${String(v)}`, fn: (r) => (r[k] ?? null) === v }), chain),
      not: (k: string, o: string, v: unknown) => (
        filters.push({ desc: `${k} not ${o} ${String(v)}`, fn: (r) => (o === 'is' ? (r[k] ?? null) !== v : r[k] !== v) }), chain
      ),
      // PostgREST's like: % is any run, _ one character.
      like: (k: string, pattern: string) => {
        const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 's')
        filters.push({ desc: `${k} like ${pattern}`, fn: (r) => typeof r[k] === 'string' && re.test(r[k] as string) })
        return chain
      },
      gt: (k: string, v: unknown) => (filters.push({ desc: `${k}>`, fn: (r) => r[k] != null && cmp(r[k], v) > 0 }), chain),
      gte: (k: string, v: unknown) => (filters.push({ desc: `${k}>=`, fn: (r) => r[k] != null && cmp(r[k], v) >= 0 }), chain),
      lt: (k: string, v: unknown) => (filters.push({ desc: `${k}<`, fn: (r) => r[k] != null && cmp(r[k], v) < 0 }), chain),
      lte: (k: string, v: unknown) => (filters.push({ desc: `${k}<=`, fn: (r) => r[k] != null && cmp(r[k], v) <= 0 }), chain),
      order: (key: string, o?: { ascending?: boolean }) => ((sort = { key, ascending: o?.ascending !== false }), chain),
      limit: (n: number) => ((max = n), chain),
      maybeSingle: async () => {
        const { data, error } = await run()
        return { data: data?.[0] ?? null, error }
      },
      single: async () => {
        const { data, error } = await run()
        if (error) return { data: null, error }
        return data && data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: 'not one row' } }
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
    }
    return chain
  }

  type TeammateAskArgs = { p_session_id: string; p_user_id: string; p_key: string; p_question: string; p_per_hour: number; p_per_job: number; p_per_day: number }
  // The SQL's steps: the caps given, a live session, the key's event, else the caps' count, else the insert (one step: JS runs it without a gap).
  const teammateAsk = (a: TeammateAskArgs) => {
    if (a.p_per_hour == null || a.p_per_job == null || a.p_per_day == null) throw new Error('local_agent_teammate_ask: every cap is required')
    const session = (tables.local_agent_session ?? []).find((r) => r.id === a.p_session_id && r.user_id === a.p_user_id)
    if (!session || ['cancelled', 'failed', 'expired'].includes(session.status as string)) return { status: 'ended' }
    const events = (tables.local_agent_event ??= [])
    const asks = events.filter((e) => e.user_id === a.p_user_id && e.source === 'server' && e.kind === 'ask')
    const dup = asks.filter((e) => e.session_id === a.p_session_id && (e.payload as { key?: unknown } | null)?.key === a.p_key).at(-1)
    if (dup) return { status: 'duplicate', id: dup.id }
    const nowMs = Date.now()
    const counted = asks.filter((e) => (e.payload as { via?: unknown } | null)?.via === 'message_teammate')
    const since = (ms: number) => (e: Row) => Date.parse(e.created_at as string) >= nowMs - ms
    const job = counted.filter((e) => e.session_id === a.p_session_id)
    if (job.filter(since(60 * 60_000)).length >= a.p_per_hour) return { status: 'capped', cap: 'hour' }
    if (job.length >= a.p_per_job) return { status: 'capped', cap: 'job' }
    if (counted.filter(since(24 * 60 * 60_000)).length >= a.p_per_day) return { status: 'capped', cap: 'day' }
    const row: Row = {
      id: ++eventId, session_id: a.p_session_id, user_id: a.p_user_id, source: 'server', kind: 'ask',
      payload: { question: a.p_question, via: 'message_teammate', key: a.p_key }, created_at: now(), updated_at: now(),
    }
    events.push(row)
    writes.push({ table: 'local_agent_event', op: 'insert', values: [row], filters: [] })
    return { status: 'recorded', id: row.id }
  }

  return {
    tables,
    from,
    interleave: (when, action) => void hooks.push({ when, action, done: false }),
    // migration 410's local_agent_relay_acquire and 419's local_agent_teammate_ask, in memory.
    rpc: async (name: string, args?: unknown) => {
      if (name === 'local_agent_teammate_ask') return { data: teammateAsk(args as TeammateAskArgs) as unknown, error: null }
      if (name !== 'local_agent_relay_acquire') return { data: null, error: null }
      const a = args as { p_user_id: string; p_session_id: string; p_max: number; p_ttl_seconds: number }
      const slots = (tables.local_agent_relay_slot ??= [])
      const nowMs = Date.now()
      tables.local_agent_relay_slot = slots.filter((x) => !(x.user_id === a.p_user_id && Date.parse(x.expires_at as string) < nowMs))
      if (tables.local_agent_relay_slot.filter((x) => x.user_id === a.p_user_id).length >= a.p_max) return { data: null, error: null }
      const id = randomUUID()
      tables.local_agent_relay_slot.push({ id, user_id: a.p_user_id, session_id: a.p_session_id, expires_at: new Date(nowMs + a.p_ttl_seconds * 1000).toISOString() })
      return { data: id as unknown, error: null }
    },
    channel: (topic: string) => ({
      send: async (msg: unknown) => {
        rings.push({ topic, msg })
        return 'ok'
      },
    }),
    removeChannel: async () => 'ok',
    rings,
    writes,
  }
}

export const USER = '11111111-1111-4111-8111-111111111111'
export const OTHER = '22222222-2222-4222-8222-222222222222'
export const DEVICE = '33333333-3333-4333-8333-333333333333'
export const WS = '44444444-4444-4444-8444-444444444444'
export const CONV = '55555555-5555-4555-8555-555555555555'
export const FOLDER = '66666666-6666-4666-8666-666666666666'

/** A device, a granted git folder (edit) and a conversation, for USER. */
export function seeded(extra: Record<string, Row[]> = {}): FakeDb {
  return fakeDb({
    user_device: [{ user_id: USER, id: DEVICE, name: 'Liam’s MacBook', platform: 'macos', app_version: '0.3.0', last_seen_at: new Date().toISOString() }],
    device_folder: [
      { id: FOLDER, user_id: USER, device_id: DEVICE, grant_id: 'g1', label: 'native-intelligence', path: '/Users/l/code/native-intelligence', mode: 'edit', is_git: true, revoked_at: null },
    ],
    chat_conversations: [{ id: CONV, user_id: USER, workspace_id: WS }],
    ...extra,
  })
}
