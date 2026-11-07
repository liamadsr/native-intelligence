/**
 * isCompanyVisibleTo / filterVisibleCompanies: the company twin of the contact
 * fence (company_visible_to, mig 235, argument order (company, user)). Fails
 * CLOSED on an RPC error, a throw, a non-boolean answer or a row with no id.
 */
import { describe, it, expect, vi } from 'vitest'
import { filterVisibleCompanies, isCompanyVisibleTo } from '../contact-visibility'

function client(answer: (companyId: string) => unknown) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args })
    return answer(args.p_company_id as string)
  })
  return { supabase: { rpc } as never, calls }
}

describe('company visibility fence', () => {
  it('asks company_visible_to(company, user) and keeps only `true`, in order', async () => {
    const { supabase, calls } = client((id) => ({ data: id === 'co-b' ? false : id === 'co-c' ? 'yes' : true, error: null }))
    const rows = [{ id: 'co-a' }, { id: 'co-b' }, { id: 'co-c' }, { id: 7 }, { id: 'co-d' }]
    expect(await filterVisibleCompanies(supabase, 'user-1', rows)).toEqual([{ id: 'co-a' }, { id: 'co-d' }])
    expect(calls[0]).toEqual({ fn: 'company_visible_to', args: { p_company_id: 'co-a', p_user_id: 'user-1' } })
    expect(calls).toHaveLength(4) // the id-less row never reaches the RPC
  })

  it('fails closed on an RPC error or a throw', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errored = client(() => ({ data: null, error: { message: 'down' } }))
    expect(await isCompanyVisibleTo(errored.supabase, 'co-a', 'user-1')).toBe(false)
    const thrown = client(() => {
      throw new Error('boom')
    })
    expect(await isCompanyVisibleTo(thrown.supabase, 'co-a', 'user-1')).toBe(false)
  })
})
