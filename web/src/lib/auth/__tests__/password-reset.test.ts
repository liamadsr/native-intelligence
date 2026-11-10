import { describe, expect, it } from 'vitest'
import { passwordResetReturnUrl, resetErrorPath, resetExchangeErrorCode, resetLinkProblem } from '../password-reset'

/**
 * A password reset ends where it was asked for: in a browser on that
 * browser's /reset-password, in the desktop app back in the app through
 * /auth/desktop-callback (the app's web view holds the verifier; an email
 * link always opens in the system browser).
 */
const NI = 'https://nativeintelligence.dev'
const OLD = 'https://dial8.ai'

describe('passwordResetReturnUrl', () => {
  it('asks a browser reset back to that browser’s reset page', () => {
    expect(passwordResetReturnUrl('browser', NI, NI)).toBe(`${NI}/reset-password`)
    expect(passwordResetReturnUrl('browser', OLD, NI)).toBe(`${OLD}/reset-password`)
    expect(passwordResetReturnUrl('browser', 'http://localhost:3000', 'http://localhost:3000')).toBe('http://localhost:3000/reset-password')
  })

  it('asks a desktop reset back through the desktop callback, the address a desktop sign-in already uses', () => {
    expect(passwordResetReturnUrl('desktop', NI, NI)).toBe(`${NI}/auth/desktop-callback`)
    // A window on the app's other domain returns through the app's address (signInReturnUrl).
    expect(passwordResetReturnUrl('desktop', OLD, NI)).toBe(`${NI}/auth/desktop-callback`)
    expect(passwordResetReturnUrl('desktop', 'http://localhost:3000', 'http://localhost:3000')).toBe('http://localhost:3000/auth/desktop-callback')
  })
})

describe('resetExchangeErrorCode', () => {
  it('names a link opened somewhere other than where it was asked for', () => {
    expect(resetExchangeErrorCode({ code: 'pkce_code_verifier_not_found' })).toBe('opened_elsewhere')
  })

  it('names an expired link, and keeps everything else generic', () => {
    expect(resetExchangeErrorCode({ code: 'flow_state_expired' })).toBe('link_expired')
    expect(resetExchangeErrorCode({ code: 'bad_code_verifier' })).toBe('auth_failed')
    expect(resetExchangeErrorCode({})).toBe('auth_failed')
    expect(resetExchangeErrorCode(null)).toBe('auth_failed')
  })
})

describe('resetErrorPath', () => {
  it('builds the reset page’s error address, with a safe code only', () => {
    expect(resetErrorPath('opened_elsewhere')).toBe('/reset-password?error=opened_elsewhere')
    expect(resetErrorPath('link_expired')).toBe('/reset-password?error=link_expired')
    expect(resetErrorPath('<script>')).toBe('/reset-password?error=auth_failed')
    expect(resetErrorPath('')).toBe('/reset-password?error=auth_failed')
  })
})

describe('resetLinkProblem', () => {
  it('reads the reset page’s ?error=', () => {
    expect(resetLinkProblem(undefined)).toBeNull()
    expect(resetLinkProblem(null)).toBeNull()
    expect(resetLinkProblem('opened_elsewhere')).toBe('opened_elsewhere')
    expect(resetLinkProblem('link_expired')).toBe('expired')
    expect(resetLinkProblem('auth_failed')).toBe('failed')
    // Any ?error= at all is a failed link: the form stays shut.
    expect(resetLinkProblem('')).toBe('failed')
    expect(resetLinkProblem('anything')).toBe('failed')
  })
})
