/**
 * Choosing what the workspace reads (source.ts, store.ts): the suggestion
 * from the workspace's own website, matching what a person typed, choosing
 * through the caller's own connection only (an unverified site refused),
 * one row per workspace kept by the code, clearing, and the status the
 * "Connect Google" card reads.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearSearchConsoleSite,
  googleSeoStatus,
  matchSite,
  setAnalyticsProperty,
  setSearchConsoleSite,
  suggestSite,
} from '../source'
import {
  foldSourceRows,
  readSource,
  writeSource,
  type SourceRow,
} from '../store'
import type { SearchConsoleSiteOption } from '../view'
import {
  ALEX,
  ALEX_GA,
  ALEX_SC,
  BEA,
  BEA_SC,
  chosenSource,
  fakeFetch,
  json,
  on,
  tokenFor,
  workspace,
  WS,
} from './fixtures'

const NOW = new Date('2026-11-12T15:00:00Z')
const opt = (site_url: string, verified = true): SearchConsoleSiteOption => ({
  site_url,
  verified,
  permission_level: verified ? 'siteOwner' : 'siteUnverifiedUser',
  account_id: BEA_SC,
  account_email: null,
})

beforeEach(() => {
  tokenFor.mockClear()
})

describe('suggestSite', () => {
  it('suggests the one verified property covering the website (a domain property covers www)', () => {
    expect(
      suggestSite('https://www.example.com', [
        opt('sc-domain:example.com'),
        opt('sc-domain:other.example'),
      ]),
    ).toBe('sc-domain:example.com')
    expect(suggestSite('example.com', [opt('https://www.example.com/')])).toBe(
      'https://www.example.com/',
    )
  })

  it('nothing when none, several, or only an unverified one match', () => {
    expect(suggestSite(null, [opt('sc-domain:example.com')])).toBeNull()
    expect(
      suggestSite('https://example.com', [
        opt('sc-domain:example.com'),
        opt('https://example.com/'),
      ]),
    ).toBeNull()
    expect(
      suggestSite('https://example.com', [opt('sc-domain:example.com', false)]),
    ).toBeNull()
    expect(
      suggestSite('https://shop.example.com', [opt('https://example.com/')]),
    ).toBeNull()
  })
})

describe('matchSite', () => {
  it('takes Google’s exact name, or a bare domain only one property covers', () => {
    expect(
      matchSite('sc-domain:example.com', [opt('sc-domain:example.com')]),
    ).toMatchObject({ ok: true })
    expect(
      matchSite('example.com', [opt('sc-domain:example.com')]),
    ).toMatchObject({ ok: true, option: { site_url: 'sc-domain:example.com' } })
  })

  it('refuses an unverified site, one it can’t see, and an ambiguous name', () => {
    expect(
      matchSite('sc-domain:example.com', [opt('sc-domain:example.com', false)]),
    ).toMatchObject({ ok: false, code: 'NO_ACCESS' })
    expect(
      matchSite('sc-domain:nope.example', [opt('sc-domain:example.com')]),
    ).toMatchObject({ ok: false, code: 'NO_ACCESS' })
    expect(
      matchSite('example.com', [
        opt('sc-domain:example.com'),
        opt('https://example.com/'),
      ]),
    ).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
  })
})

describe('the source row', () => {
  const row = (over: Partial<SourceRow>): SourceRow => ({
    ...(chosenSource() as unknown as SourceRow),
    ...over,
  })

  it('folds rows: each product from the newest row that has it', () => {
    const out = foldSourceRows([
      row({ id: 'a', sc_site_url: 'sc-domain:old.example', updated_at: '1' }),
      row({ id: 'b', ga4_property_id: null, updated_at: '2' }),
    ])
    expect(out).toMatchObject({
      id: 'b',
      sc_site_url: 'sc-domain:example.com',
      ga4_property_id: 'properties/123',
    })
    expect(foldSourceRows([])).toBeNull()
  })

  it('a write keeps one row per workspace', async () => {
    const { db, tables } = workspace({
      source: [
        chosenSource({ id: 'a', updated_at: '2026-11-01T00:00:00Z' }),
        chosenSource({
          id: 'b',
          sc_site_url: 'sc-domain:other.example',
          updated_at: '2026-11-02T00:00:00Z',
        }),
      ],
    })
    await writeSource(db, WS, { ga4_property_name: 'Renamed' }, NOW)
    expect(tables.seo_google_source.map((r) => r.id)).toEqual(['b'])
    expect(await readSource(db, WS)).toMatchObject({
      sc_site_url: 'sc-domain:other.example',
      ga4_property_name: 'Renamed',
      ga4_property_id: 'properties/123',
    })
  })
})

describe('setSearchConsoleSite', () => {
  const google = () =>
    fakeFetch([
      on('/webmasters/v3/sites', () =>
        json({
          siteEntry: [
            {
              siteUrl: 'sc-domain:example.com',
              permissionLevel: 'siteFullUser',
            },
            {
              siteUrl: 'https://unverified.example/',
              permissionLevel: 'siteUnverifiedUser',
            },
          ],
        }),
      ),
    ])

  it('chooses through the caller’s own connection, and every read then goes through it', async () => {
    const { db, tables } = workspace()
    const out = await setSearchConsoleSite(
      db,
      { workspaceId: WS, userId: BEA },
      { site_url: 'example.com' },
      { tokenForAccount: tokenFor, fetchImpl: google().fetch, now: NOW },
    )
    expect(out).toMatchObject({
      ok: true,
      source: {
        site_url: 'sc-domain:example.com',
        account_id: BEA_SC,
        chosen_by: BEA,
        chosen_by_name: 'Bea Chen',
        health: 'ok',
      },
    })
    expect(tables.seo_google_source).toHaveLength(1)
    expect(tables.seo_google_source[0]).toMatchObject({
      workspace_id: WS,
      sc_account_id: BEA_SC,
      sc_chosen_by: BEA,
    })
  })

  it('refuses an unverified site and a caller with no connection', async () => {
    const { db } = workspace()
    expect(
      await setSearchConsoleSite(
        db,
        { workspaceId: WS, userId: BEA },
        { site_url: 'https://unverified.example/' },
        { tokenForAccount: tokenFor, fetchImpl: google().fetch },
      ),
    ).toMatchObject({ ok: false, code: 'NO_ACCESS' })
    const none = workspace({ accounts: [] })
    expect(
      await setSearchConsoleSite(
        none.db,
        { workspaceId: WS, userId: BEA },
        { site_url: 'sc-domain:example.com' },
        { tokenForAccount: tokenFor, fetchImpl: google().fetch },
      ),
    ).toMatchObject({ ok: false, code: 'NOT_CONNECTED' })
  })

  it('refuses a connection that isn’t the caller’s', async () => {
    const { db } = workspace()
    expect(
      await setSearchConsoleSite(
        db,
        { workspaceId: WS, userId: BEA },
        { site_url: 'sc-domain:example.com', account_id: ALEX_SC },
        { tokenForAccount: tokenFor, fetchImpl: google().fetch },
      ),
    ).toMatchObject({
      ok: false,
      code: 'NO_ACCESS',
    })
  })

  it('a workspace guest can’t choose what the workspace reads, even through their own connection', async () => {
    const { db, tables } = workspace({
      members: [
        {
          id: 'm1',
          workspace_id: WS,
          user_id: ALEX,
          role: 'owner',
          display_name: 'Alex Rivera',
        },
        {
          id: 'm2',
          workspace_id: WS,
          user_id: BEA,
          role: 'guest',
          display_name: 'Bea Chen',
        },
      ],
    })
    const g = google()
    const out = await setSearchConsoleSite(
      db,
      { workspaceId: WS, userId: BEA },
      { site_url: 'sc-domain:example.com' },
      { tokenForAccount: tokenFor, fetchImpl: g.fetch },
    )
    expect(out).toMatchObject({ ok: false, code: 'NO_ACCESS' })
    expect(out.ok === false && out.message).toMatch(/ask a member/i)
    // Refused before Google is asked and before anything is written.
    expect(g.calls).toHaveLength(0)
    expect(tables.seo_google_source ?? []).toHaveLength(0)
  })

  it('a caller whose only connection needs a sign-in is told so', async () => {
    const { db, tables } = workspace()
    tables.connected_account.find((a) => a.id === BEA_SC)!.reauth_required_at =
      '2026-11-05T00:00:00Z'
    expect(
      await setSearchConsoleSite(
        db,
        { workspaceId: WS, userId: BEA },
        { site_url: 'sc-domain:example.com' },
        { tokenForAccount: tokenFor, fetchImpl: google().fetch },
      ),
    ).toMatchObject({
      ok: false,
      code: 'RECONNECT_NEEDED',
    })
  })

  it('clearing needs no connection and leaves Analytics alone', async () => {
    const { db } = workspace({ source: [chosenSource()] })
    await clearSearchConsoleSite(db, { workspaceId: WS })
    expect(await readSource(db, WS)).toMatchObject({
      sc_site_url: null,
      sc_account_id: null,
      ga4_property_id: 'properties/123',
    })
  })
})

describe('setAnalyticsProperty', () => {
  it('stores the property with its name, time zone and currency read from Google', async () => {
    const { db } = workspace()
    const g = fakeFetch([
      on('/accountSummaries', () =>
        json({
          accountSummaries: [
            {
              account: 'accounts/1',
              displayName: 'Fernhill',
              propertySummaries: [
                { property: 'properties/123', displayName: 'Example site' },
              ],
            },
          ],
        }),
      ),
      on('/v1beta/properties/123', () =>
        json({
          name: 'properties/123',
          displayName: 'Example site',
          timeZone: 'Europe/London',
          currencyCode: 'GBP',
        }),
      ),
    ])
    const out = await setAnalyticsProperty(
      db,
      { workspaceId: WS, userId: ALEX },
      { property_id: '123' },
      { tokenForAccount: tokenFor, fetchImpl: g.fetch, now: NOW },
    )
    expect(out).toMatchObject({
      ok: true,
      source: {
        property_id: 'properties/123',
        property_name: 'Example site',
        time_zone: 'Europe/London',
        currency_code: 'GBP',
        account_id: ALEX_GA,
        chosen_by: ALEX,
      },
    })
  })

  it('refuses a property the caller’s account can’t see, and one that isn’t an id', async () => {
    const { db } = workspace()
    const g = fakeFetch([
      on('/accountSummaries', () => json({ accountSummaries: [] })),
    ])
    expect(
      await setAnalyticsProperty(
        db,
        { workspaceId: WS, userId: ALEX },
        { property_id: 'properties/999' },
        { tokenForAccount: tokenFor, fetchImpl: g.fetch },
      ),
    ).toMatchObject({ ok: false, code: 'NO_ACCESS' })
    expect(
      await setAnalyticsProperty(
        db,
        { workspaceId: WS, userId: ALEX },
        { property_id: 'my site' },
        { tokenForAccount: tokenFor, fetchImpl: g.fetch },
      ),
    ).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    // Bea has no Analytics connection at all.
    expect(
      await setAnalyticsProperty(
        db,
        { workspaceId: WS, userId: BEA },
        { property_id: 'properties/1' },
        { tokenForAccount: tokenFor, fetchImpl: g.fetch },
      ),
    ).toMatchObject({ ok: false, code: 'NOT_CONNECTED' })
  })
})

describe('googleSeoStatus', () => {
  it('per product: state, the caller’s connections, the choice and who made it, the options, the suggestion', async () => {
    const { db, tables } = workspace({
      source: [
        chosenSource({
          ga4_property_id: null,
          ga4_account_id: null,
          ga4_chosen_by: null,
        }),
      ],
    })
    tables.company.push({
      id: 'co',
      workspace_id: WS,
      is_workspace_company: true,
      domain: 'example.com',
      website: null,
    })
    const g = fakeFetch([
      on('/webmasters/v3/sites', () =>
        json({
          siteEntry: [
            { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
          ],
        }),
      ),
    ])
    const status = await googleSeoStatus(
      db,
      { workspaceId: WS, userId: BEA },
      { tokenForAccount: tokenFor, fetchImpl: g.fetch },
    )
    expect(status.workspace_site_url).toBe('https://example.com')
    expect(status.search_console).toMatchObject({
      state: 'ready',
      my_accounts: [{ account_id: BEA_SC, status: 'ok' }],
      source: {
        site_url: 'sc-domain:example.com',
        chosen_by_name: 'Alex Rivera',
        health: 'ok',
      },
      suggested: 'sc-domain:example.com',
    })
    expect(status.analytics).toMatchObject({
      state: 'not_connected',
      my_accounts: [],
      source: null,
      options: [],
    })
  })

  it('a chosen source whose connection is gone reads needs_reconnect', async () => {
    const { db } = workspace({
      source: [chosenSource({ sc_account_id: null })],
    })
    const g = fakeFetch([
      on('/webmasters/v3/sites', () => json({ siteEntry: [] })),
      on('/accountSummaries', () => json({})),
    ])
    const status = await googleSeoStatus(
      db,
      { workspaceId: WS, userId: ALEX },
      { tokenForAccount: tokenFor, fetchImpl: g.fetch },
    )
    expect(status.search_console.state).toBe('needs_reconnect')
    expect(status.analytics.state).toBe('ready')
  })

  it('a chosen source whose chooser left the workspace reads needs_reconnect, not healthy', async () => {
    const { db } = workspace({
      source: [chosenSource()],
      members: [
        {
          id: 'm2',
          workspace_id: WS,
          user_id: BEA,
          role: 'member',
          display_name: 'Bea Chen',
        },
      ],
    })
    const g = fakeFetch([
      on('/webmasters/v3/sites', () => json({ siteEntry: [] })),
      on('/accountSummaries', () => json({})),
    ])
    const status = await googleSeoStatus(
      db,
      { workspaceId: WS, userId: BEA },
      { tokenForAccount: tokenFor, fetchImpl: g.fetch },
    )
    expect(status.search_console.state).toBe('needs_reconnect')
    expect(status.analytics.state).toBe('needs_reconnect')
  })
})
