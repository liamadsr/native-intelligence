/**
 * The real stores behind a form's public side (../deps.ts): a personal
 * link's secret opens its form only while the link is good and the form is
 * still `invited`; a members form is for members, never a guest; a
 * submission's contact is found or made at once but changed (only when its
 * maker can see it) and its loops started only when the row is stored; and
 * the row an unclear write left is looked for in its own table. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(async () => ({ user: { id: 'u-sam' } }) as unknown),
  upsert: vi.fn(),
  settle: vi.fn(async () => {}),
  visible: vi.fn(async () => true),
}))
vi.mock('@/lib/api-auth', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/customers/contacts', () => ({ upsertCustomerContact: h.upsert, settleCustomerContact: h.settle }))
vi.mock('@/lib/crm/contact-visibility', () => ({ isContactVisibleTo: h.visible }))
vi.mock('@/lib/flows/emit-record-created', () => ({ emitRecordsCreated: vi.fn() }))
vi.mock('@/lib/flows/event-triggers', () => ({ workspaceHasEventFlows: vi.fn(async () => false) }))
vi.mock('@/lib/tables/store', () => ({ applyOps: vi.fn(), getTable: vi.fn() }))
vi.mock('@/lib/website/intake-test', () => ({ takeIntakeTest: vi.fn() }))

const { findFormByLink, formGateDeps, formSubmitDeps } = await import('../deps')
const { generateInviteToken, hashInviteToken } = await import('../invites')
const { FORM_TITLE_KEY } = await import('../types')

type Row = Record<string, unknown>

/** A client over a few tables: every select chain filters by its .eq() calls and answers maybeSingle with the first match. */
function db(tables: Record<string, Row[]>) {
  const reads: Array<{ table: string; filters: Row }> = []
  const from = (table: string) => {
    const filters: Row = {}
    const q: Record<string, unknown> = {}
    q.select = () => q
    q.eq = (col: string, v: unknown) => {
      filters[col] = v
      return q
    }
    q.maybeSingle = async () => {
      reads.push({ table, filters: { ...filters } })
      const row = (tables[table] ?? []).find((r) => Object.entries(filters).every(([k, v]) => r[k] === v)) ?? null
      return { data: row, error: null }
    }
    return q
  }
  return { client: { from } as unknown as SupabaseClient, reads }
}

const FORM_ROW = (extra: Row = {}): Row => ({
  id: 'form-1',
  workspace_id: 'ws-1',
  table_id: 't-1',
  name: 'Rug repairs',
  fields: [{ key: FORM_TITLE_KEY, label: 'Name', required: true }],
  access: 'invited',
  allowed_origins: [],
  thanks: null,
  description: null,
  submit_label: null,
  bot_check: true,
  active: true,
  key_prefix: 'fk_abcdef',
  created_by: 'u-owner',
  created_at: '',
  updated_at: '',
  last_submitted_at: null,
  ...extra,
})

const TOKEN = generateInviteToken()
const LATER = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString()
const EARLIER = new Date(Date.now() - 60_000).toISOString()
const INVITE = (extra: Row = {}): Row => ({ id: 'inv-1', form_id: 'form-1', token_hash: hashInviteToken(TOKEN), label: null, contact_id: null, created_by: 'u-owner', created_at: '', expires_at: LATER, used_at: null, row_id: null, ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireUser.mockResolvedValue({ user: { id: 'u-sam' } })
})

describe("a personal link's secret", () => {
  it('opens its invited form while it is unused and not lapsed', async () => {
    const { client } = db({ data_form_invite: [INVITE()], data_form: [FORM_ROW()] })
    expect((await formGateDeps(client).formOfInvite(TOKEN))?.id).toBe('form-1')
    expect((await formSubmitDeps(client).formOfInvite!(TOKEN))?.id).toBe('form-1')
    expect((await findFormByLink(client, TOKEN))?.id).toBe('form-1')
  })

  it('opens nothing once used or lapsed', async () => {
    for (const invite of [INVITE({ used_at: EARLIER }), INVITE({ expires_at: EARLIER })]) {
      const { client } = db({ data_form_invite: [invite], data_form: [FORM_ROW()] })
      expect(await formGateDeps(client).formOfInvite(TOKEN)).toBeNull()
      expect(await findFormByLink(client, TOKEN)).toBeNull()
    }
  })

  it('opens nothing once its form is switched to public or members: every link ever made stops, a new form link or not', async () => {
    for (const access of ['public', 'members']) {
      const { client } = db({ data_form_invite: [INVITE()], data_form: [FORM_ROW({ access })] })
      expect(await formGateDeps(client).formOfInvite(TOKEN), access).toBeNull()
      expect(await formSubmitDeps(client).formOfInvite!(TOKEN), access).toBeNull()
      expect(await findFormByLink(client, TOKEN), access).toBeNull()
    }
  })

  it('a switched-off invited form is still found (the caller answers it closed)', async () => {
    const { client } = db({ data_form_invite: [INVITE()], data_form: [FORM_ROW({ active: false })] })
    expect((await formGateDeps(client).formOfInvite(TOKEN))?.active).toBe(false)
  })
})

