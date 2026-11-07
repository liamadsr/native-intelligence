import { describe, it, expect } from 'vitest'
import { memberColumns, withMemberSchema } from '../member-schema'

/**
 * The double behind every member-email regression test: a member query that
 * names a column the table doesn't have must fail the way PostgREST fails it,
 * not hand back the fake's rows. These are the exact reads that shipped
 * broken, because their tests' fakes returned `{ email }` member rows.
 */

type Rows = Record<string, unknown>[]
type Result = { data: unknown; error: unknown }

interface Query extends PromiseLike<Result> {
  select(columns: string): Query
  eq(column: string, value: unknown): Query
  in(column: string, values: unknown[]): Query
  or(filters: string): Query
  limit(count: number): Query
  insert(values: Record<string, unknown>): Query
  maybeSingle(): Promise<Result>
}

/** A permissive fake: every chain resolves to the table's rows. */
function permissive(tables: Record<string, Rows>) {
  return {
    from(table: string): Query {
      const rows = tables[table] ?? []
      const query: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'in', 'or', 'limit', 'insert']) query[method] = () => query
      query.maybeSingle = async () => ({ data: rows[0] ?? null, error: null })
      query.then = (resolve: (v: Result) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve)
      return query as unknown as Query
    },
  }
}

describe('memberColumns (from the migrations)', () => {
  it('has the columns member really has, and no email: that lives on auth.users', () => {
    const columns = memberColumns()
    for (const column of ['id', 'user_id', 'workspace_id', 'role', 'display_name', 'onboarding_completed_at']) {
      expect(columns.has(column)).toBe(true)
    }
    expect(columns.has('email')).toBe(false)
  })
})

describe('withMemberSchema', () => {
  const db = withMemberSchema(
    permissive({
      member: [{ id: 'm1', user_id: 'u1', display_name: 'Ada', email: 'ada@acme.com' }],
      capture_participant: [{ external_email: 'x@y.com', member_id: 'm1' }],
    }),
  )
  const missingEmail = { data: null, error: expect.objectContaining({ code: '42703', message: 'column member.email does not exist' }) }

  it('refuses each member.email read that shipped broken', async () => {
    // calendar-contacts, meeting prep, participant seeding, shares
    expect(await db.from('member').select('email, user_id').eq('workspace_id', 'w')).toMatchObject(missingEmail)
    expect(await db.from('member').select('id, display_name, email').eq('workspace_id', 'w').in('email', ['a@b.co'])).toMatchObject(missingEmail)
    expect(await db.from('member').select('id').eq('workspace_id', 'w').eq('email', 'a@b.co').limit(1).maybeSingle()).toMatchObject(missingEmail)
    // draft follow-up's embed
    expect(await db.from('capture_participant').select('external_email, member:member!member_id(email)').eq('capture_id', 'c')).toMatchObject(missingEmail)
  })

  it('refuses embedding auth.users from a member row: the auth schema is not exposed', async () => {
    const res = await db
      .from('member')
      .select('id, user:user_id!inner(email)')
      .eq('workspace_id', 'w')
      .eq('user:user_id.email', 'a@b.co')
      .limit(1)
      .maybeSingle()
    expect(res).toMatchObject({ data: null, error: expect.objectContaining({ code: 'PGRST200' }) })
  })

  it('refuses writing a column member lacks, and an .or() on one', async () => {
    expect(await db.from('member').insert({ user_id: 'u', email: 'a@b.co' })).toMatchObject(missingEmail)
    expect(await db.from('member').select('id').or('email.eq.a@b.co,display_name.eq.Ada')).toMatchObject(missingEmail)
  })

  it('passes valid queries through to the fake, rows and all', async () => {
    expect(await db.from('member').select('id, user_id, display_name').eq('workspace_id', 'w')).toMatchObject({
      data: [{ id: 'm1' }],
      error: null,
    })
    expect(await db.from('member').select('id').eq('user_id', 'u1').maybeSingle()).toMatchObject({ data: { id: 'm1' }, error: null })
    expect(await db.from('capture_participant').select('external_email, member_id, member:member!member_id(display_name)')).toMatchObject({
      error: null,
    })
  })
})
