/**
 * The submission handler's phase 3 branches (../submit.ts): the bot check,
 * the post's own fields, the website flow's live check, the form's own page
 * as an origin, and an invited form's personal links. Made-up people.
 */
import { describe, expect, it, vi } from 'vitest'
import type { DataColumn } from '@/lib/tables/types'
import { INTAKE_TEST_FIELD } from '@/lib/website/types'
import { issueChallenge, solveChallenge } from '../challenge'
import { generateInviteToken, type FormInvite } from '../invites'
import { generateFormKey } from '../store'
import { CHALLENGE_REFUSED, INVITE_REFUSED, handleFormSubmit, type FormSubmitDeps } from '../submit'
import { FORM_TITLE_KEY, type DataForm } from '../types'

const KEY = generateFormKey()
const SECRET = 'test-secret'
const T0 = Date.parse('2026-11-15T12:00:00Z')
const NOW = T0 + 10_000

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
const COLUMNS = [
  col('email', 'Email', 'email'),
  col('message', 'Message', 'text'),
  col('challenge', 'Challenge', 'text'),
  col('customer', 'Customer', 'relation', { config: { target: { kind: 'contact' } } }),
]

const FORM: DataForm = {
  id: 'form-1',
  workspaceId: 'ws-1',
  tableId: 't1',
  name: 'Contact us',
  fields: [
    { key: FORM_TITLE_KEY, label: 'Name', required: true },
    { key: 'email', label: 'Email', required: true },
    { key: 'message', label: 'Message', required: false },
    { key: 'challenge', label: 'Challenge', required: false },
  ],
  access: 'public',
  allowedOrigins: [],
  thanks: null,
  description: null,
  submitLabel: null,
  botCheck: true,
  active: true,
  keyPrefix: 'fk_abcdef',
  createdBy: 'user-owner',
  createdAt: '',
  updatedAt: '',
  lastSubmittedAt: null,
}

const invite = (extra: Partial<FormInvite> = {}): FormInvite => ({
  id: 'inv-1',
  formId: 'form-1',
  label: 'Sam Rivera',
  contactId: null,
  createdBy: 'user-owner',
  createdAt: '',
  expiresAt: new Date(NOW + 86_400_000).toISOString(),
  usedAt: null,
  rowId: null,
  ...extra,
})

function deps(form: Partial<DataForm> = {}, over: Partial<FormSubmitDeps> = {}) {
  const live = { ...FORM, ...form }
  return {
    findForm: vi.fn(async (k: string) => (k === KEY ? live : null)),
    formOfInvite: vi.fn(async () => live as DataForm | null),
    clientKey: vi.fn(() => 'client-a'),
    memberOf: vi.fn(async () => 'member' as const),
    countFormAttempts: vi.fn(async () => 0),
    countClientAttempts: vi.fn(async () => 0),
    columns: vi.fn(async () => COLUMNS as DataColumn[] | null),
    openAttempt: vi.fn(async () => 'att-1'),
    claimAttempt: vi.fn<FormSubmitDeps['claimAttempt']>(async () => ({ kind: 'new' })),
    claimInvite: vi.fn<NonNullable<FormSubmitDeps['claimInvite']>>(async () => invite()),
    releaseInvite: vi.fn(async () => {}),
    markInviteStored: vi.fn(async () => {}),
    takeTest: vi.fn(async () => false),
    canWrite: vi.fn(async () => true),
    markStored: vi.fn(async () => {}),
    releaseAttempt: vi.fn(async () => {}),
    upsertContact: vi.fn(async () => 'contact-typed' as string | null),
    writeRow: vi.fn<FormSubmitDeps['writeRow']>(async () => ({ ok: true })),
    challengeSecret: () => SECRET,
    now: () => NOW,
    newId: vi.fn(() => 'row-1'),
    ...over,
  } satisfies FormSubmitDeps
}

