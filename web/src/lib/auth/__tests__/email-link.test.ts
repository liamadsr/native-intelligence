import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emailLinkTarget, emailLinkType, isPkceTokenHash } from '../email-link'

/**
 * The Supabase Auth email templates (supabase/templates, pasted into the
 * dashboard) link to dial8.ai's /auth/confirm with the fields it reads, and
 * nothing in them points at supabase.co.
 */

const TEMPLATES = join(process.cwd(), 'supabase/templates')
const EXPECTED: Record<string, string> = {
  'confirmation.html': 'signup',
  'magic-link.html': 'magiclink',
  'recovery.html': 'recovery',
  'invite.html': 'invite',
  'email-change.html': 'email_change',
}

describe('auth email templates', () => {
  it('exist for every email that carries a link', () => {
    expect(readdirSync(TEMPLATES).sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  it.each(Object.entries(EXPECTED))('%s links to /auth/confirm with type=%s', (file, type) => {
    const html = readFileSync(join(TEMPLATES, file), 'utf8')
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1])
    expect(hrefs).toEqual([
      `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=${type}&redirect_to={{ .RedirectTo }}`,
    ])
    expect(emailLinkType(type)).toBe(type)
    expect(html).not.toMatch(/supabase|ConfirmationURL/i)
  })
})

describe('email link fields', () => {
  it('accepts only a PKCE token hash', () => {
    expect(isPkceTokenHash('pkce_0123456789abcdef0123456789abcdef0123456789abcdef01234567')).toBe(true)
    for (const bad of [
      null,
      '',
      '0123456789abcdef0123456789abcdef0123456789abcdef01234567',
      'pkce_short',
      `pkce_${'a'.repeat(65)}`,
      'pkce_0123456789ABCDEF0123456789abcdef0123456789abcdef01234567',
      'pkce_0123456789abcdef0123456789abcdef0123456789abcdef0123456/',
    ]) {
      expect(isPkceTokenHash(bad), String(bad)).toBe(false)
    }
  })

  it("lands on the sign-in's own redirect when it is on this origin, else where the type does", () => {
    const origin = 'https://dial8.ai'
    expect(emailLinkTarget('https://dial8.ai/auth/desktop-callback', 'magiclink', origin).toString()).toBe(
      'https://dial8.ai/auth/desktop-callback',
    )
    expect(emailLinkTarget('https://dial8.ai/reset-password#x', 'recovery', origin).toString()).toBe(
      'https://dial8.ai/reset-password',
    )
    for (const other of [null, '', 'not a url', '/auth/callback', 'https://evil.example/auth/callback', 'http://dial8.ai/auth/callback']) {
      expect(emailLinkTarget(other, 'signup', origin).toString(), String(other)).toBe('https://dial8.ai/auth/callback')
      expect(emailLinkTarget(other, 'recovery', origin).toString(), String(other)).toBe('https://dial8.ai/reset-password')
    }
  })
})
