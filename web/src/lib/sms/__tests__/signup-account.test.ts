import { describe, expect, it, vi } from 'vitest'
import { SIGNUP_PLACEHOLDER_NAME, SIGNUP_WORKSPACE_NAME, createPhoneAccount, signupWelcomeText } from '../signup-account'
import { SMS_TEXT_SIGNUP_CONSENT_VERSION, consentCoversAlerts } from '../consent'

/**
 * The account a text sign-up makes: a phone user, its workspace, the number
 * linked and verified with the sign-up's consent, no web wizard, and setup by
 * text switched on. A number an older account still carries is freed for the
 * person who proved it, never handed that account.
 */
const PHONE = '+15551234567'
const T0 = Date.parse('2026-11-02T15:00:00Z')

function fakeSupabase(opts: { phoneTaken?: boolean; linkFails?: boolean; released?: Record<string, string | null> } = {}) {
  const released = opts.released ?? { 'user-old': null }
  let taken = opts.phoneTaken ?? false
  const calls: Array<{ op: string; table?: string; args?: unknown }> = []
  const createUser = vi.fn(async (args: unknown) => {
    calls.push({ op: 'createUser', args })
    if (taken) return { data: { user: null }, error: { code: 'phone_exists', message: 'Phone number already registered by another user' } }
    return { data: { user: { id: 'user-new' } }, error: null }
  })
  const deleteUser = vi.fn(async () => ({ error: null }))
  const getUserById = vi.fn(async (id: string) => ({ data: { user: { id, email: released[id] ?? null } }, error: null }))
  const rpc = vi.fn(async (name: string, args: unknown) => {
    calls.push({ op: `rpc:${name}`, args })
    if (name === 'release_signup_number') {
      taken = false
      return { data: Object.keys(released), error: null }
    }
    return { data: null, error: null }
  })
  const from = (table: string) => {
    let op = 'select'
    let payload: unknown = null
    const result = () => {
      if (op === 'insert' && table === 'user_phone' && opts.linkFails) return { data: null, error: { message: 'link down' } }
      if (op === 'select' && table === 'member') return { data: { workspace_id: 'ws-new' }, error: null }
      return { data: null, error: null }
    }
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      neq: () => chain,
      in: (column: string, values: unknown) => (calls.push({ op: 'in', table, args: { column, values } }), chain),
      limit: () => chain,
      update: (p: unknown) => ((op = 'update'), (payload = p), calls.push({ op: 'update', table, args: p }), chain),
      delete: () => ((op = 'delete'), calls.push({ op: 'delete', table }), chain),
      insert: (p: unknown) => ((op = 'insert'), (payload = p), calls.push({ op: 'insert', table, args: p }), chain),
      maybeSingle: async () => result(),
      then: (ok: (v: unknown) => unknown) => Promise.resolve(result()).then(ok),
    }
    void payload
    return chain
  }
  return { client: { auth: { admin: { createUser, deleteUser, getUserById } }, rpc, from } as never, calls, createUser, deleteUser, rpc }
}

