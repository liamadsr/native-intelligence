/**
 * A form's public side (../public.ts): the shape a page draws, which holds
 * nothing of the workspace; who a link opens for (members, personal links);
 * and the two GETs, with the POST's CORS and gates.
 */
import { describe, expect, it, vi } from 'vitest'
import type { DataColumn } from '@/lib/tables/types'
import { verifyChallenge, solveChallenge } from '../challenge'
import { generateInviteToken, type FormInvite } from '../invites'
import { __clearFormReadsForTests, FORM_READS_CLIENT_PER_MINUTE, formShape, handleFormRead, openForm, type FormReadDeps } from '../public'
import { generateFormKey } from '../store'
import { FORM_TITLE_KEY, type DataForm } from '../types'

const KEY = generateFormKey()
const NOW = Date.parse('2026-11-15T12:00:00Z')
const col = (key: string, label: string, field_type: DataColumn['field_type'], extra: Partial<DataColumn> = {}): DataColumn => ({
  id: `col-${key}`,
  table_id: 'table-secret-id',
  key,
  label,
  field_type,
  options: [],
  config: {},
  position: 0,
  deleted_at: null,
  ...extra,
})
const COLUMNS = [
  col('email', 'Email', 'email'),
  col('notes', 'Anything else', 'text'),
  col('service', 'Service', 'select', { options: ['Cleaning', 'Repair'] }),
  col('rooms', 'Rooms', 'multi_select', { options: ['Kitchen', 'Hall'] }),
  col('budget', 'Budget', 'currency', { config: { currency: 'EUR' } }),
  col('owner', 'Owner', 'person'),
  col('old', 'Old', 'text', { deleted_at: '2026-11-01' }),
]
const FORM: DataForm = {
  id: 'form-1',
  workspaceId: 'ws-secret',
  tableId: 'table-secret-id',
  name: 'Get a quote',
  fields: [
    { key: FORM_TITLE_KEY, label: 'Your name', required: true },
    { key: 'email', label: 'Email', required: true },
    { key: 'notes', label: 'Message', required: false },
    { key: 'service', label: 'Service', required: false },
    { key: 'rooms', label: 'Rooms', required: false },
    { key: 'budget', label: 'Budget', required: false },
    { key: 'owner', label: 'Owner', required: false },
    { key: 'old', label: 'Old', required: false },
    { key: 'gone', label: 'Gone', required: false },
  ],
  access: 'public',
  allowedOrigins: [],
  thanks: 'We will call you.',
  description: 'Tell us about the job.',
  submitLabel: 'Request a quote',
  botCheck: true,
  active: true,
  keyPrefix: 'fk_abcdef',
  createdBy: 'user-owner-secret',
  createdAt: '',
  updatedAt: '',
  lastSubmittedAt: null,
}

describe('the shape a page draws', () => {
  it("is the form's own words and fields, and nothing of the workspace", () => {
    const shape = formShape(FORM, COLUMNS)
    expect(shape).toEqual({
      name: 'Get a quote',
      description: 'Tell us about the job.',
      submit_label: 'Request a quote',
      thanks: 'We will call you.',
      bot_check: true,
      access: 'public',
      fields: [
        { name: 'your_name', label: 'Your name', type: 'text', required: true },
        { name: 'email', label: 'Email', type: 'email', required: true },
        // A message is a few lines, by its label.
        { name: 'notes', label: 'Message', type: 'text', required: false, long: true },
        { name: 'service', label: 'Service', type: 'select', required: false, options: ['Cleaning', 'Repair'] },
        { name: 'rooms', label: 'Rooms', type: 'multi_select', required: false, options: ['Kitchen', 'Hall'] },
        { name: 'budget', label: 'Budget', type: 'currency', required: false, currency: 'EUR' },
        // A person column, a deleted column and a missing one are left out, as a submission skips them.
      ],
    })
    const json = JSON.stringify(shape)
    for (const secret of ['table-secret-id', 'ws-secret', 'user-owner-secret', 'fk_abcdef', 'form-1']) expect(json).not.toContain(secret)
  })
})

