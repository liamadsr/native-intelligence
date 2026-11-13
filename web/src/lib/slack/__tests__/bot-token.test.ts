/**
 * The stored Slack bot tokens (bot-token.ts, migration 643): never stored in
 * the clear, cached briefly and forgotten on demand, refreshed when the app
 * rotates tokens (one refresh at a time, written by compare and set, and
 * another container's newer token used when it got there first), "gone" when
 * none is stored, checked with auth.test, and revoked then deleted on
 * Disconnect. Every token, id and key here is made up.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SLACK_TEST_CLIENT_ID, SLACK_TEST_CLIENT_SECRET, stubSlackEnv } from '@/test/slack'

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    throw new Error('tests pass their own client')
  },
}))

import {
  CACHE_MS,
  REFRESH_MARGIN_MS,
  SlackInstallationGoneError,
  SlackTokenError,
  deleteSlackBotToken,
  forgetSlackBotToken,
  isInstallationGone,
  readSlackGrant,
  revokeSlackBotToken,
  saveSlackBotToken,
  slackBotToken,
  verifySlackInstallation,
} from '../bot-token'
import { decryptCredential, encryptCredential } from '@/lib/crypto/credentials'

const TEAM = 'T0MADEUP1'
const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)

type Row = Record<string, unknown>

/** An in-memory slack_bot_token: just the query shapes bot-token.ts uses. */
function fakeDb() {
  const rows = new Map<string, Row>()
  const state = { reads: 0, failDelete: false, clock: NOW }
  const builder = () => {
    let op: 'select' | 'upsert' | 'delete' | 'update' = 'select'
    let payload: Row = {}
    const filters: Array<(r: Row) => boolean> = []
    const matching = () => [...rows.values()].filter((r) => filters.every((f) => f(r)))
    const run = async () => {
      const stamp = new Date(state.clock).toISOString()
      if (op === 'upsert') {
        const id = payload.slack_team_id as string
        rows.set(id, { created_at: rows.get(id)?.created_at ?? stamp, ...payload, updated_at: stamp })
        return { data: null, error: null }
      }
      if (op === 'delete') {
        if (state.failDelete) return { data: null, error: { message: 'down' } }
        for (const r of matching()) rows.delete(r.slack_team_id as string)
        return { data: null, error: null }
      }
      if (op === 'update') {
        const hit = matching()
        for (const r of hit) rows.set(r.slack_team_id as string, { ...r, ...payload, updated_at: stamp })
        return { data: hit.map((r) => ({ version: payload.version ?? r.version })), error: null }
      }
      return { data: matching(), error: null }
    }
    const b = {
      select: () => b,
      eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), b),
      lt: (col: string, v: string) => (filters.push((r) => String(r[col]) < v), b),
      upsert: (row: Row) => ((op = 'upsert'), (payload = row), b),
      delete: () => ((op = 'delete'), b),
      update: (row: Row) => ((op = 'update'), (payload = row), b),
      maybeSingle: async () => {
        state.reads++
        const r = matching()[0]
        return { data: r ? { ...r } : null, error: null }
      },
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => run().then(resolve, reject),
    }
    return b
  }
  const client = {
    from: (table: string) => {
      if (table !== 'slack_bot_token') throw new Error(`unexpected table ${table}`)
      return builder()
    },
  }
  return { client: client as never, rows, state }
}

/** Slack's answers, by method; records what was asked. */
function fakeSlack(answers: Record<string, (body: URLSearchParams, headers: Headers) => unknown>) {
  const calls: Array<{ method: string; body: URLSearchParams; headers: Headers }> = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).replace('https://slack.com/api/', '')
    const body = new URLSearchParams(String(init?.body ?? ''))
    const headers = new Headers(init?.headers)
    calls.push({ method, body, headers })
    const answer = answers[method]
    if (!answer) throw new Error(`unexpected Slack call ${method}`)
    return Response.json(answer(body, headers))
  })
  return { fetch: fetchFn as unknown as typeof fetch, calls }
}

const noSleep = async () => {}

beforeAll(() => {
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'))
})
afterAll(() => vi.unstubAllEnvs())

beforeEach(() => {
  stubSlackEnv()
  forgetSlackBotToken(TEAM)
})

