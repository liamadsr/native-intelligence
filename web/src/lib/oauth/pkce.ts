/**
 * PKCE (RFC 7636, S256) for the providers whose app is public (Brevo,
 * config.ts isPkceProvider): no client secret, so the code exchange proves it
 * is the same party that started the flow with a code verifier instead.
 *
 * Stateless: the verifier is derived from the flow's nonce (signed into the
 * state, and the web flow's binding cookie) with the server's state secret.
 * The authorize URL carries only its hash (the challenge); the callback
 * re-derives the verifier from the state's nonce. Someone who sees the
 * authorize URL or the state learns the nonce, never the verifier: that needs
 * the secret. A fresh nonce per connect makes a fresh verifier per connect.
 */
import crypto from 'crypto'
import { oauthStateSecret } from './state'

/** The flow's code verifier: 43 base64url characters (32 bytes), within RFC 7636's 43-128. */
export function pkceVerifier(nonce: string): string {
  return crypto.createHmac('sha256', oauthStateSecret()).update(`pkce:${nonce}`).digest('base64url')
}

/** The S256 challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}