function deps(form: Partial<DataForm> | null = {}, over: Partial<FormReadDeps> = {}) {
  const live = form ? { ...FORM, ...form } : null
  return {
    findForm: vi.fn(async (k: string) => (k === KEY ? live : null)),
    formOfInvite: vi.fn(async () => live),
    columns: vi.fn(async () => COLUMNS as DataColumn[] | null),
    memberOf: vi.fn(async () => 'member' as 'member' | 'signed_out' | 'not_member'),
    findInvite: vi.fn(async (): Promise<FormInvite | null> => ({ id: 'inv-1', formId: 'form-1', label: null, contactId: null, createdBy: null, createdAt: '', expiresAt: new Date(NOW + 1000).toISOString(), usedAt: null, rowId: null })),
    challengeSecret: () => 'test-secret',
    now: () => NOW,
    ...over,
  } satisfies FormReadDeps
}

describe('who a link opens for', () => {
  it('a wrong or malformed link is missing; a switched-off form, or one whose table is gone, is closed', async () => {
    expect((await openForm('nope', null, deps())).kind).toBe('missing')
    expect((await openForm(generateFormKey(), null, deps())).kind).toBe('missing')
    expect((await openForm(KEY, null, deps({ active: false }))).kind).toBe('closed')
    expect((await openForm(KEY, null, deps({}, { columns: vi.fn(async () => null) }))).kind).toBe('closed')
    expect((await openForm(KEY, null, deps())).kind).toBe('open')
  })

  it('a members form: open to a member only', async () => {
    expect((await openForm(KEY, null, deps({ access: 'members' }, { memberOf: vi.fn(async () => 'signed_out' as const) }))).kind).toBe('signed_out')
    expect((await openForm(KEY, null, deps({ access: 'members' }, { memberOf: vi.fn(async () => 'not_member' as const) }))).kind).toBe('not_member')
    expect((await openForm(KEY, null, deps({ access: 'members' }))).kind).toBe('open')
  })

  it('an invited form: open with a good personal link only, in the path or beside the key', async () => {
    const token = generateInviteToken()
    const invited = { access: 'invited' as const }
    expect((await openForm(KEY, null, deps(invited))).kind).toBe('invite_needed')
    expect(await openForm(token, null, deps(invited))).toMatchObject({ kind: 'open', invite: token })
    expect(await openForm(KEY, token, deps(invited))).toMatchObject({ kind: 'open', invite: token })
    const used = deps(invited, { findInvite: vi.fn(async () => ({ id: 'i', formId: 'form-1', label: null, contactId: null, createdBy: null, createdAt: '', expiresAt: new Date(NOW + 1000).toISOString(), usedAt: new Date(NOW - 1).toISOString(), rowId: 'r' })) })
    expect((await openForm(token, null, used)).kind).toBe('invite_needed')
    const lapsed = deps(invited, { findInvite: vi.fn(async () => ({ id: 'i', formId: 'form-1', label: null, contactId: null, createdBy: null, createdAt: '', expiresAt: new Date(NOW - 1).toISOString(), usedAt: null, rowId: null })) })
    expect((await openForm(token, null, lapsed)).kind).toBe('invite_needed')
    // Another form's link: findInvite answers only for its own form.
    expect((await openForm(KEY, token, deps(invited, { findInvite: vi.fn(async () => null) }))).kind).toBe('invite_needed')
  })
})

const APP = 'https://nativeintelligence.dev'
const get = (path: string, headers: Record<string, string> = {}) => new Request(`${APP}${path}`, { headers: { host: 'nativeintelligence.dev', ...headers } })

