/**
 * The send path's draft-rewrite hook (draft-rewrite.ts, wired into
 * sendProviderDraft). Pinned:
 *   - a heavy rewrite of an agent draft records a `draft_rewrite` candidate
 *     holding ONLY the score, word counts, origin and pointers: no draft
 *     text, no sent text, no subject, anywhere in the row;
 *   - a light edit, a short draft, a send without edits, or a draft with no
 *     Dial8 row records nothing;
 *   - it never fails or holds up a send: a broken candidate write or draft
 *     read is swallowed and the send still answers ok.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { draftOrigin, noteDraftRewrite, readDraftForRewrite } from '../draft-rewrite'

let fake: FakeSupabase
vi.mock('@/lib/admin', () => ({ getServiceClient: () => fake }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: vi.fn(async () => ({ token: 'g-tok', email: 'liam@dial8.ai' })),
  getValidTokenForCapability: vi.fn(),
  getAllValidTokens: vi.fn(),
  getValidTokenForAccount: vi.fn(async () => ({ token: 'work-tok', email: 'liam@dial8.ai', accountId: 'acct-work' })),
}))

import { sendProviderDraft } from '@/lib/integrations/email'

const WS = 'f6000000-0000-4000-8000-000000000001'
const ROW = 'd7000000-0000-4000-8000-000000000001'
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'

const DRAFT_TEXT =
  'Hi Simon, thanks for the exploratory meeting today. As promised I am sending over our pricing sheet and the onboarding plan for your team. Let me know if Thursday works for a follow up.'
const REWRITE =
  'Simon — quick change of plan: our budget is frozen until the board meets in November, so let us pause the pilot. I will reach out once we have a decision.'

const reply = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response

const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  const method = init?.method ?? 'GET'
  if (url.startsWith(`${GMAIL}/messages/`)) {
    return reply(200, { id: 'm-draft', threadId: 'thr-1', labelIds: ['DRAFT'], payload: { headers: [{ name: 'To', value: 'simon@harborline.io' }, { name: 'Subject', value: 'Re: Pricing' }] } })
  }
  if (url.startsWith(`${GMAIL}/drafts?`)) return reply(200, { drafts: [{ id: 'r-7', message: { id: 'm-draft', threadId: 'thr-1' } }] })
  if (url === `${GMAIL}/drafts/send` && method === 'POST') return reply(200, { id: 'm-sent', threadId: 'thr-1', labelIds: ['SENT'] })
  return reply(404)
})

function seed(draft: Record<string, unknown> = {}) {
  fake.seed('email_thread_index', [
    { id: 'idx-1', workspace_id: WS, user_id: 'user-1', account_id: 'acct-work', provider: 'google', provider_thread_id: 'thr-1', folder: 'drafts', is_draft: true, linked_contact_id: 'contact-simon' },
  ])
  fake.seed('email_draft', [
    {
      id: ROW,
      workspace_id: WS,
      user_id: 'user-1',
      provider_draft_id: 'm-draft',
      provider_thread_id: 'thr-1',
      email_thread_id: 'idx-1',
      account_id: 'acct-work',
      status: 'pending_review',
      body_text: DRAFT_TEXT,
      metadata: { origin: 'automatic' },
      ...draft,
    },
  ])
}

const edits = (body: string) => ({ to: ['simon@harborline.io'], cc: [], subject: 'Re: Pricing — new subject', body })

/** The detached hook settles on a later tick: wait for its write (or for nothing to come). */
const settle = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  fake = makeFakeSupabase({ rpc: { update_contact_interaction_stats: () => ({ data: null, error: null }) } })
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendProviderDraft → draft_rewrite candidate', () => {
  it('a heavy rewrite records a score and pointers, and no mail text at all', async () => {
    seed()
    await expect(sendProviderDraft('user-1', WS, 'thr-1', 'm-draft', edits(REWRITE))).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() => expect(fake.rows('eval_candidate')).toHaveLength(1))
    const [row] = fake.rows('eval_candidate')
    expect(row).toMatchObject({
      workspace_id: WS,
      user_id: 'user-1',
      source: 'draft_rewrite',
      polarity: 'bad',
      dedupe_key: `draft:${ROW}`,
      ref_type: 'email_draft',
      ref_id: ROW,
      status: 'new',
    })
    const ev = row.evidence as Record<string, unknown>
    expect(Object.keys(ev).sort()).toEqual(['accountId', 'at', 'contactId', 'kind', 'origin', 'providerThreadId', 'similarity', 'wordsAfter', 'wordsBefore'])
    expect(ev).toMatchObject({ kind: 'draft_rewrite', origin: 'automatic', providerThreadId: 'thr-1', accountId: 'acct-work', contactId: 'contact-simon' })
    expect(ev.similarity as number).toBeLessThan(0.5)
    // Not one word of either text, nor the subject, anywhere in the row.
    const stored = JSON.stringify(row)
    for (const leak of ['exploratory', 'pricing sheet', 'budget is frozen', 'November', 'new subject', 'Simon']) expect(stored).not.toContain(leak)
  })

  it('a light edit records nothing', async () => {
    seed()
    await sendProviderDraft('user-1', WS, 'thr-1', 'm-draft', edits(DRAFT_TEXT.replace('Thursday', 'Friday')))
    await settle()
    expect(fake.rows('eval_candidate')).toHaveLength(0)
  })

  it('a send without edits records nothing (and reads no draft text)', async () => {
    seed()
    await sendProviderDraft('user-1', WS, 'thr-1', 'm-draft')
    await settle()
    expect(fake.rows('eval_candidate')).toHaveLength(0)
    expect(fake.selects.some((s) => s.table === 'email_draft' && s.columns.includes('body_text'))).toBe(false)
  })

  it('a draft with no Dial8 row (written in the mailbox) records nothing', async () => {
    seed({ provider_draft_id: 'm-other', provider_thread_id: 'thr-other' })
    await sendProviderDraft('user-1', WS, 'thr-1', 'm-draft', edits(REWRITE))
    await settle()
    expect(fake.rows('eval_candidate')).toHaveLength(0)
  })

  it('a broken candidate write never fails the send', async () => {
    seed()
    const real = fake.from.bind(fake)
    fake.from = (table: string) => {
      if (table === 'eval_candidate') throw new Error('eval_candidate is down')
      return real(table)
    }
    await expect(sendProviderDraft('user-1', WS, 'thr-1', 'm-draft', edits(REWRITE))).resolves.toMatchObject({ ok: true, messageId: 'm-sent' })
    await settle()
  })

  it('a broken draft read never fails the send', async () => {
    seed()
    const real = fake.from.bind(fake)
    let reads = 0
    fake.from = (table: string) => {
      // The lifecycle read passes; the rewrite's text read throws.
      if (table === 'email_draft' && ++reads === 2) throw new Error('read failed')
      return real(table)
    }
    await expect(sendProviderDraft('user-1', WS, 'thr-1', 'm-draft', edits(REWRITE))).resolves.toMatchObject({ ok: true })
    await settle()
    expect(fake.rows('eval_candidate')).toHaveLength(0)
  })
})

