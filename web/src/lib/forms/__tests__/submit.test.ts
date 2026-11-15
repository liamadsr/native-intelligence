/**
 * POST /api/intake/forms/<key> (../submit.ts): the key, who may submit, the
 * caps, the body, the repeat, the contact, then one row written; and what a
 * stranger holding the link can never do.
 */
import { describe, expect, it, vi } from 'vitest'
import type { DataColumn } from '@/lib/tables/types'
import { FORM_CLIENT_HOURLY_CAP, FORM_HOURLY_CAP, contactColumnOf, formCorsHeaders, handleFormSubmit, sameSite, type FormSubmitDeps } from '../submit'
import { formClientKey, senderNetwork } from '../client'
import { generateFormKey, hashFormKey, isFormKeyShape } from '../store'
import { FORM_TITLE_KEY, type DataForm } from '../types'

const KEY = generateFormKey()

const col = (key: string, label: string, field_type: DataColumn['field_type'], extra: Partial<DataColumn> = {}): DataColumn => ({
  id: `col-${key}`,
  table_id: 't1',
  key,
  label,
  field_type,
  options: [],
  config: {},
  position: 0,
  deleted_at: null,
  ...extra,
})
const COLUMNS = [col('email', 'Email', 'email'), col('message', 'Message', 'text'), col('customer', 'Customer', 'relation', { config: { target: { kind: 'contact' } } })]

const FORM: DataForm = {
  id: 'form-1',
  workspaceId: 'ws-1',
  tableId: 't1',
  name: 'Contact us',
  fields: [
    { key: FORM_TITLE_KEY, label: 'Name', required: true },
    { key: 'email', label: 'Email', required: true },
    { key: 'message', label: 'Message', required: false },
  ],
  access: 'public',
  allowedOrigins: [],
  thanks: 'Thanks, we will be in touch.',
  active: true,
  keyPrefix: 'fk_abcdef',
  createdBy: 'user-owner',
  createdAt: '',
  updatedAt: '',
  lastSubmittedAt: null,
}

function deps(form: Partial<DataForm> = {}, over: Partial<FormSubmitDeps> = {}) {
  const live = { ...FORM, ...form }
  const d = {
    findForm: vi.fn(async (k: string) => (k === KEY ? live : null)),
    clientKey: vi.fn(() => 'client-a'),
    memberOf: vi.fn(async () => 'member' as const),
    countFormAttempts: vi.fn(async () => 0),
    countClientAttempts: vi.fn(async () => 0),
    columns: vi.fn(async () => COLUMNS as DataColumn[] | null),
    openAttempt: vi.fn(async () => 'att-1'),
    claimAttempt: vi.fn(async () => ({ kind: 'new' }) as { kind: 'new' } | { kind: 'repeat'; rowId: string | null }),
    canWrite: vi.fn(async () => true),
    markStored: vi.fn(async () => {}),
    releaseAttempt: vi.fn(async () => {}),
    upsertContact: vi.fn(async () => 'contact-1' as string | null),
    writeRow: vi.fn<FormSubmitDeps['writeRow']>(async () => ({ ok: true })),
    now: () => Date.parse('2026-11-15T12:00:00Z'),
    newId: vi.fn(() => 'row-1'),
    ...over,
  } satisfies FormSubmitDeps
  return d
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://nativeintelligence.dev/api/intake/forms/x', { method: 'POST', headers: { 'content-type': 'application/json', host: 'nativeintelligence.dev', ...headers }, body: JSON.stringify(body) })
}
const GOOD = { name: 'Sarah Lindqvist', email: 'sarah@example.com', message: 'Two rugs.' }

