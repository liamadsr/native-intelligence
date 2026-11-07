/**
 * Automatic drafts (A6 review): a run nobody asked in a chat (a work run's own
 * turns, a server-started helper, an unattended loop) can't get past the
 * shared daily cap or draft a thread twice through create_email_draft.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const h = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  remaining: vi.fn(async () => 5),
  create: vi.fn(async () => ({ id: 'prov-1', threadId: 't1', message: 'ok' })),
  readThread: vi.fn(async (): Promise<unknown> => null),
}))
vi.mock('@/lib/email/email-read-service', () => ({ readEmailThread: h.readThread, readEmailMessage: vi.fn() }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => h.db }))
vi.mock('@/lib/email/arrival-drafts', () => ({ remainingAutoDrafts: h.remaining }))
vi.mock('@/lib/oauth/token-manager', () => ({ getValidToken: vi.fn(async () => ({ token: 't' })) }))
vi.mock('@/lib/integrations/email', () => ({ createEmailDraft: h.create, listEmails: vi.fn() }))
vi.mock('../_shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_shared')>()),
  resolveCreateWorkspace: async (_db: unknown, _u: string, ws: string) => ({ ok: true, workspaceId: ws, workspaceName: 'W' }),
}))

import { automaticDraftRefusal, createEmailTools } from '../email'

beforeEach(() => {
  h.db = makeFakeSupabase()
  h.remaining.mockReset().mockResolvedValue(5)
  h.create.mockClear()
  h.readThread.mockReset().mockResolvedValue(null)
  h.db.seed('email_thread_index', [{ id: 'ti-1', user_id: 'u1', provider_thread_id: 'pt-1', account_id: 'acct-1', provider: 'google' }])
  h.db.seed('connected_account', [{ id: 'acct-1', user_id: 'u1', account_email: 'me@dial8.ai' }])
})

const run = async (automatic: boolean, input: Record<string, unknown>) => {
  const tools = createEmailTools('u1', 'w1', true, 'session', automatic) as unknown as Record<string, { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }>
  return tools.create_email_draft.execute({ to: ['dana@acme.example'], subject: 'Re: x', body: 'Hi', ...input }, {})
}

describe('automaticDraftRefusal', () => {
  it('refuses a thread that already has a draft waiting for review, and a day whose cap is used up; allows otherwise', async () => {
    expect(await automaticDraftRefusal('u1', 'w1', 'pt-1')).toBeNull()
    h.db.seed('email_draft', [{ id: 'd1', email_thread_id: 'ti-1', status: 'pending_review' }])
    expect(await automaticDraftRefusal('u1', 'w1', 'pt-1')).toContain('already waiting')
    h.remaining.mockResolvedValue(0)
    expect(await automaticDraftRefusal('u1', 'w1', undefined)).toContain('limit of automatic drafts')
  })

  const liveThread = (...messages: Array<Record<string, unknown>>) => ({
    threadId: 'pt-1', subject: 'x', participantEmails: [], source: 'provider',
    messages: messages.map((m, i) => ({ messageId: `m${i}`, to: 'me@dial8.ai', cc: '', isDraft: false, date: 'd', subject: 'x', bodyText: 'b', hasAttachments: false, attachmentNames: [], ...m })),
  })

  it('refuses a draft to a no-reply address, and a thread whose newest message is automated mail (read live)', async () => {
    expect(await automaticDraftRefusal('u1', 'w1', undefined, undefined, ['gustonoreply@gusto.com'])).toContain('automated')
    expect(await automaticDraftRefusal('u1', 'w1', undefined, undefined, ['dana@acme.example', 'no-reply@x.com'])).toContain('automated')
    h.readThread.mockResolvedValue(liveThread({ from: 'Dana <dana@acme.example>', automatedBy: 'auto_submitted' }))
    expect(await automaticDraftRefusal('u1', 'w1', 'pt-1', undefined, ['dana@acme.example'])).toContain('automated')
    expect(h.readThread).toHaveBeenCalledWith('u1', 'pt-1', 'w1', { accountId: 'acct-1', provider: 'google' })
    h.readThread.mockResolvedValue(liveThread({ from: 'notifications@github.com' }))
    expect(await automaticDraftRefusal('u1', 'w1', 'pt-1', undefined, ['dana@acme.example'])).toContain('automated')
  })

  it('allows a person, and a notification address the person has written to in the thread', async () => {
    h.readThread.mockResolvedValue(liveThread({ from: 'Dana <dana@acme.example>' }))
    expect(await automaticDraftRefusal('u1', 'w1', 'pt-1', undefined, ['dana@acme.example'])).toBeNull()
    const address = 'reply+0f06a1b2c3d4e5f60718293a4b5c6d7e@reply.github.com'
    h.readThread.mockResolvedValue(liveThread({ from: address }, { from: 'Me <me@dial8.ai>', to: address }, { from: address }))
    expect(await automaticDraftRefusal('u1', 'w1', 'pt-1', undefined, [address])).toBeNull()
  })

  describe("the reply gate's hard pre-filter (GEN-1164)", () => {
    // The thread's only index row (seed appends: start from an empty fake).
    const index = (more: Record<string, unknown>) => {
      h.db = makeFakeSupabase()
      h.db.seed('email_thread_index', [{ id: 'ti-1', user_id: 'u1', workspace_id: 'w1', provider_thread_id: 'pt-1', account_id: 'acct-1', provider: 'google', ...more }])
    }

    it("refuses a draft to one of the person's own addresses", async () => {
      h.db.seed('connected_account', [{ id: 'acct-1', user_id: 'u1', account_email: 'me@dial8.ai', capability: 'email' }, { id: 'acct-2', user_id: 'u1', account_email: 'Me@Gmail.com', capability: 'email' }])
      expect(await automaticDraftRefusal('u1', 'w1', undefined, undefined, ['Liam <me@gmail.com>'])).toContain("person's own address")
      expect(await automaticDraftRefusal('u1', 'w1', undefined, undefined, ['dana@acme.example'])).toBeNull()
    })

    it("refuses a thread the reply check found owes no reply; the person's own newest message (a follow-up they owe) is fine", async () => {
      index({ from_email: 'dana@acme.example', needs_reply: false })
      h.db.seed('connected_account', [{ id: 'acct-1', user_id: 'u1', account_email: 'me@dial8.ai', capability: 'email' }])
      expect(await automaticDraftRefusal('u1', 'w1', 'pt-1', undefined, ['dana@acme.example'])).toContain('no reply owed')
      index({ from_email: 'me@dial8.ai', needs_reply: false, label_ids: ['CATEGORY_UPDATES'] })
      h.db.seed('connected_account', [{ id: 'acct-1', user_id: 'u1', account_email: 'me@dial8.ai', capability: 'email' }])
      expect(await automaticDraftRefusal('u1', 'w1', 'pt-1', undefined, ['dana@acme.example'])).toBeNull()
    })

    it("a waiting draft on the thread counts even when no index row names it", async () => {
      index({ from_email: 'dana@acme.example' })
      h.db.seed('email_draft', [{ id: 'd9', user_id: 'u1', provider_thread_id: 'pt-1', email_thread_id: null, status: 'pending_review' }])
      expect(await automaticDraftRefusal('u1', 'w1', 'pt-1', undefined, ['dana@acme.example'])).toContain('already waiting')
    })

    it("refuses Gmail's Promotions and Forums, and Updates from someone the person doesn't know", async () => {
      h.readThread.mockResolvedValue(null)
      index({ from_email: 'dana@acme.example', label_ids: ['INBOX', 'CATEGORY_PROMOTIONS'] })
      expect(await automaticDraftRefusal('u1', 'w1', 'pt-1', undefined, ['dana@acme.example'])).toContain('automated')
      index({ from_email: 'dana@acme.example', label_ids: ['INBOX', 'CATEGORY_UPDATES'] })
      h.db.seed('connected_account', [{ id: 'acct-1', user_id: 'u1', account_email: 'me@dial8.ai', capability: 'email' }])
      expect(await automaticDraftRefusal('u1', 'w1', 'pt-1', undefined, ['dana@acme.example'])).toContain('automated')
      // A contact of theirs in Updates is someone they know.
      h.db.seed('contact', [{ id: 'c1', workspace_id: 'w1', email: 'dana@acme.example', merged_into_contact_id: null }])
      expect(await automaticDraftRefusal('u1', 'w1', 'pt-1', undefined, ['dana@acme.example'])).toBeNull()
    })

    it('refuses calendar mail and a transactional sender, read live', async () => {
      h.readThread.mockResolvedValue(liveThread({ from: 'Jessae <jessae@example.com>', subject: 'Invitation: Coffee @ Thu Oct 16, 2026', attachmentNames: ['invite.ics'] }))
      expect(await automaticDraftRefusal('u1', 'w1', 'pt-1', undefined, ['jessae@example.com'])).toContain('automated')
      h.readThread.mockResolvedValue(liveThread({ from: 'Stripe <invoice+statements@stripe.com>', replyTo: 'hello@shiraz.example' }))
      expect(await automaticDraftRefusal('u1', 'w1', 'pt-1', undefined, ['hello@shiraz.example'])).toContain('automated')
    })
  })

  it('a check that fails refuses (the cap is a spend guard)', async () => {
    h.remaining.mockRejectedValue(new Error('down'))
    expect(await automaticDraftRefusal('u1', 'w1', undefined)).toContain('Could not check')
  })
})

describe('create_email_draft', () => {
  it('an automatic run is refused past the cap or on a thread with a waiting draft; nothing is written to the mailbox', async () => {
    h.remaining.mockResolvedValue(0)
    expect(await run(true, { thread_id: 'pt-9' })).toMatchObject({ success: false, code: 'AUTOMATIC_DRAFT_REFUSED' })
    h.remaining.mockResolvedValue(3)
    h.db.seed('email_draft', [{ id: 'd1', email_thread_id: 'ti-1', status: 'edited' }])
    expect(await run(true, { thread_id: 'pt-1' })).toMatchObject({ success: false, code: 'AUTOMATIC_DRAFT_REFUSED' })
    expect(h.create).not.toHaveBeenCalled()
  })

  it('an automatic run is refused a reply to a no-reply sender; nothing is written to the mailbox', async () => {
    expect(await run(true, { to: ['gustonoreply@gusto.com'], thread_id: 'pt-1' })).toMatchObject({ success: false, code: 'AUTOMATIC_DRAFT_REFUSED' })
    expect(h.create).not.toHaveBeenCalled()
  })

  it('an automatic body that talks about the task is refused before anything is written; a chat draft is the person\'s words', async () => {
    const body = "Here's the email body:\n\nHi Dana, Tuesday works."
    const result = await run(true, { thread_id: 'pt-1', body })
    expect(result).toMatchObject({ success: false, code: 'DRAFT_BODY_REFUSED' })
    expect(result.error).toContain('Pass only the text of the email')
    expect(h.create).not.toHaveBeenCalled()
    expect(await run(false, { thread_id: 'pt-1', body })).toMatchObject({ success: true })
  })

  it('the person in a chat is never held to the automatic cap', async () => {
    h.remaining.mockResolvedValue(0)
    expect(await run(false, { thread_id: 'pt-1' })).toMatchObject({ success: true })
    expect(h.remaining).not.toHaveBeenCalled()
  })
})
