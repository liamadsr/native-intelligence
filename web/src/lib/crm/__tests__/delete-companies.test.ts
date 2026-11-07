/**
 * Tests for deleteCompaniesWithContacts — the company⇒contacts cascade.
 *
 * Locked in: dry-run counts without writes, write order (enrollment exit →
 * contact delete → company delete), workspace scoping (ids outside the
 * workspace are ignored), .in() chunking (PostgREST URL-limit guard),
 * pagination past PostgREST's 1000-row response cap, and merged tombstones
 * being deleted but excluded from the reported people counts.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deleteCompaniesWithContacts } from '../delete-companies'

interface RecordedCall {
  table: string
  op: 'select' | 'update' | 'delete'
  payload?: unknown
  inFilter?: { column: string; values: string[] }
  eqs: Array<[string, unknown]>
  range?: { from: number; to: number }
}

/** A contact fixture entry: a plain id, a merged-away tombstone, or a
 *  teammate self-contact (member_id set). */
type ContactEntry = string | { id: string; merged?: true; member?: true }

/**
 * Recording fake for the service client. Selects answer from the provided
 * fixture data (filtered by the .in() list and sliced by .range(), mimicking
 * PostgREST); writes succeed and are recorded for order/scoping assertions.
 */
function makeServiceClient(fixture: {
  /** Company ids that exist in the workspace. */
  companies: string[]
  /** companyId → contacts (plain ids or tombstones). */
  contactsByCompany: Record<string, ContactEntry[]>
}) {
  const calls: RecordedCall[] = []

  const client = {
    from(table: string) {
      const call: RecordedCall = { table, op: 'select', eqs: [] }
      calls.push(call)
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: (payload: unknown) => {
          call.op = 'update'
          call.payload = payload
          return builder
        },
        delete: () => {
          call.op = 'delete'
          return builder
        },
        in: (column: string, values: string[]) => {
          call.inFilter = { column, values }
          return builder
        },
        eq: (column: string, value: unknown) => {
          call.eqs.push([column, value])
          return builder
        },
        is: (column: string, value: unknown) => {
          call.eqs.push([column, value])
          return builder
        },
        order: () => builder,
        range: (from: number, to: number) => {
          call.range = { from, to }
          return builder
        },
        then: (resolve: (r: unknown) => unknown) => {
          let data: unknown = null
          if (call.op === 'select') {
            const values = call.inFilter?.values ?? []
            if (call.table === 'company') {
              data = values
                .filter((id) => fixture.companies.includes(id))
                .map((id) => ({ id }))
            } else if (call.table === 'contact') {
              // Mimic PostgREST: the helper's .is('member_id', null) filter
              // must exclude teammate self-contacts from the result.
              const memberFiltered = call.eqs.some(
                ([col, val]) => col === 'member_id' && val === null,
              )
              let rows = values.flatMap((companyId) =>
                (fixture.contactsByCompany[companyId] ?? [])
                  .map((entry) =>
                    typeof entry === 'string' ? { id: entry } : entry,
                  )
                  .filter((entry) => !(memberFiltered && entry.member))
                  .map((entry) => ({
                    id: entry.id,
                    merged_into_contact_id:
                      typeof entry === 'object' && entry.merged ? 'ct-merge-target' : null,
                  })),
              )
              if (call.range) rows = rows.slice(call.range.from, call.range.to + 1)
              data = rows
            }
          }
          return Promise.resolve({ data, error: null }).then(resolve)
        },
      }
      return builder
    },
  }

  return { client: client as unknown as SupabaseClient, calls }
}

const WS = 'ws-1'

