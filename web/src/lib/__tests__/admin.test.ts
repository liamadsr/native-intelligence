/**
 * Who is an admin (lib/admin.ts, security review 2026-10-31): a named
 * allowlist from ADMIN_EMAILS, never a whole domain, and the second-factor
 * check that switches on with ADMIN_REQUIRES_MFA.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/headers', () => ({ cookies: vi.fn() }))

import { ADMIN_REQUIRES_MFA, adminEmails, hasAdminAssurance, isAuthorizedAdmin } from '../admin'

/** A client whose assurance read answers `level` (or fails). */
function client(level: 'aal1' | 'aal2' | null, error: unknown = null) {
  const getAuthenticatorAssuranceLevel = vi.fn(async (_jwt?: string) => ({
    data: error ? null : { currentLevel: level, nextLevel: level, currentAuthenticationMethods: [] },
    error,
  }))
  return { supabase: { auth: { mfa: { getAuthenticatorAssuranceLevel } } } as unknown as SupabaseClient, getAuthenticatorAssuranceLevel }
}

describe('isAuthorizedAdmin', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('names admins one by one, from ADMIN_EMAILS', () => {
    vi.stubEnv('ADMIN_EMAILS', 'liam@dial8.ai')
    expect([...adminEmails()]).toEqual(['liam@dial8.ai'])
    expect(isAuthorizedAdmin('liam@dial8.ai')).toBe(true)
    expect(isAuthorizedAdmin(' Liam@Dial8.AI ')).toBe(true)
  })

  it('no longer lets in any other @dial8.ai address', () => {
    vi.stubEnv('ADMIN_EMAILS', 'liam@dial8.ai')
    expect(isAuthorizedAdmin('toby@dial8.ai')).toBe(false)
    expect(isAuthorizedAdmin('new-hire@dial8.ai')).toBe(false)
    expect(isAuthorizedAdmin('liam@dial8.ai.evil.example')).toBe(false)
    expect(isAuthorizedAdmin('liam+x@dial8.ai')).toBe(false)
  })

  it('has nobody when ADMIN_EMAILS is unset or empty', () => {
    vi.stubEnv('ADMIN_EMAILS', '')
    expect(isAuthorizedAdmin('liam@dial8.ai')).toBe(false)
    delete process.env.ADMIN_EMAILS
    expect(adminEmails().size).toBe(0)
    expect(isAuthorizedAdmin('liam@dial8.ai')).toBe(false)
  })

  it('refuses no email at all', () => {
    vi.stubEnv('ADMIN_EMAILS', 'liam@dial8.ai')
    expect(isAuthorizedAdmin(undefined)).toBe(false)
    expect(isAuthorizedAdmin('')).toBe(false)
  })
})

describe('hasAdminAssurance', () => {
  it('is off until every admin has a factor: no read, always enough', async () => {
    expect(ADMIN_REQUIRES_MFA).toBe(false)
    const { supabase, getAuthenticatorAssuranceLevel } = client('aal1')
    expect(await hasAdminAssurance(supabase)).toBe(true)
    expect(getAuthenticatorAssuranceLevel).not.toHaveBeenCalled()
  })

  it('when required: AAL2 only, from the cookie session or a bearer token', async () => {
    expect(await hasAdminAssurance(client('aal2').supabase, { required: true })).toBe(true)
    expect(await hasAdminAssurance(client('aal1').supabase, { required: true })).toBe(false)
    expect(await hasAdminAssurance(client(null).supabase, { required: true })).toBe(false)
    const bearer = client('aal2')
    expect(await hasAdminAssurance(bearer.supabase, { required: true, jwt: 'eyJ.token' })).toBe(true)
    expect(bearer.getAuthenticatorAssuranceLevel).toHaveBeenCalledWith('eyJ.token')
  })

  it('when required: a failed read is not enough', async () => {
    expect(await hasAdminAssurance(client(null, { message: 'no session' }).supabase, { required: true })).toBe(false)
    const throwing = { auth: { mfa: { getAuthenticatorAssuranceLevel: async () => { throw new Error('down') } } } } as unknown as SupabaseClient
    expect(await hasAdminAssurance(throwing, { required: true })).toBe(false)
  })
})
