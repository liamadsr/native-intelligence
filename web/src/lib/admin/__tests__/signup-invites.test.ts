import { describe, it, expect } from 'vitest'
import {
  normalizeInviteEmail,
  renderSignupInviteEmail,
  signupInviteStatus,
} from '../signup-invites'

describe('normalizeInviteEmail', () => {
  it('lower-cases and trims a usable address', () => {
    expect(normalizeInviteEmail('  Jane@Gmail.COM ')).toBe('jane@gmail.com')
  })

  it('rejects non-addresses', () => {
    for (const bad of ['', 'jane', '@x.com', 'jane@', 'jane@localhost', 'a b@x.com', 12, null]) {
      expect(normalizeInviteEmail(bad)).toBeNull()
    }
  })
})

describe('signupInviteStatus', () => {
  const now = new Date('2026-09-02T12:00:00Z')
  it('used beats expired', () => {
    expect(signupInviteStatus({ used_at: '2026-08-01T00:00:00Z', expires_at: '2026-08-02T00:00:00Z' }, now)).toBe('used')
  })
  it('expired when past expiry and unused', () => {
    expect(signupInviteStatus({ used_at: null, expires_at: '2026-09-01T00:00:00Z' }, now)).toBe('expired')
  })
  it('pending otherwise', () => {
    expect(signupInviteStatus({ used_at: null, expires_at: '2026-10-01T00:00:00Z' }, now)).toBe('pending')
  })
})

describe('renderSignupInviteEmail', () => {
  it('tells a card-required invitee about the trial, and a comped one that no card is needed', () => {
    expect(renderSignupInviteEmail({ token: 't', note: null, skip_payment: false }).html).toContain('7-day free trial')
    expect(renderSignupInviteEmail({ token: 't', note: null, skip_payment: true }).html).toContain('No card needed')
    expect(renderSignupInviteEmail({ token: 't', note: null }).html).toContain('No card needed')
  })

  it('links to the token and escapes the note', () => {
    const { subject, html } = renderSignupInviteEmail({ token: 'abc123', note: '<b>hi</b> & bye' })
    expect(subject).toContain('Dial8')
    expect(html).toContain('/login?invite=abc123')
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt; &amp; bye')
    expect(html).not.toContain('<b>hi</b>')
  })
})