describe('the key', () => {
  it('a wrong or malformed key is 404 and reads nothing', async () => {
    const d = deps()
    expect((await handleFormSubmit(post(GOOD), 'fk_wrong', d)).status).toBe(404)
    expect(d.columns).not.toHaveBeenCalled()
    expect(d.writeRow).not.toHaveBeenCalled()
  })

  it('keys are fk_ plus 43 base64url characters, stored only as their SHA-256', () => {
    expect(isFormKeyShape(KEY)).toBe(true)
    expect(isFormKeyShape('fk_short')).toBe(false)
    expect(isFormKeyShape(`qk_${KEY.slice(3)}`)).toBe(false)
    expect(hashFormKey(KEY)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashFormKey(KEY)).not.toContain(KEY.slice(3))
  })

  it('a switched-off form, or one whose table is gone, is closed (410) and writes nothing', async () => {
    const off = deps({ active: false })
    expect((await handleFormSubmit(post(GOOD), KEY, off)).status).toBe(410)
    expect(off.writeRow).not.toHaveBeenCalled()
    const gone = deps({}, { columns: vi.fn(async () => null) })
    expect((await handleFormSubmit(post(GOOD), KEY, gone)).status).toBe(410)
    expect(gone.writeRow).not.toHaveBeenCalled()
  })
})

