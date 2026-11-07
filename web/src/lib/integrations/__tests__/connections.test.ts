/**
 * The Connections list model (connections.ts): which group each connection
 * lands in, why, and with which one action.
 */
import { describe, it, expect } from 'vitest'
import {
  groupConnections,
  needsAttention,
  panelRows,
  HUBSPOT_WRITE_SCOPE,
  type ConnectionRow,
  type McpServerRow,
  type SlackAppStatus,
} from '../connections'
import { INTEGRATION_CATALOG } from '../catalog'
import type { ConnectedAccount, OAuthStatus } from '../oauth-status'
import type { SuggestedMcpServer } from '@/lib/mcp-client/suggested'
import type { LocalCalendarStatus } from '@/lib/tauri-bridge'

function account(over: Partial<ConnectedAccount> & Pick<ConnectedAccount, 'provider' | 'capability'>): ConnectedAccount {
  return {
    id: `${over.provider}-${over.capability}-${over.account_email ?? 'a'}`,
    account_email: 'a@x.com',
    display_name: null,
    color: '#000',
    is_enabled: true,
    is_primary: false,
    is_visible: true,
    scopes: ['granted'],
    missing_scopes: [],
    reauth_required_at: null,
    ...over,
  }
}

function status(...accounts: ConnectedAccount[]): OAuthStatus {
  return { accounts }
}

const SUGGESTED: SuggestedMcpServer[] = [
  { id: 'atlassian', display_name: 'Atlassian', server_url: 'https://mcp.atlassian.com/v1/sse', transport: 'sse', description: '', accent: '', category: 'projects' as const, vetted: { checked: '2026-10-22', listedIn: ['registry' as const] } },
  { id: 'linear', display_name: 'Linear', server_url: 'https://mcp.linear.app/mcp', transport: 'streamable_http', description: '', accent: '', category: 'projects' as const, vetted: { checked: '2026-10-22', listedIn: ['registry' as const] } },
]

function mcp(over: Partial<McpServerRow> = {}): McpServerRow {
  return {
    id: 'srv1',
    display_name: 'Atlassian',
    server_url: 'https://mcp.atlassian.com/v1/sse',
    is_enabled: true,
    last_error: null,
    token_expires_at: null,
    ...over,
  }
}

function group(input: Partial<Parameters<typeof groupConnections>[0]> = {}) {
  return groupConnections({
    status: null,
    mcpServers: null,
    suggested: SUGGESTED,
    desktop: false,
    localExchange: null,
    ...input,
  })
}

function row(rows: ConnectionRow[], key: string): ConnectionRow | undefined {
  return rows.find((r) => r.key === key)
}

describe('grouping', () => {
  it('with nothing connected, every catalog entry (GitHub included) and every suggestion is available, in order', () => {
    const g = group()
    expect(g.connected).toEqual([])
    expect(g.attention).toEqual([])
    expect(g.available.map((r) => r.key)).toEqual([
      ...INTEGRATION_CATALOG.map((e) => `${e.provider}:${e.capability}`),
      'mcp-suggested:atlassian',
      'mcp-suggested:linear',
    ])
    expect(row(g.available, 'github:github')).toBeDefined()
    expect(row(g.available, 'google:email')).toMatchObject({
      kind: 'oauth',
      statusText: 'Not connected',
      action: 'connect',
      settingsPath: 'connectors/google/email',
      detail: null,
    })
    expect(needsAttention(g)).toBe(false)
  })

  it('splits connected, attention and available, keeping catalog order within each group and MCP last', () => {
    const g = group({
      status: status(
        account({ provider: 'linear', capability: 'tasks' }),
        account({ provider: 'google', capability: 'calendar' }),
        account({ provider: 'asana', capability: 'tasks', reauth_required_at: '2026-10-01T00:00:00Z' }),
      ),
      mcpServers: [mcp()],
    })
    expect(g.connected.map((r) => r.key)).toEqual(['google:calendar', 'linear:tasks', 'mcp:srv1'])
    expect(g.attention.map((r) => r.key)).toEqual(['asana:tasks'])
    expect(row(g.connected, 'google:calendar')).toMatchObject({
      statusText: 'Connected',
      action: 'manage',
      detail: 'a@x.com',
      settingsPath: 'connectors/google/calendar',
    })
    expect(needsAttention(g)).toBe(true)
  })
})

