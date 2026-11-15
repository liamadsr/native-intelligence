/**
 * upsertCustomerContact and the contact_created loops: a contact it MADE (a
 * website form's, a quote's, a customer's first text's) starts them at once;
 * a contact it found starts nothing; a workspace with no such loop sends
 * nothing; and a send that fails never fails the intake.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ send: vi.fn(async (..._args: unknown[]) => ({ ids: ['e'] })) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: (...args: unknown[]) => h.send(...args) } }))

const { settleCustomerContact, upsertCustomerContact } = await import('../contacts')

const WS = 'ws-fernhill'
const OWNER = 'u-ana'

/**
 * A client with one workspace's contacts (`existing`) and `loops` enabled
 * contact_created loops. Records what it inserts.
 */
function client(opts: { existing?: Array<Record<string, unknown>>; loops?: number; flowReadFails?: boolean } = {}) {
  const inserted: Array<Record<string, unknown>> = []
  const updated: Array<Record<string, unknown>> = []
  const flowFilters: Array<Record<string, unknown>> = []
  const from = (table: string) => {
    const f: Record<string, unknown> = {}
    const q: Record<string, unknown> = {}
    const chain = (name: string) => (...args: unknown[]) => {
      if (name === 'eq') f[args[0] as string] = args[1]
      return q
    }
    for (const m of ['select', 'eq', 'is', 'or', 'ilike', 'limit']) q[m] = chain(m)
    if (table === 'contact') {
      q.maybeSingle = async () => ({ data: (opts.existing ?? [])[0] ?? null, error: null })
      q.insert = (row: Record<string, unknown>) => {
        inserted.push(row)
        return { select: () => ({ single: async () => ({ data: { id: 'c-new', full_name: row.full_name, email: row.email, phone: row.phone, relationship_type: 'lead' }, error: null }) }) }
      }
      q.update = (patch: Record<string, unknown>) => {
        updated.push(patch)
        return { eq: () => ({ eq: async () => ({ error: null }) }) }
      }
      // The phone lookup awaits the query itself.
      q.then = (cb: (v: unknown) => unknown) => Promise.resolve({ data: opts.existing ?? [], error: null }).then(cb)
    } else if (table === 'member') {
      q.maybeSingle = async () => ({ data: { id: 'm-ana' }, error: null })
    } else if (table === 'flow') {
      q.limit = () => {
        flowFilters.push({ ...f })
        return Promise.resolve(opts.flowReadFails ? { count: null, error: { message: 'down' } } : { count: opts.loops ?? 0, error: null })
      }
    }
    return q
  }
  return { supabase: { from } as unknown as SupabaseClient, inserted, updated, flowFilters }
}

const form = { name: 'Rosa Diaz', email: 'rosa@fernhill.example', phone: null, source: 'web_form' as const }

beforeEach(() => {
  h.send.mockReset()
  h.send.mockResolvedValue({ ids: ['e'] })
})

