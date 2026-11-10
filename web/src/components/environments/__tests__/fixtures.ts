/**
 * Environments as the routes give them, and a fake of the routes, for the
 * components' tests (and the screenshot harness's data).
 */
import { vi } from 'vitest'
import type { CloudEnvironment } from '@/lib/environments/types'
import type { MacEnvironmentItem } from '@/lib/local-agent/environment-client'

export const THIS_MAC = 'dev-this'

export function mac(over: Partial<MacEnvironmentItem> = {}): MacEnvironmentItem {
  return {
    kind: 'mac',
    id: 'env-mac',
    name: "Liam's MacBook Pro",
    deviceId: THIS_MAC,
    deviceName: "Liam's MacBook Pro",
    appVersion: '0.3.0',
    lastSeenAt: '2026-10-22T10:00:00Z',
    online: true,
    supportsBaseBranch: true,
    folders: [
      { id: 'f-1', label: 'native-intelligence', mode: 'edit', isGit: true, baseBranch: 'main', repoFullName: 'liamadsr/native-intelligence' },
      { id: 'f-2', label: 'notes', mode: 'read', isGit: false, baseBranch: null, repoFullName: null },
    ],
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...over,
  }
}

export function cloud(over: Partial<CloudEnvironment> = {}): CloudEnvironment {
  return {
    kind: 'cloud',
    id: 'env-cloud',
    name: 'Default cloud',
    workspaceId: 'ws-1',
    shared: true,
    networkAccess: 'restricted',
    createdBy: 'u-1',
    canEdit: true,
    envVars: 'NODE_ENV=test\nAPI_URL=https://example.test',
    setupScript: 'npm ci',
    secretsHidden: false,
    hasEnvVars: true,
    hasSetupScript: true,
    isWorkspaceDefault: false,
    projectCount: 0,
    archivedAt: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...over,
  }
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export interface FakeRoute {
  method?: string
  /** Matched against the URL's start. */
  url: string
  reply: (body: unknown, url: string) => Response
}

/**
 * A fetch over these routes, newest first: an unmatched GET of the list or a
 * chat answers from `state`, anything else 404s. Each call is recorded with
 * its parsed body.
 */
export function fakeFetch(state: { list: unknown[]; defaultEnvironmentId?: string | null; chat?: unknown; local?: unknown }, routes: FakeRoute[] = []) {
  const calls: Array<{ method: string; url: string; body: unknown }> = []
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url: input, body })
    const route = routes.find((r) => (r.method ?? 'GET') === method && input.startsWith(r.url))
    if (route) return route.reply(body, input)
    if (method === 'GET' && input === '/api/account/environments') {
      return json({ environments: state.list, defaultEnvironmentId: state.defaultEnvironmentId ?? null })
    }
    if (method === 'GET' && input.startsWith('/api/account/environments/chat')) {
      return json(state.chat ?? { environmentId: null, source: 'none', environment: null })
    }
    if (method === 'GET' && input === '/api/local-agent/environment') {
      return json(state.local ?? { devices: [], folders: [], worktrees: [] })
    }
    return json({ error: 'not found' }, 404)
  })
  return { fn, calls }
}