describe('GET the shape and a challenge', () => {
  it('a public form answers any site (CORS) with its shape, never cached', async () => {
    const res = await handleFormRead(get('/api/intake/forms/k', { origin: 'https://brightweave.example' }), KEY, 'shape', deps())
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toContain('GET')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await res.json()).name).toBe('Get a quote')
  })

  it("a challenge is one the POST takes, for this form", async () => {
    const res = await handleFormRead(get('/api/intake/forms/k/challenge'), KEY, 'challenge', deps())
    const { token, difficulty } = (await res.json()) as { token: string; difficulty: number }
    expect(difficulty).toBeGreaterThan(0)
    expect(verifyChallenge({ formId: 'form-1', token, answer: solveChallenge(token), now: NOW + 3000, secret: 'test-secret' }).ok).toBe(true)
  })

  it('404 for a wrong key, 410 for a closed form, 403 for an unlisted site', async () => {
    expect((await handleFormRead(get('/x'), 'fk_wrong', 'shape', deps())).status).toBe(404)
    expect((await handleFormRead(get('/x'), KEY, 'challenge', deps({ active: false }))).status).toBe(410)
    const listed = deps({ allowedOrigins: ['https://brightweave.example'] })
    expect((await handleFormRead(get('/x', { origin: 'https://evil.example' }), KEY, 'shape', listed)).status).toBe(403)
    expect((await handleFormRead(get('/x', { origin: 'https://brightweave.example' }), KEY, 'shape', listed)).status).toBe(200)
    expect((await handleFormRead(get('/x', { origin: APP }), KEY, 'shape', listed)).status).toBe(200)
  })

  it('a members form answers only a member, from its own page, with no CORS', async () => {
    const members = { access: 'members' as const }
    const cross = await handleFormRead(get('/x', { origin: 'https://evil.example' }), KEY, 'shape', deps(members))
    expect(cross.status).toBe(403)
    expect(cross.headers.get('access-control-allow-origin')).toBeNull()
    expect((await handleFormRead(get('/x'), KEY, 'challenge', deps(members, { memberOf: vi.fn(async () => 'signed_out' as const) }))).status).toBe(401)
    expect((await handleFormRead(get('/x'), KEY, 'shape', deps(members, { memberOf: vi.fn(async () => 'not_member' as const) }))).status).toBe(403)
    expect((await handleFormRead(get('/x', { origin: APP }), KEY, 'shape', deps(members))).status).toBe(200)
  })

  it('an invited form answers only a good personal link', async () => {
    const invited = { access: 'invited' as const }
    expect((await handleFormRead(get('/x'), KEY, 'shape', deps(invited))).status).toBe(403)
    const token = generateInviteToken()
    expect((await handleFormRead(get(`/x?i=${token}`), KEY, 'shape', deps(invited))).status).toBe(200)
    expect((await handleFormRead(get('/x'), token, 'challenge', deps(invited))).status).toBe(200)
    expect((await handleFormRead(get('/x'), token, 'challenge', deps(invited, { findInvite: vi.fn(async () => null) }))).status).toBe(403)
  })

  it('a read that fails is a 500, never an open door', async () => {
    const res = await handleFormRead(get('/x'), KEY, 'shape', deps({}, { findForm: vi.fn(async () => { throw new Error('down') }) }))
    expect(res.status).toBe(500)
  })
})

describe('a cap on the GETs, per sender', () => {
  it(`answers ${FORM_READS_CLIENT_PER_MINUTE} reads a minute to one sender, across the shape and the challenge, then 429 before anything is read`, async () => {
    __clearFormReadsForTests()
    let now = NOW
    const d = deps({}, { clientKey: () => 'sender-a', now: () => now })
    for (let i = 0; i < FORM_READS_CLIENT_PER_MINUTE; i++) {
      expect((await handleFormRead(get('/x'), KEY, i % 2 ? 'challenge' : 'shape', d)).status, `read ${i + 1}`).toBe(200)
    }
    const reads = vi.mocked(d.findForm).mock.calls.length
    const over = await handleFormRead(get('/x', { origin: 'https://brightweave.example' }), KEY, 'shape', d)
    expect(over.status).toBe(429)
    expect(over.headers.get('Cache-Control')).toBe('no-store')
    // Refused before the form is looked up: a flood reads nothing.
    expect(vi.mocked(d.findForm).mock.calls.length).toBe(reads)
    // A wrong key counts too: guessing keys is reading.
    expect((await handleFormRead(get('/x'), 'fk_wrong', 'shape', d)).status).toBe(429)

    // Another sender, and the same one a minute on, are answered.
    expect((await handleFormRead(get('/x'), KEY, 'shape', deps({}, { clientKey: () => 'sender-b', now: () => now }))).status).toBe(200)
    now += 60_000
    expect((await handleFormRead(get('/x'), KEY, 'shape', d)).status).toBe(200)
  })

  it('a sender the edge said nothing of is not counted (as the POST cap)', async () => {
    __clearFormReadsForTests()
    const d = deps({}, { clientKey: () => null })
    for (let i = 0; i < FORM_READS_CLIENT_PER_MINUTE + 5; i++) expect((await handleFormRead(get('/x'), KEY, 'shape', d)).status).toBe(200)
  })
})
