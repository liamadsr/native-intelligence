/**
 * Agent links outside your workspace (src/lib/agent-links/outside.ts): email
 * lookup that never says who's on Native Intelligence, connect tokens, binding a request to
 * whoever opened it (once), claiming email requests on sign-in, the answering
 * workspaces and the admin's switch. Over a small in-memory stand-in for
 * agent_link, agent_guest, member and workspace.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const endLinkForWorkspace = vi.fn(async (_s: unknown, _i: { linkId: string; byUserId: string }) => ({ ok: true }))
const requestLink = vi.fn(async (_s: unknown, _i: Record<string, unknown>) => ({ ok: true, link: { id: 'l-new' } }) as unknown)
vi.mock('../store', () => ({
  requestLink: (s: unknown, i: Record<string, unknown>) => requestLink(s, i),
  outsideLinksAllowed: (settings: unknown) => (settings as { outside_agent_links?: unknown } | null)?.outside_agent_links !== false,
  endLinkForWorkspace: (s: unknown, i: { linkId: string; byUserId: string }) => endLinkForWorkspace(s, i),
}))
const send = vi.fn(async (_m: unknown) => ({ error: null as unknown }))
vi.mock('@/lib/email', () => ({ BASE_URL: 'https://dial8.ai', sendEmail: (m: unknown) => send(m) }))

import {
  EMAIL_REQUESTS_PER_DAY,
  claimEmailRequests,
  connectLinkUrl,
  createConnectLink,
  requestLinkByEmail,
  emailRequestsToday,
  findConnectTarget,
  generateConnectToken,
  hashConnectToken,
  isConnectTokenShape,
  listAnswerWorkspaces,
  normalizeLinkEmail,
  redeemConnectToken,
  resolveEmailTarget,
  sendLinkRequestEmail,
  setOutsideLinksAllowed,
} from '../outside'

type Row = Record<string, unknown>

/** eq / neq / in / is / not-is / gte / or filters; update writes; the two 435 unique keys answer 23505; rpc looks emails up in `users`. */
function fakeDb(tables: Record<string, Row[]>, users: Array<{ id: string; email: string }> = []) {
  const clash: Record<string, (a: Row, b: Row) => boolean> = {
    agent_guest: (a, b) => a.state !== 'removed' && b.state !== 'removed' && a.peer_user_id != null && a.owner_user_id === b.owner_user_id && a.peer_user_id === b.peer_user_id,
    agent_link: (a, b) => {
      const open = (r: Row) => (r.state === 'requested' || r.state === 'active') && r.target_user_id != null
      const pair = (r: Row) => [r.requester_user_id, r.target_user_id].sort().join()
      return open(a) && open(b) && pair(a) === pair(b)
    },
  }
  const orFilter = (expr: string) => {
    const parts = expr.split(',').map((p) => p.split('.'))
    return (r: Row) => parts.some(([k, op, v]) => (op === 'is' ? (r[k] ?? null) === null : r[k] === v))
  }
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let patch: Row | null = null
    let head = false
    const rows = () => (tables[table] ??= [])
    const run = async () => {
      const hit = rows().filter((r) => filters.every((f) => f(r)))
      if (patch) {
        for (const r of hit) {
          const next = { ...r, ...patch }
          if (rows().some((o) => o !== r && clash[table]?.(o, next))) return { data: null, error: { message: 'duplicate', code: '23505' } }
        }
        for (const r of hit) Object.assign(r, patch)
      }
      return { data: hit, error: null, count: head ? hit.length : null }
    }
    const chain: Record<string, unknown> = {
      select: (_s?: string, opts?: { head?: boolean }) => ((head = !!opts?.head), chain),
      update: (p: Row) => ((patch = p), chain),
      order: () => chain,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), chain),
      neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), chain),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), chain),
      not: (k: string, _op: string, _v: unknown) => (filters.push((r) => (r[k] ?? null) !== null), chain),
      gte: (k: string, v: string) => (filters.push((r) => String(r[k]) >= v), chain),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), chain),
      or: (expr: string) => (filters.push(orFilter(expr)), chain),
      maybeSingle: async () => {
        const { data, error } = await run()
        return { data: data?.[0] ?? null, error }
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
    }
    return chain
  }
  const rpc = async (name: string, args: { p_email: string }) => {
    if (name !== 'agent_link_user_for_email') return { data: null, error: { message: 'no such function' } }
    return { data: users.find((u) => u.email === args.p_email.toLowerCase())?.id ?? null, error: null }
  }
  return { from, rpc } as unknown as SupabaseClient
}

