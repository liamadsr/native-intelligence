import { readFileSync } from 'node:fs'

/**
 * The relay's side of /api/browser-relay/* (docs/plans/cloud-browser.md, C2).
 * Runs in the sandbox. On the hosted backend it holds no credential: every
 * request carries only the relay's mark header, and the sandbox firewall adds
 * the run token to requests that carry it (backend-hosted.ts
 * `relayNetworkPolicy`). On the runtime backend, whose firewall cannot add a
 * header, the server writes the token into a file only the relay's user can
 * read (backend-runtime.ts), and the relay is started with `--token-file`:
 * then each request reads that file and sends the token itself, beside the
 * mark (a fresh token, written at an exit switch, is used from the next
 * request on). No file, no token header: as on the hosted backend.
 */

export const RELAY_MARK = { 'x-ni-relay': '1' } as const
/** The header the hosted firewall adds and the runtime relay sends itself (relay-token.ts RELAY_TOKEN_HEADER). */
export const RELAY_TOKEN = 'x-ni-relay-token'

/** The token in `path`, or null when there is none (no file, or an empty one). Never logged. */
export function readRelayTokenFile(path: string): string | null {
  try {
    const token = readFileSync(path, 'utf8').trim()
    return token ? token : null
  } catch {
    return null
  }
}

export interface ClaimedCommand {
  id: string
  command: string
  tab_id: string | null
  request: Record<string, unknown> | null
  workspace_id: string
  claimed_at: string | null
  lease_expires_at: string | null
}

/** What the person's browser has learned about sites (C4): reached only through the Mac, or never used. */
export interface SiteMemory { needsHome: string[]; neverAutomate: string[] }

export class RelayRestart extends Error {
  constructor(readonly version: string) { super(`the app is now ${version}`) }
}

export class RelayClient {
  /** `readToken`: the runtime backend's token file, read at each request (`readRelayTokenFile`); none on the hosted one. */
  constructor(readonly origin: string, readonly version: string, private fetchImpl: typeof fetch = fetch, private readToken?: () => string | null) {}

  private async call(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}) {
    const signal = AbortSignal.any([AbortSignal.timeout(init.timeoutMs ?? 30_000), ...(init.signal ? [init.signal] : [])])
    const token = this.readToken?.() ?? null
    return this.fetchImpl(`${this.origin}${path}`, {
      method: init.method ?? 'GET', signal,
      headers: { ...RELAY_MARK, ...(token ? { [RELAY_TOKEN]: token } : {}), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
  }

  /**
   * The next waiting command (a ~25 s long-poll), or null, and who drives the
   * browser now (C4). Throws RelayRestart when the app moved to another build.
   */
  async next(signal?: AbortSignal): Promise<{ command: { id: string; command: string } | null; driver?: 'agent' | 'person' }> {
    const response = await this.call(`/api/browser-relay/next?v=${encodeURIComponent(this.version)}`, { signal, timeoutMs: 40_000 })
    if (response.status === 426) throw new RelayRestart(String((await response.json().catch(() => ({}))).version ?? ''))
    if (!response.ok) throw new Error(`relay next: ${response.status}`)
    const body = (await response.json()) as { command: { id: string; command: string } | null; driver?: string }
    return { command: body.command, ...(body.driver === 'person' || body.driver === 'agent' ? { driver: body.driver } : {}) }
  }

  /** Claim it, with the person's blocked sites as of now; null when another relay (or a Stop) got there first. */
  async claim(id: string): Promise<{ command: ClaimedCommand; blockedSites: string[]; siteMemory?: SiteMemory; driver?: 'agent' | 'person' } | null> {
    const response = await this.call(`/api/browser-relay/commands/${encodeURIComponent(id)}/claim`, { method: 'POST', body: {} })
    if (response.status === 409) return null
    if (!response.ok) throw new Error(`relay claim: ${response.status}`)
    return response.json()
  }

  /** Tell the server where the browser's traffic leaves now (C4): it sets the network policy to match. */
  async setExit(mode: 'mac' | 'cloud', tunnel: { up: boolean; deviceId?: string | null }): Promise<boolean> {
    const response = await this.call('/api/browser-relay/exit', { method: 'POST', body: { mode, tunnel } }).catch(() => null)
    return response?.ok ?? false
  }

  /** Remember a page that turned the browser away (C4). Best effort. */
  async markSite(url: string, kind: 'blocked' | 'agent_ban'): Promise<void> {
    await this.call('/api/browser-relay/site-memory', { method: 'POST', body: { url, kind } }).catch(() => null)
  }

  /** One decision step: the route's own status and body, for the task ports to read. */
  async decide(id: string, body: Record<string, unknown>, signal: AbortSignal): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const response = await this.call(`/api/browser-relay/commands/${encodeURIComponent(id)}/decision`, { method: 'POST', body, signal, timeoutMs: 25_000 })
    return { status: response.status, body: await response.json().catch(() => null) }
  }

  /** Raise an approval card for a sensitive step; its id, or null when it couldn't be raised. */
  async requestApproval(id: string, summary: string, tabId: string): Promise<string | null> {
    const response = await this.call(`/api/browser-relay/commands/${encodeURIComponent(id)}/approval`, { method: 'POST', body: { summary, tabId } })
    if (!response.ok) return null
    const body = await response.json().catch(() => null) as { approvalId?: unknown } | null
    return typeof body?.approvalId === 'string' ? body.approvalId : null
  }

  /**
   * The task reached a sign-in page: raise the card that asks the person to
   * sign in themselves (sign-in-card.ts). Its id, or null when none was raised.
   */
  async requestSignIn(id: string, url: string, tabId: string): Promise<string | null> {
    const response = await this.call(`/api/browser-relay/commands/${encodeURIComponent(id)}/sign-in`, { method: 'POST', body: { url, tabId } })
    if (!response.ok) return null
    const body = await response.json().catch(() => null) as { approvalId?: unknown } | null
    return typeof body?.approvalId === 'string' ? body.approvalId : null
  }

  /** Report the outcome. Retried: the route is idempotent, and an unsettled row is only reaped after its lease. */
  async settle(id: string, status: 'completed' | 'failed' | 'denied', result: unknown, error: string | null): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await this.call(`/api/browser-relay/commands/${encodeURIComponent(id)}/settle`, { method: 'POST', body: { status, result, error } })
        if (response.ok || (response.status >= 400 && response.status < 500)) return
      } catch { /* retried */ }
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
}
