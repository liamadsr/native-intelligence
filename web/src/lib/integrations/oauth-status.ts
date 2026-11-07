/**
 * `GET /api/oauth/status`: its response shape and the ONE client read of it.
 *
 * Settings › Connectors and the chat's Connections panel both render from
 * this response, so the types live here rather than in either component. The
 * provider/capability unions come from the OAuth config (type-only: nothing of
 * that server-side module reaches a client bundle), which is the set the
 * route can actually write rows for. Deriving them from the integration
 * catalog instead would hide a provider the server sends but the catalog
 * forgot.
 */
import type { OAuthCapability, OAuthProvider } from '@/lib/oauth/config'
import { INTEGRATION_CATALOG } from './catalog'
import { notifyTaskDestinationsChanged } from '@/lib/tasks/destinations-events'

export interface ConnectedAccount {
  id: string
  provider: OAuthProvider
  capability: OAuthCapability
  account_email: string
  display_name: string | null
  color: string
  is_enabled: boolean
  is_primary: boolean
  is_visible: boolean
  workspace_ids?: string[]
  /** Scopes the provider granted (empty for rows that predate recording them). */
  scopes?: string[]
  /** Currently-required scopes this connection's grant lacks (server-computed). */
  missing_scopes?: string[]
  /**
   * When the provider refused this connection's refresh token for good
   * (migration 348). Null = healthy. Optional: absent until the route sends it.
   */
  reauth_required_at?: string | null
  /** Email accounts only. */
  notification_enabled?: boolean
  sync_status?: string | null
  last_sync_at?: string | null
  last_sync_error?: string | null
  /** Calendar accounts only. */
  color_override?: string | null
}

interface LegacyCapabilityStatus {
  connected: boolean
  email?: string
}

export interface OAuthStatus {
  accounts: ConnectedAccount[]
  /** Legacy per-provider booleans the route still sends. */
  google?: { calendar: LegacyCapabilityStatus; email: LegacyCapabilityStatus }
  microsoft?: { calendar: LegacyCapabilityStatus; email: LegacyCapabilityStatus }
}

/**
 * Providers whose accounts feed the "Push to…" menu, from the catalog rather
 * than a literal list, so a new tracker is covered by the catalog entry its
 * author has to add anyway.
 */
const TASK_PROVIDERS = new Set<string>(
  INTEGRATION_CATALOG.filter((e) => e.capability === 'tasks').map((e) => e.provider),
)

/**
 * How many task-tracker accounts a status reports. The push menu's
 * destinations are derived from exactly these, so a change in the count is the
 * signal that its cached answer is out of date. Matched on capability AND
 * provider, so a provider offering `tasks` that the menu can't target doesn't
 * announce a change the menu can't act on.
 */
export function countTaskAccounts(status: OAuthStatus | null): number {
  return (status?.accounts ?? []).filter(
    (a) => a.capability === 'tasks' && TASK_PROVIDERS.has(a.provider),
  ).length
}

/**
 * Task-tracker account count as of the last status read, from ANY surface.
 * -1 means "never read", so the first read sets the baseline without
 * announcing a change that didn't happen.
 *
 * Module-level on purpose: Settings and the Connections panel are different
 * trees reading the same answer. A tracker connected from the panel and first
 * seen by the panel's read is still a change against Settings' last read.
 */
let lastTaskAccountCount = -1

/** Test-only: forget the baseline. */
export function resetTaskAccountBaseline(): void {
  lastTaskAccountCount = -1
}

/**
 * Read `GET /api/oauth/status`. Null on a non-ok response; a network error or
 * an abort throws (callers keep their last good data).
 *
 * Every read compares the task-tracker count with the previous one and, when
 * it moved, tells the "Push to…" menu its destinations changed. That is the
 * connect/disconnect the menu's cache can't see: on desktop the OAuth detour
 * happens in the system browser and on web in a popup, so this tab is never
 * reloaded and module-level caches never reset. Every path that can change the
 * answer (mount, focus, popup message, popup closed, deep-link return) funnels
 * through a read of this route.
 */
export async function fetchOAuthStatus(init?: { signal?: AbortSignal }): Promise<OAuthStatus | null> {
  const res = await fetch('/api/oauth/status', { signal: init?.signal })
  if (!res.ok) return null
  const status = (await res.json()) as OAuthStatus
  const taskAccounts = countTaskAccounts(status)
  if (lastTaskAccountCount !== -1 && taskAccounts !== lastTaskAccountCount) {
    notifyTaskDestinationsChanged()
  }
  lastTaskAccountCount = taskAccounts
  return status
}
