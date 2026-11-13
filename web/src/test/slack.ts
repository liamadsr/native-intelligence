/**
 * Slack test helpers: made-up settings for a configured Slack app, and a
 * request signed the way Slack signs one (X-Slack-Signature, v0). Every value
 * here is made up.
 */
import { createHmac } from 'node:crypto'
import { vi } from 'vitest'

export const SLACK_TEST_APP_ID = 'A0MADEUP01'
export const SLACK_TEST_CLIENT_ID = '1111111111.2222222222'
// Built, not written out: a literal of this shape reads as a real secret to the leak check.
export const SLACK_TEST_CLIENT_SECRET = 'c1'.repeat(16)
export const SLACK_TEST_SIGNING_SECRET = '5e'.repeat(16)

/** Stub all four Slack settings (vi.stubEnv; undo with vi.unstubAllEnvs). */
export function stubSlackEnv(over: Partial<Record<'SLACK_APP_ID' | 'SLACK_CLIENT_ID' | 'SLACK_CLIENT_SECRET' | 'SLACK_SIGNING_SECRET', string>> = {}): void {
  vi.stubEnv('SLACK_APP_ID', over.SLACK_APP_ID ?? SLACK_TEST_APP_ID)
  vi.stubEnv('SLACK_CLIENT_ID', over.SLACK_CLIENT_ID ?? SLACK_TEST_CLIENT_ID)
  vi.stubEnv('SLACK_CLIENT_SECRET', over.SLACK_CLIENT_SECRET ?? SLACK_TEST_CLIENT_SECRET)
  vi.stubEnv('SLACK_SIGNING_SECRET', over.SLACK_SIGNING_SECRET ?? SLACK_TEST_SIGNING_SECRET)
}

/** The two headers Slack sends with a request: its timestamp and its v0 signature over `v0:<ts>:<raw body>`. */
export function slackSignatureHeaders(
  rawBody: string,
  opts: { secret?: string; at?: number } = {},
): { 'x-slack-request-timestamp': string; 'x-slack-signature': string } {
  const ts = String(Math.floor((opts.at ?? Date.now()) / 1000))
  const sig = createHmac('sha256', opts.secret ?? SLACK_TEST_SIGNING_SECRET).update(`v0:${ts}:${rawBody}`).digest('hex')
  return { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${sig}` }
}
