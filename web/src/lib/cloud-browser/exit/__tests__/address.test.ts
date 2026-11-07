/**
 * The hub's public-address check (exit/address.ts), the twin of the Mac's
 * policy.rs: the same ranges, and IPv4 inside IPv6 judged by its IPv4.
 */
import { describe, expect, it } from 'vitest'
import { isPublicAddress } from '../address'

describe('isPublicAddress', () => {
  it('lets the public internet through', () => {
    for (const ok of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:93.184.216.34', '64:ff9b::808:808'])
      expect(isPublicAddress(ok), ok).toBe(true)
  })

  it('refuses private, local and special ranges, also inside IPv6', () => {
    for (const refused of ['10.0.0.1', '192.168.1.1', '172.16.5.4', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.251',
      '255.255.255.255', '::1', '::', 'fe80::1', 'fd12:3456::1', 'ff02::fb', '2001:db8::1', '::ffff:192.168.1.1', '::ffff:7f00:1', '64:ff9b::a00:1', 'nonsense'])
      expect(isPublicAddress(refused), refused).toBe(false)
  })
})
