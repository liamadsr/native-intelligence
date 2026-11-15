/**
 * An in-memory stand-in for the Studio's tables and its storage bucket, for tests of src/lib/studio/server.
 * Rows are stored JSON round-tripped (as jsonb would), and the query builder supports what the Studio uses:
 *
 *   select ('*', columns, `alias:col->key` and `alias:col->>key`), insert/update/upsert/delete with a trailing
 *   select().single()/maybeSingle(), eq (also on `col->>key`), in, is, order, limit, range, single, maybeSingle,
 *   lt, gte, like, not, rpc('studio_claim_job') and rpc('studio_workspace_bytes') as migration 625 has them, and
 *   each table's primary key (23505 on a second row with the same key).
 *
 * Defaults and updated_at bumps follow migration 620. A made-up workspace and person; no real data.
 */
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { StudioContext } from '../context'
import { PAID_KINDS } from '../jobs'
import type { StudioStorage } from '../storage'

type Row = Record<string, unknown>

export const WS = '0b0b0b0b-1111-4222-8333-444444444444'
export const OTHER_WS = '0c0c0c0c-1111-4222-8333-555555555555'
export const AVA = 'a1a1a1a1-1111-4222-8333-666666666666'

let tick = Date.parse('2031-03-01T09:00:00Z')
/** A clock that moves forward a millisecond per reading, so orderings by time are stable. */
export const nowIso = () => new Date(tick++).toISOString()

