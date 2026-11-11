import { describe, it, expect } from 'vitest'
import { relationNames, withTableSchema } from '../table-schema'
import { recordingDb } from '../recording-db'

/**
 * The double behind the capture_participant and action_github_pr regression
 * tests: a table or column the schema doesn't have must fail the way
 * PostgREST fails it, not hand back the double's rows.
 */
type Result = { data: unknown; error: { code?: string; message: string } | null }
type Chain = PromiseLike<Result> & Record<string, (...args: unknown[]) => Chain>

const db = () => {
  const { client } = recordingDb({ capture_participant: [{ id: 'cp-1' }], captures: [{ id: 'cap-1' }] })
  return withTableSchema(client, ['capture_participant', 'captures']) as unknown as { from(t: string): Chain }
}

describe('relationNames (baseline + migrations after the cut)', () => {
  it('has tables only the baseline creates, follows renames, and lacks names never created', () => {
    const names = relationNames()
    expect(names.has('actions')).toBe(true) // only in the baseline dump
    expect(names.has('captures')).toBe(true)
    expect(names.has('notes')).toBe(false) // renamed to captures (025)
    expect(names.has('action_github_pr')).toBe(true)
    expect(names.has('action_github_prs')).toBe(false)
  })
})

describe('withTableSchema', () => {
  it('refuses a table the database does not have', async () => {
    const { data, error } = await db().from('action_github_prs').select('id', { count: 'exact', head: true }).eq('action_id', 'a-1')
    expect(data).toBeNull()
    expect(error).toMatchObject({ code: '42P01', message: 'relation "public.action_github_prs" does not exist' })
  })

  it('refuses ordering capture_participant by a created_at it never had', async () => {
    const { error } = await db()
      .from('capture_participant')
      .select('capture:capture_id(id, title)')
      .in('contact_id', ['ct-1'])
      .order('created_at', { ascending: false })
      .limit(20)
    expect(error).toMatchObject({ code: '42703', message: 'column capture_participant.created_at does not exist' })
  })

  it('refuses an unknown column inside an embed of a checked table, and a filter on it', async () => {
    expect((await db().from('captures').select('id, cp:capture_participant!inner(created_at)')).error).toMatchObject({ code: '42703' })
    expect((await db().from('captures').select('id, cp:capture_participant!inner(contact_id)').eq('cp.created_at', 'x')).error).toMatchObject({
      message: 'column capture_participant.created_at does not exist',
    })
  })

  it('lets real names through to the double', async () => {
    const { data, error } = await db()
      .from('captures')
      .select('id, title, started_at, cp:capture_participant!inner(contact_id)')
      .in('cp.contact_id', ['ct-1'])
      .order('started_at', { ascending: false, nullsFirst: false })
      .order('joined_at', { referencedTable: 'cp' })
    expect(error).toBeNull()
    expect(data).toEqual([{ id: 'cap-1' }])
  })
})
