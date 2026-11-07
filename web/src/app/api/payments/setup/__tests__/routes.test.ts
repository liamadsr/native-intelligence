/**
 * The setup routes at the edge (roadmap C1): the setup link's button POST
 * (same-origin only, the link used once, still an owner or admin) and
 * Stripe's refresh URL (only with its signature: a bare workspace id texts
 * nobody).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  db: null as unknown,
  startNew: vi.fn(async (): Promise<Record<string, unknown>> => ({ ok: true, redirectUrl: 'https://connect.stripe.com/setup/s/abc' })),
  startExisting: vi.fn((): Record<string, unknown> => ({ ok: true, redirectUrl: 'https://connect.stripe.com/oauth/authorize?x=1', cookie: { name: 'stripe_connect_nonce', value: 'nonce-1', maxAgeSeconds: 600 } })),
  textSetupLink: vi.fn(async (): Promise<Record<string, unknown>> => ({ sent: true })),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.db }))
vi.mock('@/lib/stripe', () => ({ getStripe: () => ({}) }))
vi.mock('@/lib/payments/onboarding', () => ({ startNewAccount: hoisted.startNew, startExistingAccount: hoisted.startExisting }))
vi.mock('@/lib/payments/setup', () => ({ textSetupLink: hoisted.textSetupLink }))

import { POST } from '../[token]/route'
import { GET as refresh } from '../refresh/route'
import { createSetupLink } from '@/lib/payments/setup-link'
import { signSetupReturn } from '@/lib/payments/return-token'
import { memDb, type MemDb } from '@/lib/payments/__tests__/mem-db'

const TOKEN = 'abcdefghijklmnopqrstuvwx'
const WS = '11111111-1111-4111-8111-111111111111'
const env = { ...process.env }

async function seed(role = 'owner'): Promise<MemDb> {
  const db = memDb({ member: [{ workspace_id: WS, user_id: 'u1', role }], workspace: [{ id: WS, name: 'Bright Loom' }], stripe_connect_account: [] })
  await createSetupLink(db.client, { userId: 'u1', workspaceId: WS, origin: 'http://localhost:3000' }, { token: () => TOKEN })
  hoisted.db = db.client
  return db
}

function press(mode: 'new' | 'existing', site: string | null = 'same-origin') {
  return new Request(`http://localhost:3000/api/payments/setup/${TOKEN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(site ? { 'sec-fetch-site': site } : {}) },
    body: `mode=${mode}`,
  })
}
const params = { params: Promise.resolve({ token: TOKEN }) }

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_platform'
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'
  hoisted.startNew.mockClear()
  hoisted.startExisting.mockClear()
  hoisted.textSetupLink.mockClear()
})
afterEach(() => {
  process.env = { ...env }
})

describe('the setup link’s button', () => {
  it('uses the link once and sends the owner to Stripe-hosted onboarding', async () => {
    await seed()
    const res = await POST(press('new'), params)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('https://connect.stripe.com/setup/s/abc')
    expect(hoisted.startNew).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ workspaceId: WS, userId: 'u1', livemode: false }))
    const again = await POST(press('new'), params)
    expect(again.headers.get('location')).toBe('http://localhost:3000/payments/setup/done?e=used')
    expect(hoisted.startNew).toHaveBeenCalledTimes(1)
  })

  it('“I already have a Stripe account” goes to Stripe OAuth with the binding cookie', async () => {
    await seed()
    const res = await POST(press('existing'), params)
    expect(res.headers.get('location')).toBe('https://connect.stripe.com/oauth/authorize?x=1')
    expect(res.headers.get('set-cookie')).toMatch(/stripe_connect_nonce=nonce-1;.*HttpOnly/i)
  })

  it('refuses a cross-site post without using the link', async () => {
    const db = await seed()
    expect((await POST(press('new', 'cross-site'), params)).status).toBe(403)
    expect((await POST(press('new', null), params)).status).toBe(403)
    expect(db.tables.stripe_connect_link[0].consumed_at ?? null).toBeNull()
    expect(hoisted.startNew).not.toHaveBeenCalled()
  })

  it('someone no longer an owner or admin gets nowhere', async () => {
    await seed('member')
    const res = await POST(press('new'), params)
    expect(res.headers.get('location')).toBe('http://localhost:3000/payments/setup/done?e=not_admin')
    expect(hoisted.startNew).not.toHaveBeenCalled()
  })
})

describe('Stripe’s refresh URL', () => {
  function hit(query: string) {
    return refresh(new Request(`http://localhost:3000/api/payments/setup/refresh?${query}`))
  }

  it('without its signature texts nobody and says nothing about the workspace', async () => {
    hoisted.db = memDb({ stripe_connect_account: [{ workspace_id: WS, stripe_account_id: 'acct_owner123', status: 'onboarding', connected_by: 'u1', linked_via: 'created' }] }).client
    for (const query of [`w=${WS}`, `w=${WS}&s=${signSetupReturn('22222222-2222-4222-8222-222222222222')}`]) {
      const res = await hit(query)
      expect(res.headers.get('location')).toBe('http://localhost:3000/payments/setup/done?e=invalid')
    }
    expect(hoisted.textSetupLink).not.toHaveBeenCalled()
  })

  it('signed: texts the owner who started setup a fresh link, and comes back signed', async () => {
    hoisted.db = memDb({ stripe_connect_account: [{ workspace_id: WS, stripe_account_id: 'acct_owner123', status: 'onboarding', connected_by: 'u1', linked_via: 'created' }] }).client
    const res = await hit(`w=${WS}&s=${encodeURIComponent(signSetupReturn(WS))}`)
    expect(hoisted.textSetupLink).toHaveBeenCalledWith(expect.anything(), { workspaceId: WS, userId: 'u1' })
    expect(res.headers.get('location')).toMatch(new RegExp(`^http://localhost:3000/payments/setup/done\\?w=${WS}&s=\\d+\\.[\\w-]+&t=sent$`))
  })
})
