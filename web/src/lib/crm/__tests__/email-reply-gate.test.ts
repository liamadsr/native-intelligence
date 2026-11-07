import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailMessageForAI } from '@/lib/email/email-read-service'

const mock = vi.hoisted(() => ({
  decide: vi.fn(), account: { account_email: 'me@example.com' } as object | null,
  accountError: null as unknown, persistError: null as unknown, dbThrows: false,
  tables: [] as string[], writes: [] as { table: string; values: Record<string, unknown>; filters: [string, unknown][] }[],
  known: new Set<string>(),
}))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: mock.decide }))
vi.mock('@/lib/agent-events/known-senders', () => ({
  knownSenders: async (_db: unknown, args: { addresses: Iterable<string | null | undefined> }) =>
    new Set([...args.addresses].filter((a): a is string => !!a && mock.known.has(a))),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => {
  if (mock.dbThrows) throw new Error('database unavailable')
  return { from: (table: string) => {
    mock.tables.push(table)
    const filters: [string, unknown][] = []
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => { filters.push([column, value]); return query },
      maybeSingle: async () => ({ data: mock.account, error: mock.accountError }),
      update: (values: Record<string, unknown>) => { mock.writes.push({ table, values, filters }); return query },
      then: (resolve: (value: { error: unknown }) => unknown) => resolve({ error: mock.persistError }),
    }
    return query
  } }
} }))
import { automaticReplyVerdict, shouldSkipAutomaticReply } from '../email-reply-gate'

const thread = { id: 'index-id', account_id: 'account', provider_thread_id: 'thread', provider_message_id: 'm1',
  message_count: 1, from_email: 'you@example.com' }
const message: EmailMessageForAI = {
  messageId: 'm1', from: 'you@example.com', to: 'me@example.com', cc: '', isDraft: false,
  date: '2026-10-03', dateISO: '2026-10-03T10:00:00.000Z', subject: 'FYI', bodyText: 'No action needed.',
  bodyComplete: true, hasAttachments: false, attachmentNames: [],
}
/** Calls that asked the reply question (not email.trust's trust-only call). */
const replyCalls = () => mock.decide.mock.calls.filter(call => call[1]?.trustOnly !== true)
const trustOnlyCalls = () => mock.decide.mock.calls.filter(call => call[1]?.trustOnly === true)
const gate = (changes: Partial<EmailMessageForAI> = {}) => shouldSkipAutomaticReply('u', 'w', thread, [{ ...message, ...changes }])
const verdict = Object.assign((changes: Partial<EmailMessageForAI> = {}) => automaticReplyVerdict('u', 'w', thread, [{ ...message, ...changes }]), {
  explicit: (changes: Partial<EmailMessageForAI> = {}) => automaticReplyVerdict('u', 'w', thread, [{ ...message, ...changes }], { explicit: true }),
})