describe('needs-attention causes', () => {
  it('reauth: reauth_required_at set → Reconnect', () => {
    const g = group({
      status: status(account({ provider: 'google', capability: 'email', account_email: 'me@x.com', reauth_required_at: '2026-10-01T00:00:00Z' })),
    })
    expect(row(g.attention, 'google:email')).toMatchObject({
      cause: 'reauth',
      statusText: 'Reconnect',
      action: 'reconnect',
      loginHint: 'me@x.com',
    })
  })

  it('missing_scopes: a non-empty missing_scopes → Update access', () => {
    const g = group({
      status: status(account({ provider: 'microsoft', capability: 'email', missing_scopes: ['Mail.Send'] })),
    })
    expect(row(g.attention, 'microsoft:email')).toMatchObject({
      cause: 'missing_scopes',
      statusText: 'Update access',
      action: 'update',
    })
  })

  it('sync_error: an email account with last_sync_error → Sync error', () => {
    const g = group({
      status: status(account({ provider: 'google', capability: 'email', last_sync_error: 'history id expired' })),
    })
    expect(row(g.attention, 'google:email')).toMatchObject({
      cause: 'sync_error',
      statusText: 'Sync error',
      action: 'manage',
      settingsPath: 'connectors/google/email',
    })
  })

  it('sync_error only applies to email', () => {
    const g = group({
      status: status(account({ provider: 'google', capability: 'calendar', last_sync_error: 'boom' })),
    })
    expect(row(g.connected, 'google:calendar')).toBeDefined()
  })

  describe('hubspot_write', () => {
    it('granted scopes without contacts.write (as the detail view checks) → Needs write access', () => {
      const g = group({
        status: status(account({ provider: 'hubspot', capability: 'crm', scopes: ['crm.objects.contacts.read'] })),
      })
      expect(row(g.attention, 'hubspot:crm')).toMatchObject({
        cause: 'hubspot_write',
        statusText: 'Needs write access',
        action: 'update',
      })
    })

    it('a legacy row with no recorded scopes is flagged too (the detail view does)', () => {
      const g = group({ status: status(account({ provider: 'hubspot', capability: 'crm', scopes: [] })) })
      expect(row(g.attention, 'hubspot:crm')?.cause).toBe('hubspot_write')
    })

    it('the route folding ONLY the write scope into missing_scopes still reads as hubspot_write', () => {
      const g = group({
        status: status(
          account({
            provider: 'hubspot',
            capability: 'crm',
            scopes: ['crm.objects.contacts.read'],
            missing_scopes: [HUBSPOT_WRITE_SCOPE],
          }),
        ),
      })
      expect(row(g.attention, 'hubspot:crm')?.cause).toBe('hubspot_write')
    })

    it('another missing HubSpot scope is missing_scopes', () => {
      const g = group({
        status: status(
          account({
            provider: 'hubspot',
            capability: 'crm',
            scopes: ['crm.objects.contacts.read'],
            missing_scopes: [HUBSPOT_WRITE_SCOPE, 'crm.objects.companies.read'],
          }),
        ),
      })
      expect(row(g.attention, 'hubspot:crm')?.cause).toBe('missing_scopes')
    })

    it('a grant with the write scope is connected', () => {
      const g = group({
        status: status(account({ provider: 'hubspot', capability: 'crm', scopes: [HUBSPOT_WRITE_SCOPE] })),
      })
      expect(row(g.connected, 'hubspot:crm')).toBeDefined()
    })
  })

  it('mcp_error: an MCP server with last_error → Error, managed on the server’s own page', () => {
    const g = group({ mcpServers: [mcp({ last_error: 'ECONNREFUSED' })] })
    expect(row(g.attention, 'mcp:srv1')).toMatchObject({
      kind: 'mcp',
      capability: 'mcp',
      cause: 'mcp_error',
      statusText: 'Error',
      action: 'manage',
      settingsPath: 'connectors/mcp/srv1',
    })
  })

  it('mcp_expired: the refresh path’s expired-token error → Expired', () => {
    const g = group({
      mcpServers: [
        mcp({
          last_error:
            'MCP server "Atlassian" needs to be reconnected — the OAuth token expired and could not be refreshed.',
        }),
      ],
    })
    expect(row(g.attention, 'mcp:srv1')).toMatchObject({ cause: 'mcp_expired', statusText: 'Reconnect', action: 'reconnect' })
  })

  it('mcp_expired: a sign-in the refresh path marked (reauth_required_at, migration 451) → Reconnect, in place', () => {
    const g = group({ mcpServers: [mcp({ reauth_required_at: '2026-10-27T04:00:00Z' })] })
    expect(row(g.attention, 'mcp:srv1')).toMatchObject({ cause: 'mcp_expired', statusText: 'Reconnect', action: 'reconnect' })
  })

  it('another last_error is still an error that opens the server page', () => {
    const g = group({ mcpServers: [mcp({ last_error: 'tools/list timed out' })] })
    expect(row(g.attention, 'mcp:srv1')).toMatchObject({ cause: 'mcp_error', statusText: 'Error', action: 'manage' })
  })

  it('a past token_expires_at alone is not attention (the token refreshes on the next call)', () => {
    const g = group({ mcpServers: [mcp({ token_expires_at: '2020-01-01T00:00:00Z' })] })
    expect(row(g.connected, 'mcp:srv1')).toBeDefined()
  })
})