describe('the hook’s parts', () => {
  it('draftOrigin: a pass’s draft (automatic or explicit), a chat’s, else unknown', () => {
    expect(draftOrigin({ origin: 'automatic' })).toBe('automatic')
    expect(draftOrigin({ origin: 'explicit' })).toBe('automatic')
    expect(draftOrigin({ origin: 'chat' })).toBe('chat')
    expect(draftOrigin(null)).toBe('unknown')
  })

  it('readDraftForRewrite never rejects, and picks the row by the sent message id', async () => {
    seed()
    const db = fake as unknown as SupabaseClient
    expect(await readDraftForRewrite(db, 'user-1', [{ id: ROW, provider_draft_id: 'm-draft' }], 'm-draft')).toMatchObject({ id: ROW, origin: 'automatic' })
    expect(await readDraftForRewrite(db, 'someone-else', [{ id: ROW, provider_draft_id: 'm-draft' }], 'm-draft')).toBeNull()
    expect(await readDraftForRewrite(db, 'user-1', [], 'm-draft')).toBeNull()
    const broken = { from: () => { throw new Error('down') } } as unknown as SupabaseClient
    await expect(readDraftForRewrite(broken, 'user-1', [{ id: ROW, provider_draft_id: 'm-draft' }], 'm-draft')).resolves.toBeNull()
  })

  it('readDraftForRewrite measures only on an exact provider draft id, never the thread’s only row', async () => {
    seed()
    const db = fake as unknown as SupabaseClient
    // The send found one row on the thread, but for another draft (or none yet): nothing to measure.
    expect(await readDraftForRewrite(db, 'user-1', [{ id: ROW, provider_draft_id: 'm-other' }], 'm-draft')).toBeNull()
    expect(await readDraftForRewrite(db, 'user-1', [{ id: ROW, provider_draft_id: null }], 'm-draft')).toBeNull()
    expect(await readDraftForRewrite(db, 'user-1', [{ id: ROW, provider_draft_id: null }], '')).toBeNull()
  })

  it('noteDraftRewrite swallows a rejected draft read', async () => {
    const out = await noteDraftRewrite(fake as unknown as SupabaseClient, { userId: 'user-1', providerThreadId: 'thr-1', draft: Promise.reject(new Error('x')), sentBody: REWRITE })
    expect(out).toBe('failed')
  })
})
