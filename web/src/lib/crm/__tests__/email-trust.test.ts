/**
 * email.trust (A5 slice 1): the writer that marks a thread on EVERY workspace
 * copy, and what the reply gate does with EMAIL_TRUST_ENFORCE on (mocked to
 * true here so these stay pinned if the shipped switch goes back to shadow;
 * it ships true since 2026-10-16, which the gate's own tests pin).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailMessageForAI } from '@/lib/email/email-read-service'

const mock = vi.hoisted(() => ({
  decide: vi.fn(),
  writes: [] as { table: string; values: Record<string, unknown>; filters: [string, unknown][] }[],
  updateError: null as unknown,
}))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: mock.decide }))
const inbox = vi.hoisted(() => ({ record: vi.fn(async (inputs: unknown[]) => inputs.length) }))
vi.mock('@/lib/agent-events/record', () => ({ recordAgentEvents: inbox.record }))
function fakeDb() {
  return { from: (table: string) => {
    const filters: [string, unknown][] = []
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => { filters.push([column, value]); return query },
      maybeSingle: async () => ({ data: { account_email: 'me@example.com' }, error: null }),
      update: (values: Record<string, unknown>) => { mock.writes.push({ table, values, filters }); return query },
      then: (resolve: (value: { error: unknown }) => unknown) => resolve({ error: mock.updateError }),
    }
    return query
  } }
}
vi.mock('@/lib/admin', () => ({ getServiceClient: () => fakeDb() }))
vi.mock('../email-trust', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../email-trust')>()),
  EMAIL_TRUST_ENFORCE: true,
}))

import { markThreadTrust, trustMarkFor } from '../email-trust'
import { shouldSkipAutomaticReply } from '../email-reply-gate'
import type { SupabaseClient } from '@supabase/supabase-js'

const thread = { id: 'index-id', account_id: 'account', provider_thread_id: 'thread', provider_message_id: 'm1', message_count: 1 }
const message: EmailMessageForAI = {
  messageId: 'm1', from: 'you@example.com', to: 'me@example.com', cc: '', isDraft: false,
  date: '2026-10-03', dateISO: '2026-10-03T10:00:00.000Z', subject: 'Hi', bodyText: 'Could you confirm Tuesday?',
  bodyComplete: true, hasAttachments: false, attachmentNames: [],
}
const verdict = (trust: string, replyRequired: boolean | null = true) => ({
  status: 'accepted', inferenceId: 'inf-9', value: { replyRequired, probability: replyRequired === null ? null : 0.95, trust, phishing: 0, injection: 0 },
})
const trustWrites = () => mock.writes.filter((write) => 'trust' in write.values)

beforeEach(() => {
  mock.writes.length = 0
  mock.updateError = null
  mock.decide.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('markThreadTrust', () => {
  it('writes every workspace copy of the thread: owner, account and provider thread, never a workspace filter', async () => {
    const ok = await markThreadTrust(fakeDb() as unknown as SupabaseClient, {
      userId: 'u', accountId: 'account', providerThreadId: 'thread', trust: 'suspicious', messageId: 'm1', inferenceId: 'inf-1',
    })
    expect(ok).toBe(true)
    expect(mock.writes).toEqual([{ table: 'email_thread_index',
      values: { trust: 'suspicious', trust_message_id: 'm1', trust_inference_id: 'inf-1' },
      filters: [['user_id', 'u'], ['account_id', 'account'], ['provider_thread_id', 'thread']] }])
    expect(mock.writes[0].filters.map(([column]) => column)).not.toContain('workspace_id')
  })

  it('a suspicious mark lands one email.suspicious row per workspace copy: the sender\'s address and contact, never a subject or body; injection lands none', async () => {
    inbox.record.mockClear()
    const copies = [
      { workspace_id: 'w1', from_email: 'it@evil.example', linked_contact_id: 'c-it' },
      { workspace_id: 'w2', from_email: 'it@evil.example', linked_contact_id: null },
    ]
    const db = { from: () => {
      const q: Record<string, unknown> = {}
      for (const k of ['update', 'eq', 'select']) q[k] = () => q
      q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: copies, error: null }).then(resolve)
      return q
    } }
    expect(await markThreadTrust(db as unknown as SupabaseClient, { userId: 'u', accountId: 'acc', providerThreadId: 'pt', trust: 'suspicious', messageId: 'm1', inferenceId: 'inf' })).toBe(true)
    expect(inbox.record).toHaveBeenCalledOnce()
    const [[inputs]] = inbox.record.mock.calls as unknown as [[Array<Record<string, unknown>>]]
    expect(inputs).toEqual([
      { workspaceId: 'w1', userId: 'u', kind: 'email.suspicious', priority: 1, refType: 'email_thread', refId: 'pt', facts: { from: 'it@evil.example', contactId: 'c-it' }, dedupeKey: 'email:suspicious:acc:pt:m1' },
      { workspaceId: 'w2', userId: 'u', kind: 'email.suspicious', priority: 1, refType: 'email_thread', refId: 'pt', facts: { from: 'it@evil.example' }, dedupeKey: 'email:suspicious:acc:pt:m1' },
    ])
    inbox.record.mockClear()
    await markThreadTrust(db as unknown as SupabaseClient, { userId: 'u', accountId: 'acc', providerThreadId: 'pt', trust: 'injection', messageId: 'm1', inferenceId: 'inf' })
    expect(inbox.record).not.toHaveBeenCalled()
  })

  it('never throws; reports a failed write', async () => {
    mock.updateError = new Error('nope')
    expect(await markThreadTrust(fakeDb() as unknown as SupabaseClient, {
      userId: 'u', accountId: 'a', providerThreadId: 't', trust: 'injection', messageId: null, inferenceId: null,
    })).toBe(false)
  })

  it('maps verdicts to marks: phishing is suspicious, injection is injection, the rest nothing', () => {
    expect(trustMarkFor('phishing')).toBe('suspicious')
    expect(trustMarkFor('injection')).toBe('injection')
    expect(trustMarkFor('safe')).toBeNull()
    expect(trustMarkFor('uncertain')).toBeNull()
  })
})

describe('the reply gate with email.trust enforced', () => {
  it('phishing: no draft and the thread is marked suspicious on every copy', async () => {
    mock.decide.mockResolvedValue(verdict('phishing'))
    expect(await shouldSkipAutomaticReply('u', 'w', thread, [message])).toBe(true)
    expect(mock.decide.mock.calls[0][2]).not.toHaveProperty('shadowQuestions')
    expect(trustWrites()).toEqual([expect.objectContaining({ values: { trust: 'suspicious', trust_message_id: 'm1', trust_inference_id: 'inf-9' } })])
  })

  it('injection: the thread is marked and drafting continues (the generator has no tools)', async () => {
    mock.decide.mockResolvedValue(verdict('injection'))
    expect(await shouldSkipAutomaticReply('u', 'w', thread, [message])).toBe(false)
    expect(trustWrites()).toEqual([expect.objectContaining({ values: expect.objectContaining({ trust: 'injection' }) })])
  })

  it('safe and uncertain change nothing', async () => {
    for (const trust of ['safe', 'uncertain']) {
      mock.decide.mockResolvedValue(verdict(trust))
      expect(await shouldSkipAutomaticReply('u', 'w', thread, [message])).toBe(false)
    }
    expect(trustWrites()).toEqual([])
  })

  it('a trust-only call (attachments) is enforced too', async () => {
    mock.decide.mockResolvedValue(verdict('phishing', null))
    expect(await shouldSkipAutomaticReply('u', 'w', thread, [{ ...message, hasAttachments: true }])).toBe(true)
    expect(mock.decide.mock.calls[0][1]).toMatchObject({ trustOnly: true })
    expect(mock.decide.mock.calls[0][2]).toMatchObject({ mode: 'enforce' })
    expect(trustWrites()).toHaveLength(1)
  })
})
