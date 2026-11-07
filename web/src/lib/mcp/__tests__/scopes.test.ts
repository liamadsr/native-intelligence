/**
 * The scope rule authorize, approve and the consent page share (scopes.ts):
 * only read and write, write bringing read, and never an empty grant, which
 * reads as a legacy full-access token.
 */
import { describe, expect, it } from 'vitest'
import { isReadOnlyToken } from '../guard'
import { grantedScopes } from '../scopes'

describe('grantedScopes', () => {
  it('no scope asked: both, as before', () => {
    expect(grantedScopes(null)).toEqual(['read', 'write'])
    expect(grantedScopes(undefined)).toEqual(['read', 'write'])
    expect(grantedScopes('')).toEqual(['read', 'write'])
  })

  it('read alone stays read-only; write always brings read', () => {
    expect(grantedScopes('read')).toEqual(['read'])
    expect(isReadOnlyToken(grantedScopes('read'))).toBe(true)
    expect(grantedScopes('write')).toEqual(['read', 'write'])
    expect(grantedScopes('write read')).toEqual(['read', 'write'])
  })

  it('drops every other word, and refuses a request naming neither', () => {
    expect(grantedScopes('read Verified\u00a0by\u00a0Anthropic')).toEqual(['read'])
    expect(grantedScopes('admin')).toBeNull()
    expect(grantedScopes('Read WRITE')).toBeNull()
    expect(grantedScopes(['read'])).toBeNull()
  })

  it('never yields an empty list (empty = legacy full access)', () => {
    expect(isReadOnlyToken([])).toBe(false)
    for (const raw of ['x', ' ', 'readwrite', 'read,write']) expect(grantedScopes(raw), raw).not.toEqual([])
  })
})
