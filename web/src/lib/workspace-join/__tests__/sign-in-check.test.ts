/**
 * Once per sign-in: the marker is the sign-in's own stamp, so a new sign-in
 * checks again and the same one never does twice.
 */
import { describe, expect, it } from 'vitest'
import { NextResponse } from 'next/server'
import { JOIN_CHECK_COOKIE, checkedThisSignIn, markCheckedThisSignIn, signInStamp } from '../sign-in-check'

const signIn = (at: string | null) => ({ last_sign_in_at: at })

describe('once per sign-in', () => {
  it('a fresh sign-in, or no marker, is unchecked; the same sign-in is checked', () => {
    expect(checkedThisSignIn(undefined, signIn('2026-11-13T10:00:00Z'))).toBe(false)
    expect(checkedThisSignIn('2026-11-13T10:00:00Z', signIn('2026-11-13T10:00:00Z'))).toBe(true)
    expect(checkedThisSignIn('2026-11-12T09:00:00Z', signIn('2026-11-13T10:00:00Z'))).toBe(false)
  })

  it('a user record without a stamp is never "checked" and writes no marker', () => {
    expect(signInStamp(signIn(null))).toBeNull()
    expect(checkedThisSignIn('', signIn(null))).toBe(false)
    const res = markCheckedThisSignIn(NextResponse.json({}), signIn(null))
    expect(res.cookies.get(JOIN_CHECK_COOKIE)).toBeUndefined()
  })

  it('writes an httpOnly marker holding the stamp', () => {
    const res = markCheckedThisSignIn(NextResponse.json({}), signIn('2026-11-13T10:00:00Z'))
    expect(res.cookies.get(JOIN_CHECK_COOKIE)).toMatchObject({ value: '2026-11-13T10:00:00Z', httpOnly: true, path: '/' })
  })
})