describe('a submission', () => {
  it('writes ONE row through the form\'s own fields (201), with the contact linked, and answers only its id and the thank-you', async () => {
    const d = deps()
    const res = await handleFormSubmit(post({ ...GOOD, customer: ['someone-else'], id: 'row-9', owner: 'm1' }), KEY, d)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true, id: 'row-1', thanks: 'Thanks, we will be in touch.' })
    expect(d.writeRow).toHaveBeenCalledTimes(1)
    expect(d.writeRow).toHaveBeenCalledWith(expect.objectContaining({ id: 'form-1' }), {
      id: 'row-1',
      title: 'Sarah Lindqvist',
      // The relation is the contact the server found or made, never an id the post named.
      values: { email: 'sarah@example.com', message: 'Two rugs.', customer: ['contact-1'] },
    })
    expect(d.upsertContact).toHaveBeenCalledWith(expect.anything(), { name: 'Sarah Lindqvist', email: 'sarah@example.com', phone: null })
    expect(d.markStored).toHaveBeenCalledWith('att-1', 'form-1')
  })

  it("a stored submission starts what follows it (the table's loops), and a failure there never loses the answer", async () => {
    const afterStored = vi.fn(async () => {})
    const d = deps({}, { afterStored })
    expect((await handleFormSubmit(post(GOOD), KEY, d)).status).toBe(201)
    expect(afterStored).toHaveBeenCalledWith(expect.objectContaining({ id: 'form-1', tableId: 't1' }), 'row-1')
    const failing = deps({}, { afterStored: vi.fn(async () => { throw new Error('inngest down') }) })
    expect((await handleFormSubmit(post(GOOD), KEY, failing)).status).toBe(201)
    // Nothing follows a refused, repeated or bot post.
    const refused = vi.fn(async () => {})
    await handleFormSubmit(post({ name: 'Sam', email: 'nope' }), KEY, deps({}, { afterStored: refused }))
    await handleFormSubmit(post({ ...GOOD, _gotcha: 'x' }), KEY, deps({}, { afterStored: refused }))
    await handleFormSubmit(post(GOOD), KEY, deps({}, { afterStored: refused, claimAttempt: vi.fn(async () => ({ kind: 'repeat', rowId: 'row-0' }) as const) }))
    expect(refused).not.toHaveBeenCalled()
  })

  it('a contact that can\'t be made never loses the row', async () => {
    const d = deps({}, { upsertContact: vi.fn(async () => { throw new Error('down') }) })
    expect((await handleFormSubmit(post(GOOD), KEY, d)).status).toBe(201)
    expect(d.writeRow).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ values: { email: 'sarah@example.com', message: 'Two rugs.' } }))
  })

  it('a value that does not fit, or a required field left empty, is 400, already counted, and writes nothing', async () => {
    const d = deps()
    const res = await handleFormSubmit(post({ name: 'Sam', email: 'nope' }), KEY, d)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Email needs an email address.')
    expect(d.openAttempt).toHaveBeenCalledWith('form-1', 'client-a')
    expect(d.claimAttempt).not.toHaveBeenCalled()
    expect(d.writeRow).not.toHaveBeenCalled()
  })

  it('a honeypot hit is answered exactly as a stored one is, and writes nothing', async () => {
    const d = deps()
    const res = await handleFormSubmit(post({ ...GOOD, _gotcha: 'bot' }), KEY, d)
    const real = await handleFormSubmit(post(GOOD), KEY, deps())
    expect(res.status).toBe(real.status)
    expect(Object.keys(await res.json()).sort()).toEqual(Object.keys(await real.json()).sort())
    expect(d.writeRow).not.toHaveBeenCalled()
    expect(d.upsertContact).not.toHaveBeenCalled()
    expect(d.claimAttempt).not.toHaveBeenCalled()
  })

  it('a re-posted submission is stored once: 200 with the row it stored', async () => {
    const d = deps({}, { claimAttempt: vi.fn(async () => ({ kind: 'repeat', rowId: 'row-0' }) as const) })
    const res = await handleFormSubmit(post({ ...GOOD, submission_id: 'sub-1' }), KEY, d)
    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe('row-0')
    expect(d.claimAttempt).toHaveBeenCalledWith({ attemptId: 'att-1', formId: 'form-1', clientHash: 'client-a', externalId: 'sub-1', rowId: 'row-1' })
    expect(d.writeRow).not.toHaveBeenCalled()
    expect(d.upsertContact).not.toHaveBeenCalled()
  })

  it('a repeat whose first post is not stored yet is never told "stored": 409', async () => {
    const d = deps({}, { claimAttempt: vi.fn(async () => ({ kind: 'repeat', rowId: null }) as const) })
    const res = await handleFormSubmit(post({ ...GOOD, submission_id: 'sub-1' }), KEY, d)
    expect(res.status).toBe(409)
    expect(d.writeRow).not.toHaveBeenCalled()
  })

  it("a contact the form's maker can't see never loses the row: it is stored without the link, and the sender can't tell", async () => {
    const writeRow = vi
      .fn<FormSubmitDeps['writeRow']>()
      .mockResolvedValueOnce({ ok: false, reason: 'invalid', error: "Customer links a record that isn't one you can link to" })
      .mockResolvedValueOnce({ ok: true })
    const d = deps({}, { writeRow })
    const res = await handleFormSubmit(post(GOOD), KEY, d)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true, id: 'row-1', thanks: 'Thanks, we will be in touch.' })
    expect(writeRow).toHaveBeenCalledTimes(2)
    expect(writeRow.mock.calls[1][1]).toEqual({ id: 'row-1', title: 'Sarah Lindqvist', values: { email: 'sarah@example.com', message: 'Two rugs.' } })
    expect(d.markStored).toHaveBeenCalled()
  })

  it("a write the table refuses frees the submission id and never tells the sender why", async () => {
    const invalid = deps({}, { writeRow: vi.fn<FormSubmitDeps['writeRow']>(async () => ({ ok: false, reason: 'invalid', error: 'Stage is required while Status is Won' })) })
    const res = await handleFormSubmit(post({ name: 'Sam', message: 'hi', email: 'sam@example.com' }), KEY, deps({}, { ...invalid, upsertContact: vi.fn(async () => null) }))
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).not.toContain('Stage')
    const lost = deps({}, { writeRow: vi.fn<FormSubmitDeps['writeRow']>(async () => ({ ok: false, reason: 'unavailable', error: 'forbidden: you can view this table but not change it' })), upsertContact: vi.fn(async () => null) })
    const res2 = await handleFormSubmit(post(GOOD), KEY, lost)
    expect(res2.status).toBe(500)
    expect(JSON.stringify(await res2.json())).not.toContain('view this table')
    expect(lost.releaseAttempt).toHaveBeenCalledWith('att-1')
    expect(lost.markStored).not.toHaveBeenCalled()
  })

  it("when the form's maker can no longer change the table, nothing is made: no contact, no row", async () => {
    const d = deps({}, { canWrite: vi.fn(async () => false) })
    const res = await handleFormSubmit(post(GOOD), KEY, d)
    expect(res.status).toBe(500)
    expect(d.upsertContact).not.toHaveBeenCalled()
    expect(d.writeRow).not.toHaveBeenCalled()
    expect(d.releaseAttempt).toHaveBeenCalledWith('att-1')
  })

  it('a 303 to the form\'s thank-you page only when it is on a listed origin', async () => {
    const d = deps({ allowedOrigins: ['https://brightweave.example'] })
    const res = await handleFormSubmit(post({ ...GOOD, _redirect: 'https://brightweave.example/thanks' }, { origin: 'https://brightweave.example' }), KEY, d)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('https://brightweave.example/thanks')
    const elsewhere = await handleFormSubmit(post({ ...GOOD, _redirect: 'https://evil.example/' }, { origin: 'https://brightweave.example' }), KEY, deps({ allowedOrigins: ['https://brightweave.example'] }))
    expect(elsewhere.status).toBe(201)
  })
})