async function stored(db: ReturnType<typeof fakeDb>, over: Partial<Parameters<typeof saveSlackBotToken>[1]> = {}) {
  expect(
    await saveSlackBotToken(db.client, {
      teamId: TEAM,
      appId: 'A0MADEUP01',
      botToken: 'xoxb-made-up-1',
      refreshToken: null,
      expiresAt: null,
      botUserId: 'U0BOT0001',
      scopes: 'chat:write,im:history',
      ...over,
    }),
  ).toBe(true)
  forgetSlackBotToken(TEAM)
}

describe('storing a token', () => {
  it('never stores a token in the clear, and reads it back', async () => {
    const db = fakeDb()
    await stored(db, { refreshToken: 'xoxe-1-made-up-refresh', expiresAt: NOW + 12 * 3600_000 })
    const row = db.rows.get(TEAM)!
    expect(JSON.stringify(row)).not.toContain('xoxb-made-up-1')
    expect(JSON.stringify(row)).not.toContain('xoxe-1-made-up-refresh')
    expect(row.bot_token_enc).toMatch(/^v1\./)
    expect(row.refresh_token_enc).toMatch(/^v1\./)
    expect(decryptCredential(row.bot_token_enc as string)).toBe('xoxb-made-up-1')
    expect(row.version).toBe(1)
    expect(await slackBotToken(TEAM, { svc: db.client, now: () => NOW })).toBe('xoxb-made-up-1')
  })

  it('a new install replaces the token and moves the version on', async () => {
    const db = fakeDb()
    await stored(db)
    await stored(db, { botToken: 'xoxb-made-up-2' })
    expect(db.rows.get(TEAM)!.version).toBe(2)
    expect(await slackBotToken(TEAM, { svc: db.client, now: () => NOW })).toBe('xoxb-made-up-2')
  })
})

describe('reading a token', () => {
  it('reads the row once while the cache lasts, again after it lapses or is forgotten', async () => {
    const db = fakeDb()
    await stored(db)
    const reads0 = db.state.reads
    await slackBotToken(TEAM, { svc: db.client, now: () => NOW })
    await slackBotToken(TEAM, { svc: db.client, now: () => NOW + 1_000 })
    expect(db.state.reads - reads0).toBe(1)
    await slackBotToken(TEAM, { svc: db.client, now: () => NOW + CACHE_MS + 1 })
    expect(db.state.reads - reads0).toBe(2)
    forgetSlackBotToken(TEAM)
    await slackBotToken(TEAM, { svc: db.client, now: () => NOW + CACHE_MS + 2 })
    expect(db.state.reads - reads0).toBe(3)
  })

  it('no stored token is "installation gone"', async () => {
    const db = fakeDb()
    const error = await slackBotToken(TEAM, { svc: db.client, now: () => NOW }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SlackInstallationGoneError)
    expect(isInstallationGone(error)).toBe(true)
    expect(isInstallationGone(new Error('other'))).toBe(false)
  })

  it('a deleted token is gone at once in this process', async () => {
    const db = fakeDb()
    await stored(db)
    await slackBotToken(TEAM, { svc: db.client, now: () => NOW })
    expect(await deleteSlackBotToken(db.client, TEAM)).toBe(true)
    await expect(slackBotToken(TEAM, { svc: db.client, now: () => NOW })).rejects.toBeInstanceOf(SlackInstallationGoneError)
  })
})

