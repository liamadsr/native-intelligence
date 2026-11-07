/**
 * Star, archive, trash, mark read and a reply draft act at the provider in
 * the THREAD's own mailbox (the index row's account, resolved as the live
 * read does: mailboxesForThread), never the person's first token. With two
 * Gmail mailboxes, a thread in the second one was modified in the first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

let fake: FakeSupabase
vi.mock('@/lib/admin', () => ({ getServiceClient: () => fake }))
const { firstToken } = vi.hoisted(() => ({ firstToken: vi.fn(async () => ({ token: 'tok-first', email: 'me@gmail.com' })) }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: firstToken,
  getAllValidTokens: vi.fn(async () => []),
  getValidTokenForAccount: vi.fn(async (accountId: string) => ({ token: `tok-${accountId}`, email: `${accountId}@x.com`, accountId })),
}))

import { archiveThread, saveDraftToProvider, toggleThreadRead, toggleThreadStar, trashThread } from '@/lib/crm/email-client'

const ME = 'user-1'
let calls: Array<{ url: string; auth: string }>

beforeEach(() => {
  fake = makeFakeSupabase()
  fake.seed('connected_account', [
    { id: 'acct-personal', user_id: ME, capability: 'email', is_enabled: true, provider: 'google', account_email: 'me@gmail.com', created_at: '1' },
    { id: 'acct-work', user_id: ME, capability: 'email', is_enabled: true, provider: 'google', account_email: 'me@work.com', created_at: '2' },
  ])
  fake.seed('email_thread_index', [
    { id: 'idx-p', user_id: ME, workspace_id: 'ws-1', account_id: 'acct-personal', provider: 'google', provider_thread_id: 'thr-personal', is_starred: false, is_unread: true, folder: 'inbox' },
    { id: 'idx-w', user_id: ME, workspace_id: 'ws-1', account_id: 'acct-work', provider: 'google', provider_thread_id: 'thr-work', is_starred: false, is_unread: true, folder: 'inbox' },
  ])
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '') })
    return { ok: true, status: 200, json: async () => ({ id: 'draft-1' }) } as unknown as Response
  }))
})
afterEach(() => vi.unstubAllGlobals())

const row = (id: string) => fake.rows('email_thread_index').find((r) => r.id === id)!

describe('thread actions use the thread’s own mailbox', () => {
  it('star, mark read, archive and trash a thread in the second mailbox with its token', async () => {
    await toggleThreadStar(ME, 'thr-work', true)
    await toggleThreadRead(ME, 'thr-work', true)
    await archiveThread(ME, 'thr-work')
    await trashThread(ME, 'thr-work')
    expect(calls.map((c) => c.auth)).toEqual(Array(4).fill('Bearer tok-acct-work'))
    expect(calls.every((c) => c.url.includes('/threads/thr-work/'))).toBe(true)
    expect(firstToken).not.toHaveBeenCalled()
    expect(row('idx-w')).toMatchObject({ is_starred: true, is_unread: false, folder: 'trash' })
    // The other mailbox's thread is untouched.
    expect(row('idx-p')).toMatchObject({ is_starred: false, is_unread: true, folder: 'inbox' })
  })

  it('a thread in the first mailbox uses that one', async () => {
    await toggleThreadStar(ME, 'thr-personal', true)
    expect(calls.map((c) => c.auth)).toEqual(['Bearer tok-acct-personal'])
  })

  it('a reply draft is saved in its thread’s mailbox', async () => {
    await saveDraftToProvider(ME, { thread_id: 'thr-work', to: ['bo@acme.com'], subject: 'Re: hi', body_html: '<p>hi</p>' })
    expect(calls).toEqual([{ url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts', auth: 'Bearer tok-acct-work' }])
  })

  it('a new draft is saved in the picked From mailbox, not the first one', async () => {
    firstToken.mockClear()
    await saveDraftToProvider(ME, { to: ['bo@acme.com'], subject: 'Hi', body_html: '<p>hi</p>', account_id: 'acct-work' })
    expect(calls).toEqual([{ url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts', auth: 'Bearer tok-acct-work' }])
    expect(firstToken).not.toHaveBeenCalled()
  })

  it('refuses a picked account that is not the person’s own', async () => {
    fake.seed('connected_account', [
      { id: 'acct-theirs', user_id: 'user-2', capability: 'email', is_enabled: true, provider: 'google', account_email: 'them@x.com', created_at: '4' },
    ])
    await expect(
      saveDraftToProvider(ME, { to: ['bo@acme.com'], subject: 'Hi', body_html: '<p>hi</p>', account_id: 'acct-theirs' }),
    ).rejects.toThrow(/unavailable/)
    expect(calls).toEqual([])
  })
})

describe('thread actions only record what the mailbox did', () => {
  it('a Gmail refusal throws and leaves the index row as it was', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response))
    await expect(trashThread(ME, 'thr-work')).rejects.toThrow(/403/)
    await expect(archiveThread(ME, 'thr-work')).rejects.toThrow(/403/)
    await expect(toggleThreadRead(ME, 'thr-work', true)).rejects.toThrow(/403/)
    await expect(toggleThreadStar(ME, 'thr-work', true)).rejects.toThrow(/403/)
    expect(row('idx-w')).toMatchObject({ is_starred: false, is_unread: true, folder: 'inbox' })
  })

  it('an Outlook archive moves each message of the conversation at Graph, then records it', async () => {
    fake.seed('connected_account', [
      { id: 'acct-ms', user_id: ME, capability: 'email', is_enabled: true, provider: 'microsoft', account_email: 'me@corp.com', created_at: '3' },
    ])
    fake.seed('email_thread_index', [
      { id: 'idx-ms', user_id: ME, workspace_id: 'ws-1', account_id: 'acct-ms', provider: 'microsoft', provider_thread_id: 'conv-1', is_starred: false, is_unread: true, folder: 'inbox' },
    ])
    const seen: Array<{ url: string; method: string; body?: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined })
      return {
        ok: true,
        status: 200,
        json: async () => ({ value: [{ id: 'msg-1' }, { id: 'msg-2' }] }),
      } as unknown as Response
    }))

    await archiveThread(ME, 'conv-1')

    const moves = seen.filter((c) => c.method === 'POST')
    expect(moves.map((c) => c.url)).toEqual([
      'https://graph.microsoft.com/v1.0/me/messages/msg-1/move',
      'https://graph.microsoft.com/v1.0/me/messages/msg-2/move',
    ])
    expect(JSON.parse(moves[0].body!)).toEqual({ destinationId: 'archive' })
    // Only the inbox copies move (Gmail's archive leaves Sent alone too).
    const lists = seen.filter((c) => c.method === 'GET')
    expect(lists).toHaveLength(1)
    expect(lists[0].url.startsWith('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?')).toBe(true)
    expect(row('idx-ms')).toMatchObject({ folder: 'archive' })
  })
})

describe('an Outlook archive keeps the index on the newest message’s new id', () => {
  // A Graph move gives each message a new id (the move's response carries it).
  // Left on the old id, the next push's re-index would read the new one as new
  // mail (src/lib/email/triage.ts compares provider_message_id before and after).
  function graph(inbox: string[], opts: { moveBody?: (id: string) => unknown } = {}) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const move = /\/me\/messages\/([^/]+)\/move$/.exec(url)
      const body = move ? (opts.moveBody ?? ((id: string) => ({ id: `${id}-archived` })))(decodeURIComponent(move[1])) : { value: inbox.map((id) => ({ id })) }
      return { ok: true, status: init?.method === 'POST' ? 201 : 200, json: async () => body } as unknown as Response
    }))
  }

  beforeEach(() => {
    fake.seed('connected_account', [
      { id: 'acct-ms', user_id: ME, capability: 'email', is_enabled: true, provider: 'microsoft', account_email: 'me@corp.com', created_at: '3' },
    ])
    fake.seed('email_thread_index', [
      // The thread's copy in two linked workspaces: one mailbox, the same newest message.
      { id: 'idx-ms', user_id: ME, workspace_id: 'ws-1', account_id: 'acct-ms', provider: 'microsoft', provider_thread_id: 'conv-1', provider_message_id: 'msg-2', folder: 'inbox' },
      { id: 'idx-ms-2', user_id: ME, workspace_id: 'ws-2', account_id: 'acct-ms', provider: 'microsoft', provider_thread_id: 'conv-1', provider_message_id: 'msg-2', folder: 'inbox' },
      // Someone else's row with the same ids: untouched.
      { id: 'idx-other', user_id: 'user-2', workspace_id: 'ws-1', account_id: 'acct-theirs', provider: 'microsoft', provider_thread_id: 'conv-1', provider_message_id: 'msg-2', folder: 'inbox' },
    ])
  })

  it('follows the newest message to its new id, in every copy of the thread in that mailbox', async () => {
    graph(['msg-1', 'msg-2'])
    await archiveThread(ME, 'conv-1')
    expect(row('idx-ms')).toMatchObject({ folder: 'archive', provider_message_id: 'msg-2-archived' })
    expect(row('idx-ms-2')).toMatchObject({ folder: 'archive', provider_message_id: 'msg-2-archived' })
    expect(row('idx-other')).toMatchObject({ folder: 'inbox', provider_message_id: 'msg-2' })
  })

  it('a newest message that did not move (a reply in Sent Items) keeps its id', async () => {
    fake.rows('email_thread_index').find((r) => r.id === 'idx-ms')!.provider_message_id = 'msg-sent'
    graph(['msg-1', 'msg-2'])
    await archiveThread(ME, 'conv-1')
    expect(row('idx-ms')).toMatchObject({ folder: 'archive', provider_message_id: 'msg-sent' })
    expect(row('idx-ms-2')).toMatchObject({ provider_message_id: 'msg-2-archived' })
  })

  it('a move whose response names no new id leaves the id as it was, and the archive still lands', async () => {
    graph(['msg-1', 'msg-2'], { moveBody: () => ({}) })
    await archiveThread(ME, 'conv-1')
    expect(row('idx-ms')).toMatchObject({ folder: 'archive', provider_message_id: 'msg-2' })
  })

  it('a move refused partway still follows what moved, and records no archive', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const move = /\/me\/messages\/([^/]+)\/move$/.exec(url)
      if (move && move[1] === 'msg-1') return { ok: false, status: 503, json: async () => ({}) } as unknown as Response
      const body = move ? { id: `${move[1]}-archived` } : { value: [{ id: 'msg-2' }, { id: 'msg-1' }] }
      return { ok: true, status: move ? 201 : 200, json: async () => body } as unknown as Response
    }))
    await expect(archiveThread(ME, 'conv-1')).rejects.toThrow(/503/)
    expect(row('idx-ms')).toMatchObject({ folder: 'inbox', provider_message_id: 'msg-2-archived' })
  })

  it('reads every page of the conversation before moving anything (a move shifts the folder’s pages)', async () => {
    const order: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const move = /\/me\/messages\/([^/]+)\/move$/.exec(url)
      if (move) {
        order.push(`move ${move[1]}`)
        return { ok: true, status: 201, json: async () => ({ id: `${move[1]}-archived` }) } as unknown as Response
      }
      const page2 = url.includes('page=2')
      order.push(page2 ? 'list 2' : 'list 1')
      const body = page2 ? { value: [{ id: 'msg-1' }] } : { value: [{ id: 'msg-2' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?page=2' }
      return { ok: true, status: 200, json: async () => body } as unknown as Response
    }))
    await archiveThread(ME, 'conv-1')
    expect(order).toEqual(['list 1', 'list 2', 'move msg-2', 'move msg-1'])
  })

  it('a legacy mailbox (no account) follows its own rows only', async () => {
    fake.seed('email_thread_index', [
      { id: 'idx-legacy', user_id: ME, workspace_id: 'ws-1', account_id: null, provider: 'microsoft', provider_thread_id: 'conv-9', provider_message_id: 'msg-2', folder: 'inbox' },
    ])
    firstToken.mockResolvedValueOnce({ token: 'tok-legacy', email: 'me@corp.com' })
    graph(['msg-1', 'msg-2'])
    await archiveThread(ME, 'conv-9')
    expect(row('idx-legacy')).toMatchObject({ folder: 'archive', provider_message_id: 'msg-2-archived' })
    // The account mailbox's rows for another thread are untouched.
    expect(row('idx-ms')).toMatchObject({ provider_message_id: 'msg-2' })
  })

  it('trash needs no following: the indexer leaves Deleted Items out, so the thread reads as gone', async () => {
    graph(['msg-1', 'msg-2'], { moveBody: (id) => ({ id: `${id}-deleted` }) })
    await trashThread(ME, 'conv-1')
    expect(row('idx-ms')).toMatchObject({ folder: 'trash', provider_message_id: 'msg-2' })
  })
})
