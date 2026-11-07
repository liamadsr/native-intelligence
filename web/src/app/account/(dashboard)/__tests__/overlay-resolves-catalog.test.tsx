// @vitest-environment jsdom
/**
 * The settings overlay must resolve a detail view for EVERY integration in the
 * shared catalog.
 *
 * This is the test that would have caught three shipped bugs. The overlay used
 * to carry its own hand-written INTEGRATION_META, and resolveView() returns
 * null for a pair that isn't in it — which the provider renders as the
 * Preferences pane. So a provider missing from that one map didn't error, it
 * silently showed the wrong settings page when opened from the dashboard.
 * HubSpot, Asana and Jira each shipped exactly that (the Jira one was fixed in
 * 60288bca).
 *
 * The cases are DERIVED from INTEGRATION_CATALOG, never hand-listed — a
 * hand-copied list would just be a fifth map with the same drift problem. Add a
 * provider to the catalog and this test covers it automatically; drop the
 * catalog out of the overlay's resolution path and every case goes red.
 *
 * The detail views are stubbed so the assertion is about ROUTING, not about the
 * (heavy) views themselves.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, Suspense } from 'react'

import { INTEGRATION_CATALOG } from '@/lib/integrations/catalog'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Stub both lazy detail views. Each echoes the props it received so we can
// assert the overlay handed down the catalog's name/description, not a
// placeholder — and so the local-exchange branch is distinguishable.
vi.mock('../../settings/integrations/[provider]/[capability]/integration-detail-view', () => ({
  IntegrationDetailView: ({
    provider,
    capability,
    name,
    description,
  }: {
    provider: string
    capability: string
    name: string
    description: string
  }) => (
    <div data-testid="integration-detail">
      {`DETAIL:${provider}:${capability}|${name}|${description}`}
    </div>
  ),
}))
vi.mock('../../settings/integrations/local-exchange/calendar/local-exchange-detail-view', () => ({
  LocalExchangeDetailView: () => <div>LOCAL_EXCHANGE_DETAIL</div>,
}))
vi.mock('../../settings/connectors/mcp-connector-view', () => ({
  McpConnectorView: ({ id }: { id: string }) => <div>{`MCP_CONNECTOR:${id}`}</div>,
}))

// The overlay module pulls in SettingsShell + every lazy settings view at
// import time. Only resolveView is under test, so the heavy neighbours are
// stubbed to keep this a unit test of the routing table.
vi.mock('../../settings/settings-shell', () => ({
  SettingsShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/lib/navigation-events', () => ({
  onOAuthCallback: () => () => {},
  onSoftNavigate: () => () => {},
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/account',
}))

import { normalizeSettingsSubPath, resolveView } from '../settings-overlay'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/**
 * Render whatever resolveView returned, flushing the React.lazy boundary so the
 * stub (not the Suspense fallback) is what we assert on. Mirrors the
 * createRoot/act pattern the sibling settings-overlay-voice test uses — this
 * repo has no @testing-library.
 */
async function renderResolved(node: React.ReactNode): Promise<string> {
  await act(async () => {
    root.render(h(Suspense, { fallback: 'LOADING' }, node))
    await Promise.resolve()
    await Promise.resolve()
  })
  return container.textContent ?? ''
}

describe('settings overlay resolves every catalog integration', () => {
  it('has a non-empty catalog to iterate (guards against a vacuous pass)', () => {
    expect(INTEGRATION_CATALOG.length).toBeGreaterThan(0)
  })

  it.each(INTEGRATION_CATALOG.map((e) => [e.provider, e.capability, e.name, e.description]))(
    'resolves a detail view for %s/%s',
    async (provider, capability, name, description) => {
      const resolved = resolveView(`connectors/${provider}/${capability}`)

      // The bug: an unregistered pair resolves to null and the provider falls
      // back to the Preferences pane.
      expect(resolved).not.toBeNull()

      // And it must be the INTEGRATION detail view carrying this entry's copy —
      // not some other view that merely happens to be non-null.
      const text = await renderResolved(resolved)
      expect(text).toContain(`DETAIL:${provider}:${capability}|${name}|${description}`)
    },
  )

  it('still resolves the local-exchange detail view (not an OAuth catalog entry)', async () => {
    const text = await renderResolved(resolveView('connectors/local-exchange/calendar'))
    expect(text).toContain('LOCAL_EXCHANGE_DETAIL')
  })

  it('resolves a connected MCP server to its own page, not an integration', async () => {
    const text = await renderResolved(resolveView('connectors/mcp/srv-1'))
    expect(text).toContain('MCP_CONNECTOR:srv-1')
  })

  it('an old integrations/… path (a stored link, a desktop soft navigation) lands on the same view', async () => {
    const [{ provider, capability, name, description }] = INTEGRATION_CATALOG
    const text = await renderResolved(resolveView(`integrations/${provider}/${capability}`))
    expect(text).toContain(`DETAIL:${provider}:${capability}|${name}|${description}`)
    expect(normalizeSettingsSubPath('integrations')).toBe('connectors')
    expect(normalizeSettingsSubPath('integrations/google/email')).toBe('connectors/google/email')
    // Only a whole first segment is renamed.
    expect(normalizeSettingsSubPath('integrations-old')).toBe('integrations-old')
  })

  it('returns null for a pair that is not an integration', () => {
    expect(resolveView('connectors/nonexistent/tasks')).toBeNull()
  })
})
