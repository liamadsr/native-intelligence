/**
 * The form builder's REST routes (src/lib/forms/manage.ts): a table's forms
 * listed without their links; a form made (the bot check on by default) and
 * changed only by someone who can change its table; personal links to an
 * invited form; each link's secret shown once, in the answer that made it.
 * The session client's RLS is the fake's rows; the secret tables' store is
 * mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { fakeTablesDb, type FakeTablesDb } from '@/lib/tables/__tests__/fake-tables-db'
import { FORM_TITLE_KEY, type DataForm } from '@/lib/forms/types'

const WS = 'ws-1'
const USER = 'u-1'
const T = '33333333-3333-4333-8333-333333333333'
const PRIVATE = '55555555-5555-4555-8555-555555555555'
const PIPE = '77777777-7777-4777-8777-777777777777'
const FORM_ID = '22222222-2222-4222-8222-222222222222'
const CONTACT = '11111111-1111-4111-8111-111111111111'
const KEY = `fk_${'b'.repeat(43)}`

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  createForm: vi.fn(),
  updateForm: vi.fn(),
  listForms: vi.fn(),
  findFormById: vi.fn(),
  createInvites: vi.fn(),
  websiteUsesForm: vi.fn(async () => false),
  markSiteUnwired: vi.fn(async () => {}),
}))
vi.mock('@/lib/website/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/website/store')>()
  return { ...real, websiteUsesForm: hoisted.websiteUsesForm, markSiteUnwired: hoisted.markSiteUnwired }
})
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/knowledge/entity-fences', () => ({ hiddenGraphRefs: vi.fn(async () => new Set()) }))
vi.mock('@/lib/forms/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/forms/store')>()
  return { ...real, createForm: hoisted.createForm, updateForm: hoisted.updateForm, listForms: hoisted.listForms, findFormById: hoisted.findFormById }
})
vi.mock('@/lib/forms/invites', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/forms/invites')>()
  return { ...real, createInvites: hoisted.createInvites }
})

const { GET: listTableForms, POST: createTableForm } = await import('@/app/api/account/tables/[id]/forms/route')
const { PATCH: patchForm } = await import('@/app/api/account/forms/[formId]/route')
const { POST: postInvites } = await import('@/app/api/account/forms/[formId]/invites/route')

const table = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  workspace_id: WS,
  name,
  icon: null,
  description: null,
  owner_member_id: 'm-1',
  visibility: 'workspace',
  version: 1,
  position: 0,
  archived_at: null,
  created_at: '',
  updated_at: '',
  ...extra,
})

let f: FakeTablesDb
function seed(role = 'member', editable = false) {
  f = fakeTablesDb(
    {
      data_table: [table(T, 'Website leads'), table(PRIVATE, 'Shared with me', { visibility: 'private', owner_member_id: 'm-2' }), table(PIPE, 'Sales', { table_kind: 'pipeline', kind: 'pipeline' })],
      custom_field_definition: [
        { id: 'c-1', workspace_id: WS, entity_type: 'data_row', table_id: T, key: 'email', label: 'Email', field_type: 'email', options: [], config: {}, position: 0, deleted_at: null },
        { id: 'c-2', workspace_id: WS, entity_type: 'data_row', table_id: PRIVATE, key: 'email', label: 'Email', field_type: 'email', options: [], config: {}, position: 0, deleted_at: null },
        { id: 'c-3', workspace_id: WS, entity_type: 'data_row', table_id: PIPE, key: 'stage', label: 'Stage', field_type: 'select', options: ['Lead', 'Won'], config: { outcomes: { Won: 'won' } }, position: 0, deleted_at: null, system: true },
      ],
      member: [{ id: 'm-1', workspace_id: WS, user_id: USER, role }],
      contact: [{ id: CONTACT, workspace_id: WS }],
    },
    (name) => (name === 'data_table_editable_by' ? { data: editable, error: null } : { data: null, error: null }),
  )
  hoisted.requireWorkspace.mockResolvedValue({ supabase: f.client, user: { id: USER }, workspaceId: WS })
}

const form = (extra: Partial<DataForm> = {}): DataForm => ({
  id: FORM_ID,
  workspaceId: WS,
  tableId: T,
  name: 'Contact us',
  fields: [{ key: FORM_TITLE_KEY, label: 'Name', required: true }, { key: 'email', label: 'Email', required: true }],
  access: 'public',
  allowedOrigins: [],
  thanks: null,
  description: null,
  submitLabel: null,
  botCheck: true,
  active: true,
  keyPrefix: 'fk_bbbbbb',
  createdBy: USER,
  createdAt: '',
  updatedAt: '',
  lastSubmittedAt: null,
  ...extra,
})

const get = (url: string) => buildRequest({ url, method: 'GET' }) as unknown as NextRequest
const send = (url: string, method: string, body: unknown) => buildRequest({ url, method, body }) as unknown as NextRequest
const tableCtx = (id = T) => ({ params: Promise.resolve({ id }) })
const formCtx = (formId = FORM_ID) => ({ params: Promise.resolve({ formId }) })
const base = 'https://nativeintelligence.dev/api/account'

beforeEach(() => {
  vi.clearAllMocks()
  seed()
})

describe('GET /api/account/tables/<id>/forms', () => {
  it("lists the table's forms by their settings, never their secrets", async () => {
    hoisted.listForms.mockResolvedValueOnce([form()])
    const res = await listTableForms(get(`${base}/tables/${T}/forms`), tableCtx())
    expect(res.status).toBe(200)
    const json = await readJson<{ forms: Array<Record<string, unknown>> }>(res)
    expect(hoisted.listForms).toHaveBeenCalledWith({ service: true }, WS, { tableId: T })
    expect(json.forms[0]).toMatchObject({ id: FORM_ID, bot_check: true, access: 'public', page_url_known: false, link_starts: 'fk_bbbbbb' })
    expect(JSON.stringify(json)).not.toMatch(/key_hash|fk_b{43}/)
  })

  it('is 404 for a table the asker cannot read, and for a guest', async () => {
    expect((await listTableForms(get(`${base}/tables/x/forms`), tableCtx('99999999-9999-4999-8999-999999999999'))).status).toBe(404)
    seed('guest')
    expect((await listTableForms(get(`${base}/tables/${T}/forms`), tableCtx())).status).toBe(404)
    expect(hoisted.listForms).not.toHaveBeenCalled()
  })
})

describe('POST /api/account/tables/<id>/forms', () => {
  it('makes a form, fields by column key, the bot check on by default; its links once', async () => {
    hoisted.createForm.mockImplementationOnce(async (_svc, input) => ({ form: form({ name: input.name, access: input.access, botCheck: input.botCheck }), key: KEY }))
    const res = await createTableForm(send(`${base}/tables/${T}/forms`, 'POST', { name: 'Contact us', fields: [{ key: FORM_TITLE_KEY, required: true }, { key: 'email', label: 'Your email', required: true }], submit_label: 'Send it' }), tableCtx())
    expect(res.status).toBe(201)
    const json = await readJson<{ form: Record<string, unknown>; url: string; page_url: string; embed: string }>(res)
    expect(hoisted.createForm).toHaveBeenCalledWith({ service: true }, expect.objectContaining({ workspaceId: WS, tableId: T, userId: USER, botCheck: true, access: 'public', submitLabel: 'Send it', fields: [{ key: FORM_TITLE_KEY, label: 'Name', required: true }, { key: 'email', label: 'Your email', required: true }] }))
    expect(json.url).toMatch(new RegExp(`/api/intake/forms/${KEY}$`))
    expect(json.page_url).toMatch(new RegExp(`/f/${KEY}$`))
    expect(json.embed).toContain(`data-ni-form="${KEY}"`)
    expect(JSON.stringify(json.form)).not.toContain(KEY)
  })

  it("refuses a guest (403), a pipeline's Stage and bad fields (400), and a table the asker cannot read (404); makes nothing", async () => {
    const stage = await createTableForm(send(`${base}/tables/${PIPE}/forms`, 'POST', { fields: [{ key: FORM_TITLE_KEY }, { key: 'stage' }] }), tableCtx(PIPE))
    expect(stage.status).toBe(400)
    expect((await stage.json()).error).toContain("can't be on a form")
    expect((await createTableForm(send(`${base}/tables/${T}/forms`, 'POST', { fields: [{ key: 'nope' }] }), tableCtx())).status).toBe(400)
    expect((await createTableForm(send(`${base}/tables/${T}/forms`, 'POST', { fields: 'x' }), tableCtx())).status).toBe(400)
    expect((await createTableForm(send(`${base}/tables/x/forms`, 'POST', { fields: [{ key: 'email' }] }), tableCtx('99999999-9999-4999-8999-999999999999'))).status).toBe(404)
    seed('guest')
    expect((await createTableForm(send(`${base}/tables/${T}/forms`, 'POST', { fields: [{ key: 'email' }] }), tableCtx())).status).toBe(403)
    expect(hoisted.createForm).not.toHaveBeenCalled()
  })

  it('a pipeline takes a form: each submission a new deal', async () => {
    hoisted.createForm.mockResolvedValueOnce({ form: form({ tableId: PIPE }), key: KEY })
    expect((await createTableForm(send(`${base}/tables/${PIPE}/forms`, 'POST', { fields: [{ key: FORM_TITLE_KEY }] }), tableCtx(PIPE))).status).toBe(201)
    expect(hoisted.createForm.mock.calls[0][1]).toMatchObject({ tableId: PIPE })
  })

  it('a table shared with the asker takes a form only with an edit grant', async () => {
    expect((await createTableForm(send(`${base}/tables/${PRIVATE}/forms`, 'POST', { fields: [{ key: 'email' }] }), tableCtx(PRIVATE))).status).toBe(403)
    seed('member', true)
    hoisted.createForm.mockResolvedValueOnce({ form: form({ tableId: PRIVATE }), key: KEY })
    expect((await createTableForm(send(`${base}/tables/${PRIVATE}/forms`, 'POST', { fields: [{ key: 'email' }] }), tableCtx(PRIVATE))).status).toBe(201)
  })
})

describe('PATCH /api/account/forms/<id>', () => {
  it('changes what was asked; new_link answers the new links once', async () => {
    hoisted.findFormById.mockResolvedValue(form())
    hoisted.updateForm.mockResolvedValueOnce({ form: form({ active: false }), key: null })
    const off = await patchForm(send(`${base}/forms/${FORM_ID}`, 'PATCH', { active: false, bot_check: false }), formCtx())
    expect(off.status).toBe(200)
    expect(hoisted.updateForm).toHaveBeenCalledWith({ service: true }, WS, FORM_ID, { active: false, botCheck: false })
    expect((await readJson<Record<string, unknown>>(off)).url).toBeUndefined()

    hoisted.updateForm.mockResolvedValueOnce({ form: form(), key: KEY })
    const relinked = await readJson<{ url: string; page_url: string }>(await patchForm(send(`${base}/forms/${FORM_ID}`, 'PATCH', { new_link: true }), formCtx()))
    expect(hoisted.updateForm).toHaveBeenLastCalledWith({ service: true }, WS, FORM_ID, { newLink: { userId: USER } })
    expect(relinked.page_url).toMatch(new RegExp(`/f/${KEY}$`))
  })

  it('a new link marks the connected website unwired when it was wired to this form, and says so; never otherwise', async () => {
    hoisted.findFormById.mockResolvedValue(form())
    hoisted.websiteUsesForm.mockResolvedValueOnce(true)
    hoisted.updateForm.mockResolvedValueOnce({ form: form(), key: KEY })
    const relinked = await readJson<{ website?: string; url: string }>(await patchForm(send(`${base}/forms/${FORM_ID}`, 'PATCH', { new_link: true }), formCtx()))
    expect(hoisted.websiteUsesForm).toHaveBeenCalledWith({ service: true }, WS, FORM_ID)
    expect(hoisted.markSiteUnwired).toHaveBeenCalledWith({ service: true }, WS, { kind: 'form', formId: FORM_ID })
    expect(relinked.website).toBe(`Their connected website's form used the old link, so its entries no longer arrive. Tell them, and offer to reconnect it (wire_website_form with form_id ${FORM_ID}).`)
    expect(relinked.url).toContain(KEY)

    // A website wired elsewhere, or a change that is not a new link: nothing marked, nothing said.
    hoisted.markSiteUnwired.mockClear()
    hoisted.updateForm.mockResolvedValueOnce({ form: form(), key: KEY })
    expect((await readJson<{ website?: string }>(await patchForm(send(`${base}/forms/${FORM_ID}`, 'PATCH', { new_link: true }), formCtx()))).website).toBeUndefined()
    hoisted.websiteUsesForm.mockClear()
    hoisted.updateForm.mockResolvedValueOnce({ form: form({ name: 'Renamed' }), key: null })
    expect((await readJson<{ website?: string }>(await patchForm(send(`${base}/forms/${FORM_ID}`, 'PATCH', { name: 'Renamed' }), formCtx()))).website).toBeUndefined()
    expect(hoisted.websiteUsesForm).not.toHaveBeenCalled()
    expect(hoisted.markSiteUnwired).not.toHaveBeenCalled()
  })

  it('the website part never fails the new link: a check that fails reads as not wired, a mark that fails still tells', async () => {
    hoisted.findFormById.mockResolvedValue(form())
    hoisted.websiteUsesForm.mockRejectedValueOnce(new Error('down'))
    hoisted.updateForm.mockResolvedValueOnce({ form: form(), key: KEY })
    const checked = await patchForm(send(`${base}/forms/${FORM_ID}`, 'PATCH', { new_link: true }), formCtx())
    expect(checked.status).toBe(200)
    expect((await readJson<{ website?: string }>(checked)).website).toBeUndefined()
    hoisted.websiteUsesForm.mockResolvedValueOnce(true)
    hoisted.markSiteUnwired.mockRejectedValueOnce(new Error('write failed'))
    hoisted.updateForm.mockResolvedValueOnce({ form: form(), key: KEY })
    const marked = await patchForm(send(`${base}/forms/${FORM_ID}`, 'PATCH', { new_link: true }), formCtx())
    expect(marked.status).toBe(200)
    expect((await readJson<{ website?: string }>(marked)).website).toContain('no longer arrive')
  })

  it("is 404 for another workspace's form or one on a table the asker can't read, 403 for a guest, 400 for nothing to change", async () => {
    hoisted.findFormById.mockResolvedValueOnce(form({ workspaceId: 'ws-other' }))
    expect((await patchForm(send(`${base}/forms/${FORM_ID}`, 'PATCH', { active: false }), formCtx())).status).toBe(404)
    hoisted.findFormById.mockResolvedValueOnce(form({ tableId: '99999999-9999-4999-8999-999999999999' }))
    expect((await patchForm(send(`${base}/forms/${FORM_ID}`, 'PATCH', { active: false }), formCtx())).status).toBe(404)
    expect((await patchForm(send(`${base}/forms/x`, 'PATCH', { active: false }), formCtx('not-an-id'))).status).toBe(404)
    hoisted.findFormById.mockResolvedValue(form())
    expect((await patchForm(send(`${base}/forms/${FORM_ID}`, 'PATCH', {}), formCtx())).status).toBe(400)
    seed('guest')
    expect((await patchForm(send(`${base}/forms/${FORM_ID}`, 'PATCH', { active: true }), formCtx())).status).toBe(403)
    expect(hoisted.updateForm).not.toHaveBeenCalled()
  })
})

describe("a change that stops a wired website's own form", () => {
  const FILES = { key: '$files', label: 'Photos', required: false }
  it.each([
    ['turning the bot check on', form({ botCheck: false }), { bot_check: true }, form({ botCheck: true }), "can't run the bot check"],
    ['taking it away from anyone with the link', form({ botCheck: false }), { access: 'members' }, form({ botCheck: false, access: 'members' }), 'anyone with the link'],
    ['switching it off', form({ botCheck: false }), { active: false }, form({ botCheck: false, active: false }), 'while the form is off'],
    ['adding a files field', form(), { fields: [{ key: FORM_TITLE_KEY, required: true }, { key: 'email', required: true }, FILES] }, form({ fields: [...form().fields, FILES] }), "can't send files"],
  ])('%s marks the site unwired and says what stopped and what to do', async (_, before, body, after, words) => {
    hoisted.findFormById.mockResolvedValue(before)
    hoisted.websiteUsesForm.mockResolvedValueOnce(true)
    hoisted.updateForm.mockResolvedValueOnce({ form: after, key: null })
    const res = await patchForm(send(`${base}/forms/${FORM_ID}`, 'PATCH', body), formCtx())
    expect(res.status).toBe(200)
    const json = await readJson<{ website?: string }>(res)
    expect(hoisted.markSiteUnwired).toHaveBeenCalledWith({ service: true }, WS, { kind: 'form', formId: FORM_ID })
    expect(json.website).toContain(words)
    expect(json.website).toContain(`wire_website_form with form_id ${FORM_ID}`)
  })

  it('the same change on a form no website is wired to marks and says nothing; a harmless change reads no wiring', async () => {
    hoisted.findFormById.mockResolvedValue(form({ botCheck: false }))
    hoisted.updateForm.mockResolvedValueOnce({ form: form({ botCheck: true }), key: null })
    expect((await readJson<{ website?: string }>(await patchForm(send(`${base}/forms/${FORM_ID}`, 'PATCH', { bot_check: true }), formCtx()))).website).toBeUndefined()
    expect(hoisted.markSiteUnwired).not.toHaveBeenCalled()
    hoisted.websiteUsesForm.mockClear()
    hoisted.updateForm.mockResolvedValueOnce({ form: form({ botCheck: false, thanks: 'Thanks!' }), key: null })
    await patchForm(send(`${base}/forms/${FORM_ID}`, 'PATCH', { thanks: 'Thanks!' }), formCtx())
    expect(hoisted.websiteUsesForm).not.toHaveBeenCalled()
  })

  it('the agent’s tools, which pass no earlier form, have it read first and get the same note', async () => {
    const { writeFormChange } = await import('@/lib/forms/manage')
    hoisted.findFormById.mockResolvedValueOnce(form({ botCheck: false }))
    hoisted.websiteUsesForm.mockResolvedValueOnce(true)
    const out = await writeFormChange({ service: true } as never, { workspaceId: WS, formId: FORM_ID, newLink: false }, async () => ({ form: form({ botCheck: true }), key: null }))
    expect(hoisted.findFormById).toHaveBeenCalledWith({ service: true }, FORM_ID)
    expect(out.website).toContain("can't run the bot check")
    // An earlier form that can't be read: nothing said, the change still written.
    hoisted.findFormById.mockRejectedValueOnce(new Error('down'))
    const unread = await writeFormChange({ service: true } as never, { workspaceId: WS, formId: FORM_ID, newLink: false }, async () => ({ form: form({ botCheck: true }), key: null }))
    expect(unread).toEqual({ written: { form: expect.objectContaining({ botCheck: true }), key: null }, website: null })
  })
})

describe('POST /api/account/forms/<id>/invites', () => {
  it('makes personal links to an invited form, once', async () => {
    hoisted.findFormById.mockResolvedValue(form({ access: 'invited' }))
    hoisted.createInvites.mockResolvedValueOnce([{ id: 'inv-1', label: 'Sam Rivera', contactId: CONTACT, url: 'https://nativeintelligence.dev/f/fi_x', expiresAt: '2026-11-29T00:00:00.000Z' }])
    const res = await postInvites(send(`${base}/forms/${FORM_ID}/invites`, 'POST', { invites: [{ label: 'Sam Rivera', contact_id: CONTACT }], expires_in_days: 14 }), formCtx())
    expect(res.status).toBe(201)
    expect(await readJson(res)).toEqual({ invites: [{ id: 'inv-1', label: 'Sam Rivera', contact_id: CONTACT, url: 'https://nativeintelligence.dev/f/fi_x', expires_at: '2026-11-29T00:00:00.000Z' }], expires_in_days: 14 })
    expect(hoisted.createInvites).toHaveBeenCalledWith({ service: true }, expect.objectContaining({ id: FORM_ID }), [{ label: 'Sam Rivera', contactId: CONTACT }], expect.objectContaining({ userId: USER, expiresInDays: 14 }))
  })

  it("refuses a form that isn't for invited people, a contact the asker can't see, and a guest", async () => {
    hoisted.findFormById.mockResolvedValue(form())
    expect((await postInvites(send(`${base}/forms/${FORM_ID}/invites`, 'POST', { invites: [{}] }), formCtx())).status).toBe(400)
    hoisted.findFormById.mockResolvedValue(form({ access: 'invited' }))
    expect((await postInvites(send(`${base}/forms/${FORM_ID}/invites`, 'POST', { invites: [{ contact_id: '44444444-4444-4444-8444-444444444444' }] }), formCtx())).status).toBe(400)
    seed('guest')
    expect((await postInvites(send(`${base}/forms/${FORM_ID}/invites`, 'POST', { invites: [{}] }), formCtx())).status).toBe(403)
    expect(hoisted.createInvites).not.toHaveBeenCalled()
  })
})
