/**
 * The stored Slack bot tokens (bot-token.ts, migration 643): never stored in
 * the clear; an install's save moves the version atomically; cached briefly
 * and forgotten on demand; never an expired token; refreshed by ONE container
 * (the claim), written by compare and set, and kept in process when the write
 * fails; a dead token renewed once, or the row deleted when it can't be; "gone"
 * when none is stored; checked with auth.test; revoked then deleted on
 * Disconnect. Every token, id and key here is made up.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SLACK_TEST_CLIENT_ID, SLACK_TEST_CLIENT_SECRET, stubSlackEnv } from '@/test/slack'

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    throw new Error('tests pass their own client')
  },
}))

import * as botToken from '../bot-token'
import { decryptCredential, encryptCredential } from '@/lib/crypto/credentials'

const {
  CACHE_MS,
  REFRESH_MARGIN_MS,
  SlackInstallationGoneError,
  SlackTokenError,
  deleteSlackBotToken,
  forgetSlackBotToken,
  isInstallationGone,
  readSlackGrant,
  renewDeadSlackBotToken,
  revokeSlackBotToken,
  saveSlackBotToken,
  slackBotToken,
  teamsWithStoredToken,
  verifySlackInstallation,
} = botToken

const TEAM = 'T0MADEUP1'
const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)

type Row = Record<string, unknown>

/** An in-memory slack_bot_token: just the query shapes bot-token.ts uses. */
function fakeDb() {
  const rows = new Map<string, Row>()
  const state = {
    reads: 0,
    failDelete: false,
    /** How many refresh writes (updates carrying a token and a version) answer an error. */
    failTokenWrites: 0,
    clock: NOW,
    /** Runs before each update is applied (another writer getting in first). */
    beforeUpdate: null as null | ((payload: Row) => void),
  }
  const builder = () => {
    let op: 'select' | 'insert' | 'delete' | 'update' = 'select'
    let payload: Row = {}
    const filters: Array<(r: Row) => boolean> = []
    const matching = () => [...rows.values()].filter((r) => filters.every((f) => f(r)))
    const run = async () => {
      const stamp = new Date(state.clock).toISOString()
      if (op === 'insert') {
        const id = payload.slack_team_id as string
        if (rows.has(id)) return { data: null, error: { code: '23505', message: 'duplicate' } }
        rows.set(id, { installed_at: stamp, refresh_claimed_until: null, created_at: stamp, ...payload, updated_at: stamp })
        return { data: null, error: null }
      }
      if (op === 'delete') {
        if (state.failDelete) return { data: null, error: { message: 'down' } }
        const hit = matching()
        for (const r of hit) rows.delete(r.slack_team_id as string)
        return { data: hit.map((r) => ({ slack_team_id: r.slack_team_id })), error: null }
      }
      if (op === 'update') {
        state.beforeUpdate?.(payload)
        if (state.failTokenWrites > 0 && 'bot_token_enc' in payload && 'version' in payload && !('installed_at' in payload)) {
          state.failTokenWrites--
          return { data: null, error: { message: 'down' } }
        }
        const hit = matching()
        for (const r of hit) rows.set(r.slack_team_id as string, { ...r, ...payload, updated_at: stamp })
        return { data: hit.map((r) => ({ version: payload.version ?? r.version })), error: null }
      }
      return { data: matching().map((r) => ({ ...r })), error: null }
    }
    const b = {
      select: () => b,
      eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), b),
      lt: (col: string, v: string) => (filters.push((r) => r[col] != null && String(r[col]) < v), b),
      in: (col: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[col])), b),
      or: (expr: string) => {
        const parts = expr.split(',').map((p) => /^(\w+)\.(is|lt)\.(.*)$/.exec(p)!)
        filters.push((r) => parts.some(([, col, opr, v]) => (opr === 'is' ? r[col] == null : r[col] != null && String(r[col]) < v.replace(/^"|"$/g, ''))))
        return b
      },
      insert: (row: Row) => ((op = 'insert'), (payload = row), b),
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
    return Response.json(await answer(body, headers))
  })
  return { fetch: fetchFn as unknown as typeof fetch, calls }
}

