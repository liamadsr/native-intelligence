'use client'

/**
 * Is a Connect card's connection there now? (The card settles on it after the
 * provider's page returns, and on mount, so a card from an earlier visit
 * shows Connected rather than a stale Connect.)
 *
 * One read per source for every card on the page: the OAuth status and the
 * app list are each fetched once and shared for a few seconds, and dropped
 * after a connect returns (invalidateConnectStatus), so a chat with several
 * cards costs two reads, not one per card. No polling.
 */
import { fetchOAuthStatus, type OAuthStatus } from '@/lib/integrations/oauth-status'
import { suggestedMcpServerFor } from '@/lib/mcp-client/suggested'
import { visibleMcpTools } from '@/lib/mcp-client/tool-access'
import { mcpNeedsReconnect } from '@/lib/mcp-client/needs-reconnect'
import type { ConnectCard } from './connect-card'

const SHARE_MS = 5_000

interface AppRow {
  server_url: string
  is_enabled?: boolean
  disabled_tools?: string[] | null
  allowed_tools?: string[] | null
  tools_cache?: Array<{ name: string }> | null
  reauth_required_at?: string | null
  last_error?: string | null
}

let oauthRead: { at: number; value: Promise<OAuthStatus | null> } | null = null
let appsRead: { at: number; value: Promise<AppRow[] | null> } | null = null

async function fetchApps(): Promise<AppRow[] | null> {
  try {
    const res = await fetch('/api/account/mcp-servers')
    if (!res.ok) return null
    return (((await res.json()) as { servers?: AppRow[] }).servers ?? []) as AppRow[]
  } catch {
    return null
  }
}

/** Forget the shared reads (a connect just returned). */
export function invalidateConnectStatus(): void {
  oauthRead = null
  appsRead = null
}

export interface ConnectState {
  connected: boolean
  /** The account, or "N tools", for the card's line and the agent's note. */
  detail: string | null
}

/** The card's connection now; null when it could not be read (the card keeps what it shows). */
export async function readConnectState(card: ConnectCard, now = Date.now()): Promise<ConnectState | null> {
  if (card.kind === 'integration') {
    if (!oauthRead || now - oauthRead.at > SHARE_MS) oauthRead = { at: now, value: fetchOAuthStatus().catch(() => null) }
    const status = await oauthRead.value
    if (!status) return null
    const mine = (status.accounts ?? []).filter((a) => a.provider === card.provider && a.capability === card.capability && !a.reauth_required_at)
    return mine.length ? { connected: true, detail: mine.map((a) => a.account_email).filter(Boolean).join(', ') || null } : { connected: false, detail: null }
  }
  if (!appsRead || now - appsRead.at > SHARE_MS) appsRead = { at: now, value: fetchApps() }
  const apps = await appsRead.value
  if (!apps) return null
  const catalogId = card.kind === 'catalog_app' ? card.catalog_id : null
  const app = apps.find((a) => (catalogId ? suggestedMcpServerFor(a.server_url)?.id === catalogId : a.server_url === card.server_url))
  // An expired sign-in is not connected: the card keeps its Reconnect.
  if (!app || mcpNeedsReconnect(app)) return { connected: false, detail: null }
  const n = visibleMcpTools(app, app.tools_cache).length
  return { connected: true, detail: `${n} ${n === 1 ? 'tool' : 'tools'}` }
}
