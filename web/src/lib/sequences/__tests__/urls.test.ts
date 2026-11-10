import { describe, it, expect, afterEach } from 'vitest'
import { getSequenceUrl } from '@/lib/sequences/urls'

const ORIGINAL = process.env.NEXT_PUBLIC_APP_URL

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL
})

describe('getSequenceUrl', () => {
  it('builds the /account?sequence= deep link on the app origin', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://nativeintelligence.dev'
    expect(getSequenceUrl('seq-123')).toBe('https://nativeintelligence.dev/account?sequence=seq-123')
  })

  it('strips a trailing slash from the configured origin', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000/'
    expect(getSequenceUrl('abc')).toBe('http://localhost:3000/account?sequence=abc')
  })

  it('defaults to the production origin', () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    expect(getSequenceUrl('x')).toBe('https://nativeintelligence.dev/account?sequence=x')
  })
})