const KEY = 'test-secret'
const LIAM = 'u-liam'
const DANA = 'u-dana'
const OTHER = 'u-other'
const later = () => new Date(Date.now() + 86_400_000).toISOString()

function link(over: Row = {}): Row {
  return {
    id: 'l1',
    requester_user_id: LIAM,
    requester_workspace_id: 'w-acme',
    requester_guest_id: 'g-half',
    target_user_id: null,
    target_email: null,
    connect_token_hash: null,
    target_workspace_id: null,
    outside: true,
    state: 'requested',
    requested_at: new Date().toISOString(),
    expires_at: later(),
    ...over,
  }
}
const half = (over: Row = {}): Row => ({ id: 'g-half', owner_user_id: LIAM, peer_user_id: null, channels: ['dial8'], state: 'invited', ...over })

beforeEach(() => {
  process.env.RUN_SKILL_INTERNAL_SECRET = KEY
  endLinkForWorkspace.mockClear()
  send.mockClear()
  requestLink.mockClear()
})
afterEach(() => {
  delete process.env.RUN_SKILL_INTERNAL_SECRET
})

describe('emails', () => {
  it('normalizes, and refuses what isn’t one', () => {
    expect(normalizeLinkEmail('  Dana@Northwind.COM ')).toBe('dana@northwind.com')
    for (const bad of ['', 'dana', 'dana@', '@x.com', 'a b@x.com', 42, null]) expect(normalizeLinkEmail(bad)).toBeNull()
  })

  it('finds the user, or nobody, the same way', async () => {
    const db = fakeDb({}, [{ id: DANA, email: 'dana@northwind.com' }])
    expect(await resolveEmailTarget(db, 'DANA@northwind.com')).toBe(DANA)
    expect(await resolveEmailTarget(db, 'nobody@northwind.com')).toBeNull()
    expect(await resolveEmailTarget(db, 'not an email')).toBeNull()
  })

  it('a failed lookup reads as nobody', async () => {
    const db = { rpc: async () => ({ data: null, error: { message: 'down' } }) } as unknown as SupabaseClient
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await resolveEmailTarget(db, 'dana@northwind.com')).toBeNull()
  })

  it('counts a day’s email requests, and fails closed', async () => {
    const db = fakeDb({ agent_link: [link({ target_email: 'a@x.com' }), link({ id: 'l2' }), link({ id: 'l3', target_email: 'b@x.com', requested_at: '2000-01-01T00:00:00Z' })] })
    expect(await emailRequestsToday(db, LIAM)).toBe(1)
    const down = { from: () => ({ select: () => ({ eq: () => ({ not: () => ({ gte: async () => ({ count: null, error: { message: 'x' } }) }) }) }) }) } as unknown as SupabaseClient
    expect(await emailRequestsToday(down, LIAM)).toBe(EMAIL_REQUESTS_PER_DAY)
  })

  it('sends one email that never says whether they’re on Native Intelligence, with the name escaped', async () => {
    expect(await sendLinkRequestEmail({ to: 'dana@northwind.com', requesterName: 'Liam <b>', url: 'https://dial8.ai/link/t' })).toBe(true)
    const msg = send.mock.calls[0][0] as { to: string; subject: string; html: string }
    expect(msg.to).toBe('dana@northwind.com')
    expect(msg.subject).toBe('Liam <b> wants their Native Intelligence agent to talk to yours')
    expect(msg.html).toContain('Liam &lt;b&gt;')
    expect(msg.html).toContain('https://dial8.ai/link/t')
    expect(msg.html).toContain("If you're new to Native Intelligence")
  })
})