describe('priority', () => {
  it('on one account: reauth beats missing_scopes beats sync_error', () => {
    const all = account({
      provider: 'google',
      capability: 'email',
      reauth_required_at: '2026-10-01T00:00:00Z',
      missing_scopes: ['x'],
      last_sync_error: 'boom',
    })
    expect(row(group({ status: status(all) }).attention, 'google:email')?.cause).toBe('reauth')
    const noReauth = { ...all, reauth_required_at: null }
    expect(row(group({ status: status(noReauth) }).attention, 'google:email')?.cause).toBe('missing_scopes')
    const syncOnly = { ...noReauth, missing_scopes: [] }
    expect(row(group({ status: status(syncOnly) }).attention, 'google:email')?.cause).toBe('sync_error')
  })

  it('across accounts: the highest-priority problem names the row, and its account leads the detail', () => {
    const g = group({
      status: status(
        account({ provider: 'google', capability: 'email', account_email: 'sync@x.com', last_sync_error: 'boom' }),
        account({ provider: 'google', capability: 'email', account_email: 'reauth@x.com', reauth_required_at: '2026-10-01T00:00:00Z' }),
      ),
    })
    expect(row(g.attention, 'google:email')).toMatchObject({
      cause: 'reauth',
      detail: 'reauth@x.com +1',
      loginHint: 'reauth@x.com',
    })
  })
})