describe('a rotating token', () => {
  const expiring = (db: ReturnType<typeof fakeDb>) => stored(db, { refreshToken: 'xoxe-1-old-refresh', expiresAt: NOW + REFRESH_MARGIN_MS - 1 })
  const refreshed = (token = 'xoxe.xoxb-made-up-new', refresh = 'xoxe-1-new-refresh') => () => ({
    ok: true,
    app_id: 'A0MADEUP01',
    token_type: 'bot',
    access_token: token,
    refresh_token: refresh,
    expires_in: 43_200,
    bot_user_id: 'U0BOT0001',
    team: { id: TEAM, name: 'Acme' },
  })

  it('is refreshed shortly before it expires, once for concurrent callers, and written by compare and set', async () => {
    const db = fakeDb()
    await expiring(db)
    const slack = fakeSlack({ 'oauth.v2.access': refreshed() })
    const deps = { svc: db.client, fetch: slack.fetch, now: () => NOW, sleep: noSleep }
    const [a, b] = await Promise.all([slackBotToken(TEAM, deps), slackBotToken(TEAM, deps)])
    expect(a).toBe('xoxe.xoxb-made-up-new')
    expect(b).toBe('xoxe.xoxb-made-up-new')
    expect(slack.calls).toHaveLength(1)
    const call = slack.calls[0]
    expect(call.body.get('grant_type')).toBe('refresh_token')
    expect(call.body.get('refresh_token')).toBe('xoxe-1-old-refresh')
    expect(call.headers.get('authorization')).toBe(`Basic ${Buffer.from(`${SLACK_TEST_CLIENT_ID}:${SLACK_TEST_CLIENT_SECRET}`).toString('base64')}`)
    expect(call.body.get('client_secret')).toBeNull()
    const row = db.rows.get(TEAM)!
    expect(row.version).toBe(2)
    expect(decryptCredential(row.bot_token_enc as string)).toBe('xoxe.xoxb-made-up-new')
    expect(decryptCredential(row.refresh_token_enc as string)).toBe('xoxe-1-new-refresh')
    expect(row.expires_at).toBe(new Date(NOW + 43_200_000).toISOString())
    expect(JSON.stringify(row)).not.toContain('xoxe-1-new-refresh')
  })

  it('lost to another writer: the row moved on, so theirs is used and ours is not written', async () => {
    const db = fakeDb()
    await expiring(db)
    const slack = fakeSlack({
      'oauth.v2.access': () => {
        // Another container refreshes and writes while our answer is on its way.
        const row = db.rows.get(TEAM)!
        db.rows.set(TEAM, { ...row, version: 2, bot_token_enc: encryptCredential('xoxe.xoxb-theirs'), expires_at: new Date(NOW + 43_200_000).toISOString() })
        return refreshed('xoxe.xoxb-ours')()
      },
    })
    const token = await slackBotToken(TEAM, { svc: db.client, fetch: slack.fetch, now: () => NOW, sleep: noSleep })
    expect(token).toBe('xoxe.xoxb-theirs')
    expect(decryptCredential(db.rows.get(TEAM)!.bot_token_enc as string)).toBe('xoxe.xoxb-theirs')
    expect(db.rows.get(TEAM)!.version).toBe(2)
  })

  it('refused because another container spent the refresh token: the row is read again and its newer token used', async () => {
    const db = fakeDb()
    await expiring(db)
    const slack = fakeSlack({ 'oauth.v2.access': () => ({ ok: false, error: 'invalid_refresh_token' }) })
    let waits = 0
    const sleep = async () => {
      waits++
      if (waits === 2) {
        db.rows.set(TEAM, { ...db.rows.get(TEAM)!, version: 2, bot_token_enc: encryptCredential('xoxe.xoxb-theirs'), expires_at: new Date(NOW + 43_200_000).toISOString() })
      }
    }
    expect(await slackBotToken(TEAM, { svc: db.client, fetch: slack.fetch, now: () => NOW, sleep })).toBe('xoxe.xoxb-theirs')
    expect(waits).toBe(2)
  })

  it('refused with nobody else writing: a still-valid token is used; an expired one is an error, never "gone"', async () => {
    const db = fakeDb()
    await expiring(db)
    const slack = fakeSlack({ 'oauth.v2.access': () => ({ ok: false, error: 'invalid_refresh_token' }) })
    expect(await slackBotToken(TEAM, { svc: db.client, fetch: slack.fetch, now: () => NOW, sleep: noSleep })).toBe('xoxb-made-up-1')
    const late = NOW + REFRESH_MARGIN_MS
    const error = await slackBotToken(TEAM, { svc: db.client, fetch: slack.fetch, now: () => late, sleep: noSleep }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SlackTokenError)
    expect(isInstallationGone(error)).toBe(false)
    expect(String(error)).not.toContain('xox')
  })

  it('a token that does not rotate is never refreshed', async () => {
    const db = fakeDb()
    await stored(db)
    const slack = fakeSlack({})
    expect(await slackBotToken(TEAM, { svc: db.client, fetch: slack.fetch, now: () => NOW + 365 * 86_400_000 })).toBe('xoxb-made-up-1')
    expect(slack.calls).toHaveLength(0)
  })
})

