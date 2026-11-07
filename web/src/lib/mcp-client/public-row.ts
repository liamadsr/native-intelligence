/**
 * A connected MCP server row as the settings routes return it: the public
 * columns only (never the encrypted tokens or OAuth metadata), with
 * `approval_free_tools` read OPTIONALLY.
 *
 * The routes read `*` and pick from it rather than naming columns, so a
 * deploy that lands before migration 339 (approval_free_tools) cannot take
 * Settings > MCP down with "column does not exist": the column is simply
 * absent and reads as [] (nothing approval-free, the safe side).
 */
const PUBLIC_KEYS = [
  'id',
  'display_name',
  'server_url',
  'transport',
  'auth_type',
  'is_enabled',
  'disabled_tools',
  'require_approval_tools',
  'tools_cache',
  'tools_cache_refreshed_at',
  'last_health_check_at',
  'last_error',
  'token_expires_at',
  // Its sign-in needs the person (migration 451; absent before it, read as healthy).
  'reauth_required_at',
  'created_at',
] as const

export function publicMcpServer(row: unknown): Record<string, unknown> | null {
  if (!row || typeof row !== 'object') return null
  const source = row as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of PUBLIC_KEYS) if (key in source) out[key] = source[key]
  out.approval_free_tools = Array.isArray(source.approval_free_tools) ? source.approval_free_tools : []
  // The allow-list (migration 396): null until seeded, and before the migration.
  out.allowed_tools = Array.isArray(source.allowed_tools) ? source.allowed_tools : null
  return out
}

/** A PostgREST / Postgres error saying this column does not exist (migration not applied yet). */
export function isMissingColumnError(error: { code?: string | null; message?: string | null } | null | undefined, column: string): boolean {
  if (!error) return false
  const code = error.code ?? ''
  const message = error.message ?? ''
  return (code === '42703' || code === 'PGRST204' || /does not exist|could not find/i.test(message)) && message.includes(column)
}