beforeEach(() => {
  mock.account = { account_email: 'me@example.com' }
  mock.accountError = null; mock.persistError = null; mock.dbThrows = false
  mock.tables.length = 0; mock.writes.length = 0; mock.known = new Set()
  mock.decide.mockReset().mockResolvedValue({ status: 'accepted', value: { replyRequired: false } })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('built-in email reply gate', () => {
  it.each(['off', 'shadow', 'enforce'])('enforces accepted no-reply even with obsolete environment mode %s', async mode => {
    vi.stubEnv('JEV_EMAIL_REPLY_MODE', mode)
    expect(await gate()).toBe(true)
    expect(mock.decide).toHaveBeenCalledTimes(1)
    expect(mock.decide.mock.calls[0][2]).toMatchObject({ mode: 'enforce' })
    expect(mock.writes).toHaveLength(1)
  })

  it('persists an accepted no only against the exact user, workspace, account, thread and revision', async () => {
    expect(await gate()).toBe(true)
    expect(mock.writes).toEqual([{ table: 'email_thread_index', values: { needs_reply: false }, filters: [
      ['user_id', 'u'], ['workspace_id', 'w'], ['account_id', 'account'],
      ['provider_thread_id', 'thread'], ['provider_message_id', 'm1'],
    ] }])
  })

  it('a confident yes drafts, nothing persisted', async () => {
    mock.decide.mockResolvedValue({ status: 'accepted', value: { replyRequired: true } })
    expect(await verdict()).toBe('draft')
    expect(mock.writes).toEqual([])
  })

  it.each([
    { status: 'accepted', value: { replyRequired: null, trust: 'safe' } },
    { status: 'escalate', reason: 'uncertain' },
    { status: 'escalate', reason: 'unavailable' },
    { status: 'escalate', reason: 'accounting_unavailable' },
    { status: 'cancelled', reason: 'caller_cancelled' },
  ])('unsure or undecided ($status $reason): the person is asked, no draft guessed, nothing persisted (E3, decision 1)', async result => {
    mock.decide.mockResolvedValue(result)
    expect(await verdict()).toBe('ask')
    expect(await gate()).toBe(true)
    expect(mock.writes).toEqual([])
  })

  it('a model failure asks (E3); an account lookup failure still drafts, before any model call', async () => {
    mock.decide.mockRejectedValue(new Error('provider outage'))
    expect(await verdict()).toBe('ask')
    expect(mock.writes).toEqual([])
    mock.decide.mockClear()
    mock.accountError = new Error('account lookup unavailable')
    expect(await gate()).toBe(false)
    mock.accountError = null; mock.account = null
    expect(await gate()).toBe(false)
    mock.account = { account_email: 'not a mailbox' }
    expect(await gate()).toBe(false)
    expect(mock.decide).not.toHaveBeenCalled()
    expect(mock.writes).toEqual([])
  })

  it.each(['noreply@example.com', 'No Reply <no-reply@example.com>', 'do_not_reply@example.com', 'mailer-daemon@example.com'])('blocks %s before the model', async from => {
    expect(await gate({ from })).toBe(true)
    expect(mock.decide).not.toHaveBeenCalled()
    expect(mock.tables).not.toContain('connected_account')
  })

  describe('automated mail (src/lib/email/automated-sender.ts), before any model call', () => {
    const category = () => mock.writes.map(w => w.values.auto_classified)

    it.each([
      [{ from: 'Gusto <gustonoreply@gusto.com>' }, 'notification'],
      [{ from: 'noreply+abc@example.com' }, 'notification'],
      [{ from: 'Jane <jane@example.com>', automatedBy: 'auto_submitted' as const }, 'notification'],
      [{ from: 'Jane <jane@example.com>', automatedBy: 'mailing_list' as const }, 'newsletter'],
      [{ from: 'notifications@github.com' }, 'notification'],
      [{ from: 'reply+0f06a1b2c3d4e5f60718293a4b5c6d7e@reply.github.com' }, 'notification'],
    ])('skips %j and records the revision as needing no reply (%s)', async (changes, expected) => {
      expect(await gate(changes)).toBe(true)
      expect(mock.decide).not.toHaveBeenCalled()
      expect(mock.writes).toHaveLength(1)
      expect(mock.writes[0].values).toMatchObject({ needs_reply: false })
      expect(category()).toEqual([expected])
    })

    it('an unverified Reply-To still yields to an automated header', async () => {
      expect(await gate({ from: 'jane@example.com', replyToKnown: false, automatedBy: 'precedence' })).toBe(true)
      expect(mock.decide).not.toHaveBeenCalled()
    })

    it('a notification address the person has answered in the thread goes on to the reply decision', async () => {
      const address = 'reply+0f06a1b2c3d4e5f60718293a4b5c6d7e@reply.github.com'
      const messages = [
        { ...message, messageId: 'm0', from: address },
        { ...message, messageId: 'mine', from: 'Me <me@example.com>', to: address },
        { ...message, from: address },
      ]
      mock.decide.mockResolvedValue({ status: 'accepted', value: { replyRequired: true } })
      expect(await shouldSkipAutomaticReply('u', 'w', { ...thread, message_count: 3 }, messages)).toBe(false)
      expect(replyCalls()).toHaveLength(1)
      expect(mock.tables).toContain('connected_account')
    })

    it('a person whose address merely contains "reply" goes on to the reply decision', async () => {
      mock.decide.mockResolvedValue({ status: 'accepted', value: { replyRequired: true } })
      expect(await gate({ from: 'Sam <replyhq-founder@replyhq.com>' })).toBe(false)
      expect(replyCalls()).toHaveLength(1)
    })

    it('an explicit request is held only by the no-reply address rule', async () => {
      mock.decide.mockResolvedValue({ status: 'accepted', value: { replyRequired: true } })
      const explicit = (changes: Partial<EmailMessageForAI>) =>
        shouldSkipAutomaticReply('u', 'w', thread, [{ ...message, ...changes }], { explicit: true })
      expect(await explicit({ from: 'notifications@github.com' })).toBe(false)
      expect(await explicit({ from: 'jane@example.com', automatedBy: 'mailing_list' })).toBe(false)
      expect(await explicit({ from: 'gustonoreply@gusto.com' })).toBe(true)
      expect(mock.decide).not.toHaveBeenCalled()
    })

    it('a thread with no indexed revision is skipped without persisting anything', async () => {
      expect(await shouldSkipAutomaticReply('u', 'w', { ...thread, provider_message_id: null },
        [{ ...message, from: 'noreply@example.com' }])).toBe(true)
      expect(mock.writes).toEqual([])
    })
  })

  it('does not mistake a display name for a no-reply address and honors human Reply-To', async () => {
    mock.decide.mockResolvedValue({ status: 'accepted', value: { replyRequired: true } })
    expect(await gate({ from: 'No Reply Robot <alex@example.com>' })).toBe(false)
    expect(await gate({ from: 'no-reply@forms.example.com', replyTo: 'Alex <alex@example.com>', bodyText: 'Can you send me a quote?' })).toBe(false)
    expect(mock.decide).toHaveBeenCalledTimes(2)
    expect(mock.writes).toEqual([])
  })

  it.each(['broken header', 'person@example..com', 'no-reply@example.com\r\nBcc: attacker@example.com'])('preserves drafting for a malformed nonempty Reply-To: %s', async replyTo => {
    expect(await gate({ from: 'no-reply@example.com', replyTo })).toBe(false)
    expect(mock.decide).not.toHaveBeenCalled()
    expect(mock.tables).toEqual([])
    expect(mock.writes).toEqual([])
  })

  it.each(['no-reply@example.com', 'human@example.com'])('does not classify %s when provider Reply-To evidence is unknown', async from => {
    expect(await gate({ from, replyToKnown: false })).toBe(false)
    expect(mock.decide).not.toHaveBeenCalled()
    expect(mock.tables).toEqual([])
    expect(mock.writes).toEqual([])
  })

  it('keeps known absent Reply-To eligible for deterministic no-reply detection', async () => {
    expect(await gate({ from: 'no-reply@example.com', replyToKnown: true })).toBe(true)
    expect(mock.decide).not.toHaveBeenCalled()
    expect(mock.writes).toHaveLength(1)
  })

  it.each([{ replyToKnown: false }, { replyTo: 'malformed destination' }])('does not suppress a conversation with incomplete earlier Reply-To evidence (nothing remembered); the person is asked (E3): %j', async changes => {
    const messages = [{ ...message, messageId: 'old', ...changes }, message]
    expect(await automaticReplyVerdict('u', 'w', { ...thread, message_count: 2 }, messages)).toBe('ask')
    expect(replyCalls()).toHaveLength(0)
    expect(mock.writes).toEqual([])
  })

  it.each([
    { hasAttachments: true }, { bodyText: '' }, { bodyComplete: false },
  ])('still blocks a no-reply destination with incomplete semantic evidence: %j', async changes => {
    expect(await gate({ ...changes, from: 'no-reply@example.com' })).toBe(true)
    expect(mock.decide).not.toHaveBeenCalled()
  })

  it('still blocks no-reply destinations for explicit requests and during a database outage', async () => {
    mock.dbThrows = true
    expect(await shouldSkipAutomaticReply('u', 'w', thread, [{ ...message, from: 'no-reply@example.com' }], { explicit: true, complete: false })).toBe(true)
    expect(mock.decide).not.toHaveBeenCalled()
  })

  it.each([undefined, [], [{ ...message, isDraft: true }]])('does not classify index-only no-reply evidence without a read non-draft message: %j', async messages => {
    expect(await shouldSkipAutomaticReply('u', 'w', { ...thread, from_email: 'no-reply@example.com' }, messages)).toBe(false)
    expect(mock.decide).not.toHaveBeenCalled()
    expect(mock.tables).toEqual([])
    expect(mock.writes).toEqual([])
  })

  it('lets a newer human request override an old no-reply sender', async () => {
    mock.decide.mockResolvedValue({ status: 'accepted', value: { replyRequired: true } })
    const messages = [{ ...message, messageId: 'old', from: 'no-reply@example.com' }, { ...message, bodyText: 'Could you confirm the appointment?' }]
    expect(await shouldSkipAutomaticReply('u', 'w', { ...thread, message_count: 2, from_email: 'no-reply@example.com' }, messages)).toBe(false)
    expect(mock.decide).toHaveBeenCalledTimes(1)
    expect(mock.writes).toEqual([])
  })

  it('classifies latest-owner messages instead of suppressing promised follow-ups by direction alone', async () => {
    expect(await gate({ from: 'Me <me@example.com>', to: 'you@example.com', bodyText: 'Confirmed for Tuesday.' })).toBe(true)
    expect(mock.decide).toHaveBeenCalledTimes(1)
    mock.decide.mockResolvedValue({ status: 'accepted', value: { replyRequired: true } })
    mock.writes.length = 0
    expect(await gate({ from: 'Me <me@example.com>', to: 'you@example.com', bodyText: 'I will send the updated estimate in a follow-up shortly.' })).toBe(false)
    expect(mock.decide).toHaveBeenCalledTimes(2)
    expect(mock.writes).toEqual([])
  })

  describe("Gmail's categories (GEN-1164), before the model", () => {
    const labelled = (label_ids: string[], changes: Partial<EmailMessageForAI> = {}) =>
      automaticReplyVerdict('u', 'w', { ...thread, label_ids }, [{ ...message, ...changes }])
    beforeEach(() => mock.decide.mockResolvedValue({ status: 'accepted', value: { replyRequired: true } }))

    it.each(['CATEGORY_PROMOTIONS', 'CATEGORY_FORUMS'])('%s is bulk mail: no draft, remembered as a newsletter', async (label) => {
      expect(await labelled(['INBOX', label])).toBe('no_reply')
      expect(mock.decide).not.toHaveBeenCalled()
      expect(mock.writes.map(w => w.values)).toEqual([{ needs_reply: false, auto_classified: 'newsletter' }])
    })

    it('Updates from someone the person does not know: no draft, remembered as a notification', async () => {
      expect(await labelled(['INBOX', 'CATEGORY_UPDATES'])).toBe('no_reply')
      expect(mock.decide).not.toHaveBeenCalled()
      expect(mock.writes.map(w => w.values)).toEqual([{ needs_reply: false, auto_classified: 'notification' }])
    })

    it('Updates from someone they know, or where they have written in the thread, goes to Jev as usual', async () => {
      mock.known.add('you@example.com')
      expect(await labelled(['INBOX', 'CATEGORY_UPDATES'])).toBe('draft')
      expect(mock.decide.mock.calls[0][1]).toMatchObject({ knownSender: true })
      mock.known.clear(); mock.decide.mockClear()
      const conversation = [{ ...message, messageId: 'm0', from: 'Me <me@example.com>', to: 'you@example.com' }, message]
      expect(await automaticReplyVerdict('u', 'w', { ...thread, message_count: 2, label_ids: ['CATEGORY_UPDATES'] }, conversation)).toBe('draft')
      expect(mock.decide.mock.calls[0][1]).toMatchObject({ knownSender: false })
    })

    it('Updates relaying a human (a form lead): Jev decides, and only its confident yes drafts', async () => {
      const lead = { from: 'Forms <no-reply@forms.example.com>', replyTo: 'Alex <alex@prospect.example>', bodyText: 'Can you send me a quote for 20 seats?' }
      expect(await labelled(['INBOX', 'CATEGORY_UPDATES'], lead)).toBe('draft')
      expect(mock.decide).toHaveBeenCalledTimes(1)
      mock.decide.mockResolvedValue({ status: 'accepted', value: { replyRequired: null, trust: 'safe' } })
      expect(await labelled(['INBOX', 'CATEGORY_UPDATES'], lead)).toBe('no_reply')
    })

    it("Promotions where the person has written (a rep's 1:1 reply) goes to Jev", async () => {
      const conversation = [{ ...message, messageId: 'm0', from: 'Me <me@example.com>', to: 'you@example.com' }, message]
      expect(await automaticReplyVerdict('u', 'w', { ...thread, message_count: 2, label_ids: ['CATEGORY_PROMOTIONS'] }, conversation)).toBe('draft')
      expect(mock.decide).toHaveBeenCalledTimes(1)
    })

    it('an explicit request is the person\'s own choice', async () => {
      expect(await automaticReplyVerdict('u', 'w', { ...thread, label_ids: ['CATEGORY_PROMOTIONS'] }, [message], { explicit: true })).toBe('draft')
    })
  })

  it('a notification sender with a human Reply-To (a ticket comment) is drafted only on a confident yes (GEN-1164)', async () => {
    const ticket = { from: 'Tickets <notifications@tickets.example>', replyTo: 'Jamie <jamie@example.com>' }
    mock.decide.mockResolvedValue({ status: 'accepted', value: { replyRequired: null, trust: 'safe' } })
    expect(await verdict(ticket)).toBe('no_reply')
    mock.decide.mockResolvedValue({ status: 'accepted', value: { replyRequired: true, trust: 'safe' } })
    expect(await verdict(ticket)).toBe('draft')
  })

  it('mail the person sent themselves is never drafted, before the model (GEN-1164: "Test" to their own address)', async () => {
    mock.decide.mockResolvedValue({ status: 'accepted', value: { replyRequired: true } })
    expect(await verdict({ from: 'Me <me@example.com>', to: 'me@example.com', subject: 'Test', bodyText: 'Test' })).toBe('no_reply')
    expect(mock.decide).not.toHaveBeenCalled()
    expect(mock.writes).toEqual([{ table: 'email_thread_index', values: { needs_reply: false }, filters: expect.any(Array) }])
    // An explicit request is the person's own choice.
    expect(await verdict.explicit({ from: 'Me <me@example.com>', to: 'me@example.com' })).toBe('draft')
  })

  it('does not semantically classify or persist a stale index revision', async () => {
    const newer = { ...message, messageId: 'm2', bodyText: 'New question after the indexed revision' }
    expect(await shouldSkipAutomaticReply('u', 'w', { ...thread, message_count: 2 }, [message, newer])).toBe(false)
    expect(mock.decide).not.toHaveBeenCalled()
    expect(mock.writes).toEqual([])
    // An out-of-date read cannot classify the indexed revision by sender either.
    expect(await shouldSkipAutomaticReply('u', 'w', { ...thread, message_count: 2 }, [message, { ...newer, from: 'no-reply@example.com' }])).toBe(false)
    expect(mock.writes).toEqual([])
  })

  it.each([
    { message_count: 2 }, { message_count: 1.5 }, { has_attachments: true },
  ])('a thread Jev can\'t fully judge (paginated, attachments) is asked about, never guessed at (E3): %j', async changes => {
    expect(await automaticReplyVerdict('u', 'w', { ...thread, ...changes }, [message])).toBe('ask')
    expect(replyCalls()).toHaveLength(0)
    expect(mock.writes).toEqual([])
  })

  it.each([
    { provider_message_id: 'new' }, { provider_thread_id: null }, { account_id: null },
  ])('a stale or unidentified thread still drafts, never classified: %j', async changes => {
    expect(await automaticReplyVerdict('u', 'w', { ...thread, ...changes }, [message])).toBe('draft')
    expect(replyCalls()).toHaveLength(0)
    expect(mock.writes).toEqual([])
  })

  it.each([{ hasAttachments: true }, { bodyComplete: false }])('a message Jev can\'t fully read is asked about (E3): %j', async changes => {
    expect(await verdict(changes)).toBe('ask')
    expect(replyCalls()).toHaveLength(0)
    expect(mock.writes).toEqual([])
  })

  it.each([{ isDraft: true }, { bodyText: '' }, { bodyText: '  ' }, { messageId: undefined }])('a message with nothing to judge still drafts, never classified: %j', async changes => {
    expect(await verdict(changes)).toBe('draft')
    expect(replyCalls()).toHaveLength(0)
    expect(mock.writes).toEqual([])
  })

  it('an explicit request drafts; a paginated read is asked about (trust-only call); a missing conversation drafts unclassified', async () => {
    expect(await shouldSkipAutomaticReply('u', 'w', thread, [message], { explicit: true })).toBe(false)
    // A paginated read can't answer the reply question: asked (E3).
    expect(await automaticReplyVerdict('u', 'w', thread, [message], { complete: false })).toBe('ask')
    // complete:false gets email.trust's trust-only call, never the reply question.
    expect(replyCalls()).toHaveLength(0)
    expect(trustOnlyCalls()).toHaveLength(1)
    mock.decide.mockClear()
    expect(await shouldSkipAutomaticReply('u', 'w', thread, undefined)).toBe(false)
    expect(await shouldSkipAutomaticReply('u', 'w', thread, [])).toBe(false)
    expect(mock.decide).not.toHaveBeenCalled()
    expect(mock.writes).toEqual([])
  })

  it.each([{ from: 'not an address' }, { from: 'person@example..com' }, { to: '', cc: '' }])('incomplete header identity can\'t answer the reply question: asked, not drafted (E3): %j', async changes => {
    expect(await verdict(changes)).toBe('ask')
    expect(replyCalls()).toHaveLength(0)
    expect(mock.writes).toEqual([])
  })

  it('passes grounded direction, Reply-To, separate Cc and ISO dates to the shared decision service', async () => {
    const messages = [
      { ...message, messageId: 'old', from: 'Me <ME@example.com>', to: 'Alex <alex@example.com>' },
      { ...message, from: 'Website <no-reply@forms.example.com>', replyTo: 'Alex <alex@example.com>',
        to: 'Me <me@example.com>', cc: '"Jones, Pat" <pat@example.com>, Sam <sam@example.com>' },
    ]
    await shouldSkipAutomaticReply('u', 'w', { ...thread, message_count: 2 }, messages)
    expect(mock.decide).toHaveBeenCalledWith('email.reply_required', expect.objectContaining({
      mailbox: 'me@example.com', mailboxId: 'account', threadId: 'thread', revision: 'm1', complete: true,
      messages: [expect.objectContaining({ direction: 'outbound', to: ['alex@example.com'], cc: [], date: message.dateISO }),
        expect.objectContaining({ direction: 'inbound', replyTo: 'Alex <alex@example.com>', to: ['me@example.com'], cc: ['pat@example.com', 'sam@example.com'] })],
    }), { userId: 'u', workspaceId: 'w', runId: 'index-id', mode: 'enforce' })
  })

  it('does not turn a failed persistence write into permission to draft to a no-reply address', async () => {
    mock.persistError = new Error('write unavailable')
    expect(await gate({ from: 'no-reply@example.com' })).toBe(true)
    expect(mock.decide).not.toHaveBeenCalled()
  })

  describe('email.trust enforced (email-reply-v4; shadow until 2026-10-16)', () => {
    const phishing = { status: 'accepted', inferenceId: 'inf-1', value: { replyRequired: true, probability: 0.95, trust: 'phishing', phishing: 0.97, injection: 0.02 } }

    it('asks the trust questions on the reply call as enforced: none named shadow; an uncertain verdict changes nothing', async () => {
      mock.decide.mockResolvedValue({ ...phishing, value: { ...phishing.value, trust: 'uncertain', phishing: 0.3, injection: 0.2 } })
      expect(await gate()).toBe(false)
      expect(mock.decide.mock.calls[0][2]).toEqual({ userId: 'u', workspaceId: 'w', runId: 'index-id', mode: 'enforce' })
      expect(mock.writes).toEqual([])
    })

    it('a phishing verdict marks the thread suspicious (this revision, this inference), skips the draft and remembers no reply is owed', async () => {
      mock.decide.mockResolvedValue(phishing)
      expect(await gate()).toBe(true)
      expect(mock.writes.map(write => write.values)).toEqual([{ trust: 'suspicious', trust_message_id: 'm1', trust_inference_id: 'inf-1' }, { needs_reply: false }])
    })

    it('an injection verdict marks the thread and keeps drafting (the no-tools generator)', async () => {
      mock.decide.mockResolvedValue({ ...phishing, value: { ...phishing.value, trust: 'injection', phishing: 0.02, injection: 0.95 } })
      expect(await gate()).toBe(false)
      expect(mock.writes.map(write => write.values)).toEqual([{ trust: 'injection', trust_message_id: 'm1', trust_inference_id: 'inf-1' }])
    })

    it('a thread with attachments gets an enforced trust-only call; phishing there skips the draft too', async () => {
      mock.decide.mockResolvedValue({ ...phishing, value: { ...phishing.value, replyRequired: null, probability: null } })
      expect(await gate({ hasAttachments: true })).toBe(true)
      expect(mock.writes.map(write => write.values)).toEqual([{ trust: 'suspicious', trust_message_id: 'm1', trust_inference_id: 'inf-1' }, { needs_reply: false }])
      expect(replyCalls()).toHaveLength(0)
      expect(trustOnlyCalls()).toHaveLength(1)
      expect(mock.decide.mock.calls[0][1]).toMatchObject({ trustOnly: true, complete: false, attachmentsUnseen: true })
      expect(mock.decide.mock.calls[0][2]).toEqual({ userId: 'u', workspaceId: 'w', runId: 'index-id', mode: 'enforce' })
    })

    it('makes no trust call for an explicit request or a thread with nothing readable', async () => {
      expect(await shouldSkipAutomaticReply('u', 'w', thread, [message], { explicit: true })).toBe(false)
      expect(await gate({ bodyText: '' })).toBe(false)
      expect(mock.decide).not.toHaveBeenCalled()
    })
  })
})

describe('a no-reply sender with a real Reply-To (Liam, 2026-10-18: the cases that got drafted)', () => {
  const unsure = { status: 'accepted', value: { replyRequired: null, probability: null } }
  const cases = [
    ['a cancelled reservation', 'Resy Reservations <noreply@resy.com>', 'Osteriola <restaurant@example.com>'],
    ['a free-tier usage notice', 'Inngest <noreply@email.inngest.com>', 'hello@inngest.com'],
    ['a shared Google Doc', '"Sam (via Google Docs)" <drive-shares-dm-noreply@google.com>', 'sam@example.com'],
    ['a relayed co-founder invitation', 'YC Co-Founder Matching <no-reply@ycombinator.com>', 'cofounder-matching@ycombinator.com'],
    ['a webinar reminder', 'The Exa Team <no-reply@sequel.io>', 'hello@exa.ai'],
  ] as const

  it.each(cases)('%s: Jev unsure → no draft, and this revision is not asked again', async (_, from, replyTo) => {
    mock.decide.mockResolvedValue(unsure)
    expect(await gate({ from, replyTo })).toBe(true)
    expect(replyCalls()).toHaveLength(1)
    expect(mock.writes.map(write => write.values)).toEqual([{ needs_reply: false }])
  })

  it('undecided (escalated) → no draft either, but nothing is remembered', async () => {
    mock.decide.mockResolvedValue({ status: 'escalate', reason: 'uncertain' })
    expect(await gate({ from: 'noreply@resy.com', replyTo: 'restaurant@example.com' })).toBe(true)
    expect(mock.writes).toEqual([])
  })

  it('Jev confident a reply is needed → drafted (a form lead asking for a quote)', async () => {
    mock.decide.mockResolvedValue({ status: 'accepted', value: { replyRequired: true } })
    expect(await gate({ from: 'no-reply@forms.example.com', replyTo: 'Alex <alex@example.com>', bodyText: 'Can you send me a quote?' })).toBe(false)
    expect(mock.writes).toEqual([])
  })

  it('with attachments the reply question is never asked: no draft, nothing remembered', async () => {
    mock.decide.mockResolvedValue({ status: 'accepted', value: { replyRequired: null, probability: null, trust: 'safe' } })
    expect(await gate({ from: 'noreply@resy.com', replyTo: 'restaurant@example.com', hasAttachments: true })).toBe(true)
    expect(replyCalls()).toHaveLength(0)
    expect(trustOnlyCalls()).toHaveLength(1)
    expect(mock.writes).toEqual([])
  })

  it('once the person has written in the thread, an unsure answer is treated as for anyone: asked, not remembered (they are conversing through it)', async () => {
    mock.decide.mockResolvedValue(unsure)
    const relay = { from: 'no-reply@ycombinator.com', replyTo: 'cofounder-matching@ycombinator.com' }
    const messages = [
      { ...message, ...relay, messageId: 'm1' },
      { ...message, messageId: 'm2', from: 'Me <me@example.com>', to: 'cofounder-matching@ycombinator.com' },
      { ...message, ...relay, messageId: 'm3' },
    ]
    expect(await automaticReplyVerdict('u', 'w', { ...thread, provider_message_id: 'm3', message_count: 3 }, messages)).toBe('ask')
    expect(mock.writes).toEqual([])
  })

  it('a person writing, unsure: asked, not drafted (E3, decision 1), and left waiting on a reply (nothing remembered)', async () => {
    mock.decide.mockResolvedValue(unsure)
    expect(await verdict({ from: "Healy O'Donnell <healy@example.com>" })).toBe('ask')
    expect(await verdict({ from: 'Apple Developer <developer@insideapple.example.com>' })).toBe('ask')
    expect(mock.writes).toEqual([])
  })
})

describe('a reply address that is an opaque token (Liam, 2026-10-20: a Square receipt was drafted)', () => {
  const square = { from: "\"Marigold Flower Shop\" <messenger@messaging.squareup.com>",
    replyTo: 'efb205310081b3c5093b4924485e0b9fd48bea157390e7cacba01251c13bd108@reply2.squareup.com',
    bodyText: 'Reply to this email to leave feedback. You paid $24.20.' }

  it('is automated before any model call, and the index files it as a notification', async () => {
    expect(await gate(square)).toBe(true)
    expect(mock.decide).not.toHaveBeenCalled()
    expect(mock.writes.map(write => write.values)).toEqual([{ needs_reply: false, auto_classified: 'notification' }])
  })

  it('once the person has written to it, Jev decides as usual', async () => {
    mock.decide.mockResolvedValue({ status: 'accepted', value: { replyRequired: true } })
    const messages = [
      { ...message, ...square, messageId: 'm1' },
      { ...message, messageId: 'm2', from: 'Me <me@example.com>', to: square.replyTo },
      { ...message, ...square, messageId: 'm3' },
    ]
    expect(await shouldSkipAutomaticReply('u', 'w', { ...thread, provider_message_id: 'm3', message_count: 3 }, messages)).toBe(false)
    expect(replyCalls()).toHaveLength(1)
  })
})
