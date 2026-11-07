/**
 * A small in-memory service client for the lens tests: just the reads and
 * writes lens-plan.ts, lens-deliver.ts and lens-runs.ts make. Rows live in
 * `tables`; filters are applied for eq / neq / in / gte / not-null.
 */
type Row = Record<string, unknown>

export function lensFakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = { lens_finding: [], flow_run: [], attention_item: [], ...structuredClone(seed) }
  const writes: Array<{ table: string; op: string; rows: Row[] }> = []

  const query = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let limitN: number | null = null
    let op: 'select' | 'update' = 'select'
    let patch: Row = {}
    const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
    const b: Record<string, unknown> = {}
    const done = () => {
      if (op === 'update') {
        const hit = rows()
        for (const r of hit) Object.assign(r, patch)
        writes.push({ table, op: 'update', rows: hit.map((r) => ({ ...r })) })
        return { data: hit, error: null }
      }
      const out = rows()
      return { data: limitN === null ? out : out.slice(0, limitN), error: null }
    }
    Object.assign(b, {
      select: () => b,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
      neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), b),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), b),
      gte: (k: string, v: string) => (filters.push((r) => typeof r[k] === 'string' && (r[k] as string) >= v), b),
      not: (k: string) => (filters.push((r) => r[k] != null), b),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), b),
      or: () => b,
      order: () => b,
      limit: (n: number) => ((limitN = n), b),
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => ({ data: rows()[0] ?? null, error: null }),
      update: (p: Row) => ((op = 'update'), (patch = p), b),
      insert: async (row: Row | Row[]) => {
        const list = Array.isArray(row) ? row : [row]
        ;(tables[table] ??= []).push(...list.map((r) => ({ ...r })))
        writes.push({ table, op: 'insert', rows: list })
        return { data: null, error: null }
      },
      upsert: async (row: Row | Row[], opts: { onConflict?: string } = {}) => {
        const list = Array.isArray(row) ? row : [row]
        const keys = (opts.onConflict ?? 'id').split(',')
        const into = (tables[table] ??= [])
        const added: Row[] = []
        for (const r of list) {
          if (into.some((e) => keys.every((k) => e[k] === r[k]))) continue
          const stored = { id: `${table}-${into.length + 1}`, status: 'new', created_at: new Date().toISOString(), used_at: null, ...r }
          into.push(stored)
          added.push(stored)
        }
        writes.push({ table, op: 'upsert', rows: added })
        return { data: null, error: null }
      },
      then: (resolve: (r: unknown) => unknown) => Promise.resolve(done()).then(resolve),
    })
    return b
  }

  // The RPCs the lens code calls, as migration 397 defines them; anything else is the usage gate.
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    if (name === 'claim_lens_batch') {
      const rows = tables.lens_finding ?? []
      const dayStart = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').toISOString()
      const mine = rows.filter((r) => r.workspace_id === args.p_workspace_id && r.lens === args.p_lens)
      if (mine.some((r) => (r.status === 'claimed' || r.status === 'used') && typeof r.used_at === 'string' && r.used_at >= dayStart)) return { data: [], error: null }
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
      const open = mine.filter((r) => r.kind !== 'testimonial' && r.status === 'new' && String(r.created_at) >= since).slice(0, Number(args.p_limit ?? 30))
      for (const r of open) Object.assign(r, { status: 'claimed', used_at: new Date().toISOString() })
      writes.push({ table: 'lens_finding', op: 'claim', rows: open.map((r) => ({ ...r })) })
      return { data: open.map((r) => ({ ...r })), error: null }
    }
    return { data: [{ allowed: true, is_paid_plan: true }], error: null }
  }
  return { client: { from: query, rpc } as never, tables, writes }
}
