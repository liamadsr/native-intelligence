/**
 * Whose token a read uses (token.ts): always the connection the workspace's
 * choice names, whoever asks; with nothing chosen NO_SOURCE (the asker has a
 * connection) or NOT_CONNECTED (they don't); and RECONNECT_NEEDED naming the
 * member to ask whenever that connection can't be used.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GoogleSeoError } from '../errors'
import { attributeFailure, callerAccounts, resolveReadToken } from '../token'
import {
  ALEX,
  ALEX_GA,
  ALEX_SC,
  BEA,
  BEA_SC,
  chosenSource,
  SC_SCOPES,
  tokenFor,
  workspace,
  WS,
} from './fixtures'

async function failureOf(p: Promise<unknown>): Promise<GoogleSeoError> {
  try {
    await p
  } catch (err) {
    if (err instanceof GoogleSeoError) return err
    throw err
  }
  throw new Error('expected a failure')
}

beforeEach(() => {
  tokenFor.mockClear()
})

describe('resolveReadToken', () => {
  it('reads through the chooser’s connection, whoever asks', async () => {
    const { db } = workspace({ source: [chosenSource()] })
    const read = await resolveReadToken(
      db,
      { workspaceId: WS, userId: BEA },
      'search_console',
      { tokenForAccount: tokenFor },
    )
    expect(read.accountId).toBe(ALEX_SC)
    expect(tokenFor).toHaveBeenCalledWith(ALEX_SC)
    expect(tokenFor).not.toHaveBeenCalledWith(BEA_SC)
    expect(read.owner).toEqual({
      user_id: ALEX,
      name: 'Alex Rivera',
      is_you: false,
    })
    const ga = await resolveReadToken(
      db,
      { workspaceId: WS, userId: null },
      'analytics',
      { tokenForAccount: tokenFor },
    )
    expect(ga.accountId).toBe(ALEX_GA)
  })

  it('nothing chosen: NO_SOURCE for someone with a connection, NOT_CONNECTED for someone without', async () => {
    const { db } = workspace()
    expect(
      (
        await failureOf(
          resolveReadToken(
            db,
            { workspaceId: WS, userId: BEA },
            'search_console',
            { tokenForAccount: tokenFor },
          ),
        )
      ).code,
    ).toBe('NO_SOURCE')
    expect(
      (
        await failureOf(
          resolveReadToken(db, { workspaceId: WS, userId: BEA }, 'analytics', {
            tokenForAccount: tokenFor,
          }),
        )
      ).code,
    ).toBe('NOT_CONNECTED')
    // A scheduled read has nobody to connect: it says nothing is chosen.
    expect(
      (
        await failureOf(
          resolveReadToken(db, { workspaceId: WS, userId: null }, 'analytics', {
            tokenForAccount: tokenFor,
          }),
        )
      ).code,
    ).toBe('NO_SOURCE')
    expect(tokenFor).not.toHaveBeenCalled()
  })

  it('one product chosen does not make the other readable', async () => {
    const { db } = workspace({
      source: [
        chosenSource({
          ga4_property_id: null,
          ga4_account_id: null,
          ga4_chosen_by: null,
        }),
      ],
    })
    expect(
      (
        await failureOf(
          resolveReadToken(db, { workspaceId: WS, userId: ALEX }, 'analytics', {
            tokenForAccount: tokenFor,
          }),
        )
      ).code,
    ).toBe('NO_SOURCE')
  })

  it('the connection was removed: RECONNECT_NEEDED naming the chooser', async () => {
    const { db } = workspace({
      source: [chosenSource({ sc_account_id: null })],
    })
    const err = await failureOf(
      resolveReadToken(db, { workspaceId: WS, userId: BEA }, 'search_console', {
        tokenForAccount: tokenFor,
      }),
    )
    expect(err.code).toBe('RECONNECT_NEEDED')
    expect(err.details().reconnect_by).toEqual({
      user_id: ALEX,
      name: 'Alex Rivera',
      is_you: false,
    })
    expect(err.message).toMatch(/^Alex Rivera chose this/)
  })

  it('the chooser left the workspace: the read stops at once, and no token is taken', async () => {
    const { db } = workspace({
      source: [chosenSource()],
      // Alex chose the site and has since been removed; Bea is still here.
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
    for (const userId of [BEA, null]) {
      const err = await failureOf(
        resolveReadToken(db, { workspaceId: WS, userId }, 'search_console', {
          tokenForAccount: tokenFor,
        }),
      )
      expect(err.code).toBe('RECONNECT_NEEDED')
      expect(err.message).toMatch(/no longer a member of the workspace/)
      expect(err.message).toMatch(/choose it again/)
    }
    expect(tokenFor).not.toHaveBeenCalled()
  })

  it('the chooser is now a guest: the same, a guest’s connection is never read through', async () => {
    const { db } = workspace({
      source: [chosenSource()],
      members: [
        {
          id: 'm1',
          workspace_id: WS,
          user_id: ALEX,
          role: 'guest',
          display_name: 'Alex Rivera',
        },
        {
          id: 'm2',
          workspace_id: WS,
          user_id: BEA,
          role: 'member',
          display_name: 'Bea Chen',
        },
      ],
    })
    const err = await failureOf(
      resolveReadToken(db, { workspaceId: WS, userId: BEA }, 'analytics', {
        tokenForAccount: tokenFor,
      }),
    )
    expect(err.code).toBe('RECONNECT_NEEDED')
    expect(err.message).toMatch(/no longer a member of the workspace/)
    expect(tokenFor).not.toHaveBeenCalled()
  })

  it('a choice with no chooser on record (their account is gone) is not read', async () => {
    const { db } = workspace({
      source: [chosenSource({ sc_chosen_by: null })],
    })
    const err = await failureOf(
      resolveReadToken(db, { workspaceId: WS, userId: BEA }, 'search_console', {
        tokenForAccount: tokenFor,
      }),
    )
    expect(err.code).toBe('RECONNECT_NEEDED')
    expect(tokenFor).not.toHaveBeenCalled()
  })

  it('says "your" to the chooser', async () => {
    const { db } = workspace({
      source: [chosenSource({ sc_account_id: null })],
    })
    const err = await failureOf(
      resolveReadToken(
        db,
        { workspaceId: WS, userId: ALEX },
        'search_console',
        { tokenForAccount: tokenFor },
      ),
    )
    expect(err.message).toMatch(/^Your Search Console connection/)
  })

  it.each([
    ['switched off', { is_enabled: false }],
    ['refused by Google', { reauth_required_at: '2026-11-05T00:00:00Z' }],
  ])(
    'a connection %s needs a reconnect, with no token asked for',
    async (_label, patch) => {
      const { db, tables } = workspace({ source: [chosenSource()] })
      Object.assign(
        tables.connected_account.find((a) => a.id === ALEX_SC)!,
        patch,
      )
      expect(
        (
          await failureOf(
            resolveReadToken(
              db,
              { workspaceId: WS, userId: BEA },
              'search_console',
              { tokenForAccount: tokenFor },
            ),
          )
        ).code,
      ).toBe('RECONNECT_NEEDED')
      expect(tokenFor).not.toHaveBeenCalled()
    },
  )

  it('a grant missing the read-only scope needs a reconnect', async () => {
    const { db, tables } = workspace({ source: [chosenSource()] })
    tables.user_oauth_tokens.find((t) => t.account_id === ALEX_SC)!.scopes = [
      'https://www.googleapis.com/auth/userinfo.email',
    ]
    expect(
      (
        await failureOf(
          resolveReadToken(
            db,
            { workspaceId: WS, userId: ALEX },
            'search_console',
            { tokenForAccount: tokenFor },
          ),
        )
      ).code,
    ).toBe('RECONNECT_NEEDED')
  })

  it('never reads through a connection that isn’t the chooser’s own, or isn’t this product', async () => {
    const someoneElses = workspace({
      source: [chosenSource({ sc_account_id: BEA_SC })],
    })
    expect(
      (
        await failureOf(
          resolveReadToken(
            someoneElses.db,
            { workspaceId: WS, userId: ALEX },
            'search_console',
            { tokenForAccount: tokenFor },
          ),
        )
      ).code,
    ).toBe('RECONNECT_NEEDED')
    const wrongProduct = workspace({
      source: [chosenSource({ sc_account_id: ALEX_GA })],
    })
    expect(
      (
        await failureOf(
          resolveReadToken(
            wrongProduct.db,
            { workspaceId: WS, userId: ALEX },
            'search_console',
            { tokenForAccount: tokenFor },
          ),
        )
      ).code,
    ).toBe('RECONNECT_NEEDED')
    expect(tokenFor).not.toHaveBeenCalled()
  })

  it('no token from the token manager (a dead refresh) needs a reconnect', async () => {
    const { db } = workspace({ source: [chosenSource()] })
    const none = vi.fn(async () => null)
    expect(
      (
        await failureOf(
          resolveReadToken(
            db,
            { workspaceId: WS, userId: BEA },
            'search_console',
            { tokenForAccount: none },
          ),
        )
      ).code,
    ).toBe('RECONNECT_NEEDED')
  })

  it('folds duplicate rows (a merged workspace): each product from the newest row that has it', async () => {
    const { db } = workspace({
      source: [
        chosenSource({
          id: 'old',
          sc_site_url: 'sc-domain:old.example',
          updated_at: '2026-10-01T00:00:00Z',
        }),
        chosenSource({
          id: 'new',
          ga4_property_id: null,
          ga4_account_id: null,
          updated_at: '2026-11-04T00:00:00Z',
        }),
      ],
    })
    const sc = await resolveReadToken(
      db,
      { workspaceId: WS, userId: ALEX },
      'search_console',
      { tokenForAccount: tokenFor },
    )
    expect(sc.source.sc_site_url).toBe('sc-domain:example.com')
    expect(sc.source.ga4_property_id).toBe('properties/123')
  })
})

describe('attributeFailure', () => {
  it('a 401 from Google mid-read names the member whose connection it is', () => {
    const raw = new GoogleSeoError('RECONNECT_NEEDED', 'analytics', 'x', {
      reconnectBy: null,
      detail: 'HTTP 401',
    })
    const out = attributeFailure(raw, 'analytics', {
      user_id: ALEX,
      name: 'Alex Rivera',
      is_you: false,
    }) as GoogleSeoError
    expect(out.details().reconnect_by?.name).toBe('Alex Rivera')
    const other = new GoogleSeoError('QUOTA', 'analytics', 'q')
    expect(
      attributeFailure(other, 'analytics', {
        user_id: ALEX,
        name: null,
        is_you: true,
      }),
    ).toBe(other)
  })
})

describe('callerAccounts', () => {
  it('lists the caller’s own connections for one product, each with a token or why not', async () => {
    const { db, tables } = workspace()
    tables.connected_account.push({
      id: 'acc-off',
      user_id: BEA,
      provider: 'google',
      capability: 'search_console',
      account_email: 'old@fernhillstudio.example',
      is_enabled: false,
      is_primary: false,
      created_at: '2026-11-03T00:00:00Z',
    })
    tables.user_oauth_tokens.push({
      id: 't9',
      user_id: BEA,
      account_id: 'acc-off',
      scopes: SC_SCOPES,
      updated_at: '2026-11-03T00:00:00Z',
    })
    const mine = await callerAccounts(db, { userId: BEA }, 'search_console', {
      tokenForAccount: tokenFor,
    })
    expect(mine.map((a) => [a.accountId, a.status])).toEqual([
      [BEA_SC, 'ok'],
      ['acc-off', 'needs_reconnect'],
    ])
    expect(mine[0].token).toBe(`tok-${BEA_SC.slice(0, 4)}`)
    expect(
      await callerAccounts(db, { userId: BEA }, 'analytics', {
        tokenForAccount: tokenFor,
      }),
    ).toEqual([])
  })
})
