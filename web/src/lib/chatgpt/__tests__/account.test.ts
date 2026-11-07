import { randomBytes } from 'node:crypto'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WORK_EMAIL_REQUIRED_MESSAGE } from '@/lib/auth/work-email'
import { resolveChatGptAccount, sessionTokenHash } from '../account'
import { saveConnection } from '../connection'
import { fakeService, type FakeService } from './fake-service'

const identity = (over: Partial<{ sub: string; email: string | null; emailVerified: boolean; name: string | null }> = {}) => ({
  sub: 'sub-1',
  email: 'ada@acme.com',
  emailVerified: true,
  name: 'Ada Lovelace',
  ...over,
})

let svc: FakeService

beforeAll(() => {
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', randomBytes(32).toString('base64'))
})

beforeEach(() => {
  svc = fakeService()
})

describe('resolveChatGptAccount', () => {
  it('signs a linked ChatGPT account in as its person, even if the email changed', async () => {
    svc.users.set('u-linked', { id: 'u-linked', email: 'old@acme.com' })
    await saveConnection(svc.client, {
      userId: 'u-linked',
      identity: identity({ email: 'old@acme.com' }),
      clientId: 'oaiapp_partner',
      tokens: { accessToken: 'a', refreshToken: 'r', idToken: null, expiresIn: 3600, scopes: [] },
    })
    expect(await resolveChatGptAccount(svc.client, identity({ email: 'new@acme.com' }))).toEqual({
      ok: true,
      userId: 'u-linked',
      email: 'old@acme.com',
      created: false,
    })
    expect(svc.calls.createUser).toHaveLength(0)
  })

  it('links a verified email to the existing account', async () => {
    svc.users.set('u-1', { id: 'u-1', email: 'Ada@Acme.com' })
    expect(await resolveChatGptAccount(svc.client, identity())).toEqual({ ok: true, userId: 'u-1', email: 'ada@acme.com', created: false })
    expect(svc.calls.createUser).toHaveLength(0)
  })

  it("never links to an account whose email was never confirmed: someone else may have set its password", async () => {
    svc.users.set('u-1', { id: 'u-1', email: 'ada@acme.com', unconfirmed: true })
    expect(await resolveChatGptAccount(svc.client, identity())).toEqual({ ok: false, error: 'email_unconfirmed' })
    expect(svc.users.size).toBe(1)
  })

  it('creates a confirmed account named from the ID token', async () => {
    const result = await resolveChatGptAccount(svc.client, identity())
    expect(result).toMatchObject({ ok: true, email: 'ada@acme.com', created: true })
    expect(svc.calls.createUser[0]).toEqual({
      email: 'ada@acme.com',
      email_confirm: true,
      user_metadata: { full_name: 'Ada Lovelace', name: 'Ada Lovelace' },
      app_metadata: { signup_via: 'chatgpt' },
    })
  })

  it('never links or creates on an unverified or missing email', async () => {
    svc.users.set('u-1', { id: 'u-1', email: 'ada@acme.com' })
    expect(await resolveChatGptAccount(svc.client, identity({ emailVerified: false }))).toEqual({ ok: false, error: 'unverified_email' })
    expect(await resolveChatGptAccount(svc.client, identity({ email: null }))).toEqual({ ok: false, error: 'unverified_email' })
    expect(svc.calls.createUser).toHaveLength(0)
  })

  it('names the work-email refusal', async () => {
    svc.createUser = () => ({ error: { message: WORK_EMAIL_REQUIRED_MESSAGE } })
    expect(await resolveChatGptAccount(svc.client, identity({ email: 'ada@gmail.com' }))).toEqual({
      ok: false,
      error: 'work_email_required',
    })
  })
})

describe('sessionTokenHash', () => {
  it('generates a magic-link token without sending mail', async () => {
    expect(await sessionTokenHash(svc.client, 'ada@acme.com')).toBe('hash-for-ada@acme.com')
    expect(svc.calls.generateLink[0]).toEqual({ type: 'magiclink', email: 'ada@acme.com' })
  })
})
