import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Tests for src/lib/stripe.ts.
 *
 * Goals:
 *  - getStripe() is a singleton (same instance returned across calls)
 *  - getStripe() throws when the key isn't set
 *  - getStripeForEnv('production') uses PROD_STRIPE_SECRET_KEY
 *  - getStripeForEnv returns null when the relevant key is missing (so
 *    admin routes can surface a friendly 500 instead of crashing)
 */

// Stub the Stripe constructor so we can assert which key was used without
// actually instantiating a real client.
const stripeInstances: Array<{ key: string }> = []
vi.mock('stripe', () => {
  return {
    default: class MockStripe {
      key: string
      constructor(key: string) {
        this.key = key
        stripeInstances.push(this)
      }
    },
  }
})

const { getStripe, getStripeForEnv, safeCheckoutOrigin, __resetStripeClientsForTest } = await import(
  '@/lib/stripe'
)

beforeEach(() => {
  stripeInstances.length = 0
  __resetStripeClientsForTest()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getStripe', () => {
  it('throws when STRIPE_SECRET_KEY is missing', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    expect(() => getStripe()).toThrow('STRIPE_SECRET_KEY is not set')
  })

  it('returns a cached singleton on subsequent calls', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_1')
    const a = getStripe()
    const b = getStripe()
    expect(a).toBe(b)
    expect(stripeInstances).toHaveLength(1)
  })
})

describe('getStripeForEnv', () => {
  it('returns null in development when STRIPE_SECRET_KEY is missing', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    expect(getStripeForEnv('development')).toBeNull()
  })

  it('returns null in production when PROD_STRIPE_SECRET_KEY is missing', () => {
    vi.stubEnv('PROD_STRIPE_SECRET_KEY', '')
    expect(getStripeForEnv('production')).toBeNull()
  })

  it('uses PROD_STRIPE_SECRET_KEY in production', () => {
    vi.stubEnv('PROD_STRIPE_SECRET_KEY', 'sk_live_prod')
    const client = getStripeForEnv('production') as unknown as { key: string }
    expect(client).not.toBeNull()
    expect(client.key).toBe('sk_live_prod')
  })

  it('uses STRIPE_SECRET_KEY in development', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_dev')
    const client = getStripeForEnv('development') as unknown as { key: string }
    expect(client).not.toBeNull()
    expect(client.key).toBe('sk_test_dev')
  })

  it('caches the prod client across calls', () => {
    vi.stubEnv('PROD_STRIPE_SECRET_KEY', 'sk_live_prod')
    const a = getStripeForEnv('production')
    const b = getStripeForEnv('production')
    expect(a).toBe(b)
    expect(stripeInstances).toHaveLength(1)
  })
})

describe('safeCheckoutOrigin (P2-6)', () => {
  it.each(['nativeintelligence.dev', 'dial8.ai'])("allows the app's own origin on %s, and its www", (domain) => {
    expect(safeCheckoutOrigin(`https://${domain}`)).toBe(`https://${domain}`)
    expect(safeCheckoutOrigin(`https://www.${domain}`)).toBe(`https://www.${domain}`)
  })

  it.each(['nativeintelligence.dev', 'dial8.ai'])('rejects a look-alike of %s', (domain) => {
    for (const evil of [`https://${domain}.evil.com`, `https://evil.${domain}`, `https://not${domain}`, `https://browser-relay.${domain}`, `http://${domain}`]) {
      expect(safeCheckoutOrigin(evil), evil).not.toBe(evil)
    }
  })

  it('rejects an attacker origin and falls back to the canonical site', () => {
    expect(safeCheckoutOrigin('https://evil.example.com')).not.toBe('https://evil.example.com')
    expect(safeCheckoutOrigin('https://dial8.ai.evil.com')).not.toContain('evil')
  })

  it('falls back when the origin header is absent', () => {
    const out = safeCheckoutOrigin(null)
    expect(out.startsWith('http')).toBe(true)
    expect(out).not.toBe('')
  })
})
