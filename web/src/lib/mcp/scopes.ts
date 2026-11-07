/**
 * The scopes Dial8's MCP OAuth server grants, and what a request for them
 * becomes. Pure (no server imports): the consent page builds its lines from
 * the same rule authorize and approve apply.
 */

export const MCP_SCOPES = ['read', 'write'] as const

/**
 * The scopes a request asks for that Dial8 grants. No scope asked means both,
 * as before. `write` brings `read` with it: a token without `read` is never
 * read-only (isReadOnlyToken in guard.ts), so `write` alone would read too,
 * and the consent page must say so. Anything else is dropped. Null when
 * neither is asked for: the request is refused, never granted an empty list,
 * which reads as a legacy full-access token.
 */
export function grantedScopes(raw: unknown): Array<(typeof MCP_SCOPES)[number]> | null {
  if (raw === undefined || raw === null || raw === '') return [...MCP_SCOPES]
  if (typeof raw !== 'string') return null
  const asked = raw.split(/\s+/)
  if (asked.includes('write')) return ['read', 'write']
  if (asked.includes('read')) return ['read']
  return null
}