describe("upsertCustomerContact and the workspace's contact loops", () => {
  it('a contact it made starts them at once (no delay), its id only', async () => {
    const { supabase, flowFilters } = client({ loops: 1 })
    const made = await upsertCustomerContact(supabase, { workspaceId: WS, ownerUserId: OWNER }, form)
    expect(made).toMatchObject({ id: 'c-new', created: true })
    expect(flowFilters).toEqual([{ workspace_id: WS, enabled: true, trigger_type: 'contact_created' }])
    expect(h.send).toHaveBeenCalledOnce()
    const event = h.send.mock.calls[0][0] as { name: string; id: string; ts?: number; data: Record<string, unknown> }
    expect(event).toMatchObject({ name: 'flow/contact.created', id: 'contact-created:c-new', data: { workspace_id: WS, contact_id: 'c-new', source: 'form' } })
    expect(event.ts).toBeUndefined()
    // Never the stranger's words.
    expect(JSON.stringify(event)).not.toMatch(/Rosa|rosa@/)
  })

  it('a contact it found starts nothing', async () => {
    const { supabase, flowFilters } = client({ loops: 1, existing: [{ id: 'c-old', full_name: 'Rosa Diaz', email: 'rosa@fernhill.example', phone: null, relationship_type: 'lead' }] })
    const found = await upsertCustomerContact(supabase, { workspaceId: WS, ownerUserId: OWNER }, form)
    expect(found).toMatchObject({ id: 'c-old', created: false })
    expect(flowFilters).toEqual([])
    expect(h.send).not.toHaveBeenCalled()
  })

  it('a workspace with no contact loop sends nothing', async () => {
    const { supabase } = client({ loops: 0 })
    expect(await upsertCustomerContact(supabase, { workspaceId: WS, ownerUserId: OWNER }, { ...form, source: 'sms', email: null, phone: '+15555550142' })).toMatchObject({ created: true })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('a failed send, or a failed read of the loops, never fails the intake', async () => {
    h.send.mockRejectedValue(new Error('inngest down'))
    const { supabase, inserted } = client({ loops: 1 })
    expect(await upsertCustomerContact(supabase, { workspaceId: WS, ownerUserId: OWNER }, form)).toMatchObject({ id: 'c-new', created: true })
    expect(inserted).toHaveLength(1)
    // A read that fails is answered as "there may be one" (the dispatcher finds nothing): still never a throw.
    const failing = client({ flowReadFails: true })
    expect(await upsertCustomerContact(failing.supabase, { workspaceId: WS, ownerUserId: OWNER }, form)).toMatchObject({ created: true })
    const throwing = vi.fn(async () => {
      throw new Error('boom')
    })
    expect(await upsertCustomerContact(client({ loops: 1 }).supabase, { workspaceId: WS, ownerUserId: OWNER }, form, { notify: throwing })).toMatchObject({ created: true })
    expect(throwing).toHaveBeenCalledOnce()
  })
})

describe('a deferred upsert (a form: changed and its loops started only once the row is stored)', () => {
  const placeholder = { id: 'c-old', full_name: 'Customer ending 0142', email: 'rosa@fernhill.example', phone: null, relationship_type: 'contact' }

  it('a found contact is linked but not changed: the change comes back for later', async () => {
    const { supabase, updated } = client({ existing: [placeholder] })
    const found = await upsertCustomerContact(supabase, { workspaceId: WS, ownerUserId: OWNER }, form, { defer: true })
    expect(found).toMatchObject({ id: 'c-old', created: false, fullName: 'Customer ending 0142', deferred: { patch: { full_name: 'Rosa Diaz', relationship_type: 'lead' }, notify: false } })
    expect(updated).toEqual([])
    await settleCustomerContact(supabase, { workspaceId: WS, contactId: 'c-old' }, found!.deferred!)
    expect(updated).toEqual([expect.objectContaining({ full_name: 'Rosa Diaz', relationship_type: 'lead' })])
  })

  it('a made contact starts no loop until it is settled', async () => {
    const { supabase, inserted } = client({ loops: 1 })
    const made = await upsertCustomerContact(supabase, { workspaceId: WS, ownerUserId: OWNER }, form, { defer: true })
    expect(made).toMatchObject({ id: 'c-new', created: true, deferred: { patch: null, notify: true } })
    expect(inserted).toHaveLength(1)
    expect(h.send).not.toHaveBeenCalled()
    await settleCustomerContact(supabase, { workspaceId: WS, contactId: 'c-new' }, made!.deferred!)
    expect(h.send).toHaveBeenCalledOnce()
  })

  it('without defer, nothing changes from before: the change and the loops happen at once (the quote intake, a text)', async () => {
    const found = client({ existing: [placeholder] })
    const r = await upsertCustomerContact(found.supabase, { workspaceId: WS, ownerUserId: OWNER }, form)
    expect(r).toMatchObject({ fullName: 'Rosa Diaz' })
    expect(r).not.toHaveProperty('deferred')
    expect(found.updated).toHaveLength(1)
  })

  it('settling with nothing held back writes nothing and sends nothing', async () => {
    const { supabase, updated } = client({ loops: 1 })
    await settleCustomerContact(supabase, { workspaceId: WS, contactId: 'c-old' }, { patch: null, notify: false })
    expect(updated).toEqual([])
    expect(h.send).not.toHaveBeenCalled()
  })
})
