/**
 * A saved login's fill, the pure half (src/lib/browser-agent/sign-in-fill.ts):
 * the question for the person's computer, its answer, and which fields of a
 * sign-in page the answer goes into.
 */
import { describe, expect, it } from 'vitest'
import { parseSavedLoginAnswer, savedLoginQuestion, signInFields } from '../sign-in-fill'

const bytes = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
const account = (ref: string, name = 'Email', over: Record<string, unknown> = {}) =>
  ({ ref, name, canType: true, disabled: false, forbidden: false, input: { type: 'email', autocomplete: 'username' }, ...over })
const password = (ref: string, over: Record<string, unknown> = {}) =>
  ({ ref, name: 'Password', canType: false, disabled: false, forbidden: true, secretKind: 'password' as const, ...over })

describe('the question and the answer', () => {
  it('asks for the page’s host and nothing else', () => {
    expect(JSON.parse(new TextDecoder().decode(savedLoginQuestion('app.example.com')))).toEqual({ v: 1, op: 'saved_login', host: 'app.example.com' })
  })

  it('reads a login only from a whole, plain yes', () => {
    const yes = { ok: true, host: 'App.Example.com', username: 'kim@example.com', password: 'made-up-secret' }
    expect(parseSavedLoginAnswer(bytes(yes), 'app.example.com')).toEqual({ host: 'app.example.com', username: 'kim@example.com', password: 'made-up-secret' })
    // An answer for another host than the one asked about is no answer.
    expect(parseSavedLoginAnswer(bytes(yes), 'evil.example')).toBeNull()
    expect(parseSavedLoginAnswer(bytes({ ...yes, host: undefined }), 'app.example.com')).toBeNull()
    for (const no of [null, bytes(''), bytes('not json'), bytes([]), bytes({ ok: false, reason: 'none' }), bytes({ ...yes, password: undefined }),
      bytes({ ...yes, username: '' }), bytes({ ...yes, password: '' }), bytes({ ...yes, ok: 'true' }),
      bytes({ ...yes, password: 'x'.repeat(513) })]) expect(parseSavedLoginAnswer(no, 'app.example.com')).toBeNull()
  })
})

describe('signInFields', () => {
  it('the one known password and the account field just above it', () => {
    const search = { ref: 'e1', name: 'Search', canType: true, disabled: false, forbidden: false, input: { type: 'search', autocomplete: '' } }
    expect(signInFields({ elements: [search, account('e2', 'Work email'), account('e3'), password('e4')] })).toEqual({ account: 'e3', password: 'e4' })
    // A sign-in form above a sign-up form: only the known password, and the account before it.
    expect(signInFields({ elements: [account('e1'), password('e2'), account('e3'), password('e4', { secretKind: 'new-password' })] })).toEqual({ account: 'e1', password: 'e2' })
  })

  it('the first step of a two-step sign-in is the page’s only account field; the second is the password alone', () => {
    expect(signInFields({ elements: [account('e1', 'Email or phone')] })).toEqual({ account: 'e1' })
    expect(signInFields({ elements: [password('e7')] })).toEqual({ password: 'e7' })
    // Two account fields and no password: which one is a guess, so neither.
    expect(signInFields({ elements: [account('e1'), account('e2')] })).toEqual({})
  })

  it('never a disabled field, a frame’s field, two known passwords, or a field that is not an account’s', () => {
    expect(signInFields({ elements: [account('e1', 'Email', { disabled: true }), password('e2', { disabled: true })] })).toEqual({})
    expect(signInFields({ elements: [account('f0e1', 'Email', { frame: 'f0' }), password('f0e2', { frame: 'f0' })] })).toEqual({})
    expect(signInFields({ elements: [password('e1'), password('e2')] })).toEqual({})
    expect(signInFields({ elements: [{ ref: 'e1', name: 'Coupon', canType: true, disabled: false, forbidden: false, input: { type: 'text', autocomplete: '' } }, password('e2')] })).toEqual({ password: 'e2' })
    expect(signInFields({})).toEqual({})
  })
})
