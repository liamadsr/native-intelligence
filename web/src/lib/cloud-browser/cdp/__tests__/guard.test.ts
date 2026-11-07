/**
 * The cloud browser's navigation guard lease (src/lib/cloud-browser/cdp/guard.ts),
 * matching the desktop's browser_set_agent_guard: lowercase entries, empty ones
 * dropped, capped at 10 minutes, no lease or no sites = no guard, and an entry
 * blocks its host and every subdomain only while the lease lasts.
 */
import { describe, expect, it } from 'vitest'
import { guardBlocks, guardLease, MAX_GUARD_LEASE_MS } from '../guard'

describe('guardLease', () => {
  it('lowercases entries and drops empty ones', () => {
    expect(guardLease(['LinkedIn.com', ''], 60_000, 0)).toEqual({ sites: ['linkedin.com'], until: 60_000 })
  })
  it('caps the lease at 10 minutes', () => {
    expect(guardLease(['linkedin.com'], Number.MAX_SAFE_INTEGER, 0)?.until).toBe(MAX_GUARD_LEASE_MS)
  })
  it('no lease or no sites is no guard', () => {
    expect(guardLease(['linkedin.com'], 0)).toBeNull()
    expect(guardLease(['linkedin.com'], -5)).toBeNull()
    expect(guardLease([], 60_000)).toBeNull()
    expect(guardLease([''], 60_000)).toBeNull()
  })
})

describe('guardBlocks', () => {
  const lease = { sites: ['linkedin.com'], until: 1000 }
  it('blocks the site and its subdomains, not look-alikes', () => {
    expect(guardBlocks(lease, 'https://www.linkedin.com/feed', 0)).toBe('linkedin.com')
    expect(guardBlocks(lease, 'http://M.LinkedIn.COM:8443/in/me', 0)).toBe('linkedin.com')
    expect(guardBlocks(lease, 'https://evillinkedin.com/', 0)).toBeNull()
    expect(guardBlocks(lease, 'https://example.com/?next=https://linkedin.com', 0)).toBeNull()
  })
  it('blocks nothing once the lease ends, or with no guard', () => {
    expect(guardBlocks(lease, 'https://linkedin.com/', 1000)).toBeNull()
    expect(guardBlocks(null, 'https://linkedin.com/', 0)).toBeNull()
  })
})
