import { OAUTH_CONFIG } from '@/lib/oauth/config'

// Scopes excluded from the granted-vs-required diff: providers don't echo them
// back in the token response's scope field (offline_access materializes as a
// refresh token; hubspot's 'oauth' is implicit), so requiring them would show a
// permanent false "reconnect" banner.
const SCOPE_DIFF_IGNORE: Record<string, Set<string>> = {
  microsoft: new Set(['offline_access']),
  hubspot: new Set(['oauth']),
}

// Azure may return Graph scopes fully-qualified (https://graph.microsoft.com/Mail.Send)
// or short (Mail.Send), in either case. Google scopes ARE full URLs — compare raw.
export function normalizeScope(provider: string, scope: string): string {
  if (provider === 'microsoft') {
    const short = scope.includes('/') ? scope.slice(scope.lastIndexOf('/') + 1) : scope
    return short.toLowerCase()
  }
  return scope
}

/**
 * Which currently-required scopes this account's stored grant is missing.
 * Empty stored scopes = unknown (legacy rows) — report nothing rather than
 * flagging every old connection.
 */
export function missingScopes(
  provider: string,
  capability: string,
  granted: string[],
): string[] {
  const providerConfig = OAUTH_CONFIG[provider as keyof typeof OAUTH_CONFIG]
  const required = providerConfig?.scopes?.[
    capability as keyof typeof providerConfig.scopes
  ] as string[] | undefined
  if (!required || granted.length === 0) return []
  const ignore = SCOPE_DIFF_IGNORE[provider]
  const grantedSet = new Set(granted.map((s) => normalizeScope(provider, s)))
  return required.filter(
    (r) => !ignore?.has(r) && !grantedSet.has(normalizeScope(provider, r)),
  )
}
