import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

/**
 * Triage on arrival (src/lib/email/triage.ts): every touched thread is
 * indexed once from metadata; only a thread whose newest message changed is
 * handed on, the account's own workspace copy of a personal thread that needs
 * a reply (and has no draft yet) to drafting, a held one to the hold refresh.
 * Nothing is written to a stored-mail table.
 */

let db: FakeSupabase

/** What the provider says about each thread when it is re-read. */
let providerSays: Record<string, { provider_message_id: string; needs_reply: boolean; auto_classified: string; is_draft?: boolean; from_email?: string }>

const hoisted = vi.hoisted(() => ({
  indexGmailThread: vi.fn(),
  indexOutlookThread: vi.fn(),
  deleteThreadCopies: vi.fn(async () => {}),
}))
vi.mock('@/lib/crm/email-sync', () => ({
  indexGmailThread: hoisted.indexGmailThread,
  indexOutlookThread: hoisted.indexOutlookThread,
  deleteThreadCopies: hoisted.deleteThreadCopies,
}))

const { readThreadRevisions, triageArrivals, understandableThreads } = await import('@/lib/email/triage')

/** The indexer writes the provider's answer onto every copy of the thread, as writeThreadCopies does. */
function indexer() {
  return async (_db: unknown, target: { threadId: string }) => {
    const says = providerSays[target.threadId]
    if (!says) return 'unreadable'
    const copies = db.rows('email_thread_index').filter((row) => row.provider_thread_id === target.threadId)
    for (const row of copies) Object.assign(row, says)
    if (!copies.length) db.rows('email_thread_index').push(ROW(target.threadId, says.provider_message_id, says))
    return 'indexed'
  }
}

const ROW = (thread: string, message: string, extra: Record<string, unknown> = {}) => ({
  id: `${thread}-${extra.workspace_id ?? 'ws-1'}`,
  user_id: 'u-1',
  workspace_id: 'ws-1',
  provider: 'google',
  account_id: 'acct-1',
  provider_thread_id: thread,
  provider_message_id: message,
  needs_reply: false,
  auto_classified: null,
  is_draft: false,
  ...extra,
})

const REF = { userId: 'u-1', provider: 'google' as const, accountId: 'acct-1' }
const triage = (threadIds: string[]) =>
  triageArrivals(db as never, { ...REF, workspaceId: 'ws-1', threadIds, accessToken: 'tok', mailboxEmail: 'me@x.com' })

beforeEach(() => {
  db = makeFakeSupabase()
  providerSays = {}
  hoisted.indexGmailThread.mockReset().mockImplementation(indexer())
  hoisted.indexOutlookThread.mockReset().mockImplementation(indexer())
  hoisted.deleteThreadCopies.mockClear()
})

describe('readThreadRevisions', () => {
  it("reads each thread's newest message for this account only", async () => {
    db.seed('email_thread_index', [
      ROW('t1', 'm1'),
      ROW('t1', 'm9', { id: 'other-acct', account_id: 'acct-2' }),
      ROW('t2', 'm2'),
    ])
    expect(await readThreadRevisions(db as never, REF, ['t1', 't2', 't3'])).toEqual({ t1: 'm1', t2: 'm2' })
  })

  it('reads a legacy mailbox by its rows with no account', async () => {
    db.seed('email_thread_index', [ROW('t1', 'm1', { account_id: null }), ROW('t1', 'm9', { id: 'acct' })])
    expect(await readThreadRevisions(db as never, { ...REF, accountId: null }, ['t1'])).toEqual({ t1: 'm1' })
  })

  it('reads nothing for no threads', async () => {
    expect(await readThreadRevisions(db as never, REF, [])).toEqual({})
    expect(db.calls).toHaveLength(0)
  })
})