describe('checking an installation', () => {
  it("is the stored token, which Slack's auth.test names as the same team", async () => {
    const db = fakeDb()
    await stored(db)
    const ok = fakeSlack({ 'auth.test': () => ({ ok: true, team_id: TEAM, user_id: 'U0BOT0001' }) })
    expect(await verifySlackInstallation(TEAM, { svc: db.client, fetch: ok.fetch, now: () => NOW })).toEqual({ token: 'xoxb-made-up-1' })
    expect(ok.calls[0].headers.get('authorization')).toBe('Bearer xoxb-made-up-1')

    forgetSlackBotToken(TEAM)
    const other = fakeSlack({ 'auth.test': () => ({ ok: true, team_id: 'T0OTHER01' }) })
    expect(await verifySlackInstallation(TEAM, { svc: db.client, fetch: other.fetch, now: () => NOW })).toBeNull()

    forgetSlackBotToken(TEAM)
    const dead = fakeSlack({ 'auth.test': () => ({ ok: false, error: 'token_revoked' }) })
    expect(await verifySlackInstallation(TEAM, { svc: db.client, fetch: dead.fetch, now: () => NOW })).toBeNull()
  })

  it('no stored token: none, and Slack is not asked', async () => {
    const slack = fakeSlack({})
    expect(await verifySlackInstallation(TEAM, { svc: fakeDb().client, fetch: slack.fetch, now: () => NOW })).toBeNull()
    expect(slack.calls).toHaveLength(0)
  })
})

describe('removing a token', () => {
  it('Disconnect revokes it at Slack, then deletes it', async () => {
    const db = fakeDb()
    await stored(db)
    const slack = fakeSlack({ 'auth.revoke': () => ({ ok: true, revoked: true }) })
    expect(await revokeSlackBotToken(TEAM, { svc: db.client, fetch: slack.fetch, now: () => NOW })).toBe('revoked')
    expect(slack.calls.map((c) => c.method)).toEqual(['auth.revoke'])
    expect(slack.calls[0].headers.get('authorization')).toBe('Bearer xoxb-made-up-1')
    expect(db.rows.has(TEAM)).toBe(false)
  })

  it('a refused revoke still deletes it; nothing stored is "gone"; a delete that fails is "failed"', async () => {
    const db = fakeDb()
    await stored(db)
    const refused = fakeSlack({ 'auth.revoke': () => ({ ok: false, error: 'ratelimited' }) })
    expect(await revokeSlackBotToken(TEAM, { svc: db.client, fetch: refused.fetch, now: () => NOW })).toBe('revoked')
    expect(db.rows.has(TEAM)).toBe(false)
    expect(await revokeSlackBotToken(TEAM, { svc: db.client, fetch: refused.fetch, now: () => NOW })).toBe('gone')

    await stored(db)
    db.state.failDelete = true
    expect(await revokeSlackBotToken(TEAM, { svc: db.client, fetch: refused.fetch, now: () => NOW })).toBe('failed')
  })

  it('an event from before a newer install does not delete the newer token', async () => {
    const db = fakeDb()
    db.state.clock = NOW + 60_000
    await stored(db)
    expect(await deleteSlackBotToken(db.client, TEAM, { writtenBefore: new Date(NOW).toISOString() })).toBe(true)
    expect(db.rows.has(TEAM)).toBe(true)
    expect(await deleteSlackBotToken(db.client, TEAM, { writtenBefore: new Date(NOW + 120_000).toISOString() })).toBe(true)
    expect(db.rows.has(TEAM)).toBe(false)
  })
})

describe('readSlackGrant', () => {
  it("reads an install's answer, and only well-formed ids", () => {
    const got = readSlackGrant({
      ok: true,
      app_id: 'A0MADEUP01',
      token_type: 'bot',
      access_token: 'xoxb-made-up-1',
      scope: 'chat:write',
      bot_user_id: 'U0BOT0001',
      team: { id: TEAM, name: 'Acme' },
      enterprise: { id: 'not-an-id' },
      authed_user: { id: 'U0PERSON1' },
      is_enterprise_install: false,
    })
    expect(got).toEqual({
      ok: true,
      grant: expect.objectContaining({ appId: 'A0MADEUP01', teamId: TEAM, enterpriseId: null, botUserId: 'U0BOT0001', authedUserId: 'U0PERSON1', expiresIn: null, refreshToken: null }),
    })
  })

  it("passes on Slack's error code, never its body", () => {
    expect(readSlackGrant({ ok: false, error: 'invalid_code' })).toEqual({ ok: false, error: 'invalid_code' })
    expect(readSlackGrant({ ok: false, error: 'Something <long> with spaces' })).toEqual({ ok: false, error: 'unknown_error' })
    expect(readSlackGrant(null)).toEqual({ ok: false, error: 'bad_answer' })
  })
})
