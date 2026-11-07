/**
 * An in-memory one_time_link table for the link tests: insert, a select by
 * token_hash, and the conditional update consume makes (is consumed_at null,
 * expires_at > now), applied as Postgres would.
 */
type Row = Record<string, unknown>

export function oneTimeLinkDb(opts: { failInsert?: boolean } = {}) {
  const rows: Row[] = []
  let n = 0
  const from = (table: string) => {
    if (table !== 'one_time_link') throw new Error(`unexpected table ${table}`)
    const filters: Array<(r: Row) => boolean> = []
    let patch: Row | null = null
    const matching = () => rows.filter((r) => filters.every((f) => f(r)))
    const chain: Record<string, unknown> = {
      insert: async (row: Row) => {
        if (opts.failInsert) return { error: { message: 'insert down' } }
        rows.push({ id: `link-${++n}`, consumed_at: null, created_at: new Date().toISOString(), ...row })
        return { error: null }
      },
      update: (p: Row) => ((patch = p), chain),
      select: () => chain,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), chain),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), chain),
      gt: (k: string, v: string) => (filters.push((r) => Date.parse(String(r[k])) > Date.parse(v)), chain),
      maybeSingle: async () => ({ data: matching()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
        const hit = matching()
        if (patch) for (const r of hit) Object.assign(r, patch)
        return Promise.resolve({ data: hit.map((r) => ({ ...r })), error: null }).then(ok, bad)
      },
    }
    return chain
  }
  return { rows, client: { from } as never }
}
