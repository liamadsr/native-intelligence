/**
 * "Me" in a member filter. The filter picker offers it for every member-typed
 * field and, under is_any_of / is_none_of, inside an array. Callers only
 * pre-resolve the member id for actions, so applyFilters resolves it itself
 * for the rest instead of dropping the filter or sending '@me' to Postgres.
 */
import { describe, it, expect } from 'vitest'
import { applyFilters } from '@/lib/views/query-engine'
import type { FilterOperator, ViewEntityType, ViewFilter } from '@/lib/views/types'

function makeQuerySpy() {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        return (...args: unknown[]) => {
          calls.push({ method: prop, args })
          return proxy
        }
      },
    },
  )
  return { query: proxy, calls }
}

/** A supabase stub whose only read is the member lookup. */
function memberDb(memberId: string | null) {
  const reads: Array<Record<string, unknown>> = []
  const supabase = {
    from: (table: string) => {
      const eqs: Record<string, unknown> = { table }
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = (col: string, v: unknown) => {
        eqs[col] = v
        return chain
      }
      chain.maybeSingle = async () => {
        reads.push(eqs)
        return { data: memberId ? { id: memberId } : null, error: null }
      }
      return chain
    },
  }
  return { supabase: supabase as never, reads }
}

const f = (field: string, operator: FilterOperator, value: unknown): ViewFilter => ({
  id: `${field}-${operator}`,
  field,
  operator,
  value: value as ViewFilter['value'],
})

async function run(entity: ViewEntityType, filter: ViewFilter, ids: { memberId?: string; userId?: string }) {
  const { query, calls } = makeQuerySpy()
  const { supabase, reads } = memberDb('mem-me')
  await applyFilters(query as never, entity, [filter], supabase, 'ws-1', ids)
  return { calls, reads }
}

describe('@me in member filters', () => {
  it('"Creator is Me" on documents resolves the member id instead of dropping the filter', async () => {
    const { calls, reads } = await run('document', f('created_by', 'is', '@me'), { userId: 'user-1' })
    expect(reads).toEqual([{ table: 'member', user_id: 'user-1', workspace_id: 'ws-1' }])
    expect(calls).toContainEqual({ method: 'eq', args: ['created_by', 'mem-me'] })
  })

  it('"Lead is Me" on projects never sends a literal @me', async () => {
    const { calls } = await run('project', f('lead_id', 'is', '@me'), { userId: 'user-1' })
    expect(calls).toContainEqual({ method: 'eq', args: ['lead_id', 'mem-me'] })
    expect(JSON.stringify(calls)).not.toContain('@me')
  })

  it('"Assignee is any of [Me, Bob]" maps @me inside the array', async () => {
    const { calls, reads } = await run('action', f('assignee_id', 'is_any_of', ['@me', 'mem-bob']), {
      memberId: 'mem-pre',
      userId: 'user-1',
    })
    expect(reads).toEqual([]) // pre-resolved: no lookup
    expect(JSON.stringify(calls)).toContain('mem-pre')
    expect(JSON.stringify(calls)).not.toContain('@me')
  })

  it('user_id still resolves to the auth user id', async () => {
    const { calls } = await run('capture', f('user_id', 'is', '@me'), { userId: 'user-1' })
    expect(calls).toContainEqual({ method: 'eq', args: ['user_id', 'user-1'] })
  })
})
