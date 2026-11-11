/** Test keys, and a webhook delivery signed as LiveKit signs one: a token whose sha256 claim is the body's hash. */
import { createHash } from 'node:crypto'
import { AccessToken } from 'livekit-server-sdk'

export const KEY = 'APItestkey0001'
export const SECRET = 'testsecret-testsecret-testsecret-testsecret-0001'
export const LIVEKIT_ENV = { LIVEKIT_URL: 'wss://livekit.example.invalid', LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET }

export async function signWebhook(body: string, key = KEY, secret = SECRET): Promise<string> {
  const token = new AccessToken(key, secret, { ttl: '5m' })
  token.sha256 = createHash('sha256').update(body).digest('base64')
  return token.toJwt()
}
