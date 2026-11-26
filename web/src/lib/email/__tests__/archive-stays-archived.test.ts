/**
 * Incoming's Done stays done (Liam, 11-26: "I dismissed all the
 * notifications and they went through and Google updated, but then they all
 * came back again"). The person's archive here (src/lib/email/thread-triage.ts)
 * against the mailbox sync's writer (src/lib/crm/email-sync.ts
 * indexGmailThread), on one index:
 *
 *   - a sync whose Gmail answer predates the archive (its thread historyId is
 *     older than the one the archive left; read before it, or answered late)
 *     never puts the thread back in the inbox, whenever it writes: the
 *     clock fence (synced_at) only catches a read that STARTED before the
 *     archive's stamp;
 *   - with no historyId to go by, a read whose messages are all older than
 *     the archive doesn't either;
 *   - a new message after the archive brings it back, and so does the person
 *     moving it back in Gmail itself (a newer historyId), or Undo;
 *   - archived in Gmail itself, the sync still takes it out of the inbox.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import type { SupabaseClient } from '@supabase/supabase-js'

let db: FakeSupabase
vi.mock('@/lib/admin', () => ({ getServiceClient: () => db }))
vi.mock('@sentry/nextjs', () => ({ captureMessage: () => {} }))
vi.mock('@/lib/oauth/token-manager', () => ({ getValidToken: vi.fn(async () => null), getAllValidTokens: vi.fn(async () => []), getValidTokenForAccount: vi.fn(async () => null) }))
vi.mock('@/lib/email/thread-mailbox', () => ({
  mailboxesForThread: async function* () {
    yield { provider: 'google', token: 'tok', email: 'liam@example.test', accountId: 'acct-1' }
  },
}))

const { changeEmailThreads } = await import('@/lib/email/thread-triage')
const { indexGmailThread } = await import('@/lib/crm/email-sync')

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const WS = 'f7000000-0000-4000-8000-000000000001'
const T = 'thr-invite'

interface Msg {
  id: string
  labelIds: string[]
  internalDate: string
  from: string
}
/** Gmail as it holds the thread now: its messages and its historyId (bumped by every change). */
let gmail: { historyId: number; messages: Msg[] }
/** What the next metadata read answers instead of now (a read taken before a change, answered late). */
let staleAnswer: { historyId: number; messages: Msg[] } | null

