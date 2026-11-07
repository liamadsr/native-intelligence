import { describe, it, expect } from 'vitest'
import { authCallbackErrorCode } from '../callback-error'
import { WORK_EMAIL_REQUIRED_MESSAGE } from '../work-email'

describe('authCallbackErrorCode', () => {
  it('keeps the generic missing_code when no error is present', () => {
    expect(authCallbackErrorCode(new URLSearchParams(''))).toBe('missing_code')
    expect(authCallbackErrorCode(new URLSearchParams('state=abc'))).toBe('missing_code')
  })

  it('names the work-email refusal', () => {
    const params = new URLSearchParams({
      error: 'server_error',
      error_code: 'unexpected_failure',
      error_description: WORK_EMAIL_REQUIRED_MESSAGE,
    })
    expect(authCallbackErrorCode(params)).toBe('work_email_required')
  })

  it('names an email link that expired or was already used', () => {
    // As Supabase's verify endpoint redirects for a spent link.
    const params = new URLSearchParams({
      error: 'access_denied',
      error_code: 'otp_expired',
      error_description: 'Email link is invalid or has expired',
    })
    expect(authCallbackErrorCode(params)).toBe('link_expired')
  })

  it('maps every other provider error to auth_failed', () => {
    const params = new URLSearchParams({
      error: 'access_denied',
      error_description: 'The user denied the request',
    })
    expect(authCallbackErrorCode(params)).toBe('auth_failed')
    expect(authCallbackErrorCode(new URLSearchParams({ error: 'server_error' }))).toBe('auth_failed')
  })
})