describe('multiple accounts', () => {
  it('several healthy accounts make one connected row led by the primary', () => {
    const g = group({
      status: status(
        account({ provider: 'google', capability: 'calendar', account_email: 'b@x.com' }),
        account({ provider: 'google', capability: 'calendar', account_email: 'a@x.com', is_primary: true }),
        account({ provider: 'google', capability: 'calendar', account_email: 'c@x.com' }),
      ),
    })
    expect(g.connected.filter((r) => r.key === 'google:calendar')).toHaveLength(1)
    expect(row(g.connected, 'google:calendar')?.detail).toBe('a@x.com +2')
  })

  it('one account needing attention puts the whole entry in attention', () => {
    const g = group({
      status: status(
        account({ provider: 'microsoft', capability: 'calendar', account_email: 'ok@x.com' }),
        account({ provider: 'microsoft', capability: 'calendar', account_email: 'bad@x.com', missing_scopes: ['Calendars.ReadWrite'] }),
      ),
    })
    expect(row(g.connected, 'microsoft:calendar')).toBeUndefined()
    expect(row(g.attention, 'microsoft:calendar')?.detail).toBe('bad@x.com +1')
  })

  it('GitHub shows the login without the @github suffix', () => {
    const g = group({ status: status(account({ provider: 'github', capability: 'github', account_email: 'octocat@github' })) })
    expect(row(g.connected, 'github:github')?.detail).toBe('octocat')
  })
})

describe('MCP suggestions', () => {
  it('a server that only shares a catalog app’s NAME is custom, and the real app stays on offer', () => {
    const g = group({ mcpServers: [mcp({ id: 'b', display_name: 'linear', server_url: 'https://other.example/mcp' })] })
    expect(row(g.connected, 'mcp:b')).toMatchObject({ provider: 'mcp', mcp: { suggested: null } })
    expect(row(g.available, 'mcp-suggested:linear')).toBeDefined()
  })

  it('an added suggested server is not offered again: matched by host, as the approval policy matches it', () => {
    const g = group({
      mcpServers: [
        mcp({ id: 'a', display_name: 'My Atlassian', server_url: 'https://mcp.atlassian.com/v1/sse' }),
        // Linear's old /sse address: the same host, so still Linear.
        mcp({ id: 'b', display_name: 'Linear (old)', server_url: 'https://MCP.linear.app/sse' }),
      ],
    })
    expect(g.available.filter((r) => r.kind === 'mcp')).toEqual([])
    expect(row(g.connected, 'mcp:b')).toMatchObject({ provider: 'linear', mcp: { suggested: SUGGESTED[1] } })
    expect(row(g.connected, 'mcp:a')).toMatchObject({
      provider: 'atlassian',
      name: 'My Atlassian',
      detail: 'mcp.atlassian.com',
      mcp: { serverId: 'a', suggested: SUGGESTED[0] },
    })
  })

  it('an available suggestion carries what connecting it needs', () => {
    const g = group({ mcpServers: [mcp()] })
    expect(row(g.available, 'mcp-suggested:linear')).toMatchObject({
      kind: 'mcp',
      provider: 'linear',
      action: 'connect',
      settingsPath: 'connectors',
      mcp: { serverId: null, serverUrl: 'https://mcp.linear.app/mcp', suggested: SUGGESTED[1] },
    })
    expect(row(g.available, 'mcp-suggested:atlassian')).toBeUndefined()
  })

  it('a custom server has no suggestion and lists as provider "mcp"', () => {
    const g = group({ mcpServers: [mcp({ id: 'c', display_name: 'Internal', server_url: 'https://mcp.internal.example/' })] })
    expect(row(g.connected, 'mcp:c')).toMatchObject({ provider: 'mcp', mcp: { suggested: null } })
  })

  it('a disabled server stays connected, marked off', () => {
    const g = group({ mcpServers: [mcp({ is_enabled: false })] })
    expect(row(g.connected, 'mcp:srv1')?.statusText).toBe('Connected app, off')
  })

  it('reads as a connected app beside an OAuth connection of the same name (not a duplicate)', () => {
    const g = group({
      status: status(account({ provider: 'linear', capability: 'tasks', account_email: 'l@x.com' })),
      mcpServers: [mcp({ id: 'lin', display_name: 'Linear', server_url: 'https://mcp.linear.app/mcp' })],
    })
    const mcpRow = row(g.connected, 'mcp:lin')!
    expect(mcpRow.statusText).toBe('Connected app')
    expect(mcpRow.detail).toBe('mcp.linear.app')
    expect(row(g.connected, 'linear:tasks')?.statusText).toBe('Connected')
  })
})

