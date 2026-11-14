/**
 * Environment resolution for gating testing/diagnostic UI. NODE_ENV decides
 * whether real users see the recording test harness, so the production/lower
 * split is worth pinning.
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
  it('a built app (NODE_ENV=production) is production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(getAppEnvironment()).toBe('production')
    expect(isProductionEnvironment()).toBe(true)
    expect(isLowerEnvironment()).toBe(false)
  })

  it('development is a lower environment', () => {
    vi.stubEnv('NODE_ENV', 'development')
    expect(getAppEnvironment()).toBe('development')
    expect(isProductionEnvironment()).toBe(false)
    expect(isLowerEnvironment()).toBe(true)
  })

  it('the test suite is a lower environment', () => {
    expect(getAppEnvironment()).toBe('test')
    expect(isLowerEnvironment()).toBe(true)
  })

  it('an empty NODE_ENV counts as unset: development', () => {
    vi.stubEnv('NODE_ENV', '')
    expect(getAppEnvironment()).toBe('development')
    expect(isLowerEnvironment()).toBe(true)
  })
})
