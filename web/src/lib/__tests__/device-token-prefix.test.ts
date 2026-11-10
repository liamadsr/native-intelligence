import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => { throw new Error('no database in this test') } }))

import { isDeviceToken } from '../device-tokens'

describe('isDeviceToken', () => {
  it('knows a token minted now and one minted before the rename', () => {
    expect(isDeviceToken('nid_a1b2c3')).toBe(true)
    expect(isDeviceToken('d8d_a1b2c3')).toBe(true)
  })

  it('is false for a Supabase JWT and for a token that only contains a prefix', () => {
    expect(isDeviceToken('eyJhbGciOiJIUzI1NiJ9.e30.x')).toBe(false)
    expect(isDeviceToken('xnid_a1b2c3')).toBe(false)
    expect(isDeviceToken('')).toBe(false)
  })
})