describe('local Exchange', () => {
  const connected: LocalCalendarStatus = {
    hasAccess: true,
    exchangeCalendars: [{ id: '1', title: 'Work', accountName: 'Exchange', color: '#f00' }],
  }

  it('is listed only on desktop', () => {
    expect([...group().available, ...group().connected].some((r) => r.kind === 'local')).toBe(false)
    expect(row(group({ desktop: true }).available, 'local_exchange:calendar')).toMatchObject({
      kind: 'local',
      action: 'connect',
      statusText: 'Not connected',
    })
  })

  it('with access and Exchange calendars it is connected, after the catalog and before MCP', () => {
    const g = group({ desktop: true, localExchange: connected, mcpServers: [mcp()] })
    expect(row(g.connected, 'local_exchange:calendar')).toMatchObject({
      action: 'manage',
      detail: 'Exchange',
      settingsPath: 'connectors/local-exchange/calendar',
    })
    expect(g.connected.map((r) => r.key)).toEqual(['local_exchange:calendar', 'mcp:srv1'])
  })

  it('access without Exchange calendars has nothing to grant: it opens the detail page', () => {
    const g = group({ desktop: true, localExchange: { hasAccess: true, exchangeCalendars: [] } })
    expect(row(g.available, 'local_exchange:calendar')).toMatchObject({ action: 'manage', statusText: 'No Exchange accounts' })
  })
})

describe('Dial8’s Slack app', () => {
  const team = (over: Partial<NonNullable<SlackAppStatus['installations']>[number]> = {}) => ({
    teamId: 'T1',
    teamName: 'Acme',
    teamDomain: 'acme',
    myLink: null,
    ...over,
  })
  const all = (g: ReturnType<typeof group>) => [...g.connected, ...g.attention, ...g.available]

  it('has no row before the first read, or where this deployment has no Slack app', () => {
    expect(all(group()).some((r) => r.kind === 'app')).toBe(false)
    expect(all(group({ slack: { configured: false } })).some((r) => r.kind === 'app')).toBe(false)
  })

  it('is something to add until the person’s own Slack account is linked, and opens its page', () => {
    for (const slack of [
      { configured: true, canInstall: true, canLink: true, installations: [] },
      { configured: true, canInstall: false, canLink: true, installations: [team()] },
    ]) {
      expect(row(group({ slack }).available, 'slack:messaging')).toMatchObject({
        kind: 'app',
        action: 'connect',
        statusText: 'Not connected',
        settingsPath: 'connectors/slack',
      })
    }
  })

  it('is not offered to someone it would only tell to ask an admin', () => {
    // A member with no Slack workspace bound yet, and a guest (who can't link).
    for (const slack of [
      { configured: true, canInstall: false, canLink: true, installations: [] },
      { configured: true, canInstall: false, canLink: false, installations: [team()] },
    ]) {
      expect(all(group({ slack })).some((r) => r.kind === 'app')).toBe(false)
    }
  })

  it('linked, it is connected under the person’s handle and team, after the catalog and before MCP', () => {
    const g = group({ slack: { configured: true, installations: [team({ myLink: { slackUserName: 'liam' } })] }, mcpServers: [mcp()] })
    expect(row(g.connected, 'slack:messaging')).toMatchObject({ action: 'manage', detail: '@liam · Acme', statusText: 'Connected' })
    expect(g.connected.map((r) => r.key)).toEqual(['slack:messaging', 'mcp:srv1'])
  })

  it('linked in several Slack workspaces, one row leads with the first', () => {
    const slack = {
      configured: true,
      installations: [team({ myLink: { slackUserName: null } }), team({ teamId: 'T2', teamName: 'Beta', myLink: { slackUserName: 'l' } })],
    }
    expect(row(group({ slack }).connected, 'slack:messaging')?.detail).toBe('Acme +1')
  })
})