describe('connect tokens', () => {
  it('are 32 URL-safe characters, hashed with the key', () => {
    const token = generateConnectToken()
    expect(isConnectTokenShape(token)).toBe(true)
    expect(isConnectTokenShape('short')).toBe(false)
    expect(isConnectTokenShape('../../../../../../../../etc/pass')).toBe(false)
    expect(hashConnectToken(token, KEY)).not.toBe(hashConnectToken(token, 'other'))
    expect(hashConnectToken(token, KEY)).not.toContain(token)
    expect(connectLinkUrl(token)).toBe(`https://dial8.ai/link/${token}`)
  })

  it('open a waiting request only', async () => {
    const token = generateConnectToken()
    const hash = hashConnectToken(token, KEY)
    const db = fakeDb({ agent_link: [link({ connect_token_hash: hash })] })
    expect((await findConnectTarget(db, token))?.linkId).toBe('l1')
    expect(await findConnectTarget(db, generateConnectToken())).toBeNull()
    for (const over of [{ state: 'active' }, { state: 'declined' }, { expires_at: '2000-01-01T00:00:00Z' }]) {
      const stale = fakeDb({ agent_link: [link({ connect_token_hash: hash, ...over })] })
      expect(await findConnectTarget(stale, token), JSON.stringify(over)).toBeNull()
    }
  })

  it('fail closed without the key', async () => {
    const token = generateConnectToken()
    const db = fakeDb({ agent_link: [link({ connect_token_hash: hashConnectToken(token, KEY) })] })
    delete process.env.RUN_SKILL_INTERNAL_SECRET
    expect(await findConnectTarget(db, token)).toBeNull()
  })
})