describe('createPhoneAccount', () => {
  it('a phone user (confirmed) with the placeholder name the auth trigger needs, signed up via sms', async () => {
    const db = fakeSupabase()
    expect(await createPhoneAccount(db.client, { phone: PHONE, nowMs: T0 })).toEqual({ ok: true, account: { userId: 'user-new', workspaceId: 'ws-new', phone: PHONE } })
    expect(db.createUser).toHaveBeenCalledWith({ phone: PHONE, phone_confirm: true, user_metadata: { full_name: SIGNUP_PLACEHOLDER_NAME }, app_metadata: { signup_via: 'sms' } })
  })

  it('names the workspace, links the number verified with the sign-up consent, skips the wizard and turns setup by text on', async () => {
    const db = fakeSupabase()
    await createPhoneAccount(db.client, { phone: PHONE, nowMs: T0 })
    const at = new Date(T0).toISOString()
    expect(db.calls).toContainEqual({ op: 'update', table: 'workspace', args: { name: SIGNUP_WORKSPACE_NAME } })
    // A business that serves customers: the service-business edition (its words: jobs, customers).
    expect(db.calls).toContainEqual({ op: 'update', table: 'workspace', args: { settings: { edition: 'service' } } })
    expect(db.calls).toContainEqual({ op: 'delete', table: 'user_phone' })
    expect(consentCoversAlerts(SMS_TEXT_SIGNUP_CONSENT_VERSION)).toBe(true)
    expect(db.calls).toContainEqual({
      op: 'insert',
      table: 'user_phone',
      args: {
        user_id: 'user-new',
        workspace_id: 'ws-new',
        phone_e164: PHONE,
        line: 'dial8',
        verified_at: at,
        consented_at: at,
        consent_version: SMS_TEXT_SIGNUP_CONSENT_VERSION,
        alerts_consented_at: at,
        alerts_consent_version: SMS_TEXT_SIGNUP_CONSENT_VERSION,
        updated_at: at,
      },
    })
    expect(db.calls).toContainEqual({ op: 'update', table: 'member', args: { onboarding_completed_at: at } })
    expect(db.rpc).toHaveBeenCalledWith('merge_onboarding_progress', { p_workspace_id: 'ws-new', p_patch: { text_signup: { started_at: at } }, p_user_id: 'user-new' })
  })

  it('a number an older account still carries is released first, then a FRESH account is made: never the old one', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const db = fakeSupabase({ phoneTaken: true })
    expect(await createPhoneAccount(db.client, { phone: PHONE, nowMs: T0 })).toMatchObject({ ok: true, account: { userId: 'user-new' } })
    expect(db.rpc).toHaveBeenCalledWith('release_signup_number', { p_phone: PHONE })
    expect(db.createUser).toHaveBeenCalledTimes(2)
    // The old phone-only account has no other way in: its connections are switched off, not left syncing for nobody.
    expect(db.calls).toContainEqual({ op: 'update', table: 'connected_account', args: { is_enabled: false } })
    expect(db.calls).toContainEqual({ op: 'in', table: 'connected_account', args: { column: 'user_id', values: ['user-old'] } })
  })

  it("a released account with an email (a business line's holder, say) keeps its connections: only phone-only accounts lose them", async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const db = fakeSupabase({ phoneTaken: true, released: { 'user-old': null, 'user-biz': 'owner@rugs.example', 'user-placeholder': '15551234567@unknown' } })
    expect(await createPhoneAccount(db.client, { phone: PHONE, nowMs: T0 })).toMatchObject({ ok: true })
    expect(db.calls).toContainEqual({ op: 'in', table: 'connected_account', args: { column: 'user_id', values: ['user-old', 'user-placeholder'] } })
  })

  it('no phone-only account among the released: no connection is touched', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const db = fakeSupabase({ phoneTaken: true, released: { 'user-biz': 'owner@rugs.example' } })
    expect(await createPhoneAccount(db.client, { phone: PHONE, nowMs: T0 })).toMatchObject({ ok: true })
    expect(db.calls.some((c) => c.table === 'connected_account')).toBe(false)
  })

  it('a step failing after the user exists removes it again, so the next code starts clean', async () => {
    const db = fakeSupabase({ linkFails: true })
    expect(await createPhoneAccount(db.client, { phone: PHONE, nowMs: T0 })).toEqual({ ok: false, error: 'user_phone link failed: link down' })
    expect(db.deleteUser).toHaveBeenCalledWith('user-new')
  })
})

describe('the welcome', () => {
  it('says what Native Intelligence is, carries the Google link, never asks for a password, and has the opt-out lines', () => {
    const text = signupWelcomeText('https://dial8.ai/l/AbCdEfGhIjKlMnOpQrStUv12')
    expect(text).toContain("I'm your Dial8 agent")
    expect(text).toContain('connect your Google account so I can see your email and calendar: https://dial8.ai/l/AbCdEfGhIjKlMnOpQrStUv12 ')
    expect(text).toContain("I'll never ask for a password by text")
    expect(text).toContain('Reply STOP to opt out, HELP for help.')
    // Plain GSM-7: it is the webhook's TwiML reply as is.
    expect(text).toMatch(/^[\x20-\x7e]+$/)
  })

  it('without a link it says how to ask for one', () => {
    expect(signupWelcomeText(null)).toContain('text me "connect Google"')
  })
})