describe('who is a member, for a members form', () => {
  it("a member is; a guest of the workspace isn't, and nor is someone with no member row; signed out is said so", async () => {
    const req = new Request('https://nativeintelligence.dev/api/intake/forms/x', { method: 'POST' })
    const members = db({ member: [{ id: 'm-sam', workspace_id: 'ws-1', user_id: 'u-sam', role: 'member' }] })
    expect(await formSubmitDeps(members.client).memberOf(req, 'ws-1')).toBe('member')
    expect(await formGateDeps(members.client).memberOf('ws-1')).toBe('member')
    const guests = db({ member: [{ id: 'm-sam', workspace_id: 'ws-1', user_id: 'u-sam', role: 'guest' }] })
    expect(await formSubmitDeps(guests.client).memberOf(req, 'ws-1')).toBe('not_member')
    expect(await formGateDeps(guests.client).memberOf('ws-1')).toBe('not_member')
    expect(await formSubmitDeps(db({ member: [] }).client).memberOf(req, 'ws-1')).toBe('not_member')
    h.requireUser.mockResolvedValueOnce(new Response(null, { status: 401 }))
    expect(await formGateDeps(members.client).memberOf('ws-1')).toBe('signed_out')
  })
})

describe("a submission's contact", () => {
  const form = { id: 'form-1', workspaceId: 'ws-1', tableId: 't-1', createdBy: 'u-owner' } as Parameters<ReturnType<typeof formSubmitDeps>['upsertContact']>[0]
  const who = { name: 'Rosa Diaz', email: 'rosa@fernhill.example', phone: null }

  it('is found or made deferred: nothing changes and no loop starts until the stored row settles it', async () => {
    h.upsert.mockResolvedValueOnce({ id: 'c-old', fullName: 'Customer ending 0142', email: null, phone: '+15555550142', created: false, deferred: { patch: { full_name: 'Rosa Diaz', relationship_type: 'lead' }, notify: false } })
    const found = await formSubmitDeps(db({}).client).upsertContact(form, who)
    expect(h.upsert).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-1', ownerUserId: 'u-owner' }, { ...who, source: 'web_form' }, { defer: true })
    expect(found).toMatchObject({ id: 'c-old' })
    expect(h.settle).not.toHaveBeenCalled()
    await (found as { settle: () => Promise<void> }).settle()
    expect(h.visible).toHaveBeenCalledWith(expect.anything(), 'c-old', 'u-owner', { grants: false })
    expect(h.settle).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-1', contactId: 'c-old' }, { patch: { full_name: 'Rosa Diaz', relationship_type: 'lead' }, notify: false })
  })

  it("a found contact the form's maker can't see is never changed", async () => {
    h.visible.mockResolvedValueOnce(false)
    h.upsert.mockResolvedValueOnce({ id: 'c-private', fullName: 'Rosa', email: 'rosa@fernhill.example', phone: null, created: false, deferred: { patch: { relationship_type: 'lead' }, notify: false } })
    const found = (await formSubmitDeps(db({}).client).upsertContact(form, who)) as { settle: () => Promise<void> }
    await found.settle()
    expect(h.settle).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-1', contactId: 'c-private' }, { patch: null, notify: false })
  })

  it("a made contact's loops are owed, started when it settles; no visibility read is needed with nothing to change", async () => {
    h.upsert.mockResolvedValueOnce({ id: 'c-new', fullName: 'Rosa Diaz', email: 'rosa@fernhill.example', phone: null, created: true, deferred: { patch: null, notify: true } })
    const made = (await formSubmitDeps(db({}).client).upsertContact(form, who)) as { settle: () => Promise<void> }
    await made.settle()
    expect(h.visible).not.toHaveBeenCalled()
    expect(h.settle).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-1', contactId: 'c-new' }, { patch: null, notify: true })
  })
})

describe('the row an unclear write left', () => {
  it("is looked for by its id in the form's own table and workspace", async () => {
    const { client, reads } = db({ data_row: [{ id: 'row-1', table_id: 't-1', workspace_id: 'ws-1' }] })
    const deps = formSubmitDeps(client)
    const form = { id: 'form-1', workspaceId: 'ws-1', tableId: 't-1' } as Parameters<NonNullable<typeof deps.rowExists>>[0]
    expect(await deps.rowExists!(form, 'row-1')).toBe(true)
    expect(await deps.rowExists!(form, 'row-2')).toBe(false)
    expect(await deps.rowExists!({ ...form, tableId: 't-other' }, 'row-1')).toBe(false)
    expect(reads[0]).toEqual({ table: 'data_row', filters: { id: 'row-1', table_id: 't-1', workspace_id: 'ws-1' } })
  })
})
