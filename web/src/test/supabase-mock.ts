/**
 * Lightweight Supabase mock builder for tests.
 *
 * The real Supabase query builder exposes a long chain:
 *   supabase.from(t).select(c).eq(k, v).eq(k, v).limit(n).single()
 *
 * Reproducing every chain method by hand in each test is tedious and
 * error-prone (see the existing gmail-webhook.test.ts). This helper builds
 * a thenable chain that accepts any method call and resolves to whatever
 * `data`/`error` you provide.
 *
 * Usage:
 *   const supabase = createSupabaseMock({
 *     auth: { user: { id: 'u1' } },
 *     tables: {
 *       member: { data: { workspace_id: 'w1' }, error: null },
 *     },
 *   })
 *   vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))
 *
 * Pattern: every table lookup returns the same result for any chained call.
 * For tests that need different results for different chain methods
 * (e.g. .single() returns one thing, .limit().single() returns another)
 * use `tableHandler` to return a custom builder.
 */
import { vi, type Mock } from 'vitest'

export type SupabaseResult<T = unknown> = {
  data: T | null
  error: { message: string; code?: string } | null
}

export type TableResultMap = Record<string, SupabaseResult | SupabaseResult[]>

export interface SupabaseMockOptions {
  auth?: {
    user?: { id: string; email?: string } | null
    error?: { message: string } | null
  }
  tables?: TableResultMap
  rpc?: Record<string, SupabaseResult>
  /**
   * Called for any `from(table)` — use when you need custom chain behavior
   * per test. Takes precedence over `tables`.
   */
  tableHandler?: (table: string) => unknown
}

/**
 * Build a chainable thenable that:
 *   - returns `this` for any chain method call
 *   - resolves to `result` when awaited or when a terminal method is called
 *
 * Terminal methods: single, maybeSingle, limit (returning a thenable),
 * and the chain itself is thenable so `await supabase.from(x).select(y).eq(k,v)` works.
 */
function makeChain(result: SupabaseResult | SupabaseResult[]): unknown {
  const chain: Record<string, unknown> = {
    then: (resolve: (r: unknown) => unknown) => Promise.resolve(result).then(resolve),
    catch: (reject: (e: unknown) => unknown) => Promise.resolve(result).catch(reject),
    finally: (cb: () => void) => Promise.resolve(result).finally(cb),
  }

  // Terminal-ish methods that return a single row — for these, if the caller
  // stored an array in `result.data`, pick the first element.
  const terminalSingleMethods = ['single', 'maybeSingle']
  for (const m of terminalSingleMethods) {
    chain[m] = vi.fn(() => {
      const r = result as SupabaseResult
      if (Array.isArray(r.data)) {
        return Promise.resolve({ data: r.data[0] ?? null, error: r.error })
      }
      return Promise.resolve(r)
    })
  }

  // Everything else returns `this` so chains compose.
  const proxyHandler: ProxyHandler<Record<string, unknown>> = {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      // Unknown method — return a vi.fn that returns the chain itself.
      const fn = vi.fn(() => proxy)
      target[prop] = fn
      return fn
    },
  }

  const proxy = new Proxy(chain, proxyHandler)
  return proxy
}

export function createSupabaseMock(opts: SupabaseMockOptions = {}) {
  const user = opts.auth?.user ?? null
  const authError = opts.auth?.error ?? null

  const fromCalls: Mock = vi.fn((table: string) => {
    if (opts.tableHandler) return opts.tableHandler(table)
    const result = opts.tables?.[table]
    if (result === undefined) {
      // Default: empty success so tests don't explode on unexpected tables.
      return makeChain({ data: null, error: null })
    }
    return makeChain(result)
  })

  const rpcCalls: Mock = vi.fn((fnName: string) => {
    const result = opts.rpc?.[fnName]
    return Promise.resolve(result ?? { data: null, error: null })
  })

  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user },
        error: authError,
      })),
    },
    from: fromCalls,
    rpc: rpcCalls,
    _internal: { fromCalls, rpcCalls },
  }
}

export type SupabaseMock = ReturnType<typeof createSupabaseMock>