describe('who may submit', () => {
  it("a public form with listed sites refuses another site's browser (403), and mirrors an allowed one", async () => {
    const d = deps({ allowedOrigins: ['https://brightweave.example'] })
    const refused = await handleFormSubmit(post(GOOD, { origin: 'https://evil.example' }), KEY, d)
    expect(refused.status).toBe(403)
    expect(refused.headers.get('access-control-allow-origin')).toBeNull()
    expect(d.writeRow).not.toHaveBeenCalled()
    const allowed = await handleFormSubmit(post(GOOD, { origin: 'https://brightweave.example' }), KEY, d)
    expect(allowed.status).toBe(201)
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://brightweave.example')
  })

  it('a members form takes a signed-in member only, from the app\'s own pages, and answers no other site', async () => {
    const out = deps({ access: 'members' }, { memberOf: vi.fn(async () => 'signed_out' as const) })
    expect((await handleFormSubmit(post(GOOD), KEY, out)).status).toBe(401)
    const stranger = deps({ access: 'members' }, { memberOf: vi.fn(async () => 'not_member' as const) })
    expect((await handleFormSubmit(post(GOOD), KEY, stranger)).status).toBe(403)
    expect(stranger.writeRow).not.toHaveBeenCalled()

    const member = deps({ access: 'members' })
    const cross = await handleFormSubmit(post(GOOD, { origin: 'https://evil.example' }), KEY, member)
    expect(cross.status).toBe(403)
    expect(member.memberOf).not.toHaveBeenCalled()
    const own = await handleFormSubmit(post(GOOD, { origin: 'https://nativeintelligence.dev' }), KEY, member)
    expect(own.status).toBe(201)
    expect(own.headers.get('access-control-allow-origin')).toBeNull()
    expect(member.memberOf).toHaveBeenCalledWith(expect.anything(), 'ws-1')
  })

  it('CORS: any origin for a public form with none listed, none for a members form', () => {
    expect(formCorsHeaders('https://a.example', { access: 'public', allowedOrigins: [] })['Access-Control-Allow-Origin']).toBe('*')
    expect(formCorsHeaders('https://a.example', { access: 'members', allowedOrigins: [] })).toEqual({ Vary: 'Origin' })
  })

  it("a browser's request is the app's own when its Origin names the host it was sent to", () => {
    const req = (headers: Record<string, string>) => new Request('https://x.example/', { headers })
    expect(sameSite(req({ host: 'dial8.ai' }), 'https://dial8.ai')).toBe(true)
    expect(sameSite(req({ host: 'dial8.ai' }), 'https://evil.example')).toBe(false)
    expect(sameSite(req({ host: 'dial8.ai' }), 'not a url')).toBe(false)
    expect(sameSite(req({ host: 'dial8.ai' }), null)).toBe(true)
  })
})

