/**
 * The caller's Supabase JWT, sealed into a chat-run token (the browser chat's
 * and the device ask's) so the internal chat tool route can hand it to the two
 * tools that call back into the app AS the user (generate_email_drafts → /api/account/email/generate-drafts,
 * draft_followup_email → /api/account/captures/[id]/draft-followup). Both
 * endpoints authenticate with `supabase.auth.getUser()` on the request's
 * credential, so a server-to-server call without the caller's bearer is a 401.
 *
 * ── Parity with the in-process /api/device/ask (the route before eve) ───────
 * That route passed the request's bearer straight into
 * createTools(user, supabase, workspace, bearerToken). What that bought:
 *   - a Supabase JWT caller → the two tools worked (the endpoints accept it);
 *   - a `nid_` device token → nothing: createClient() never forwards a nid_
 *     bearer to Supabase, so both endpoints answered 401 and the tools
 *     returned { success: false };
 *   - a cookie caller → no bearer at all → the same 401.
 * So ONLY the JWT case is sealed here. A device token is never sealed: it
 * would unlock nothing the old route unlocked, and it is a long-lived hardware
 * credential that has no business riding a run token. The browser chat mint
 * (/api/account/chat/eve-session) seals the JWT the browser authenticated the
 * mint with (its Bearer) — the same credential the in-process chat route
 * passed to createTools; a cookie-only mint seals nothing.
 *
 * ── Why sealed, and why inside the token ────────────────────────────────────
 * The run token travels through the eve runtime and is kept on the session's
 * principal attributes (durable session state). A plaintext JWT must not sit
 * there, so it is AES-256-GCM encrypted with a key derived (HKDF-SHA256) from
 * the chat internal secret; the additional data binds it to the token's
 * (conversationId, userId, workspaceId). Carrying it INSIDE the HMAC-signed
 * token means it cannot be swapped, and needs no new header, attribute or
 * forwarding code in the chat-agent — the tool proxies already forward the
 * token verbatim. The tool route opens it only for a token that passed every
 * gate (secret, HMAC + exp, and for a surface token the ownership-row liveness
 * fence), and only when the JWT's `sub` is the token's own user.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { internalSecret } from './chat-run-token'
import { decodeJwtSub } from '@/lib/supabase/server'

/** HKDF info — versioned so a future format change cannot open an old blob. */
const KEY_INFO = 'dial8/chat-run-credential/v1'
const IV_BYTES = 12
const TAG_BYTES = 16

/** What the sealed credential is bound to (the token's durable claims). */
export interface RunCredentialBinding {
  conversationId: string
  userId: string
  workspaceId: string
}

/** A plain Uint8Array copy — node:crypto's typings refuse a Buffer (as in chat-run-token.ts). */
function u8(b: Buffer | ArrayBuffer): Uint8Array {
  return new Uint8Array(b)
}

function key(secret: string): Uint8Array {
  return u8(hkdfSync('sha256', u8(Buffer.from(secret, 'utf8')), new Uint8Array(0), KEY_INFO, 32))
}

function aad(bind: RunCredentialBinding): Uint8Array {
  return u8(Buffer.from(`${bind.conversationId}\n${bind.userId}\n${bind.workspaceId}`, 'utf8'))
}

/**
 * Seal a Supabase JWT for the token of (conversationId, userId, workspaceId).
 * Returns base64url(iv | tag | ciphertext). Throws when the secret is unset —
 * the caller mints a token right after, which needs the same secret.
 */
export function sealRunCredential(jwt: string, bind: RunCredentialBinding): string {
  const secret = internalSecret()
  if (!secret) throw new Error('[chat-run] CHAT_INTERNAL_SECRET is not set — cannot seal a credential')
  const iv = u8(randomBytes(IV_BYTES))
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv)
  cipher.setAAD(aad(bind))
  const body = [u8(cipher.update(jwt, 'utf8')), u8(cipher.final())]
  return Buffer.concat([iv, u8(cipher.getAuthTag()), ...body]).toString('base64url')
}

/**
 * Open a sealed credential for the given binding. Null on anything wrong: no
 * secret, a malformed or tampered blob, a different binding, or a plaintext
 * that is not a JWT for `bind.userId` (never act as another user). The
 * signature itself is verified downstream by Supabase (auth.getUser / RLS).
 */
export function openRunCredential(sealed: string, bind: RunCredentialBinding): string | null {
  const secret = internalSecret()
  if (!secret || typeof sealed !== 'string' || sealed.length === 0) return null
  try {
    const raw = u8(Buffer.from(sealed, 'base64url'))
    if (raw.length <= IV_BYTES + TAG_BYTES) return null
    const decipher = createDecipheriv('aes-256-gcm', key(secret), raw.subarray(0, IV_BYTES))
    decipher.setAAD(aad(bind))
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    const jwt = Buffer.concat([
      u8(decipher.update(raw.subarray(IV_BYTES + TAG_BYTES))),
      u8(decipher.final()),
    ]).toString('utf8')
    return decodeJwtSub(jwt) === bind.userId ? jwt : null
  } catch {
    return null
  }
}