const APP = 'https://nativeintelligence.dev'
function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${APP}/api/intake/forms/x`, { method: 'POST', headers: { 'content-type': 'application/json', host: 'nativeintelligence.dev', ...headers }, body: JSON.stringify(body) })
}
const GOOD = { name: 'Sarah Lindqvist', email: 'sarah@example.com', message: 'Two rugs.' }
function solved(formId = 'form-1', at = T0) {
  const { token } = issueChallenge(formId, at, SECRET)
  return { _challenge: token, _answer: solveChallenge(token) }
}

describe('the bot check', () => {
  it('a post without a solved challenge is refused 400 "Reload the page and try again.", counted by the caps, and writes nothing', async () => {
    for (const body of [GOOD, { ...GOOD, _challenge: 'v1.junk', _answer: '1' }, { ...GOOD, ...solved('form-2') }, { ...GOOD, ...solved('form-1', NOW - 500) }]) {
      const d = deps()
      const res = await handleFormSubmit(post(body), KEY, d)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: CHALLENGE_REFUSED, code: 'CHALLENGE_FAILED' })
      expect(d.openAttempt).toHaveBeenCalled()
      expect(d.claimAttempt).not.toHaveBeenCalled()
      expect(d.writeRow).not.toHaveBeenCalled()
      expect(d.upsertContact).not.toHaveBeenCalled()
    }
  })

  it('a solved one is taken: its random part is claimed with the try, and none of the post\'s own fields reach a column', async () => {
    const d = deps()
    const answer = solved()
    const res = await handleFormSubmit(post({ ...GOOD, ...answer }), KEY, d)
    expect(res.status).toBe(201)
    expect(d.claimAttempt).toHaveBeenCalledWith(expect.objectContaining({ challengeId: answer._challenge.split('.')[2] }))
    // A field labelled Challenge is not filled by the post's _challenge.
    expect(d.writeRow.mock.calls[0][1].values).toEqual({ email: 'sarah@example.com', message: 'Two rugs.', customer: ['contact-typed'] })
  })

  it('a challenge another submission already stores with is refused, and writes nothing', async () => {
    const d = deps({}, { claimAttempt: vi.fn<FormSubmitDeps['claimAttempt']>(async () => ({ kind: 'challenge_used' })) })
    const res = await handleFormSubmit(post({ ...GOOD, ...solved() }), KEY, d)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('CHALLENGE_FAILED')
    expect(d.writeRow).not.toHaveBeenCalled()
  })

  it('off, nothing changes: a post with no challenge is stored', async () => {
    const d = deps({ botCheck: false })
    expect((await handleFormSubmit(post(GOOD), KEY, d)).status).toBe(201)
    expect(d.claimAttempt).toHaveBeenCalledWith(expect.objectContaining({ challengeId: null }))
  })

  it('a write that fails gives the challenge back with the try', async () => {
    const d = deps({}, { writeRow: vi.fn<FormSubmitDeps['writeRow']>(async () => ({ ok: false, reason: 'unavailable', error: 'down' })), upsertContact: vi.fn(async () => null) })
    expect((await handleFormSubmit(post({ ...GOOD, ...solved() }), KEY, d)).status).toBe(500)
    expect(d.releaseAttempt).toHaveBeenCalledWith('att-1')
  })
})

describe("the website flow's live check", () => {
  it('a post carrying a pending check\'s nonce is the check: { ok, test }, never parsed, never stored', async () => {
    const d = deps({ botCheck: true, fields: [{ key: 'email', label: 'Email', required: true }, { key: FORM_TITLE_KEY, label: 'Phone number', required: true }] }, { takeTest: vi.fn(async () => true) })
    const res = await handleFormSubmit(post({ name: 'Native Intelligence website check', email: 'check@example.com', [INTAKE_TEST_FIELD]: 'nonce-1234567890abcdef' }), KEY, d)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, test: true })
    expect(d.takeTest).toHaveBeenCalledWith('ws-1', 'nonce-1234567890abcdef')
    expect(d.claimAttempt).not.toHaveBeenCalled()
    expect(d.writeRow).not.toHaveBeenCalled()
    expect(d.upsertContact).not.toHaveBeenCalled()
    // It still went through the caps.
    expect(d.openAttempt).toHaveBeenCalled()
  })

  it("a nonce that is not one of the workspace's is an ordinary post, its field never stored", async () => {
    const d = deps({ botCheck: false })
    const res = await handleFormSubmit(post({ ...GOOD, [INTAKE_TEST_FIELD]: 'nonce-1234567890abcdef' }), KEY, d)
    expect(res.status).toBe(201)
    expect(JSON.stringify(d.writeRow.mock.calls[0][1])).not.toContain('nonce')
  })
})

describe("the form's own page", () => {
  it('a public form with listed sites still takes its own page (the app\'s origin), and refuses others', async () => {
    const d = deps({ botCheck: false, allowedOrigins: ['https://brightweave.example'] })
    expect((await handleFormSubmit(post(GOOD, { origin: APP }), KEY, d)).status).toBe(201)
    expect((await handleFormSubmit(post(GOOD, { origin: 'https://evil.example' }), KEY, deps({ botCheck: false, allowedOrigins: ['https://brightweave.example'] }))).status).toBe(403)
  })
})

describe('an invited form', () => {
  const INVITED: Partial<DataForm> = { access: 'invited', botCheck: false }

  it("takes nothing with the form's own link alone (403), and writes nothing", async () => {
    const d = deps(INVITED)
    const res = await handleFormSubmit(post(GOOD), KEY, d)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: INVITE_REFUSED })
    expect(d.claimInvite).not.toHaveBeenCalled()
    expect(d.writeRow).not.toHaveBeenCalled()
  })

  it('takes a personal link in the path: claimed for this submission, marked with its row, the typed contact found as usual', async () => {
    const token = generateInviteToken()
    const d = deps(INVITED)
    const res = await handleFormSubmit(post(GOOD, { origin: APP }), token, d)
    expect(res.status).toBe(201)
    expect(d.formOfInvite).toHaveBeenCalledWith(token)
    expect(d.findForm).not.toHaveBeenCalled()
    expect(d.claimInvite).toHaveBeenCalledWith('form-1', token, new Date(NOW).toISOString())
    expect(d.markInviteStored).toHaveBeenCalledWith('inv-1', 'row-1')
    expect(d.upsertContact).toHaveBeenCalled()
  })

  it("takes one beside the form's key (_invite)", async () => {
    const token = generateInviteToken()
    const d = deps(INVITED)
    expect((await handleFormSubmit(post({ ...GOOD, _invite: token }), KEY, d)).status).toBe(201)
    expect(d.claimInvite).toHaveBeenCalledWith('form-1', token, expect.any(String))
  })

  it('a link made for a contact links THAT contact, and none is found or made from what was typed', async () => {
    const d = deps(INVITED, { claimInvite: vi.fn(async () => invite({ contactId: 'contact-invited' })) })
    expect((await handleFormSubmit(post(GOOD), generateInviteToken(), d)).status).toBe(201)
    expect(d.upsertContact).not.toHaveBeenCalled()
    expect(d.writeRow.mock.calls[0][1].values.customer).toEqual(['contact-invited'])
  })

  it('a used, lapsed or other form\'s link (the claim finds nothing) is 403, the try let go, nothing written', async () => {
    const d = deps(INVITED, { claimInvite: vi.fn(async () => null) })
    const res = await handleFormSubmit(post(GOOD), generateInviteToken(), d)
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('INVITE_USED')
    expect(d.releaseAttempt).toHaveBeenCalledWith('att-1')
    expect(d.writeRow).not.toHaveBeenCalled()
  })

  it('a write that fails gives the link back, so the person can send again', async () => {
    const d = deps(INVITED, { writeRow: vi.fn<FormSubmitDeps['writeRow']>(async () => ({ ok: false, reason: 'unavailable', error: 'down' })) })
    expect((await handleFormSubmit(post(GOOD), generateInviteToken(), d)).status).toBe(500)
    expect(d.releaseInvite).toHaveBeenCalledWith('inv-1')
    expect(d.markInviteStored).not.toHaveBeenCalled()
    const maker = deps(INVITED, { canWrite: vi.fn(async () => false) })
    await handleFormSubmit(post(GOOD), generateInviteToken(), maker)
    expect(maker.releaseInvite).toHaveBeenCalledWith('inv-1')
  })

  it("answers no other site's browser, and has no CORS", async () => {
    const d = deps(INVITED)
    const res = await handleFormSubmit(post(GOOD, { origin: 'https://evil.example' }), generateInviteToken(), d)
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(d.openAttempt).not.toHaveBeenCalled()
  })

  it('caps still apply', async () => {
    const d = deps(INVITED, { countFormAttempts: vi.fn(async () => 1000) })
    expect((await handleFormSubmit(post(GOOD), generateInviteToken(), d)).status).toBe(429)
    expect(d.claimInvite).not.toHaveBeenCalled()
  })

  it('a personal link whose form is gone is 404', async () => {
    const d = deps(INVITED, { formOfInvite: vi.fn(async () => null) })
    expect((await handleFormSubmit(post(GOOD), generateInviteToken(), d)).status).toBe(404)
  })
})