const KEYS: Record<string, string[]> = {
  studio_asset: ['workspace_id', 'id'],
  studio_blob: ['workspace_id', 'key'],
  studio_record: ['workspace_id', 'collection', 'key'],
}
const DEFAULTS: Record<string, () => Row> = {
  studio_project: () => ({ client: null, notes: null, brand: null, cast_members: [], archived_at: null, created_by: null }),
  studio_video: () => ({ studio_project_id: null, status: 'draft', variant_of: null, revision: 1, summary: {}, archived_at: null, created_by: null }),
  studio_video_version: () => ({ kind: 'project', label: '', created_by: null }),
  studio_job: () => ({ video_id: null, status: 'queued', progress: 0, logs: [], input: {}, result: null, error: null, cancel_requested: false, worker_id: null, attempts: 0, claimed_at: null, heartbeat_at: null, created_by: null }),
  studio_script: () => ({ video_id: null, studio_project_id: null, beats: [], created_by: null }),
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

/** A column or a JSON path (`doc->beats`, `input->>title`) of a row. */
function read(row: Row, expr: string): unknown {
  const m = /^([a-z_]+)(->>?)(\w+)$/.exec(expr)
  if (!m) return row[expr]
  const base = row[m[1]!] as Record<string, unknown> | null | undefined
  const v = base && typeof base === 'object' ? base[m[3]!] : undefined
  if (v === undefined || v === null) return null
  return m[2] === '->>' ? (typeof v === 'object' ? JSON.stringify(v) : String(v)) : v
}

function project(row: Row, fields: string): Row {
  if (fields.trim() === '*') return clone(row)
  const out: Row = {}
  for (const raw of fields.split(',').map((f) => f.trim()).filter(Boolean)) {
    const [alias, expr] = raw.includes(':') ? raw.split(':') : [raw.replace(/->>?/g, '_'), raw]
    out[alias!.trim()] = clone(read(row, expr!.trim()))
  }
  return out
}

/** The most values one `.in()` may list before the request would pass the gateway's URL limit. */
export const MAX_IN = 200

/** `queueFunction: false` stands for a database without migration 627 (no studio_queue_job). */
export function fakeDb(tables: Record<string, Row[]> = {}, options: { queueFunction?: boolean } = {}) {
  const queueFunction = options.queueFunction !== false
  const sameKey = (table: string, a: Row, b: Row) => (KEYS[table] ?? ['id']).every((k) => a[k] === b[k])
  const rowsOf = (table: string) => (tables[table] ??= [])
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = []
    let op: { kind: 'select' } | { kind: 'insert'; rows: Row[] } | { kind: 'upsert'; rows: Row[]; on: string[] } | { kind: 'update'; patch: Row } | { kind: 'delete' } = { kind: 'select' }
    let fields = '*'
    let returning = false
    let max = Infinity
    let offset = 0
    let sort: { key: string; ascending: boolean } | null = null
    let tooLong = false
    const fresh = (input: Row): Row => {
      const at = nowIso()
      return { ...(DEFAULTS[table]?.() ?? {}), ...(KEYS[table] ? {} : { id: randomUUID() }), created_at: at, updated_at: at, ...clone(input) }
    }
    const run = async (): Promise<{ data: Row[] | null; error: { message: string; code?: string } | null }> => {
      if (tooLong) return { data: null, error: { message: 'URI too long', code: '414' } }
      const out = (rows: Row[]) => ({ data: rows.map((r) => project(r, fields)), error: null })
      if (op.kind === 'insert') {
        const made = op.rows.map(fresh)
        for (const r of made) if ([...rowsOf(table), ...made.filter((m) => m !== r)].some((o) => sameKey(table, o, r))) return { data: null, error: { message: 'duplicate key', code: '23505' } }
        rowsOf(table).push(...made)
        return returning ? out(made) : { data: null, error: null }
      }
      if (op.kind === 'upsert') {
        const done: Row[] = []
        for (const input of op.rows) {
          const on = op.on.length ? op.on : KEYS[table] ?? ['id']
          const existing = rowsOf(table).find((r) => on.every((k) => r[k] === input[k]))
          if (existing) Object.assign(existing, clone(input), { updated_at: nowIso() })
          else rowsOf(table).push(fresh(input))
          done.push(existing ?? rowsOf(table).at(-1)!)
        }
        return returning ? out(done) : { data: null, error: null }
      }
      let hit = rowsOf(table).filter((r) => filters.every((f) => f(r)))
      if (op.kind === 'update') {
        const patch = clone(op.patch)
        for (const r of hit) Object.assign(r, patch, 'updated_at' in patch ? {} : { updated_at: nowIso() })
        return returning ? out(hit) : { data: null, error: null }
      }
      if (op.kind === 'delete') {
        tables[table] = rowsOf(table).filter((r) => !hit.includes(r))
        return returning ? out(hit) : { data: null, error: null }
      }
      if (sort) {
        const { key, ascending } = sort
        hit = [...hit].sort((a, b) => String(read(a, key) ?? '').localeCompare(String(read(b, key) ?? '')) * (ascending ? 1 : -1))
      }
      return out(hit.slice(offset, offset + max))
    }
    const chain: Record<string, unknown> = {
      select: (f?: string) => {
        fields = f ?? '*'
        if (op.kind !== 'select') returning = true
        return chain
      },
      insert: (input: Row | Row[]) => ((op = { kind: 'insert', rows: Array.isArray(input) ? input : [input] }), chain),
      upsert: (input: Row | Row[], opts?: { onConflict?: string }) => (
        (op = { kind: 'upsert', rows: Array.isArray(input) ? input : [input], on: (opts?.onConflict ?? '').split(',').map((k) => k.trim()).filter(Boolean) }), chain
      ),
      update: (patch: Row) => ((op = { kind: 'update', patch }), chain),
      delete: () => ((op = { kind: 'delete' }), chain),
      eq: (k: string, v: unknown) => (filters.push((r) => read(r, k) === v), chain),
      neq: (k: string, v: unknown) => (filters.push((r) => read(r, k) !== v), chain),
      lt: (k: string, v: string) => (filters.push((r) => String(read(r, k) ?? '') < v), chain),
      gte: (k: string, v: string) => (filters.push((r) => String(read(r, k) ?? '') >= v), chain),
      like: (k: string, pattern: string) => (filters.push((r) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`).test(String(read(r, k) ?? ''))), chain),
      not: (k: string, operator: string, v: unknown) => (
        filters.push((r) =>
          operator === 'is'
            ? (read(r, k) ?? null) !== v
            : operator === 'like'
              ? !new RegExp(`^${String(v).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`).test(String(read(r, k) ?? ''))
              : read(r, k) !== v,
        ),
        chain
      ),
      // A list that long would pass the gateway's URL limit (a uuid is 37 characters of the query string).
      in: (k: string, vs: unknown[]) => (vs.length > MAX_IN ? (tooLong = true) : filters.push((r) => vs.includes(read(r, k))), chain),
      is: (k: string, v: unknown) => (filters.push((r) => (read(r, k) ?? null) === v), chain),
      order: (key: string, opts?: { ascending?: boolean }) => ((sort = { key, ascending: opts?.ascending !== false }), chain),
      limit: (n: number) => ((max = n), chain),
      range: (a: number, b: number) => ((offset = a), (max = b - a + 1), chain),
      single: async () => {
        const { data, error } = await run()
        return { data: data?.[0] ?? null, error: error ?? (data?.length ? null : { message: 'no rows', code: 'PGRST116' }) }
      },
      maybeSingle: async () => {
        const { data, error } = await run()
        return { data: data?.[0] ?? null, error }
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
    }
    return chain
  }
  const rpc = async (name: string, args: Record<string, unknown>) => {
    if (name === 'studio_workspace_bytes') return { data: workspaceBytes(String(args.p_workspace)), error: null }
    if (name === 'studio_queue_job' && queueFunction) return { data: queue(args), error: null }
    // PostgREST's answer for a function that is not there (a migration not applied).
    if (name !== 'studio_claim_job') return { data: null, error: { message: `Could not find the function public.${name}`, code: 'PGRST202' } }
    return { data: claim(String(args.p_worker), args.p_kinds as string[], Number(args.p_stale_seconds ?? 180)), error: null }
  }
  /** studio_queue_job (627): the open jobs counted and the job inserted at once; past a cap, no row. */
  const queue = (args: Record<string, unknown>) => {
    const open = rowsOf('studio_job').filter((j) => j.workspace_id === args.p_workspace && (j.status === 'queued' || j.status === 'running') && !j.cancel_requested)
    if (open.length >= Number(args.p_max_open) || (args.p_kind === 'export' && open.filter((j) => j.kind === 'export').length >= Number(args.p_max_exports))) return []
    const at = nowIso()
    const row: Row = { ...DEFAULTS.studio_job!(), id: randomUUID(), created_at: at, updated_at: at, workspace_id: args.p_workspace, video_id: args.p_video ?? null, kind: args.p_kind, input: clone(args.p_input ?? {}), created_by: args.p_created_by ?? null }
    rowsOf('studio_job').push(row)
    return [clone(row)]
  }
  /** studio_workspace_bytes (625): stored files plus pending writes. */
  const workspaceBytes = (workspace: string) =>
    rowsOf('studio_blob').filter((b) => b.workspace_id === workspace).reduce((n, b) => n + Number(b.bytes), 0) +
    rowsOf('studio_record').filter((r) => r.workspace_id === workspace && r.collection === 'blob-writes').reduce((n, r) => n + (Number((r.value as Row)?.bytes) || 0), 0)
  /**
   * studio_claim_job as 625 and 631 have it: stale running paid jobs (the kinds in PAID_KINDS) end failed, stale running jobs asked to stop end cancelled, queued ones asked to stop are
   * cancelled, stale ones past three tries fail, other stale ones go back in the queue; then the queued job of the
   * workspace with the fewest running jobs is taken, the oldest first.
   */
  const claim = (worker: string, kinds: string[], staleSeconds: number) => {
    const jobs = rowsOf('studio_job')
    // The code under test stamps heartbeats with the real clock and the fake stamps rows with its own: stale is
    // stale by both.
    const since = Math.min(Date.parse(nowIso()), Date.now()) - staleSeconds * 1000
    const stale = (j: Row) => j.status === 'running' && Date.parse(String(j.heartbeat_at ?? j.claimed_at ?? j.created_at)) < since
    for (const j of jobs) {
      if (stale(j) && PAID_KINDS.includes(String(j.kind)))
        Object.assign(j, { status: 'failed', error: 'The worker stopped while making this, after it may have asked the provider: it may have charged. Check the costs before trying again.', updated_at: nowIso() })
      else if (stale(j) && j.cancel_requested) Object.assign(j, { status: 'cancelled', error: j.error ?? 'Cancelled.', updated_at: nowIso() })
      else if (j.status === 'queued' && j.cancel_requested) Object.assign(j, { status: 'cancelled', error: j.error ?? 'Cancelled.', updated_at: nowIso() })
      else if (stale(j) && (j.attempts as number) >= 3) Object.assign(j, { status: 'failed', error: 'The worker stopped while doing this, three times. Try again.', updated_at: nowIso() })
      else if (stale(j)) Object.assign(j, { status: 'queued', worker_id: null, updated_at: nowIso() })
    }
    const running = (workspace: unknown) => jobs.filter((r) => r.workspace_id === workspace && r.status === 'running').length
    const queued = jobs
      .filter((j) => j.status === 'queued' && !j.cancel_requested && kinds.includes(j.kind as string))
      .sort((a, b) => running(a.workspace_id) - running(b.workspace_id) || String(a.created_at).localeCompare(String(b.created_at)))[0]
    if (!queued) return []
    Object.assign(queued, { status: 'running', worker_id: worker, attempts: (queued.attempts as number) + 1, claimed_at: nowIso(), heartbeat_at: nowIso() })
    return [clone(queued)]
  }
  return { tables, client: { from, rpc } as unknown as SupabaseClient }
}

/**
 * A bucket in memory. `put` stands in for the browser's (or worker's) PUT to an upload link; `putLink` PUTs through a
 * signed link as storage does: a link signed without upsert is refused when the object is there already (and, like
 * storage's, it stays good for another PUT once the object is gone). `remove` takes at most 1000 paths a call, as
 * storage's delete route allows; `failList` makes listings fail.
 */
export function fakeStorage() {
  const objects = new Map<string, { bytes: Uint8Array; type: string }>()
  const upserts = new Map<string, boolean>()
  const storage: StudioStorage & {
    put(path: string, bytes: Uint8Array): void
    putLink(link: { url: string; headers: Record<string, string> }, bytes: Uint8Array): boolean
    objects: typeof objects
    failList: boolean
    removeCalls: number[]
  } = {
    objects,
    failList: false,
    removeCalls: [],
    put(path, bytes) {
      objects.set(path, { bytes, type: 'application/octet-stream' })
    },
    putLink(link, bytes) {
      const path = link.url.replace('fake://upload/', '')
      if (link.headers['x-upsert'] !== 'true' && objects.has(path)) return false
      objects.set(path, { bytes, type: 'application/octet-stream' })
      return true
    },
    async signUpload(path, contentType, options) {
      const upsert = options?.upsert !== false
      upserts.set(path, upsert)
      return { url: `fake://upload/${path}`, headers: { 'content-type': contentType, 'x-upsert': String(upsert) } }
    },
    async size(path) {
      return objects.get(path)?.bytes.byteLength ?? null
    },
    async folders(folder) {
      const prefix = folder ? `${folder}/` : ''
      const names = new Set<string>()
      for (const p of objects.keys()) {
        if (!p.startsWith(prefix)) continue
        const rest = p.slice(prefix.length).split('/')
        if (rest.length > 1) names.add(rest[0]!)
      }
      return [...names]
    },
    async signRead(paths) {
      return paths.map((p) => `fake://read/${p}`)
    },
    async list(folder) {
      if (storage.failList) throw new Error('Storage could not list that folder.')
      const prefix = `${folder}/`
      return [...objects.entries()].filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map(([p, o]) => ({ name: p.slice(prefix.length), size: o.bytes.byteLength }))
    },
    async remove(paths) {
      if (paths.length > 1000) throw new Error('At most 1000 objects can be deleted per request.')
      storage.removeCalls.push(paths.length)
      for (const p of paths) objects.delete(p)
    },
    async upload(path, bytes, contentType) {
      objects.set(path, { bytes: new Uint8Array(bytes), type: contentType })
    },
    async head(path, bytes) {
      return objects.get(path)?.bytes.slice(0, bytes) ?? new Uint8Array(0)
    },
  }
  return storage
}

/** A context over a fake database and bucket, for the made-up workspace. */
export function fakeContext(tables: Record<string, Row[]> = {}) {
  const db = fakeDb(tables)
  const storage = fakeStorage()
  const ctx: StudioContext = { supabase: db.client, workspaceId: WS, userId: AVA, storage }
  return { ctx, db, storage, tables: db.tables }
}