describe('Texting', () => {
  const all = (g: ReturnType<typeof group>) => [...g.connected, ...g.attention, ...g.available]
  const team = (over: Partial<NonNullable<SlackAppStatus['installations']>[number]> = {}) => ({
    teamId: 'T1',
    teamName: 'Acme',
    teamDomain: 'acme',
    myLink: null,
    ...over,
  })
  it('has no row before the first read, or where this deployment has no texting', () => {
    expect(all(group()).some((r) => r.key === 'sms:messaging')).toBe(false)
    expect(all(group({ phone: { available: false, phone: null } })).some((r) => r.key === 'sms:messaging')).toBe(false)
  })

  it('is something to add until a phone is verified, and opens Settings › Phone', () => {
    expect(row(group({ phone: { available: true, phone: null } }).available, 'sms:messaging')).toMatchObject({
      kind: 'app',
      name: 'Texting',
      action: 'connect',
      statusText: 'Not connected',
      settingsPath: 'phone',
    })
  })

  it('verified, it is connected under the masked number, and says when texts are off', () => {
    const on = group({ phone: { available: true, phone: { masked: '•••• 1234', optedOut: false } } })
    expect(row(on.connected, 'sms:messaging')).toMatchObject({ action: 'manage', detail: '•••• 1234', settingsPath: 'phone' })
    const off = group({ phone: { available: true, phone: { masked: '•••• 1234', optedOut: true } } })
    expect(row(off.connected, 'sms:messaging')?.detail).toBe('•••• 1234 · texts off (STOP)')
  })

  it('comes after Slack and before MCP', () => {
    const g = group({
      slack: { configured: true, installations: [team({ myLink: { slackUserName: 'liam' } })] },
      phone: { available: true, phone: { masked: '•••• 1234', optedOut: false } },
      mcpServers: [mcp()],
    })
    expect(g.connected.map((r) => r.key)).toEqual(['slack:messaging', 'sms:messaging', 'mcp:srv1'])
  })
})

describe('the side panel’s list (panelRows)', () => {
  const keys = (rows: ConnectionRow[]) => rows.map((r) => r.key)

  it('needs attention, then connected, then everything that could be added, each group in its own order', () => {
    const g = group({
      status: status(
        account({ provider: 'google', capability: 'email' }),
        account({ provider: 'hubspot', capability: 'crm', reauth_required_at: '2026-10-01T00:00:00Z' }),
      ),
    })
    const rows = panelRows(g)
    expect(keys(rows)).toEqual([...keys(g.attention), ...keys(g.connected), ...keys(g.available)])
    expect(rows[0].key).toBe('hubspot:crm')
    expect(rows[1].key).toBe('google:email')
    expect(rows.slice(2).every((r) => r.group === 'available')).toBe(true)
  })

  it('lists every connection: every integration and every MCP app, added or not', () => {
    const g = group({ mcpServers: [mcp()] })
    const rows = panelRows(g)
    expect(rows).toHaveLength(g.attention.length + g.connected.length + g.available.length)
    expect(keys(rows)).toEqual(expect.arrayContaining(['mcp:srv1', 'mcp-suggested:linear', ...INTEGRATION_CATALOG.map((e) => `${e.provider}:${e.capability}`)]))
  })

  it('an integration and the same service’s MCP server are two rows, connected or not', () => {
    const neither = panelRows(group())
    expect(neither.filter((r) => r.name === 'Linear').map((r) => r.key)).toEqual(['linear:tasks', 'mcp-suggested:linear'])
    const both = panelRows(
      group({
        status: status(account({ provider: 'linear', capability: 'tasks' })),
        mcpServers: [mcp({ id: 'lin', display_name: 'Linear', server_url: 'https://mcp.linear.app/mcp' })],
      }),
    )
    expect(both.filter((r) => r.name === 'Linear').map((r) => r.key)).toEqual(['linear:tasks', 'mcp:lin'])
  })
})
