import { describe, expect, it } from 'vitest'
import {
  DEMO_USER_EMAIL,
  demoSupabaseTarget,
  isDemoUserEmail,
  isLocalHostname,
} from '../demo-workspace-guard'

describe('demoSupabaseTarget', () => {
  it("accepts DEV's hosted project", () => {
    expect(demoSupabaseTarget('https://edrjddsxjoigpbecqgfb.supabase.co')).toBe('dev')
    expect(demoSupabaseTarget('https://EDRJDDSXJOIGPBECQGFB.supabase.co/')).toBe('dev')
  })

  it('accepts a Supabase on this machine', () => {
    expect(demoSupabaseTarget('http://localhost:54321')).toBe('local')
    expect(demoSupabaseTarget('http://127.0.0.1:54321')).toBe('local')
    expect(demoSupabaseTarget('http://[::1]:54321')).toBe('local')
  })

  it('always refuses PROD', () => {
    expect(demoSupabaseTarget('https://bzfthjzyzevjokbuhqci.supabase.co')).toBeNull()
    // PROD's ref anywhere in the URL is refused, even behind a local proxy.
    expect(demoSupabaseTarget('http://localhost:54321/?project=bzfthjzyzevjokbuhqci')).toBeNull()
  })

  it('refuses any other project or host', () => {
    expect(demoSupabaseTarget('https://someotherproject.supabase.co')).toBeNull()
    // Substring tricks: DEV's ref inside another hostname is not DEV.
    expect(demoSupabaseTarget('https://edrjddsxjoigpbecqgfb.supabase.co.evil.example')).toBeNull()
    expect(demoSupabaseTarget('https://evil.example/edrjddsxjoigpbecqgfb.supabase.co')).toBeNull()
    expect(demoSupabaseTarget('https://localhost.evil.example')).toBeNull()
  })

  it('refuses a missing or malformed URL', () => {
    expect(demoSupabaseTarget(undefined)).toBeNull()
    expect(demoSupabaseTarget(null)).toBeNull()
    expect(demoSupabaseTarget('')).toBeNull()
    expect(demoSupabaseTarget('not a url')).toBeNull()
    expect(demoSupabaseTarget('ftp://localhost')).toBeNull()
  })
})

describe('isLocalHostname', () => {
  it('knows loopback names only', () => {
    expect(isLocalHostname('localhost')).toBe(true)
    expect(isLocalHostname('127.0.0.1')).toBe(true)
    expect(isLocalHostname('[::1]')).toBe(true)
    expect(isLocalHostname('nativeintelligence.dev')).toBe(false)
    expect(isLocalHostname('localhost.example')).toBe(false)
    expect(isLocalHostname(null)).toBe(false)
  })
})

describe('isDemoUserEmail', () => {
  it('matches the demo person only', () => {
    expect(DEMO_USER_EMAIL.endsWith('.test')).toBe(true)
    expect(isDemoUserEmail(DEMO_USER_EMAIL)).toBe(true)
    expect(isDemoUserEmail(' Demo@Native-Intelligence.test ')).toBe(true)
    expect(isDemoUserEmail('someone@native-intelligence.test')).toBe(false)
    expect(isDemoUserEmail(null)).toBe(false)
  })
})
