/**
 * A table-aware Supabase fake for the home thread (src/lib/chat/home-thread.ts)
 * and its callers: every call is recorded with its op, filters, payload and
 * options, and answered by `answer(call)`. Chains: select/eq/maybeSingle,
 * upsert(..).select(..).maybeSingle(), update(..).eq(..) (awaited).
 */
export type FakeRow = Record<string, unknown> | null
export interface FakeCall {
  table: string
  op: 'select' | 'upsert' | 'update' | 'insert'
  cols?: string
  eqs: Array<[string, unknown]>
  payload?: unknown
  options?: unknown
}

export function homeThreadFake(answer: (call: FakeCall) => { data: FakeRow; error?: { message: string } | null }) {
  const calls: FakeCall[] = []
  const from = (table: string) => {
    const call: FakeCall = { table, op: 'select', eqs: [] }
    calls.push(call)
    const c: Record<string, unknown> = {}
    c.select = (cols?: string) => {
      if (call.op === 'select') call.cols = cols
      return c
    }
    c.eq = (col: string, v: unknown) => (call.eqs.push([col, v]), c)
    c.is = (col: string, v: unknown) => (call.eqs.push([`${col}:is`, v]), c)
    c.upsert = (payload: unknown, options: unknown) => {
      call.op = 'upsert'
      call.payload = payload
      call.options = options
      return c
    }
    c.update = (payload: unknown) => {
      call.op = 'update'
      call.payload = payload
      return c
    }
    c.maybeSingle = async () => {
      const r = answer(call)
      return { data: r.data, error: r.error ?? null }
    }
    c.then = (resolve: (v: unknown) => unknown) => {
      const r = answer(call)
      return Promise.resolve({ data: r.data, error: r.error ?? null }).then(resolve)
    }
    return c
  }
  return { client: { from } as never, calls }
}
