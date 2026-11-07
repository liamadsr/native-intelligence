import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generatePhoneCode, hashPhoneCode, startPhoneVerification, verifyPhoneCode } from '../phone-verification'
import {
  HELP_REPLY,
  SMS_CONSENT_TEXT,
  SMS_CONSENT_VERSION,
  consentCoversAlerts,
  verificationText,
} from '../consent'

/**
 * Linking a phone: the SMS consent must be ticked on today's words before
 * any code is sent (US 10DLC), the code text is the reviewed copy, and the
 * stored hash is bound to the person and the number.
 */

/** Just what startPhoneVerification touches: counts, a void update, an insert. */
function fakeDb(over: { optedOutLinked?: boolean; ledgerStop?: boolean } = {}) {
  const inserts: Array<Record<string, unknown>> = []
  const chain = (table: string) => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      gte: () => q,
      is: () => q,
      not: () => q,
      in: () => q,
      order: () => q,
      limit: () => (table === 'sms_message' ? Promise.resolve({ data: over.ledgerStop ? [{ kind: 'stop' }] : [], error: null }) : q),
      maybeSingle: async () => ({
        data: table === 'user_phone' && over.optedOutLinked ? { id: 'p', user_id: 'x', workspace_id: 'w', phone_e164: '+15551234567', opted_out_at: 'x' } : null,
        error: null,
      }),
      update: () => q,
      insert: (row: Record<string, unknown>) => {
        inserts.push({ table, ...row })
        return Promise.resolve({ error: null })
      },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ count: 0, error: null, data: null }).then(resolve),
    }
    return q
  }
  return { client: { from: chain } as never, inserts }
}

beforeEach(() => {
  process.env.RUN_SKILL_INTERNAL_SECRET = 'run-skill-secret-0123456789'
})

describe('startPhoneVerification', () => {
  it('sends nothing without the consent ticked on the current words', async () => {
    const send = vi.fn()
    const db = fakeDb()
    for (const [consent, consentVersion] of [
      [false, SMS_CONSENT_VERSION],
      [undefined, SMS_CONSENT_VERSION],
      ['true', SMS_CONSENT_VERSION],
      [true, '2020-01-01'],
      [true, undefined],
    ]) {
      expect(await startPhoneVerification(db.client, { userId: 'u', workspaceId: 'w', phone: '+15551234567', consent, consentVersion }, { send })).toEqual({ ok: false, reason: 'no_consent' })
    }
    expect(send).not.toHaveBeenCalled()
    expect(db.inserts).toHaveLength(0)
  })

  it('with consent: stores the code’s HMAC (never the code) with when and which consent, and texts the reviewed copy', async () => {
    const db = fakeDb()
    const send = vi.fn(async () => ({ ok: true as const, sid: 'SM1' }))
    const out = await startPhoneVerification(
      db.client,
      { userId: 'u', workspaceId: 'w', phone: '(555) 123-4567', consent: true, consentVersion: SMS_CONSENT_VERSION },
      { send, code: () => '042137', now: () => Date.parse('2026-10-17T12:00:00Z') },
    )
    expect(out).toMatchObject({ ok: true, phone: '+15551234567' })
    expect(send).toHaveBeenCalledWith('+15551234567', 'Dial8: Your code is 042137. Reply STOP to opt out.')
    const row = db.inserts.find((r) => r.table === 'phone_verification')!
    expect(row).toMatchObject({ phone_e164: '+15551234567', consent_version: SMS_CONSENT_VERSION, consented_at: '2026-10-17T12:00:00.000Z' })
    expect(row.code_hash).toBe(hashPhoneCode('042137', { userId: 'u', phone: '+15551234567' }, process.env.RUN_SKILL_INTERNAL_SECRET!))
    expect(JSON.stringify(row)).not.toContain('042137')
  })

  it('refuses a number outside the US/Canada, and one that said STOP (they text START first)', async () => {
    const consent = { consent: true, consentVersion: SMS_CONSENT_VERSION }
    const send = vi.fn()
    expect(await startPhoneVerification(fakeDb().client, { userId: 'u', workspaceId: 'w', phone: '+44 20 7946 0958', ...consent }, { send })).toEqual({ ok: false, reason: 'unsupported_country' })
    expect(await startPhoneVerification(fakeDb({ ledgerStop: true }).client, { userId: 'u', workspaceId: 'w', phone: '+15551234567', ...consent }, { send })).toEqual({ ok: false, reason: 'unsubscribed' })
    expect(await startPhoneVerification(fakeDb({ optedOutLinked: true }).client, { userId: 'u', workspaceId: 'w', phone: '+15551234567', ...consent }, { send })).toEqual({ ok: false, reason: 'unsubscribed' })
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a number that cannot be E.164, and fails closed with no key', async () => {
    const consent = { consent: true, consentVersion: SMS_CONSENT_VERSION }
    expect(await startPhoneVerification(fakeDb().client, { userId: 'u', workspaceId: 'w', phone: '12', ...consent })).toEqual({ ok: false, reason: 'invalid_phone' })
    delete process.env.RUN_SKILL_INTERNAL_SECRET
    expect(await startPhoneVerification(fakeDb().client, { userId: 'u', workspaceId: 'w', phone: '+15551234567', ...consent })).toEqual({ ok: false, reason: 'not_configured' })
  })
})