const noSleep = async () => {}
const refreshed = (token = 'xoxe.xoxb-made-up-new', over: Record<string, unknown> = {}) => () => ({
  ok: true,
  app_id: 'A0MADEUP01',
  token_type: 'bot',
  access_token: token,
  refresh_token: 'xoxe-1-new-refresh',
  expires_in: 43_200,
  bot_user_id: 'U0BOT0001',
  team: { id: TEAM, name: 'Acme' },
  ...over,
})

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
      installedAt: NOW,
      ...over,
    }),
  ).toBe(true)
  forgetSlackBotToken(TEAM)
}

/** A rotating token, already inside its refresh margin. */
const expiring = (db: ReturnType<typeof fakeDb>, over: Partial<Parameters<typeof saveSlackBotToken>[1]> = {}) =>
  stored(db, { refreshToken: 'xoxe-1-old-refresh', expiresAt: NOW + REFRESH_MARGIN_MS - 1, ...over })

describe('storing a token (an install)', () => {
  it('never stores a token in the clear, stamps installed_at, and reads it back', async () => {
    const db = fakeDb()
    await stored(db, { refreshToken: 'xoxe-1-made-up-refresh', expiresAt: NOW + 12 * 3600_000 })
    const row = db.rows.get(TEAM)!
    expect(JSON.stringify(row)).not.toContain('xoxb-made-up-1')
    expect(JSON.stringify(row)).not.toContain('xoxe-1-made-up-refresh')
    expect(row.bot_token_enc).toMatch(/^v1\./)
    expect(decryptCredential(row.bot_token_enc as string)).toBe('xoxb-made-up-1')
    expect(row.version).toBe(1)
    expect(row.installed_at).toBe(new Date(NOW).toISOString())
    expect(await slackBotToken(TEAM, { svc: db.client, now: () => NOW })).toBe('xoxb-made-up-1')
  })

  it('a new install replaces the token at the next version, and clears any refresh claim', async () => {
    const db = fakeDb()
    await stored(db)
    db.rows.set(TEAM, { ...db.rows.get(TEAM)!, refresh_claimed_until: new Date(NOW + 10_000).toISOString() })
    await stored(db, { botToken: 'xoxb-made-up-2', installedAt: NOW + 60_000 })
    const row = db.rows.get(TEAM)!
    expect(row.version).toBe(2)
    expect(row.refresh_claimed_until).toBeNull()
    expect(row.installed_at).toBe(new Date(NOW + 60_000).toISOString())
    expect(await slackBotToken(TEAM, { svc: db.client, now: () => NOW })).toBe('xoxb-made-up-2')
  })

  it('does not defeat compare and set: a refresh landing between its read and its write makes it read again, at the next version', async () => {
    const db = fakeDb()
    await stored(db)
    let raced = false
    db.state.beforeUpdate = (payload) => {
      if (raced || !('installed_at' in payload)) return
      raced = true // a refresh elsewhere writes version 2 first
      db.rows.set(TEAM, { ...db.rows.get(TEAM)!, version: 2, bot_token_enc: encryptCredential('xoxe.xoxb-refreshed') })
    }
    await stored(db, { botToken: 'xoxb-made-up-install' })
    const row = db.rows.get(TEAM)!
    expect(row.version).toBe(3)
    expect(decryptCredential(row.bot_token_enc as string)).toBe('xoxb-made-up-install')
  })

  it('two first installs at once: the insert that loses becomes an update', async () => {
    const db = fakeDb()
    const realFrom = (db.client as unknown as { from: (t: string) => Record<string, (...a: unknown[]) => unknown> }).from
    let first = true
    ;(db.client as unknown as { from: unknown }).from = (t: string) => {
      const b = realFrom(t)
      const insert = b.insert
      b.insert = (row: unknown) => {
        if (first) {
          first = false // another install's insert lands first
          db.rows.set(TEAM, { slack_team_id: TEAM, version: 1, bot_token_enc: encryptCredential('xoxb-other'), installed_at: new Date(NOW).toISOString() })
        }
        return insert(row)
      }
      return b
    }
    await stored(db, { botToken: 'xoxb-mine' })
    expect(db.rows.get(TEAM)!.version).toBe(2)
    expect(decryptCredential(db.rows.get(TEAM)!.bot_token_enc as string)).toBe('xoxb-mine')
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
    const error = await slackBotToken(TEAM, { svc: fakeDb().client, now: () => NOW }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SlackInstallationGoneError)
    expect(isInstallationGone(error)).toBe(true)
    expect(isInstallationGone(new Error('other'))).toBe(false)
  })

  it('never hands out an expired token: with no way to renew it, the row goes and the team is gone', async () => {
    const db = fakeDb()
    await stored(db, { expiresAt: NOW - 1 })
    await expect(slackBotToken(TEAM, { svc: db.client, now: () => NOW })).rejects.toBeInstanceOf(SlackInstallationGoneError)
    expect(db.rows.has(TEAM)).toBe(false)
  })

  it('never hands out an expired token that could not be renewed for now', async () => {
    const db = fakeDb()
    await stored(db, { refreshToken: 'xoxe-1-old', expiresAt: NOW - 1 })
    const slack = fakeSlack({ 'oauth.v2.access': () => ({ ok: false, error: 'ratelimited' }) })
    const error = await slackBotToken(TEAM, { svc: db.client, fetch: slack.fetch, now: () => NOW, sleep: noSleep }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SlackTokenError)
    expect(String(error)).not.toContain('xox')
    expect(db.rows.has(TEAM)).toBe(true)
  })

  it('a cached token is never served past its expiry', async () => {
    const db = fakeDb()
    await stored(db, { refreshToken: 'xoxe-1-old', expiresAt: NOW + REFRESH_MARGIN_MS + 10_000 })
    expect(await slackBotToken(TEAM, { svc: db.client, now: () => NOW })).toBe('xoxb-made-up-1')
    // 10 s later it is inside the margin: the cache no longer answers, a refresh is due.
    const slack = fakeSlack({ 'oauth.v2.access': refreshed() })
    expect(await slackBotToken(TEAM, { svc: db.client, fetch: slack.fetch, now: () => NOW + 10_001, sleep: noSleep })).toBe('xoxe.xoxb-made-up-new')
  })
})