describe('the caps', () => {
  it('the try is recorded before the caps are read, so posts sent side by side each count the others', async () => {
    const order: string[] = []
    const d = deps(
      {},
      {
        openAttempt: vi.fn(async () => (order.push('open'), 'att-1')),
        countClientAttempts: vi.fn(async () => (order.push('count-sender'), 1)),
        countFormAttempts: vi.fn(async () => (order.push('count-form'), 1)),
      },
    )
    expect((await handleFormSubmit(post(GOOD), KEY, d)).status).toBe(201)
    expect(order).toEqual(['open', 'count-sender', 'count-form'])
  })

  it("a sender past their hour is 429 before the form's own count is read, and nothing is written", async () => {
    const at = deps({}, { countClientAttempts: vi.fn(async () => FORM_CLIENT_HOURLY_CAP) })
    expect((await handleFormSubmit(post(GOOD), KEY, at)).status).toBe(201)
    const d = deps({}, { countClientAttempts: vi.fn(async () => FORM_CLIENT_HOURLY_CAP + 1) })
    expect((await handleFormSubmit(post(GOOD), KEY, d)).status).toBe(429)
    expect(d.countFormAttempts).not.toHaveBeenCalled()
    expect(d.writeRow).not.toHaveBeenCalled()
    expect(d.countClientAttempts).toHaveBeenCalledWith('client-a', '2026-11-15T11:00:00.000Z')
  })

  it('a form past its hour is 429', async () => {
    const d = deps({}, { countFormAttempts: vi.fn(async () => FORM_HOURLY_CAP + 1) })
    expect((await handleFormSubmit(post(GOOD), KEY, d)).status).toBe(429)
    expect(d.writeRow).not.toHaveBeenCalled()
  })

  it("a cap that can't be written or read is a hold, never an open door", async () => {
    const unread = deps({}, { countFormAttempts: vi.fn(async () => { throw new Error('db down') }) })
    expect((await handleFormSubmit(post(GOOD), KEY, unread)).status).toBe(500)
    expect(unread.writeRow).not.toHaveBeenCalled()
    const unwritten = deps({}, { openAttempt: vi.fn(async () => { throw new Error('db down') }) })
    expect((await handleFormSubmit(post(GOOD), KEY, unwritten)).status).toBe(500)
    expect(unwritten.writeRow).not.toHaveBeenCalled()
  })

  it("with no usable sender address, the form's own cap still stands", async () => {
    const d = deps({}, { clientKey: vi.fn(() => null) })
    expect((await handleFormSubmit(post(GOOD), KEY, d)).status).toBe(201)
    expect(d.countClientAttempts).not.toHaveBeenCalled()
    expect(d.countFormAttempts).toHaveBeenCalled()
  })

  it('a sender is their address, an IPv6 one its /64, kept only as a keyed hash', () => {
    const key = (ip: string) => formClientKey(new Request('https://x.example/', { headers: { 'x-real-ip': ip } }), 'secret')
    expect(senderNetwork('203.0.113.7')).toBe('203.0.113.7')
    expect(senderNetwork('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(senderNetwork('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64')
    expect(senderNetwork('2001:0db8:0001:0002::1')).toBe('2001:db8:1:2::/64')
    expect(senderNetwork('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(key('2001:db8:1:2::1')).toBe(key('2001:db8:1:2:ffff:ffff:ffff:ffff'))
    expect(key('2001:db8:1:3::1')).not.toBe(key('2001:db8:1:2::1'))
    expect(key('203.0.113.7')).not.toContain('203')
    expect(key('not an address!')).toBeNull()
    expect(formClientKey(new Request('https://x.example/', { headers: { 'x-forwarded-for': '203.0.113.7' } }), 'secret')).toBeNull()
  })
})

describe('the contact column', () => {
  it("is the table's first live column that links contacts", () => {
    expect(contactColumnOf(COLUMNS)?.key).toBe('customer')
    expect(contactColumnOf([col('co', 'Company', 'relation', { config: { target: { kind: 'company' } } })])).toBeNull()
    expect(contactColumnOf([col('c', 'C', 'relation', { config: { target: { kind: 'contact' } }, deleted_at: 'x' })])).toBeNull()
  })
})
