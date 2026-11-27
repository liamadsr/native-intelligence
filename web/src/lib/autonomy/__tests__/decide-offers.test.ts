/**
 * The person's decisions on a kind (decide.ts) and the agent's offer
 * (offers.ts): only the server's own evaluation can hand a kind over, only
 * under EARNED_AUTONOMY=graduate, never a hard-limited kind, never to quiet at
 * launch (Liam, 11-27, decision 2); revoke always works (decision 1); the
 * offer's words come from the record, once per kind per 30 days.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { decideKind, isKindDecision } from '../decide'
import { maybeOfferKind, offerText } from '../offers'

const NOW = new Date('2026-11-27T12:00:00Z')

describe('decideKind', () => {
  const eligible = { level: 'ask' as const, eligible: 'tell' as const, blocked: null }
  const ctx = { graduating: true, hardLimited: false, now: NOW }

  it('hand_over: an eligible kind goes to tell, never quiet', () => {
    expect(decideKind('hand_over', eligible, ctx)).toEqual({ ok: true, patch: { level: 'tell', granted_at: NOW.toISOString(), pinned_ask: false, offer_declined_at: null } })
  })

  it('hand_over refuses: not eligible, a hard limit, or graduation off', () => {
    expect(decideKind('hand_over', { level: 'ask', eligible: null, blocked: 'streak' }, ctx)).toMatchObject({ ok: false, code: 'NOT_ELIGIBLE' })
    expect(decideKind('hand_over', { ...eligible, eligible: 'quiet' as never }, ctx)).toMatchObject({ ok: false, code: 'NOT_ELIGIBLE' })
    expect(decideKind('hand_over', eligible, { ...ctx, hardLimited: true })).toMatchObject({ ok: false, code: 'HARD_LIMIT' })
    expect(decideKind('hand_over', eligible, { ...ctx, graduating: false })).toMatchObject({ ok: false, code: 'OFF' })
  })

  it('revoke always works and starts the cooldown; never pins; not_now stamps', () => {
    expect(decideKind('revoke', { level: 'tell', eligible: null, blocked: 'at_top' }, { ...ctx, graduating: false })).toEqual({ ok: true, patch: { level: 'ask', granted_at: null, demoted_at: NOW.toISOString() } })
    expect(decideKind('never', eligible, ctx)).toEqual({ ok: true, patch: { pinned_ask: true, level: 'ask', granted_at: null } })
    expect(decideKind('not_now', eligible, ctx)).toEqual({ ok: true, patch: { offer_declined_at: NOW.toISOString() } })
    expect(decideKind('allow_offers', eligible, ctx)).toEqual({ ok: true, patch: { pinned_ask: false } })
  })

  it('only the five decisions', () => {
    expect(['hand_over', 'not_now', 'never', 'allow_offers', 'revoke'].every(isKindDecision)).toBe(true)
    expect(isKindDecision('promote')).toBe(false)
    expect(isKindDecision('quiet')).toBe(false)
  })
})

describe('maybeOfferKind', () => {
  const WS = 'ws-1'
  const USER = 'user-1'
  const KEY = 'offer_times|text|one'
  let db: FakeSupabase
  const append = vi.fn(async () => ({ written: true }))
  const graduate = { env: { EARNED_AUTONOMY: 'graduate' }, append: append as never }
  const seedClean = (n = 10, spanDays = 8) =>
    db.seed('autonomy_outcome', Array.from({ length: n }, (_, i) => ({ workspace_id: WS, user_id: USER, kind_key: KEY, outcome: 'approved', edit_ratio: null, created_at: new Date(NOW.getTime() - (0.1 + (spanDays * i) / (n - 1)) * 86_400_000).toISOString() })))

  beforeEach(() => {
    db = makeFakeSupabase()
    append.mockClear()
  })

  it('an eligible kind: one templated line in the home thread, and offered_at stamped', async () => {
    seedClean()
    expect(await maybeOfferKind(db as never, { workspaceId: WS, userId: USER, kindKey: KEY, now: NOW }, graduate)).toBe(true)
    expect(append).toHaveBeenCalledTimes(1)
    const text = (append.mock.calls[0] as unknown as [unknown, { parts: Array<{ text: string }> }])[1].parts[0].text
    expect(text).toContain('Offers of meeting times by text, to one person')
    expect(text).toContain('the last 10 of these')
    expect(text).toContain('/account/settings/autonomy')
    expect(db.rows('autonomy_kind')[0]).toMatchObject({ kind_key: KEY, level: 'ask', offered_at: NOW.toISOString() })
  })

  it('once per kind per 30 days', async () => {
    seedClean()
    await maybeOfferKind(db as never, { workspaceId: WS, userId: USER, kindKey: KEY, now: NOW }, graduate)
    expect(await maybeOfferKind(db as never, { workspaceId: WS, userId: USER, kindKey: KEY, now: new Date(NOW.getTime() + 86_400_000) }, graduate)).toBe(false)
    expect(append).toHaveBeenCalledTimes(1)
  })

  it('no offer under record, nor before it is earned, nor on a hard-limited kind, nor when pinned or granted', async () => {
    seedClean()
    expect(await maybeOfferKind(db as never, { workspaceId: WS, userId: USER, kindKey: KEY, now: NOW }, { ...graduate, env: { EARNED_AUTONOMY: 'record' } })).toBe(false)
    expect(await maybeOfferKind(db as never, { workspaceId: WS, userId: USER, kindKey: 'send_payment_link|unknown|one', now: NOW }, graduate)).toBe(false)
    db.seed('autonomy_kind', [{ id: 'k1', workspace_id: WS, user_id: USER, kind_key: KEY, level: 'ask', pinned_ask: true }])
    expect(await maybeOfferKind(db as never, { workspaceId: WS, userId: USER, kindKey: KEY, now: NOW }, graduate)).toBe(false)
    db = makeFakeSupabase()
    seedClean(9)
    expect(await maybeOfferKind(db as never, { workspaceId: WS, userId: USER, kindKey: KEY, now: NOW }, graduate)).toBe(false)
    expect(append).not.toHaveBeenCalled()
  })

  it('the words are templated from the record', () => {
    expect(offerText('Calendar invites to one person', { streak: 12, streakDays: 9.4 })).toMatch(/^Calendar invites to one person: I've drafted the last 12 of these over 9 days, and you approved every one as it was\./)
  })
})
