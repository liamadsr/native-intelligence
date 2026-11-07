/**
 * The checks every line goes through (memory-types.ts): secrets are refused
 * wherever a line is saved, and contact details are kept out of what the
 * nightly pass learns.
 */
import { describe, it, expect } from 'vitest'
import { hasContactDetails, memoryTextProblem } from '../memory-types'

describe('memoryTextProblem', () => {
  it.each([
    'My password is hunter2',
    'password: hunter2',
    'The password for the VPN is correct-horse',
    'Our api key is abc123',
    'Use AKIAIOSFODNN7EXAMPLE for the bucket',
    'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV',
    'Card 4242 4242 4242 4242',
    'Use sk-abcdefghijklmnopqrst',
  ])('refuses a secret: %s', (text) => {
    expect(memoryTextProblem(text)).toMatch(/Never save secrets/)
  })

  it.each(["Sign off with 'Best, Liam'", 'Keep replies to two or three sentences', 'Use a password manager for shared logins', 'Our ideal prospects have 50 to 200 people'])(
    'lets a preference through: %s',
    (text) => {
      expect(memoryTextProblem(text)).toBeNull()
    },
  )
})

describe('hasContactDetails', () => {
  it.each(['Cc liam@dial8.ai on pricing', 'Link to https://dial8.ai/demo', 'Point people to www.dial8.ai', 'Mention dial8.ai in the footer', 'Call me at +1 (415) 555-0100'])('finds contact details: %s', (text) => {
    expect(hasContactDetails(text)).toBe(true)
  })

  it.each(["Sign off with 'Best, Liam'", 'Keep replies to 2 or 3 sentences', 'Writes casually, no "Dear"'])('none in: %s', (text) => {
    expect(hasContactDetails(text)).toBe(false)
  })
})
