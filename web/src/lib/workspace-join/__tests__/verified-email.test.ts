/**
 * When an address is proven enough to open a workspace on its own: Supabase
 * confirmed it AND a provider identity for that address verified it; Azure
 * identities only with the domain owner's verification.
 */
import { describe, expect, it } from 'vitest'
import { hasVerifiedEmail } from '../verified-email'

const EMAIL = 'avery@acme.example'
const CONFIRMED = '2026-11-01T00:00:00.000Z'

function user(identities: Array<{ provider: string; data: Record<string, unknown> }>, confirmed: string | null = CONFIRMED) {
  return {
    email: EMAIL,
    email_confirmed_at: confirmed,
    identities: identities.map((i) => ({ provider: i.provider, identity_data: i.data })),
  }
}

describe('hasVerifiedEmail', () => {
  it('accepts a confirmed address a Google identity verified', () => {
    expect(hasVerifiedEmail(user([{ provider: 'google', data: { email: EMAIL, email_verified: true } }]))).toBe(true)
  })

  it('accepts a confirmed password account whose email identity is verified', () => {
    expect(hasVerifiedEmail(user([{ provider: 'email', data: { email: EMAIL, email_verified: true } }]))).toBe(true)
  })

  it('refuses an unconfirmed address, whatever the identity says', () => {
    expect(hasVerifiedEmail(user([{ provider: 'google', data: { email: EMAIL, email_verified: true } }], null))).toBe(false)
  })

  it('refuses a confirmed address whose identity is unverified', () => {
    expect(hasVerifiedEmail(user([{ provider: 'email', data: { email: EMAIL, email_verified: false } }]))).toBe(false)
    expect(hasVerifiedEmail(user([{ provider: 'email', data: { email: EMAIL } }]))).toBe(false)
    // A string is not taken on trust.
    expect(hasVerifiedEmail(user([{ provider: 'google', data: { email: EMAIL, email_verified: 'true' } }]))).toBe(false)
  })

  it('refuses an Azure identity that only claims the address', () => {
    // Supabase counts a missing xms_edov as verified; we don't.
    expect(hasVerifiedEmail(user([{ provider: 'azure', data: { email: EMAIL, email_verified: true } }]))).toBe(false)
    expect(hasVerifiedEmail(user([{ provider: 'azure', data: { email: EMAIL, email_verified: true, xms_edov: false } }]))).toBe(false)
    expect(hasVerifiedEmail(user([{ provider: 'azure', data: { email: EMAIL, email_verified: false, xms_edov: true } }]))).toBe(false)
  })

  it('accepts an Azure identity the domain owner verified', () => {
    expect(hasVerifiedEmail(user([{ provider: 'azure', data: { email: EMAIL, email_verified: true, xms_edov: true } }]))).toBe(true)
    expect(hasVerifiedEmail(user([{ provider: 'azure', data: { email: EMAIL, email_verified: true, xms_edov: '1' } }]))).toBe(true)
  })

  it('lets another identity vouch for the address next to an unverified Azure one', () => {
    expect(
      hasVerifiedEmail(
        user([
          { provider: 'azure', data: { email: EMAIL, email_verified: true } },
          { provider: 'google', data: { email: EMAIL, email_verified: true } },
        ]),
      ),
    ).toBe(true)
  })

  it('refuses an identity verified for a different address', () => {
    expect(hasVerifiedEmail(user([{ provider: 'google', data: { email: 'avery@northwind.example', email_verified: true } }]))).toBe(false)
  })

  it('refuses when there are no identities, or no user', () => {
    expect(hasVerifiedEmail(user([]))).toBe(false)
    expect(hasVerifiedEmail({ email: EMAIL, email_confirmed_at: CONFIRMED })).toBe(false)
    expect(hasVerifiedEmail(null)).toBe(false)
  })
})
