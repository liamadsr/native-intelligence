import { describe, expect, it } from 'vitest'
import { ONE_TIME_LINK_TTL_MS, consumeOneTimeLink, createOneTimeLink, isLinkToken, linkTokenHash, oneTimeLinkUrl, peekOneTimeLink } from '../one-time'
import { oneTimeLinkDb } from './one-time-fake'

/**
 * Single-use links: bound to one account and one purpose, stored as a hash,
 * 15 minutes by default, used once. Looking (the page, a link preview) never
 * uses one; using it twice, late, or in parallel finds nothing.
 */
const T0 = Date.parse('2026-11-02T15:00:00Z')
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv12'
const ARGS = { purpose: 'oauth_connect' as const, userId: 'user-1', workspaceId: 'ws-1', payload: { provider: 'google', capabilities: ['email', 'calendar'] }, origin: 'https://nativeintelligence.dev' }

async function made(db = oneTimeLinkDb()) {
  const link = await createOneTimeLink(db.client, ARGS, { now: () => T0, token: () => TOKEN })
  return { db, link }
}

describe('createOneTimeLink', () => {
  it('stores only the token hash, bound to the account and purpose, expiring in 15 minutes', async () => {
    const { db, link } = await made()
    expect(link).toEqual({ ok: true, token: TOKEN, url: `https://nativeintelligence.dev/l/${TOKEN}`, expiresAt: new Date(T0 + ONE_TIME_LINK_TTL_MS).toISOString() })
    expect(ONE_TIME_LINK_TTL_MS).toBe(15 * 60_000)
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0]).toMatchObject({ token_hash: linkTokenHash(TOKEN), purpose: 'oauth_connect', user_id: 'user-1', workspace_id: 'ws-1', payload: ARGS.payload })
    expect(JSON.stringify(db.rows[0])).not.toContain(TOKEN)
  })

  it('a fresh token is random, URL-safe and 24 characters', async () => {
    const db = oneTimeLinkDb()
    const a = await createOneTimeLink(db.client, ARGS)
    const b = await createOneTimeLink(db.client, ARGS)
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(isLinkToken(a.token)).toBe(true)
      expect(a.token).not.toBe(b.token)
    }
  })

  it('refuses an unknown purpose, and reports a failed write', async () => {
    const db = oneTimeLinkDb()
    expect(await createOneTimeLink(db.client, { ...ARGS, purpose: 'pay_me' as never })).toEqual({ ok: false, error: 'unknown purpose' })
    const down = oneTimeLinkDb({ failInsert: true })
    expect((await createOneTimeLink(down.client, ARGS)).ok).toBe(false)
  })

  it('the URL is the origin plus /l/<token>', () => {
    expect(oneTimeLinkUrl('https://nativeintelligence.dev/', TOKEN)).toBe(`https://nativeintelligence.dev/l/${TOKEN}`)
  })
})

describe('peek and consume', () => {
  it('peeking (the page, a link preview) never uses the link', async () => {
    const { db } = await made()
    for (let i = 0; i < 3; i++) {
      const peeked = await peekOneTimeLink(db.client, TOKEN, { now: () => T0 + 1000 })
      expect(peeked).toMatchObject({ ok: true, link: { purpose: 'oauth_connect', userId: 'user-1', workspaceId: 'ws-1' } })
    }
    expect(db.rows[0].consumed_at).toBeNull()
  })

  it('a link works once: the second use, and a peek after it, say it was used', async () => {
    const { db } = await made()
    const first = await consumeOneTimeLink(db.client, TOKEN, { now: () => T0 + 60_000 })
    expect(first).toMatchObject({ ok: true, link: { userId: 'user-1', workspaceId: 'ws-1', payload: ARGS.payload } })
    expect(await consumeOneTimeLink(db.client, TOKEN, { now: () => T0 + 61_000 })).toEqual({ ok: false, reason: 'used' })
    expect(await peekOneTimeLink(db.client, TOKEN, { now: () => T0 + 62_000 })).toEqual({ ok: false, reason: 'used' })
  })

  it('two uses at once: exactly one gets the link', async () => {
    const { db } = await made()
    const both = await Promise.all([consumeOneTimeLink(db.client, TOKEN, { now: () => T0 + 1000 }), consumeOneTimeLink(db.client, TOKEN, { now: () => T0 + 1000 })])
    expect(both.filter((r) => r.ok)).toHaveLength(1)
    expect(both.find((r) => !r.ok)).toEqual({ ok: false, reason: 'used' })
  })

  it('a link expires after 15 minutes: neither the page nor the button can use it', async () => {
    const { db } = await made()
    const late = T0 + ONE_TIME_LINK_TTL_MS
    expect(await peekOneTimeLink(db.client, TOKEN, { now: () => late })).toEqual({ ok: false, reason: 'expired' })
    expect(await consumeOneTimeLink(db.client, TOKEN, { now: () => late })).toEqual({ ok: false, reason: 'expired' })
    expect(db.rows[0].consumed_at).toBeNull()
    expect((await consumeOneTimeLink(db.client, TOKEN, { now: () => late - 1 })).ok).toBe(true)
  })

  it('an unknown token, or one of the wrong shape, finds nothing (and reads nothing for a bad shape)', async () => {
    const { db } = await made()
    expect(await peekOneTimeLink(db.client, 'ZZZZZZZZZZZZZZZZZZZZZZZZ', { now: () => T0 })).toEqual({ ok: false, reason: 'not_found' })
    for (const token of ['', 'short', `${TOKEN}x`, 'has/slash/AAAAAAAAAAAAAAAA', null, 42]) {
      expect(await consumeOneTimeLink(db.client, token, { now: () => T0 })).toEqual({ ok: false, reason: 'not_found' })
    }
  })
})