describe('triageArrivals', () => {
  it('indexes each touched thread once and hands on one whose new newest message needs a personal reply', async () => {
    db.seed('email_thread_index', [ROW('t1', 'm1')])
    providerSays = { t1: { provider_message_id: 'm2', needs_reply: true, auto_classified: 'personal' } }
    expect(await triage(['t1'])).toEqual({ draftable: ['t1'], understandable: [], held: [], indexed: 1 })
    expect(hoisted.indexGmailThread).toHaveBeenCalledTimes(1)
    expect(hoisted.indexGmailThread).toHaveBeenCalledWith(db, expect.objectContaining({
      threadId: 't1', accessToken: 'tok', userEmail: 'me@x.com', userId: 'u-1', workspaceId: 'ws-1', accountId: 'acct-1',
    }))
  })

  it('treats a thread the index did not hold before as new', async () => {
    providerSays = { t1: { provider_message_id: 'm1', needs_reply: true, auto_classified: 'important' } }
    expect((await triage(['t1'])).draftable).toEqual(['t1'])
  })

  it('leaves a thread alone when only its labels changed, keeping a "no reply needed" decision', async () => {
    db.seed('email_thread_index', [ROW('t1', 'm1', { needs_reply: false, auto_classified: 'personal' })])
    providerSays = { t1: { provider_message_id: 'm1', needs_reply: false, auto_classified: 'personal' } }
    expect((await triage(['t1'])).draftable).toEqual([])
  })

  it('does not hand on newsletters, threads needing no reply, or threads already drafted', async () => {
    db.seed('email_thread_index', [ROW('news', 'm1'), ROW('mine', 'm1'), ROW('drafted', 'm1')])
    providerSays = {
      news: { provider_message_id: 'm2', needs_reply: true, auto_classified: 'newsletter' },
      mine: { provider_message_id: 'm2', needs_reply: false, auto_classified: 'personal' },
      drafted: { provider_message_id: 'm2', needs_reply: true, auto_classified: 'personal', is_draft: true },
    }
    expect((await triage(['news', 'mine', 'drafted'])).draftable).toEqual([])
  })

  it('hands the rest of the new mail to be understood (E2): notices and no-reply mail; never a newsletter, a draft, the person\'s own message, or what drafting takes', async () => {
    db.seed('email_thread_index', ['notice', 'person-fyi', 'news', 'own', 'draft', 'reply'].map((id) => ROW(id, 'm1')))
    providerSays = {
      notice: { provider_message_id: 'm2', needs_reply: false, auto_classified: 'notification' },
      'person-fyi': { provider_message_id: 'm2', needs_reply: false, auto_classified: 'personal' },
      news: { provider_message_id: 'm2', needs_reply: false, auto_classified: 'newsletter' },
      own: { provider_message_id: 'm2', needs_reply: false, auto_classified: 'personal', from_email: 'Me@X.com' },
      draft: { provider_message_id: 'm2', needs_reply: false, auto_classified: 'personal', is_draft: true },
      reply: { provider_message_id: 'm2', needs_reply: true, auto_classified: 'personal' },
    }
    const out = await triage(['notice', 'person-fyi', 'news', 'own', 'draft', 'reply'])
    expect(out.draftable).toEqual(['reply'])
    expect(out.understandable?.sort()).toEqual(['notice', 'person-fyi'])
  })

  it("hands on only the account's own workspace copy", async () => {
    db.seed('email_thread_index', [ROW('t1', 'm1'), ROW('t1', 'm1', { workspace_id: 'ws-2' })])
    providerSays = { t1: { provider_message_id: 'm2', needs_reply: true, auto_classified: 'personal' } }
    expect((await triage(['t1'])).draftable).toEqual(['t1'])
  })

  it('keeps going when one thread cannot be read', async () => {
    db.seed('email_thread_index', [ROW('bad', 'm1'), ROW('good', 'm1')])
    providerSays = { good: { provider_message_id: 'm2', needs_reply: true, auto_classified: 'personal' } }
    hoisted.indexGmailThread.mockImplementationOnce(async () => {
      throw new Error('Gmail 500')
    })
    expect((await triage(['bad', 'good'])).draftable).toEqual(['good'])
  })

  it('a held thread with a new message goes to the hold refresh, never to a second draft', async () => {
    db.seed('email_thread_index', [ROW('t1', 'm1')])
    db.seed('email_hold', [{ id: 'h1', user_id: 'u-1', account_id: 'acct-1', provider_thread_id: 't1' }])
    providerSays = { t1: { provider_message_id: 'm2', needs_reply: true, auto_classified: 'personal' } }
    expect(await triage(['t1'])).toEqual({ draftable: [], understandable: [], held: ['t1'], indexed: 1 })
  })

  it('a thread gone from the mailbox loses its index rows; a held one goes to the refresh to be released', async () => {
    db.seed('email_thread_index', [ROW('gone', 'm1'), ROW('gone', 'm1', { workspace_id: 'ws-2' })])
    db.seed('email_hold', [{ id: 'h1', user_id: 'u-1', account_id: 'acct-1', provider_thread_id: 'gone' }])
    hoisted.indexGmailThread.mockImplementationOnce(async () => 'gone')
    expect(await triage(['gone'])).toEqual({ draftable: [], understandable: [], held: ['gone'], indexed: 1 })
    expect(hoisted.deleteThreadCopies).toHaveBeenCalledWith(db, { userId: 'u-1', accountId: 'acct-1', provider: 'google', threadId: 'gone' })
  })

  it('a muted thread with a new message is archived again and goes to neither drafting nor the agent', async () => {
    db.seed('email_thread_index', [ROW('muted', 'm1'), ROW('reply', 'm1'), ROW('notice', 'm1')])
    db.seed('email_thread_mute', [{ user_id: 'u-1', account_id: 'acct-1', provider: 'google', provider_thread_id: 'muted' }])
    providerSays = {
      muted: { provider_message_id: 'm2', needs_reply: true, auto_classified: 'personal' },
      reply: { provider_message_id: 'm2', needs_reply: true, auto_classified: 'personal' },
      notice: { provider_message_id: 'm2', needs_reply: false, auto_classified: 'notification' },
    }
    const rearchiveMuted = vi.fn(async (_db: unknown, input: { threadIds: readonly string[] }) =>
      new Set(input.threadIds.filter((id) => id === 'muted')))
    const out = await triageArrivals(db as never, { ...REF, workspaceId: 'ws-1', threadIds: ['muted', 'reply', 'notice'], accessToken: 'tok', mailboxEmail: 'me@x.com' }, { rearchiveMuted })
    expect(out.draftable).toEqual(['reply'])
    expect(out.understandable).toEqual(['notice'])
    // Only threads with a new newest message are checked, with the push's own mailbox.
    expect(rearchiveMuted).toHaveBeenCalledWith(db, { userId: 'u-1', provider: 'google', accountId: 'acct-1', accessToken: 'tok', threadIds: ['muted', 'reply', 'notice'] })
  })

  it('writes nothing to a stored-mail table: only the index (through the indexer) is read, and the mute list', async () => {
    db.seed('email_thread_index', [ROW('t1', 'm1')])
    providerSays = { t1: { provider_message_id: 'm2', needs_reply: true, auto_classified: 'personal' } }
    await triage(['t1'])
    const tables = new Set(db.calls.map((c) => c.table))
    expect([...tables].sort()).toEqual(['email_hold', 'email_thread_index', 'email_thread_mute'])
    expect(db.calls.filter((c) => c.op !== 'select')).toEqual([])
  })

  it('reads an Outlook conversation with the Outlook indexer', async () => {
    db.seed('email_thread_index', [ROW('conv', 'm1', { provider: 'microsoft' })])
    providerSays = { conv: { provider_message_id: 'm2', needs_reply: true, auto_classified: 'personal' } }
    const out = await triageArrivals(db as never, {
      ...REF, provider: 'microsoft', workspaceId: 'ws-1', threadIds: ['conv'], accessToken: 'tok', mailboxEmail: 'me@x.com',
    })
    expect(out.draftable).toEqual(['conv'])
    expect(hoisted.indexOutlookThread).toHaveBeenCalledTimes(1)
    expect(hoisted.indexGmailThread).not.toHaveBeenCalled()
  })
})

