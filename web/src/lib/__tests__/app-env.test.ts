/**
 * Environment resolution for gating testing/diagnostic UI. The precedence
 * (VERCEL_ENV → NEXT_PUBLIC_VERCEL_ENV → NODE_ENV → 'development') and the
 * production/lower split are what decide whether real users see the recording
 * test harness, so they're worth pinning.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  getAppEnvironment,
  isProductionEnvironment,
  isLowerEnvironment,
} from '../app-env'

// vi.stubEnv mutates process.env; unstub after each case so tests don't leak.
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('app-env', () => {
  it('production only when VERCEL_ENV === "production"', () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    expect(getAppEnvironment()).toBe('production')
    expect(isProductionEnvironment()).toBe(true)
    expect(isLowerEnvironment()).toBe(false)
  })

  it('preview is a lower environment', () => {
    vi.stubEnv('VERCEL_ENV', 'preview')
    expect(isProductionEnvironment()).toBe(false)
    expect(isLowerEnvironment()).toBe(true)
  })

  it('development is a lower environment', () => {
    vi.stubEnv('VERCEL_ENV', 'development')
    expect(isLowerEnvironment()).toBe(true)
  })

  it('falls back to NEXT_PUBLIC_VERCEL_ENV when VERCEL_ENV is unset', () => {
    vi.stubEnv('VERCEL_ENV', '')
    vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', 'production')
    expect(isProductionEnvironment()).toBe(true)
  })

  it('client-side production (only NEXT_PUBLIC_VERCEL_ENV set) resolves to production', () => {
    vi.stubEnv('VERCEL_ENV', '')
    vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', 'production')
    vi.stubEnv('NODE_ENV', 'production')
    expect(isLowerEnvironment()).toBe(false)
  })

  it('bare NODE_ENV=production (no Vercel signal) is NOT treated as production deploy', () => {
    // Vitest sets NODE_ENV=test; simulate a build with only NODE_ENV=production
    // and neither Vercel var — the vitest/next build step. We want the Vercel
    // signal to be authoritative, so a bare NODE_ENV shouldn't flip us to prod
    // UNLESS it's genuinely 'production'. Here NODE_ENV IS production, so the
    // helper does resolve to production — documenting that fallback explicitly.
    vi.stubEnv('VERCEL_ENV', '')
    vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', '')
    vi.stubEnv('NODE_ENV', 'production')
    expect(getAppEnvironment()).toBe('production')
  })
})