describe('a rotating token', () => {
  it('is refreshed by the claimer: one call to Slack, written at the next version, the claim cleared', async () => {
    const db = fakeDb()
    await expiring(db)
    const slack = fakeSlack({ 'oauth.v2.access': refreshed() })
    const deps = { svc: db.client, fetch: slack.fetch, now: () => NOW, sleep: noSleep }
    const [a, b] = await Promise.all([slackBotToken(TEAM, deps), slackBotToken(TEAM, deps)])
    expect([a, b]).toEqual(['xoxe.xoxb-made-up-new', 'xoxe.xoxb-made-up-new'])
    expect(slack.calls).toHaveLength(1)
    const call = slack.calls[0]
    expect(call.body.get('grant_type')).toBe('refresh_token')
    expect(call.body.get('refresh_token')).toBe('xoxe-1-old-refresh')
    expect(call.headers.get('authorization')).toBe(`Basic ${Buffer.from(`${SLACK_TEST_CLIENT_ID}:${SLACK_TEST_CLIENT_SECRET}`).toString('base64')}`)
    const row = db.rows.get(TEAM)!
    expect(row.version).toBe(2)
    expect(row.refresh_claimed_until).toBeNull()
    expect(row.installed_at).toBe(new Date(NOW).toISOString()) // a refresh never moves it
    expect(decryptCredential(row.bot_token_enc as string)).toBe('xoxe.xoxb-made-up-new')
    expect(decryptCredential(row.refresh_token_enc as string)).toBe('xoxe-1-new-refresh')
    expect(row.expires_at).toBe(new Date(NOW + 43_200_000).toISOString())
  })

  it('two containers: only the one holding the claim calls Slack; the other waits for its write and uses it', async () => {
    const db = fakeDb()
    await expiring(db)
    // A second copy of the module: another container's process, on the same table.
    vi.resetModules()
    const other = await import('../bot-token')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slack = fakeSlack({
      'oauth.v2.access': async () => {
        await gate
        return refreshed('xoxe.xoxb-from-a')()
      },
    })
    let aDone!: Promise<string>
    const sleepB = async () => {
      release() // A's answer arrives while B waits
      await aDone
    }
    aDone = slackBotToken(TEAM, { svc: db.client, fetch: slack.fetch, now: () => NOW, sleep: noSleep })
    await new Promise((r) => setTimeout(r, 0)) // A has claimed
    expect(db.rows.get(TEAM)!.refresh_claimed_until).not.toBeNull()
    const b = await other.slackBotToken(TEAM, { svc: db.client, fetch: slack.fetch, now: () => NOW, sleep: sleepB })
    expect(await aDone).toBe('xoxe.xoxb-from-a')
    expect(b).toBe('xoxe.xoxb-from-a')
    expect(slack.calls).toHaveLength(1)
    expect(db.rows.get(TEAM)!.version).toBe(2)
  })

  it('a claim held elsewhere: Slack is not called; the still-valid token is used meanwhile', async () => {
    const db = fakeDb()
    await expiring(db)
    db.rows.set(TEAM, { ...db.rows.get(TEAM)!, refresh_claimed_until: new Date(NOW + 20_000).toISOString() })
    const slack = fakeSlack({})
    expect(await slackBotToken(TEAM, { svc: db.client, fetch: slack.fetch, now: () => NOW, sleep: noSleep })).toBe('xoxb-made-up-1')
    expect(slack.calls).toHaveLength(0)
  })

  it('a lapsed claim is taken over', async () => {
    const db = fakeDb()
    await expiring(db)
    db.rows.set(TEAM, { ...db.rows.get(TEAM)!, refresh_claimed_until: new Date(NOW - 1).toISOString() })
    const slack = fakeSlack({ 'oauth.v2.access': refreshed() })
    expect(await slackBotToken(TEAM, { svc: db.client, fetch: slack.fetch, now: () => NOW, sleep: noSleep })).toBe('xoxe.xoxb-made-up-new')
    expect(slack.calls).toHaveLength(1)
  })

  it('a write that fails after a successful refresh keeps the new token in this process, and logs no token', async () => {
    const db = fakeDb()
    await expiring(db)
    db.state.failTokenWrites = 10
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const slack = fakeSlack({ 'oauth.v2.access': refreshed() })
    const deps = { svc: db.client, fetch: slack.fetch, now: () => NOW, sleep: noSleep }
    expect(await slackBotToken(TEAM, deps)).toBe('xoxe.xoxb-made-up-new')
    // Later calls in this process use it without Slack, long after the usual cache.
    expect(await slackBotToken(TEAM, { ...deps, now: () => NOW + 3 * 3600_000 })).toBe('xoxe.xoxb-made-up-new')
    expect(slack.calls).toHaveLength(1)
    expect(errors).toHaveBeenCalled()
    expect(JSON.stringify(errors.mock.calls)).not.toContain('xox')
    errors.mockRestore()
  })

  it('a write that fails once is retried and lands', async () => {
    const db = fakeDb()
    await expiring(db)
    db.state.failTokenWrites = 1
    const slack = fakeSlack({ 'oauth.v2.access': refreshed() })
    expect(await slackBotToken(TEAM, { svc: db.client, fetch: slack.fetch, now: () => NOW, sleep: noSleep })).toBe('xoxe.xoxb-made-up-new')
    expect(db.rows.get(TEAM)!.version).toBe(2)
  })

  it('a refresh answer without token_type is taken; a user token or another team is not', async () => {
    const db = fakeDb()
    await expiring(db)
    const noType = fakeSlack({ 'oauth.v2.access': refreshed('xoxe.xoxb-untyped', { token_type: undefined }) })
    expect(await slackBotToken(TEAM, { svc: db.client, fetch: noType.fetch, now: () => NOW, sleep: noSleep })).toBe('xoxe.xoxb-untyped')

    for (const over of [{ token_type: 'user' }, { team: { id: 'T0OTHER01' } }]) {
      const again = fakeDb()
      await expiring(again)
      const slack = fakeSlack({ 'oauth.v2.access': refreshed('xoxe.xoxb-wrong', over) })
      // Refused, the old token is still valid: it is used, never the wrong one.
      expect(await slackBotToken(TEAM, { svc: again.client, fetch: slack.fetch, now: () => NOW, sleep: noSleep })).toBe('xoxb-made-up-1')
      expect(decryptCredential(again.rows.get(TEAM)!.bot_token_enc as string)).toBe('xoxb-made-up-1')
    }
  })

  it('refused because another container spent the refresh token: the row is read again and its newer token used', async () => {
    const db = fakeDb()
    await expiring(db)
    const slack = fakeSlack({ 'oauth.v2.access': () => ({ ok: false, error: 'invalid_refresh_token' }) })
    let waits = 0
    const sleep = async () => {
      waits++
      if (waits === 2) db.rows.set(TEAM, { ...db.rows.get(TEAM)!, version: 2, bot_token_enc: encryptCredential('xoxe.xoxb-theirs'), expires_at: new Date(NOW + 43_200_000).toISOString() })
    }
    expect(await slackBotToken(TEAM, { svc: db.client, fetch: slack.fetch, now: () => NOW, sleep })).toBe('xoxe.xoxb-theirs')
    expect(db.rows.has(TEAM)).toBe(true)
  })

  it('definitively refused (invalid_refresh_token, nobody newer): the row is deleted and the team is gone', async () => {
    const db = fakeDb()
    await expiring(db)
    const slack = fakeSlack({ 'oauth.v2.access': () => ({ ok: false, error: 'invalid_refresh_token' }) })
    await expect(slackBotToken(TEAM, { svc: db.client, fetch: slack.fetch, now: () => NOW, sleep: noSleep })).rejects.toBeInstanceOf(SlackInstallationGoneError)
    expect(db.rows.has(TEAM)).toBe(false)
  })

  it('another refusal: still valid, the token is used; once expired, any refusal deletes it', async () => {
    const db = fakeDb()
    await expiring(db)
    const slack = fakeSlack({ 'oauth.v2.access': () => ({ ok: false, error: 'invalid_client_id' }) })
    expect(await slackBotToken(TEAM, { svc: db.client, fetch: slack.fetch, now: () => NOW, sleep: noSleep })).toBe('xoxb-made-up-1')
    expect(db.rows.get(TEAM)!.refresh_claimed_until).toBeNull() // the claim is released
    forgetSlackBotToken(TEAM)
    await expect(slackBotToken(TEAM, { svc: db.client, fetch: slack.fetch, now: () => NOW + REFRESH_MARGIN_MS, sleep: noSleep })).rejects.toBeInstanceOf(
      SlackInstallationGoneError,
    )
    expect(db.rows.has(TEAM)).toBe(false)
  })

  it('a token that does not rotate is never refreshed', async () => {
    const db = fakeDb()
    await stored(db)
    const slack = fakeSlack({})
    expect(await slackBotToken(TEAM, { svc: db.client, fetch: slack.fetch, now: () => NOW + 365 * 86_400_000 })).toBe('xoxb-made-up-1')
    expect(slack.calls).toHaveLength(0)
  })
})