describe('understandableThreads (GEN-1164: what the reply gate turned away goes to the agent)', () => {
  it("hands over notices and a person's mail; never a newsletter, a draft or the person's own message from any of their addresses", async () => {
    db.seed('connected_account', [{ id: 'acct-1', user_id: 'u-1', account_email: 'me@x.com', capability: 'email' }, { id: 'acct-2', user_id: 'u-1', account_email: 'Me@Gmail.com', capability: 'email' }])
    db.seed('email_thread_index', [
      ROW('license', 'm1', { auto_classified: 'notification', from_email: 'developer@apple.example' }),
      ROW('invite', 'm2', { auto_classified: 'notification', from_email: 'jessae@k.example' }),
      ROW('promo', 'm3', { auto_classified: 'newsletter', from_email: 'events@a16z.example' }),
      ROW('draft', 'm4', { is_draft: true, from_email: 'me@x.com' }),
      ROW('self', 'm5', { auto_classified: 'personal', from_email: 'me@gmail.com' }),
      ROW('license', 'm1', { workspace_id: 'ws-2', auto_classified: 'notification', from_email: 'developer@apple.example' }),
    ])
    const out = await understandableThreads(db as never, { userId: 'u-1', workspaceId: 'ws-1', threadIds: ['license', 'invite', 'promo', 'draft', 'self'], mailboxEmail: 'me@x.com' })
    expect(out.sort()).toEqual(['invite', 'license'])
    expect(await understandableThreads(db as never, { userId: 'u-1', workspaceId: 'ws-1', threadIds: [], mailboxEmail: null })).toEqual([])
  })

  it('a failed read hands over none, and never throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await understandableThreads({ from: () => { throw new Error('down') } } as never, { userId: 'u-1', workspaceId: 'ws-1', threadIds: ['a'], mailboxEmail: null })).toEqual([])
  })
})