const snapshot = () => ({ historyId: gmail.historyId, messages: gmail.messages.map((m) => ({ ...m, labelIds: [...m.labelIds] })) })
const asGmail = (s: { historyId: number; messages: Msg[] }, format: 'minimal' | 'metadata') => ({
  id: T,
  historyId: String(s.historyId),
  messages: s.messages.map((m) => ({
    id: m.id,
    threadId: T,
    labelIds: m.labelIds,
    internalDate: m.internalDate,
    ...(format === 'metadata' ? { payload: { headers: [{ name: 'From', value: m.from }, { name: 'To', value: 'liam@example.test' }] } } : {}),
  })),
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  const method = init?.method ?? 'GET'
  const path = url.slice(GMAIL.length)
  if (method === 'GET' && path.startsWith(`/threads/${T}?format=minimal`)) return Promise.resolve(json(asGmail(snapshot(), 'minimal')))
  if (method === 'GET' && path.startsWith(`/threads/${T}?format=metadata`)) {
    const answer = staleAnswer ?? snapshot()
    staleAnswer = null
    return Promise.resolve(json(asGmail(answer, 'metadata')))
  }
  if (method === 'POST' && path === `/threads/${T}/modify`) {
    const body = JSON.parse(String(init?.body)) as { addLabelIds?: string[]; removeLabelIds?: string[] }
    for (const m of gmail.messages) {
      m.labelIds = m.labelIds.filter((l) => !(body.removeLabelIds ?? []).includes(l))
      for (const l of body.addLabelIds ?? []) if (!m.labelIds.includes(l)) m.labelIds.push(l)
    }
    gmail.historyId += 10
    return Promise.resolve(json(asGmail(snapshot(), 'minimal')))
  }
  return Promise.resolve(json({}, 404))
}

const SENDER = 'Dana Reyes <dana@example.test>'
const ARRIVED = Date.parse('2026-11-26T09:00:00Z')
const row = () => db.rows('email_thread_index').find((r) => r.provider_thread_id === T)!
const sync = () =>
  indexGmailThread(db as unknown as SupabaseClient, { accessToken: 'tok', userEmail: 'liam@example.test', userId: 'user-1', workspaceId: WS, workspaceIds: [WS], threadId: T, accountId: 'acct-1' })
const archive = (archive: boolean) => changeEmailThreads('user-1', WS, [T], { archive })

beforeEach(() => {
  db = makeFakeSupabase()
  gmail = { historyId: 100, messages: [{ id: 'm-1', labelIds: ['INBOX', 'UNREAD'], internalDate: String(ARRIVED), from: SENDER }] }
  staleAnswer = null
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-26T10:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** The clock moves on: every write after this is later than the ones before. */
const later = (ms = 60_000) => vi.setSystemTime(new Date(Date.now() + ms))

describe('the person’s archive against a late sync', () => {
  it('a sync whose Gmail answer predates the archive, written after it, leaves the thread archived', async () => {
    await sync()
    expect(row()).toMatchObject({ folder: 'inbox', needs_reply: true })
    // What Gmail held before the archive: the answer a slow (or lagging) read gets.
    const before = snapshot()
    later()
    const [outcome] = await archive(true)
    expect(outcome.status).toBe('changed')
    expect(gmail.messages[0].labelIds).not.toContain('INBOX')
    expect(row().folder).toBe('archive')
    later()
    staleAnswer = before
    await sync()
    expect(row().folder).toBe('archive')
    // The rest of what the read said still lands.
    expect(row()).toMatchObject({ needs_reply: true, message_count: 1 })
  })

  it('with no historyId to go by, a read with nothing newer than the archive leaves it archived', async () => {
    await sync()
    const before = snapshot()
    later()
    await archive(true)
    later()
    // An answer without a historyId: the messages' own times are the evidence.
    staleAnswer = { ...before, historyId: NaN }
    await sync()
    expect(row().folder).toBe('archive')
  })

  it('the sync still files a thread archived in Gmail itself out of the inbox', async () => {
    await sync()
    later()
    gmail.messages[0].labelIds = ['UNREAD']
    gmail.historyId += 5
    await sync()
    expect(row().folder).toBe('archive')
  })

  it('a new message after the archive brings the thread back', async () => {
    await sync()
    later()
    await archive(true)
    later()
    gmail.messages.push({ id: 'm-2', labelIds: ['INBOX', 'UNREAD'], internalDate: String(Date.now()), from: SENDER })
    gmail.historyId += 3
    await sync()
    expect(row()).toMatchObject({ folder: 'inbox', message_count: 2, provider_message_id: 'm-2' })
    // Back for good: a later sync that agrees keeps it there.
    later()
    await sync()
    expect(row().folder).toBe('inbox')
  })

  it('moved back to the inbox in Gmail itself (a newer historyId, no new message) brings it back', async () => {
    await sync()
    later()
    await archive(true)
    later()
    gmail.messages[0].labelIds.push('INBOX')
    gmail.historyId += 2
    await sync()
    expect(row().folder).toBe('inbox')
  })

  it('Undo brings it back, and the sync after it agrees', async () => {
    await sync()
    later()
    await archive(true)
    expect(row().folder).toBe('archive')
    later()
    const [undone] = await archive(false)
    expect(undone.status).toBe('changed')
    expect(row().folder).toBe('inbox')
    later()
    await sync()
    expect(row().folder).toBe('inbox')
  })

  it('before migration 722 (no mark columns) the archive and the sync go on as before', async () => {
    const real = db
    const missing = { data: null, error: { code: '42703', message: 'column email_thread_index.local_archived_at does not exist' } }
    const refuse = () => {
      const chain: Record<string, unknown> = {}
      for (const m of ['eq', 'is', 'in', 'or', 'select', 'limit', 'order']) chain[m] = () => chain
      chain.maybeSingle = async () => missing
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(missing).then(resolve)
      return chain
    }
    db = Object.assign(Object.create(real), {
      from: (table: string) => {
        const q = real.from(table) as Record<string, (...a: unknown[]) => unknown>
        if (table !== 'email_thread_index') return q
        return {
          ...q,
          select: (cols: string) => (String(cols).includes('local_archived') ? refuse() : q.select(cols)),
          update: (patch: Record<string, unknown>) => (Object.keys(patch).some((k) => k.startsWith('local_archived')) ? refuse() : q.update(patch)),
        }
      },
    }) as FakeSupabase
    await sync()
    later()
    expect((await archive(true))[0].status).toBe('changed')
    expect(row().folder).toBe('archive')
    expect(row()).not.toHaveProperty('local_archived_at')
    later()
    gmail.messages.push({ id: 'm-2', labelIds: ['INBOX'], internalDate: String(Date.now()), from: SENDER })
    await sync()
    expect(row().folder).toBe('inbox')
  })

  it('an archive of a thread Gmail had already archived (the index lagging) is held the same way', async () => {
    await sync()
    const before = snapshot()
    later()
    gmail.messages[0].labelIds = ['UNREAD']
    gmail.historyId += 1
    const [outcome] = await archive(true)
    expect(outcome.status).toBe('unchanged')
    expect(row().folder).toBe('archive')
    later()
    staleAnswer = before
    await sync()
    expect(row().folder).toBe('archive')
  })
})