describe('redeeming a connect link', () => {
  const setup = (over: Row = {}, extra: Record<string, Row[]> = {}) => {
    const token = generateConnectToken()
    const tables: Record<string, Row[]> = { agent_link: [link({ connect_token_hash: hashConnectToken(token, KEY), ...over })], agent_guest: [half()], ...extra }
    return { token, tables, db: fakeDb(tables) }
  }

  it('binds the request and the requester’s half to whoever opened it, once', async () => {
    const { token, tables, db } = setup()
    expect(await redeemConnectToken(db, { token, user: { id: DANA } })).toEqual({ ok: true, linkId: 'l1' })
    expect(tables.agent_link[0]).toMatchObject({ target_user_id: DANA, connect_token_hash: null })
    expect(tables.agent_guest[0]).toMatchObject({ peer_user_id: DANA, state: 'invited' })
    expect(await redeemConnectToken(db, { token, user: { id: OTHER } })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('refuses the requester’s own link', async () => {
    const { token, db } = setup()
    expect(await redeemConnectToken(db, { token, user: { id: LIAM } })).toEqual({ ok: false, reason: 'self' })
  })

  it('a link sent to an email works only for the confirmed account on it', async () => {
    const { token, tables, db } = setup({ target_email: 'dana@northwind.com' })
    expect(await redeemConnectToken(db, { token, user: { id: OTHER, email: 'other@x.com', email_confirmed_at: 'now' } })).toEqual({ ok: false, reason: 'wrong_account' })
    expect(await redeemConnectToken(db, { token, user: { id: DANA, email: 'dana@northwind.com', email_confirmed_at: null } })).toEqual({ ok: false, reason: 'wrong_account' })
    expect(await redeemConnectToken(db, { token, user: { id: DANA, email: 'Dana@Northwind.com', email_confirmed_at: 'now' } })).toEqual({ ok: true, linkId: 'l1' })
    expect(tables.agent_link[0].target_user_id).toBe(DANA)
  })

  it('a link whose email already matched works only for that user', async () => {
    const { token, db } = setup({ target_email: 'dana@northwind.com', target_user_id: DANA })
    expect(await redeemConnectToken(db, { token, user: { id: OTHER, email: 'dana@northwind.com', email_confirmed_at: 'now' } })).toEqual({ ok: false, reason: 'wrong_account' })
    expect(await redeemConnectToken(db, { token, user: { id: DANA } })).toEqual({ ok: true, linkId: 'l1' })
  })

  it('another open link between the two is already_linked', async () => {
    const { token, tables, db } = setup({}, {})
    tables.agent_link.push(link({ id: 'l0', requester_user_id: DANA, target_user_id: LIAM, connect_token_hash: null }))
    expect(await redeemConnectToken(db, { token, user: { id: DANA } })).toEqual({ ok: false, reason: 'already_linked' })
    expect(tables.agent_link[0].target_user_id).toBeNull()
  })

  it('a requester who already lists them keeps one row: it takes their agent, the placeholder goes', async () => {
    const { token, tables, db } = setup({}, { agent_guest: [half(), { id: 'g-dana', owner_user_id: LIAM, peer_user_id: DANA, channels: ['sms'], state: 'active' }] })
    expect(await redeemConnectToken(db, { token, user: { id: DANA } })).toEqual({ ok: true, linkId: 'l1' })
    expect(tables.agent_link[0].requester_guest_id).toBe('g-dana')
    expect(tables.agent_guest.find((g) => g.id === 'g-dana')!.channels).toEqual(['sms', 'dial8'])
    expect(tables.agent_guest.find((g) => g.id === 'g-half')!.state).toBe('removed')
  })
})

describe('claiming email requests on sign-in', () => {
  it('binds waiting requests to the confirmed address, not others', async () => {
    const tables: Record<string, Row[]> = {
      agent_link: [
        link({ id: 'a', target_email: 'dana@northwind.com', requester_guest_id: 'ga' }),
        link({ id: 'b', target_email: 'dana@northwind.com', requester_user_id: OTHER, requester_guest_id: 'gb' }),
        link({ id: 'c', target_email: 'dana@northwind.com', requester_guest_id: 'gc', expires_at: '2000-01-01T00:00:00Z' }),
        link({ id: 'd', target_email: 'someone@else.com', requester_guest_id: 'gd' }),
      ],
      agent_guest: [half({ id: 'ga' }), half({ id: 'gb', owner_user_id: OTHER }), half({ id: 'gc' }), half({ id: 'gd' })],
    }
    const db = fakeDb(tables)
    expect(await claimEmailRequests(db, { id: DANA, email: 'dana@northwind.com', email_confirmed_at: null })).toBe(0)
    expect(await claimEmailRequests(db, { id: DANA, email: 'Dana@northwind.com', email_confirmed_at: 'now' })).toBe(2)
    expect(tables.agent_link.map((l) => l.target_user_id)).toEqual([DANA, DANA, null, null])
    expect(await claimEmailRequests(db, { id: DANA, email: 'dana@northwind.com', email_confirmed_at: 'now' })).toBe(0)
  })
})

describe('answering workspaces and the admin switch', () => {
  it('lists my workspaces with each one’s switch', async () => {
    const db = fakeDb({
      member: [
        { user_id: DANA, workspace: { id: 'w1', name: 'Northwind', settings: {} } },
        { user_id: DANA, workspace: { id: 'w2', name: 'Side', settings: { outside_agent_links: false } } },
        { user_id: OTHER, workspace: { id: 'w3', name: 'Theirs', settings: {} } },
      ],
    })
    expect(await listAnswerWorkspaces(db, DANA)).toEqual([
      { id: 'w1', name: 'Northwind', outsideAllowed: true },
      { id: 'w2', name: 'Side', outsideAllowed: false },
    ])
  })

  it('off keeps the other settings and ends this workspace’s outside links only', async () => {
    const tables: Record<string, Row[]> = {
      workspace: [{ id: 'w-acme', settings: { agent_autonomy: { mode: 'attempt' } } }],
      agent_link: [
        link({ id: 'mine-asked', state: 'active' }),
        link({ id: 'answering', requester_workspace_id: 'w-x', target_workspace_id: 'w-acme', state: 'active' }),
        link({ id: 'inside', outside: false, state: 'active' }),
        link({ id: 'elsewhere', requester_workspace_id: 'w-x', target_workspace_id: 'w-y', state: 'active' }),
        link({ id: 'over', state: 'ended' }),
      ],
    }
    const db = fakeDb(tables)
    expect(await setOutsideLinksAllowed(db, { workspaceId: 'w-acme', allowed: false, byUserId: 'u-admin' })).toEqual({ ended: 2 })
    expect(tables.workspace[0].settings).toEqual({ agent_autonomy: { mode: 'attempt' }, outside_agent_links: false })
    expect(endLinkForWorkspace.mock.calls.map((c) => c[1])).toEqual([
      { linkId: 'mine-asked', byUserId: 'u-admin' },
      { linkId: 'answering', byUserId: 'u-admin' },
    ])
    endLinkForWorkspace.mockClear()
    expect(await setOutsideLinksAllowed(db, { workspaceId: 'w-acme', allowed: true, byUserId: 'u-admin' })).toEqual({ ended: 0 })
    expect(endLinkForWorkspace).not.toHaveBeenCalled()
    expect(tables.workspace[0].settings).toMatchObject({ outside_agent_links: true })
  })
})

describe('asking someone outside', () => {
  const ask = { requesterUserId: LIAM, workspaceId: 'w-acme', displayName: 'Dana', preset: 'colleague' as const }
  const members = { member: [{ user_id: LIAM, workspace_id: 'w-acme', display_name: 'Liam Alizadeh' }] }

  it('by email: a token rides on the request, the lookup is wired, and one email goes out whoever it is', async () => {
    const db = fakeDb({ ...members, agent_link: [] }, [{ id: DANA, email: 'dana@northwind.com' }])
    for (const email of ['Dana@Northwind.com', 'nobody@northwind.com']) {
      expect(await requestLinkByEmail(db, { ...ask, email })).toEqual({ ok: true, link: { id: 'l-new' } })
    }
    const [first, second] = requestLink.mock.calls.map((c) => c[1])
    expect(first.email).toBe('dana@northwind.com')
    expect(typeof first.connectTokenHash).toBe('string')
    expect(first.connectTokenHash).not.toBe(second.connectTokenHash)
    expect(await (first.resolveEmail as (e: string) => Promise<string | null>)('dana@northwind.com')).toBe(DANA)
    const [a, b] = send.mock.calls.map((c) => c[0] as { subject: string; html: string })
    expect(a.subject).toBe(b.subject)
    expect(a.subject).toBe('Liam Alizadeh wants their Native Intelligence agent to talk to yours')
    expect(a.html.replace(/link\/[A-Za-z0-9_-]{32}/, 'link/T')).toBe(b.html.replace(/link\/[A-Za-z0-9_-]{32}/, 'link/T'))
  })

  it('by email: a refusal sends nothing, a bad address or the daily cap never asks', async () => {
    requestLink.mockResolvedValueOnce({ ok: false, reason: 'already_linked' })
    const db = fakeDb({ ...members, agent_link: [] })
    expect(await requestLinkByEmail(db, { ...ask, email: 'dana@northwind.com' })).toEqual({ ok: false, reason: 'already_linked' })
    expect(send).not.toHaveBeenCalled()
    expect(await requestLinkByEmail(db, { ...ask, email: 'nope' })).toEqual({ ok: false, reason: 'bad_email' })
    const full = fakeDb({ ...members, agent_link: Array.from({ length: EMAIL_REQUESTS_PER_DAY }, (_, i) => link({ id: `e${i}`, target_email: `p${i}@x.com` })) })
    requestLink.mockClear()
    expect(await requestLinkByEmail(full, { ...ask, email: 'dana@northwind.com' })).toEqual({ ok: false, reason: 'daily_cap' })
    expect(requestLink).not.toHaveBeenCalled()
  })

  it('a connect link: no target, a token whose hash is stored, the url shown once', async () => {
    const result = await createConnectLink(fakeDb({}), ask)
    expect(result.ok).toBe(true)
    const input = requestLink.mock.calls[0][1]
    expect(input).toMatchObject({ peerUserId: null, email: null })
    const url = (result as { url: string }).url
    const token = url.slice('https://dial8.ai/link/'.length)
    expect(isConnectTokenShape(token)).toBe(true)
    expect(input.connectTokenHash).toBe(hashConnectToken(token, KEY))
  })

  it('without the key nothing is asked', async () => {
    delete process.env.RUN_SKILL_INTERNAL_SECRET
    expect(await createConnectLink(fakeDb({}), ask)).toEqual({ ok: false, reason: 'no_key' })
    expect(await requestLinkByEmail(fakeDb({}), { ...ask, email: 'dana@northwind.com' })).toEqual({ ok: false, reason: 'no_key' })
    expect(requestLink).not.toHaveBeenCalled()
  })
})
