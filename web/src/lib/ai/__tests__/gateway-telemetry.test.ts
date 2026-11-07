import { describe, it, expect, vi, afterEach } from 'vitest'
import { gatewayTelemetry, gatewayTelemetryValues } from '@/lib/ai/gateway-telemetry'

/**
 * These tests own the flag env themselves via vi.stubEnv (they do NOT rely on
 * src/test/setup.ts, which is coordinated elsewhere). VERCEL_ENV is stubbed
 * per-test so the `env:` tag is deterministic regardless of where the suite runs.
 */
describe('gateway-telemetry', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('flag off', () => {
    it('gatewayTelemetryValues returns null when GATEWAY_USER_TAGGING is unset', () => {
      vi.stubEnv('GATEWAY_USER_TAGGING', '')
      expect(gatewayTelemetryValues('user-1', 'chat')).toBeNull()
    })

    it('gatewayTelemetryValues returns null when flag is any non-"all" value', () => {
      vi.stubEnv('GATEWAY_USER_TAGGING', 'true')
      expect(gatewayTelemetryValues('user-1', 'chat')).toBeNull()
    })

    it('gatewayTelemetry returns {} (spread-safe) when flag is off', () => {
      vi.stubEnv('GATEWAY_USER_TAGGING', '')
      expect(gatewayTelemetry('user-1', 'chat')).toEqual({})
    })
  })

  describe('flag on — shapes', () => {
    it('gatewayTelemetryValues returns user + feature/env tags', () => {
      vi.stubEnv('GATEWAY_USER_TAGGING', 'all')
      vi.stubEnv('VERCEL_ENV', 'production')
      expect(gatewayTelemetryValues('user-1', 'chat')).toEqual({
        user: 'user-1',
        tags: ['feature:chat', 'env:production'],
      })
    })

    it('gatewayTelemetry wraps values under providerOptions.gateway', () => {
      vi.stubEnv('GATEWAY_USER_TAGGING', 'all')
      vi.stubEnv('VERCEL_ENV', 'production')
      expect(gatewayTelemetry('user-1', 'chat')).toEqual({
        providerOptions: { gateway: { user: 'user-1', tags: ['feature:chat', 'env:production'] } },
      })
    })

    it('defaults env tag to "development" when VERCEL_ENV is unset', () => {
      vi.stubEnv('GATEWAY_USER_TAGGING', 'all')
      vi.stubEnv('VERCEL_ENV', '')
      const values = gatewayTelemetryValues('user-1', 'chat')
      expect(values?.tags).toContain('env:development')
    })
  })

  describe('tag order + optional tags', () => {
    it('emits tags in feature, env, ws, runtime, extra order', () => {
      vi.stubEnv('GATEWAY_USER_TAGGING', 'all')
      vi.stubEnv('VERCEL_ENV', 'preview')
      const values = gatewayTelemetryValues('user-1', 'chat', {
        workspaceId: 'ws-9',
        runtime: 'eve',
        extraTags: ['skill:foo'],
      })
      expect(values?.tags).toEqual([
        'feature:chat',
        'env:preview',
        'ws:ws-9',
        'runtime:eve',
        'skill:foo',
      ])
    })

    it('omits ws tag when workspaceId is falsy', () => {
      vi.stubEnv('GATEWAY_USER_TAGGING', 'all')
      vi.stubEnv('VERCEL_ENV', 'preview')
      const values = gatewayTelemetryValues('user-1', 'chat', { workspaceId: null })
      expect(values?.tags).toEqual(['feature:chat', 'env:preview'])
    })

    it('omits runtime tag when runtime is not eve', () => {
      vi.stubEnv('GATEWAY_USER_TAGGING', 'all')
      vi.stubEnv('VERCEL_ENV', 'preview')
      const values = gatewayTelemetryValues('user-1', 'chat', { workspaceId: 'ws-9' })
      expect(values?.tags).toEqual(['feature:chat', 'env:preview', 'ws:ws-9'])
    })
  })

  describe('constraint enforcement', () => {
    it('omits the user key entirely when userId is falsy (never empty string)', () => {
      vi.stubEnv('GATEWAY_USER_TAGGING', 'all')
      vi.stubEnv('VERCEL_ENV', 'production')
      const nullUser = gatewayTelemetryValues(null, 'brief')
      const undefUser = gatewayTelemetryValues(undefined, 'brief')
      const emptyUser = gatewayTelemetryValues('', 'brief')
      expect(nullUser).not.toHaveProperty('user')
      expect(undefUser).not.toHaveProperty('user')
      expect(emptyUser).not.toHaveProperty('user')
      // tags still applied so spend is feature/env attributed
      expect(nullUser?.tags).toEqual(['feature:brief', 'env:production'])
    })

    it('truncates the user id to 256 chars', () => {
      vi.stubEnv('GATEWAY_USER_TAGGING', 'all')
      const longUser = 'u'.repeat(300)
      const values = gatewayTelemetryValues(longUser, 'chat')
      expect(values?.user).toHaveLength(256)
    })

    it('truncates each tag to 64 chars', () => {
      vi.stubEnv('GATEWAY_USER_TAGGING', 'all')
      const longWs = 'w'.repeat(100)
      const values = gatewayTelemetryValues('user-1', 'chat', { workspaceId: longWs })
      const wsTag = values?.tags.find((t) => t.startsWith('ws:'))
      expect(wsTag).toHaveLength(64)
    })

    it('drops empty extra tags', () => {
      vi.stubEnv('GATEWAY_USER_TAGGING', 'all')
      vi.stubEnv('VERCEL_ENV', 'production')
      const values = gatewayTelemetryValues('user-1', 'chat', { extraTags: ['', '   ', 'keep'] })
      expect(values?.tags).toEqual(['feature:chat', 'env:production', 'keep'])
    })

    it('caps the tag list at 10, keeping the standard tags first', () => {
      vi.stubEnv('GATEWAY_USER_TAGGING', 'all')
      vi.stubEnv('VERCEL_ENV', 'production')
      const many = Array.from({ length: 20 }, (_, i) => `extra:${i}`)
      const values = gatewayTelemetryValues('user-1', 'chat', {
        workspaceId: 'ws-9',
        runtime: 'eve',
        extraTags: many,
      })
      expect(values?.tags).toHaveLength(10)
      // Standard tags survive the cap; caller extras are what's dropped.
      expect(values?.tags.slice(0, 4)).toEqual([
        'feature:chat',
        'env:production',
        'ws:ws-9',
        'runtime:eve',
      ])
    })
  })
})