describe('deleteCompaniesWithContacts', () => {
  it('dry run returns counts without any writes', async () => {
    const { client, calls } = makeServiceClient({
      companies: ['co-1', 'co-2'],
      contactsByCompany: { 'co-1': ['ct-1', 'ct-2'], 'co-2': ['ct-3'] },
    })

    const result = await deleteCompaniesWithContacts(client, WS, ['co-1', 'co-2'], {
      dryRun: true,
    })

    expect(result).toEqual({ companies: 2, contacts: 3 })
    expect(calls.every((c) => c.op === 'select')).toBe(true)
  })

  it('deletes in order: enrollment exit → contacts → companies', async () => {
    const { client, calls } = makeServiceClient({
      companies: ['co-1'],
      contactsByCompany: { 'co-1': ['ct-1', 'ct-2'] },
    })

    const result = await deleteCompaniesWithContacts(client, WS, ['co-1'])
    expect(result).toEqual({ companies: 1, contacts: 2 })

    const writes = calls.filter((c) => c.op !== 'select')
    expect(writes.map((c) => `${c.op}:${c.table}`)).toEqual([
      'update:sequence_enrollment',
      'delete:contact',
      'delete:company',
    ])

    const [exit, contactDel, companyDel] = writes
    // The enrollment exit mirrors exitEnrollment's write exactly and only
    // touches ACTIVE enrollments in this workspace.
    expect(exit.payload).toEqual({
      status: 'exited',
      exit_reason: 'removed',
      next_send_at: null,
    })
    expect(exit.inFilter).toEqual({ column: 'contact_id', values: ['ct-1', 'ct-2'] })
    expect(exit.eqs).toContainEqual(['status', 'active'])
    expect(exit.eqs).toContainEqual(['workspace_id', WS])

    expect(contactDel.inFilter).toEqual({ column: 'id', values: ['ct-1', 'ct-2'] })
    expect(contactDel.eqs).toContainEqual(['workspace_id', WS])
    expect(companyDel.inFilter).toEqual({ column: 'id', values: ['co-1'] })
    expect(companyDel.eqs).toContainEqual(['workspace_id', WS])
  })

  it('deletes merged tombstones with the company but excludes them from counts', async () => {
    const { client, calls } = makeServiceClient({
      companies: ['co-1'],
      contactsByCompany: { 'co-1': ['ct-1', { id: 'ct-tomb', merged: true }] },
    })

    const dry = await deleteCompaniesWithContacts(client, WS, ['co-1'], { dryRun: true })
    expect(dry).toEqual({ companies: 1, contacts: 1 })

    const result = await deleteCompaniesWithContacts(client, WS, ['co-1'])
    // Reported count = people; the tombstone is not a person…
    expect(result).toEqual({ companies: 1, contacts: 1 })
    // …but it still dies with the company.
    const deleted = calls
      .filter((c) => c.op === 'delete' && c.table === 'contact')
      .flatMap((c) => c.inFilter!.values)
    expect(deleted).toEqual(['ct-1', 'ct-tomb'])
  })

  it('never deletes teammate self-contacts (member_id set) — FK detaches them', async () => {
    const { client, calls } = makeServiceClient({
      companies: ['co-1'],
      contactsByCompany: {
        'co-1': ['ct-1', { id: 'ct-liam', member: true }],
      },
    })

    const dry = await deleteCompaniesWithContacts(client, WS, ['co-1'], { dryRun: true })
    expect(dry).toEqual({ companies: 1, contacts: 1 })

    const result = await deleteCompaniesWithContacts(client, WS, ['co-1'])
    expect(result).toEqual({ companies: 1, contacts: 1 })

    // The member self-contact is filtered server-side…
    const contactSelects = calls.filter((c) => c.op === 'select' && c.table === 'contact')
    for (const sel of contactSelects) {
      expect(sel.eqs).toContainEqual(['member_id', null])
    }
    // …and never appears in a delete batch.
    const deleted = calls
      .filter((c) => c.op === 'delete' && c.table === 'contact')
      .flatMap((c) => c.inFilter!.values)
    expect(deleted).toEqual(['ct-1'])
  })

  it('ignores company ids outside the workspace', async () => {
    const { client, calls } = makeServiceClient({
      companies: ['co-1'],
      contactsByCompany: { 'co-1': ['ct-1'], 'co-other': ['ct-other'] },
    })

    const result = await deleteCompaniesWithContacts(client, WS, ['co-1', 'co-other'])
    expect(result).toEqual({ companies: 1, contacts: 1 })

    // Everything past verification operates on verified ids only.
    const contactSelect = calls.find((c) => c.op === 'select' && c.table === 'contact')
    expect(contactSelect?.inFilter?.values).toEqual(['co-1'])
    const companyDel = calls.find((c) => c.op === 'delete' && c.table === 'company')
    expect(companyDel?.inFilter?.values).toEqual(['co-1'])
    const contactDel = calls.find((c) => c.op === 'delete' && c.table === 'contact')
    expect(contactDel?.inFilter?.values).toEqual(['ct-1'])
  })

  it('returns zeros without writes when no ids are in the workspace', async () => {
    const { client, calls } = makeServiceClient({
      companies: [],
      contactsByCompany: {},
    })

    const result = await deleteCompaniesWithContacts(client, WS, ['co-x'])
    expect(result).toEqual({ companies: 0, contacts: 0 })
    expect(calls.filter((c) => c.op !== 'select')).toEqual([])
  })

  it('chunks .in() lists to 100 ids per request', async () => {
    // One company with 250 contacts → contact-side writes must be chunked.
    const contactIds = Array.from({ length: 250 }, (_, i) => `ct-${i}`)
    const { client, calls } = makeServiceClient({
      companies: ['co-1'],
      contactsByCompany: { 'co-1': contactIds },
    })

    const result = await deleteCompaniesWithContacts(client, WS, ['co-1'])
    expect(result).toEqual({ companies: 1, contacts: 250 })

    const exitBatches = calls
      .filter((c) => c.op === 'update' && c.table === 'sequence_enrollment')
      .map((c) => c.inFilter!.values.length)
    expect(exitBatches).toEqual([100, 100, 50])

    const contactDeleteBatches = calls
      .filter((c) => c.op === 'delete' && c.table === 'contact')
      .map((c) => c.inFilter!.values.length)
    expect(contactDeleteBatches).toEqual([100, 100, 50])

    // All 250 contact ids covered, none twice.
    const deleted = calls
      .filter((c) => c.op === 'delete' && c.table === 'contact')
      .flatMap((c) => c.inFilter!.values)
    expect(new Set(deleted).size).toBe(250)
  })

  it('paginates contact reads past the 1000-row response cap', async () => {
    // PostgREST caps a response at 1000 rows; an unpaginated read would both
    // undercount the confirmation and orphan contacts past the cap.
    const contactIds = Array.from({ length: 1500 }, (_, i) => `ct-${i}`)
    const { client, calls } = makeServiceClient({
      companies: ['co-1'],
      contactsByCompany: { 'co-1': contactIds },
    })

    const result = await deleteCompaniesWithContacts(client, WS, ['co-1'])
    expect(result).toEqual({ companies: 1, contacts: 1500 })

    const contactSelects = calls.filter((c) => c.op === 'select' && c.table === 'contact')
    expect(contactSelects.map((c) => c.range)).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
    ])

    const deleted = calls
      .filter((c) => c.op === 'delete' && c.table === 'contact')
      .flatMap((c) => c.inFilter!.values)
    expect(new Set(deleted).size).toBe(1500)
  })

  it('chunks the company verification lookup too', async () => {
    const companyIds = Array.from({ length: 150 }, (_, i) => `co-${i}`)
    const { client, calls } = makeServiceClient({
      companies: companyIds,
      contactsByCompany: {},
    })

    const result = await deleteCompaniesWithContacts(client, WS, companyIds, {
      dryRun: true,
    })
    expect(result).toEqual({ companies: 150, contacts: 0 })

    const verifyBatches = calls
      .filter((c) => c.op === 'select' && c.table === 'company')
      .map((c) => c.inFilter!.values.length)
    expect(verifyBatches).toEqual([100, 50])
  })
})
