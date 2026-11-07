/**
 * The secret in a website quote form's URL (roadmap B1, migration 458
 * quote_intake_key): `qk_` and 32 random bytes, base64url. Only its SHA-256
 * is stored, so a leaked table never yields a working URL; the owner sees the
 * key once, when it is made, and can make a new one (the old one stops).
 *
 * A form's page shows its URL to anyone who views the page source, so the
 * key is a "publishable" one: it lets a stranger post a quote, nothing more.
 * Against that, the intake caps posts per workspace per hour, drops honeypot
 * posts, and (when the owner lists origins) refuses other sites' browsers.
 *
 * Server only; service role.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

export const INTAKE_KEY_PREFIX = 'qk_'
const KEY_SHAPE = /^qk_[A-Za-z0-9_-]{43}$/

export function hashIntakeKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/** A fresh key. */
export function generateIntakeKey(): string {
  return `${INTAKE_KEY_PREFIX}${randomBytes(32).toString('base64url')}`
}

export function isIntakeKeyShape(value: unknown): value is string {
  return typeof value === 'string' && KEY_SHAPE.test(value)
}

export interface IntakeKey {
  id: string
  workspaceId: string
  createdBy: string | null
  allowedOrigins: string[]
}

/** The live key this secret is, or null (a wrong, revoked or malformed one). Throws on a failed read. */
export async function findIntakeKey(supabase: SupabaseClient, key: string): Promise<IntakeKey | null> {
  if (!isIntakeKeyShape(key)) return null
  const { data, error } = await supabase
    .from('quote_intake_key')
    .select('id, workspace_id, created_by, allowed_origins')
    .eq('key_hash', hashIntakeKey(key))
    .is('revoked_at', null)
    .maybeSingle<{ id: string; workspace_id: string; created_by: string | null; allowed_origins: string[] | null }>()
  if (error) throw new Error(`quote_intake_key read failed: ${error.message}`)
  if (!data) return null
  return { id: data.id, workspaceId: data.workspace_id, createdBy: data.created_by, allowedOrigins: cleanOrigins(data.allowed_origins) }
}

/** Origins as stored: `https://host[:port]` only, lower case, deduped. Pure. */
export function cleanOrigins(origins: unknown): string[] {
  const out = new Set<string>()
  for (const raw of Array.isArray(origins) ? origins : []) {
    if (typeof raw !== 'string') continue
    try {
      const url = new URL(raw.trim())
      if (url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))) out.add(url.origin.toLowerCase())
    } catch {
      // Not an origin.
    }
    if (out.size >= 10) break
  }
  return [...out]
}

/**
 * Make the workspace's key, revoking any live one first (one live key per
 * workspace). Returns the secret: shown once, never stored. Throws on a failed write.
 */
export async function rotateIntakeKey(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; allowedOrigins?: readonly string[] },
): Promise<{ key: string; prefix: string; allowedOrigins: string[] }> {
  const { error: revokeError } = await supabase.from('quote_intake_key').update({ revoked_at: new Date().toISOString() }).eq('workspace_id', args.workspaceId).is('revoked_at', null)
  if (revokeError) throw new Error(`quote_intake_key revoke failed: ${revokeError.message}`)
  const key = generateIntakeKey()
  const allowedOrigins = cleanOrigins(args.allowedOrigins ?? [])
  const prefix = key.slice(0, 9)
  const { error } = await supabase.from('quote_intake_key').insert({
    workspace_id: args.workspaceId,
    key_hash: hashIntakeKey(key),
    key_prefix: prefix,
    allowed_origins: allowedOrigins,
    created_by: args.userId,
  })
  if (error) throw new Error(`quote_intake_key insert failed: ${error.message}`)
  return { key, prefix, allowedOrigins }
}

/** Stamp the key's last use. Best effort. */
export async function touchIntakeKey(supabase: SupabaseClient, keyId: string): Promise<void> {
  try {
    await supabase.from('quote_intake_key').update({ last_used_at: new Date().toISOString() }).eq('id', keyId)
  } catch {
    // Best effort.
  }
}

/** Website quotes a workspace took since `sinceIso` (the intake's hourly cap). Throws on a failed read. */
export async function countWebQuotesSince(supabase: SupabaseClient, workspaceId: string, sinceIso: string): Promise<number> {
  const { count, error } = await supabase
    .from('customer_quote')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('source', 'web_form')
    .gte('created_at', sinceIso)
  if (error) throw new Error(`customer_quote count failed: ${error.message}`)
  return count ?? 0
}