describe('the reviewed copy and the code', () => {
  it('consent, code and HELP texts are exactly what carriers review', () => {
    expect(SMS_CONSENT_TEXT).toBe(
      "I agree to receive text messages from Dial8's AI assistant at this number: replies to my texts, and texts when it needs me or has something for me while I'm away from the app, including requests for my OK and a morning summary. Urgent ones may come at night. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. See our Terms (https://dial8.ai/terms) and Privacy Policy (https://dial8.ai/privacy).",
    )
    expect(verificationText('123456')).toBe('Dial8: Your code is 123456. Reply STOP to opt out.')
    expect(HELP_REPLY).toBe('Dial8 AI assistant. Help: liam@dial8.ai. Reply STOP to opt out. Msg & data rates may apply.')
  })

  it('codes are 6 digits; the hash is bound to the person and the number', () => {
    for (let i = 0; i < 50; i++) expect(generatePhoneCode()).toMatch(/^\d{6}$/)
    const a = hashPhoneCode('123456', { userId: 'u1', phone: '+15551234567' }, 'k')
    expect(hashPhoneCode('123456', { userId: 'u2', phone: '+15551234567' }, 'k')).not.toBe(a)
    expect(hashPhoneCode('123456', { userId: 'u1', phone: '+15551234568' }, 'k')).not.toBe(a)
  })
})

describe('the away words (2026-11-01, docs/plans/reach-follows-you.md)', () => {
  it('the sign-up words name texts while away, the morning summary and the night exception, never a count: the one opt-in, no second switch', () => {
    expect(SMS_CONSENT_VERSION).toBe('2026-11-01')
    for (const words of [SMS_CONSENT_TEXT]) {
      expect(words).toMatch(/away from the app/)
      expect(words).toMatch(/morning summary/)
      expect(words).toMatch(/Urgent ones may come at night/)
      expect(words).toMatch(/Message frequency varies/)
      expect(words).toMatch(/STOP/)
      expect(words).toMatch(/HELP/)
      expect(words).not.toMatch(/\d+ (texts|messages) a day|Up to \d+/i)
    }
  })
})

describe('one opt-in covers alert texts (2026-10-24)', () => {
  it('today’s words cover the agent’s "needs your OK" texts; the replies-only words before them don’t', () => {
    expect(consentCoversAlerts(SMS_CONSENT_VERSION)).toBe(true)
    expect(consentCoversAlerts('2026-10-24')).toBe(true)
    expect(consentCoversAlerts('2026-10-17')).toBe(false)
    expect(consentCoversAlerts(null)).toBe(false)
    expect(consentCoversAlerts('latest')).toBe(false)
  })

  /** Just what verifyPhoneCode touches: the pending code, its updates, the link's upsert. */
  function verifyDb(consentVersion: string) {
    const upserts: Array<Record<string, unknown>> = []
    const pending = {
      id: 'v1',
      workspace_id: 'w',
      phone_e164: '+15551234567',
      code_hash: hashPhoneCode('123456', { userId: 'u', phone: '+15551234567' }, 'run-skill-secret-0123456789'),
      attempts: 0,
      expires_at: '2999-01-01T00:00:00.000Z',
      consented_at: '2026-10-24T12:00:00.000Z',
      consent_version: consentVersion,
    }
    const chain = (table: string) => {
      const q: Record<string, unknown> = {
        select: () => (table === 'phone_verification' ? q : q),
        eq: () => q,
        neq: () => Promise.resolve({ error: null }),
        is: () => q,
        not: () => q,
        order: () => q,
        limit: () => q,
        update: () => ({ eq: () => ({ eq: () => ({ is: () => ({ select: async () => ({ data: [{ id: 'v1' }], error: null }) }) }), is: () => ({ select: async () => ({ data: [{ id: 'v1' }], error: null }) }) }) }),
        delete: () => q,
        insert: () => Promise.resolve({ error: null }),
        upsert: (row: Record<string, unknown>) => {
          upserts.push(row)
          return Promise.resolve({ error: null })
        },
        maybeSingle: async () => ({ data: table === 'phone_verification' ? pending : null, error: null }),
      }
      return q
    }
    return { client: { from: chain } as never, upserts }
  }

  it('verifying on today’s words turns alert texts on, as of the consent', async () => {
    const db = verifyDb(SMS_CONSENT_VERSION)
    const result = await verifyPhoneCode(db.client, { userId: 'u', code: '123456' }, { send: async () => ({ ok: false }) as never })
    expect(result.ok).toBe(true)
    expect(db.upserts[0]).toMatchObject({ alerts_consented_at: '2026-10-24T12:00:00.000Z', alerts_consent_version: SMS_CONSENT_VERSION })
  })

  it('verifying on the replies-only words leaves alert texts off', async () => {
    const db = verifyDb('2026-10-17')
    const result = await verifyPhoneCode(db.client, { userId: 'u', code: '123456' }, { send: async () => ({ ok: false }) as never })
    expect(result.ok).toBe(true)
    expect(db.upserts[0]).toMatchObject({ alerts_consented_at: null, alerts_consent_version: null })
  })
})

