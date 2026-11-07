import { describe, it, expect } from 'vitest'
import { missingScopes, normalizeScope } from '@/lib/oauth/scope-diff'

describe('normalizeScope', () => {
  it('lowercases and strips the URL prefix for microsoft scopes', () => {
    expect(normalizeScope('microsoft', 'https://graph.microsoft.com/Mail.Send')).toBe('mail.send')
    expect(normalizeScope('microsoft', 'Mail.Send')).toBe('mail.send')
    expect(normalizeScope('microsoft', 'MAIL.READWRITE')).toBe('mail.readwrite')
  })

  it('leaves google scope URLs untouched', () => {
    expect(normalizeScope('google', 'https://www.googleapis.com/auth/gmail.compose')).toBe(
      'https://www.googleapis.com/auth/gmail.compose',
    )
  })
})

describe('missingScopes', () => {
  it('flags Mail.Send missing on a pre-existing microsoft email grant', () => {
    // The exact stored set of a connection made before Mail.Send was required
    const granted = ['Mail.Read', 'Mail.ReadWrite', 'User.Read', 'offline_access']
    expect(missingScopes('microsoft', 'email', granted)).toEqual(['Mail.Send'])
  })

  it('reports nothing when the grant covers the required set, in any casing/qualification', () => {
    const granted = [
      'https://graph.microsoft.com/Mail.Read',
      'https://graph.microsoft.com/Mail.ReadWrite',
      'https://graph.microsoft.com/Mail.Send',
      'https://graph.microsoft.com/User.Read',
    ]
    expect(missingScopes('microsoft', 'email', granted)).toEqual([])
  })

  it('never demands offline_access (not echoed back by Azure)', () => {
    const granted = ['Mail.Read', 'Mail.ReadWrite', 'Mail.Send', 'User.Read']
    expect(missingScopes('microsoft', 'email', granted)).toEqual([])
  })

  it('treats empty stored scopes as unknown, not missing-everything', () => {
    expect(missingScopes('microsoft', 'email', [])).toEqual([])
    expect(missingScopes('google', 'email', [])).toEqual([])
  })

  it('returns nothing for unknown provider/capability combos', () => {
    expect(missingScopes('github', 'email', ['repo'])).toEqual([])
    expect(missingScopes('nonexistent', 'email', ['x'])).toEqual([])
  })

  it('diffs google scopes by exact URL', () => {
    const granted = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ]
    expect(missingScopes('google', 'email', granted)).toEqual([
      'https://www.googleapis.com/auth/gmail.compose',
    ])
  })
})
