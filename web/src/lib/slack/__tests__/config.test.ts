/**
 * Slack's settings (config.ts): on only with all four, each well formed; and
 * Slack's request signature (signature.ts) with the signing secret. Every
 * value here is made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SLACK_TEST_SIGNING_SECRET, slackSignatureHeaders, stubSlackEnv } from '@/test/slack'
import { SLACK_BOT_SCOPES, slackAppId, slackClientId, slackClientSecret, slackConfigured, slackRedirectUri, slackSigningSecret } from '../config'
import { verifySlackSignature } from '../signature'

beforeEach(() => stubSlackEnv())
afterEach(() => vi.unstubAllEnvs())

describe('slackConfigured', () => {
  it('is on with all four settings, well formed (spaces around them are fine)', () => {
    expect(slackConfigured()).toBe(true)
    stubSlackEnv({ SLACK_CLIENT_SECRET: ' 0123456789abcdef0123456789abcdef\n' })
    expect(slackConfigured()).toBe(true)
  })

  it('is off when any one is missing', () => {
    for (const name of ['SLACK_APP_ID', 'SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET', 'SLACK_SIGNING_SECRET'] as const) {
      stubSlackEnv({ [name]: '' })
      expect(slackConfigured(), name).toBe(false)
      stubSlackEnv()
    }
  })

  it('is off when any one is malformed', () => {
    const bad = [
      { SLACK_APP_ID: 'a0lowercase' },
      { SLACK_APP_ID: 'T0NOTANAPP' },
      { SLACK_CLIENT_ID: 'not-a-client-id' },
      { SLACK_CLIENT_ID: '1234567890' },
      { SLACK_CLIENT_SECRET: 'too-short' },
      { SLACK_CLIENT_SECRET: 'zz23456789abcdef0123456789abcdef' },
      { SLACK_SIGNING_SECRET: '0123456789abcdef0123456789abcdeg' },
      { SLACK_SIGNING_SECRET: 'a'.repeat(129) },
      { SLACK_CLIENT_SECRET: 'a'.repeat(31) },
    ]
    for (const over of bad) {
      stubSlackEnv(over)
      expect(slackConfigured(), JSON.stringify(over)).toBe(false)
    }
    stubSlackEnv({ SLACK_APP_ID: 'nope', SLACK_CLIENT_ID: 'nope', SLACK_CLIENT_SECRET: 'nope', SLACK_SIGNING_SECRET: 'nope' })
    expect([slackAppId(), slackClientId(), slackClientSecret(), slackSigningSecret()]).toEqual([null, null, null, null])
  })

  it('takes secrets of 32 to 128 hexadecimal characters, either case (the same rule as the settings check)', () => {
    for (const secret of ['0123456789ABCDEF0123456789abcdef', 'a'.repeat(64), 'F'.repeat(128)]) {
      stubSlackEnv({ SLACK_CLIENT_SECRET: secret, SLACK_SIGNING_SECRET: secret })
      expect(slackConfigured(), String(secret.length)).toBe(true)
    }
  })

  it('says by name, once, that a setting is malformed, never its value', async () => {
    vi.resetModules()
    const fresh = await import('../config')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubSlackEnv({ SLACK_CLIENT_ID: 'made-up-wrong-value' })
    fresh.slackConfigured()
    fresh.slackConfigured()
    const calls = warn.mock.calls.filter((c) => JSON.stringify(c).includes('SLACK_CLIENT_ID'))
    expect(calls).toHaveLength(1)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('made-up-wrong-value')
    warn.mockRestore()
  })

  it('asks for exactly the bot scopes, and returns to our own callback', () => {
    expect([...SLACK_BOT_SCOPES].sort()).toEqual(['app_mentions:read', 'chat:write', 'im:history', 'im:read', 'im:write', 'reactions:write', 'team:read', 'users:read'])
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test/')
    expect(slackRedirectUri()).toBe('https://app.example.test/api/slack/oauth/callback')
  })
})

describe('verifySlackSignature', () => {
  const body = 'payload=%7B%7D'
  const headers = (h: Record<string, string>) => new Headers(h)

  it("takes Slack's v0 signature over the raw body with the signing secret", () => {
    expect(verifySlackSignature(headers(slackSignatureHeaders(body)), body)).toBe(true)
  })

  it('refuses no signature, another secret, another body, a stale or future timestamp', () => {
    expect(verifySlackSignature(headers({}), body)).toBe(false)
    expect(verifySlackSignature(headers(slackSignatureHeaders(body, { secret: '11111111111111111111111111111111' })), body)).toBe(false)
    expect(verifySlackSignature(headers(slackSignatureHeaders(body)), `${body}x`)).toBe(false)
    expect(verifySlackSignature(headers(slackSignatureHeaders(body, { at: Date.now() - 301_000 })), body)).toBe(false)
    expect(verifySlackSignature(headers(slackSignatureHeaders(body, { at: Date.now() + 301_000 })), body)).toBe(false)
  })

  it('verifies nothing without a well-formed signing secret (fails closed)', () => {
    stubSlackEnv({ SLACK_SIGNING_SECRET: '' })
    expect(verifySlackSignature(headers(slackSignatureHeaders(body, { secret: SLACK_TEST_SIGNING_SECRET })), body)).toBe(false)
  })
})
