/**
 * A fake database without migration 331, for the plan-column fallback tests:
 * wraps the ledger fake so a tracked_job select or update naming `plan` fails
 * with PostgREST's 42703, and everything else reads for real.
 */
import type { FakeSupabase } from './fake-supabase'

export const MISSING = { code: '42703', message: 'column tracked_job.plan does not exist' }

/** A chain whose every step returns itself and which resolves to the 42703 error. */
function failingChain(): Record<string, unknown> {
  const result = { data: null, error: MISSING }
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(result)
        return () => chain
      },
    },
  )
  return chain
}

/** The fake, as a database without the column: a select or update naming `plan` fails; the rest reads for real. */
export function withoutColumn(db: FakeSupabase) {
  const selects: string[] = []
  const client = {
    from: (table: string) => {
      const q = db.from(table) as Record<string, (...a: unknown[]) => unknown>
      return new Proxy(q, {
        get: (target, prop) => {
          if (table === 'tracked_job' && prop === 'select') {
            return (columns: string, ...rest: unknown[]) => {
              selects.push(columns)
              return /\bplan\b/.test(columns) ? failingChain() : target.select(columns, ...rest)
            }
          }
          if (table === 'tracked_job' && prop === 'update') {
            return (patch: Record<string, unknown>) => ('plan' in patch ? failingChain() : target.update(patch))
          }
          return target[prop as string]
        },
      })
    },
  }
  return { client, selects }
}