describe('a dead token', () => {
  it('with a refresh token: one forced refresh, though the token is not due', async () => {
    const db = fakeDb()
    await stored(db, { refreshToken: 'xoxe-1-old', expiresAt: NOW + 6 * 3600_000 })
    const slack = fakeSlack({ 'oauth.v2.access': refreshed() })
    expect(await renewDeadSlackBotToken(TEAM, 'xoxb-made-up-1', { svc: db.client, fetch: slack.fetch, now: () => NOW, sleep: noSleep })).toBe('xoxe.xoxb-made-up-new')
    expect(slack.calls).toHaveLength(1)
  })

  it('when the row has moved on since, its newer token is used and Slack is not asked', async () => {
    const db = fakeDb()
    await stored(db, { botToken: 'xoxb-newer' })
    const slack = fakeSlack({})
    expect(await renewDeadSlackBotToken(TEAM, 'xoxb-stale', { svc: db.client, fetch: slack.fetch, now: () => NOW, sleep: noSleep })).toBe('xoxb-newer')
    expect(slack.calls).toHaveLength(0)
  })

  it('with no refresh token: the row is deleted at its version and the team is gone', async () => {
    const db = fakeDb()
    await stored(db)
    await expect(renewDeadSlackBotToken(TEAM, 'xoxb-made-up-1', { svc: db.client, now: () => NOW, sleep: noSleep })).rejects.toBeInstanceOf(SlackInstallationGoneError)
    expect(db.rows.has(TEAM)).toBe(false)
  })

  it('a refresh refused for a dead token deletes it', async () => {
    const db = fakeDb()
    await stored(db, { refreshToken: 'xoxe-1-old', expiresAt: NOW + 6 * 3600_000 })
    const slack = fakeSlack({ 'oauth.v2.access': () => ({ ok: false, error: 'invalid_client_id' }) })
    await expect(renewDeadSlackBotToken(TEAM, 'xoxb-made-up-1', { svc: db.client, fetch: slack.fetch, now: () => NOW, sleep: noSleep })).rejects.toBeInstanceOf(
      SlackInstallationGoneError,
    )
    expect(db.rows.has(TEAM)).toBe(false)
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
  })

  it('a dead token is renewed once and checked again', async () => {
    const db = fakeDb()
    await stored(db, { refreshToken: 'xoxe-1-old', expiresAt: NOW + 6 * 3600_000 })
    const slack = fakeSlack({
      'auth.test': (_b, h) => (h.get('authorization') === 'Bearer xoxb-made-up-1' ? { ok: false, error: 'token_expired' } : { ok: true, team_id: TEAM }),
      'oauth.v2.access': refreshed(),
    })
    expect(await verifySlackInstallation(TEAM, { svc: db.client, fetch: slack.fetch, now: () => NOW, sleep: noSleep })).toEqual({ token: 'xoxe.xoxb-made-up-new' })
    expect(slack.calls.map((c) => c.method)).toEqual(['auth.test', 'oauth.v2.access', 'auth.test'])
  })

  it('a dead token with no way to renew it: none, and its row deleted', async () => {
    const db = fakeDb()
    await stored(db)
    const dead = fakeSlack({ 'auth.test': () => ({ ok: false, error: 'token_revoked' }) })
    expect(await verifySlackInstallation(TEAM, { svc: db.client, fetch: dead.fetch, now: () => NOW, sleep: noSleep })).toBeNull()
    expect(db.rows.has(TEAM)).toBe(false)
  })

  it('no stored token: none, and Slack is not asked', async () => {
    const slack = fakeSlack({})
    expect(await verifySlackInstallation(TEAM, { svc: fakeDb().client, fetch: slack.fetch, now: () => NOW })).toBeNull()
    expect(slack.calls).toHaveLength(0)
  })

  it('which teams have a token', async () => {
    const db = fakeDb()
    await stored(db)
    expect(await teamsWithStoredToken(db.client, [TEAM, 'T0OTHER01'])).toEqual(new Set([TEAM]))
    expect(await teamsWithStoredToken(db.client, [])).toEqual(new Set())
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refused = fakeSlack({ 'auth.revoke': () => ({ ok: false, error: 'ratelimited' }) })
    expect(await revokeSlackBotToken(TEAM, { svc: db.client, fetch: refused.fetch, now: () => NOW })).toBe('revoked')
    expect(db.rows.has(TEAM)).toBe(false)
    expect(await revokeSlackBotToken(TEAM, { svc: db.client, fetch: refused.fetch, now: () => NOW })).toBe('gone')
    await stored(db)
    db.state.failDelete = true
    expect(await revokeSlackBotToken(TEAM, { svc: db.client, fetch: refused.fetch, now: () => NOW })).toBe('failed')
    warn.mockRestore()
  })

  it('an event from before a newer install does not delete it (installed_at, not the last refresh)', async () => {
    const db = fakeDb()
    await stored(db, { installedAt: NOW + 60_000 })
    // A refresh later moves updated_at, never installed_at.
    db.state.clock = NOW + 5 * 3600_000
    expect(await deleteSlackBotToken(db.client, TEAM, { installedBefore: new Date(NOW).toISOString() })).toBe('newer')
    expect(db.rows.has(TEAM)).toBe(true)
    expect(await deleteSlackBotToken(db.client, TEAM, { installedBefore: new Date(NOW + 120_000).toISOString() })).toBe('deleted')
    expect(db.rows.has(TEAM)).toBe(false)
    expect(await deleteSlackBotToken(db.client, TEAM, { installedBefore: new Date(NOW).toISOString() })).toBe('none')
    expect(await deleteSlackBotToken(db.client, TEAM)).toBe('none')
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
