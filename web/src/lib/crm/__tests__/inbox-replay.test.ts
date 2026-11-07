/**
 * GEN-1164 replay: the eval set (src/lib/email/__tests__/inbox-replay-fixtures.ts)
 * through the automatic reply gate, with Jev stubbed. Acceptance:
 *   - categories 1-4 (receipts, automated notices, calendar mail, self-sent
 *     mail) get no draft, whatever Jev says short of a confident yes, and
 *     with Gmail's labels every one but the two no-reply senders relaying a
 *     human (a Docs share, Inngest's usage notice) stops BEFORE Jev (the
 *     hard pre-filter: no model call);
 *   - the real threads (Boardy, Owen, Exa/Healy, Guidepoint) reach Jev and
 *     are drafted on its yes.
 * Jev's own answers on the same threads are the live eval's
 * (scripts/jev-decisions.live.test.ts, `email.gen1164_*`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailMessageForAI } from '@/lib/email/email-read-service'
import { REPLAY_MAILBOX, REPLAY_OTHER_ACCOUNT, replayFixtures, type ReplayFixture } from '@/lib/email/__tests__/inbox-replay-fixtures'

const mock = vi.hoisted(() => ({
  decide: vi.fn(),
  known: new Set<string>(),
  writes: [] as Array<Record<string, unknown>>,
}))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: mock.decide }))
vi.mock('@/lib/agent-events/known-senders', () => ({
  knownSenders: async (_db: unknown, args: { addresses: Iterable<string | null | undefined> }) =>
    new Set([...args.addresses].filter((a): a is string => !!a && mock.known.has(a))),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({
  auth: { admin: { getUserById: async () => ({ data: { user: { email: REPLAY_MAILBOX } } }) } },
  from: (table: string) => {
    const query: Record<string, unknown> = {
      select: () => query, eq: () => query, in: () => query, limit: () => query,
      maybeSingle: async () => ({ data: table === 'connected_account' ? { account_email: REPLAY_MAILBOX } : null, error: null }),
      update: (values: Record<string, unknown>) => { mock.writes.push(values); return query },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({
        data: table === 'connected_account' ? [{ account_email: REPLAY_MAILBOX }, { account_email: REPLAY_OTHER_ACCOUNT }] : null,
        error: null,
      }).then(resolve),
    }
    return query
  },
}) }))
const { automaticReplyVerdict } = await import('../email-reply-gate')

function replay(fixture: ReplayFixture) {
  const messages: EmailMessageForAI[] = fixture.messages.map((m, i) => ({
    messageId: `${fixture.name}-${i}`, from: m.from, to: m.to ?? REPLAY_MAILBOX, cc: m.cc ?? '',
    ...(m.replyTo ? { replyTo: m.replyTo } : {}), replyToKnown: true, isDraft: false,
    date: 'Mon, 20 Oct 2026', dateISO: '2026-10-20T15:00:00.000Z', subject: m.subject, bodyText: m.body, bodyComplete: true,
    hasAttachments: !!m.attachmentNames?.length, attachmentNames: m.attachmentNames ?? [],
    ...(m.automatedBy ? { automatedBy: m.automatedBy } : {}),
  }))
  const thread = {
    id: `index-${fixture.name}`, account_id: 'account', provider_thread_id: fixture.name,
    provider_message_id: messages.at(-1)!.messageId, message_count: messages.length,
    has_attachments: messages.some((m) => m.hasAttachments), label_ids: fixture.labels ?? ['INBOX'],
  }
  return automaticReplyVerdict('user', 'workspace', thread, messages)
}

const sender = (f: ReplayFixture) => (f.messages.at(-1)!.from.match(/<([^>]+)>/)?.[1] ?? f.messages.at(-1)!.from).toLowerCase()
const unwanted = replayFixtures.filter((f) => f.category !== 'keep')
const kept = replayFixtures.filter((f) => f.category === 'keep')
/**
 * The unwanted threads only Jev can turn away: a no-reply sender relaying a
 * human Reply-To (the Docs share's sharer, Inngest's hello@), the shape a
 * form lead also has. Only Jev's confident yes drafts them.
 */
const JEV_DECIDES = ['doc_shared', 'inngest_usage']

beforeEach(() => {
  mock.decide.mockReset()
  mock.known = new Set(replayFixtures.filter((f) => f.known).map(sender))
  mock.writes.length = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('GEN-1164 replay: no drafts for receipts, notices, calendar mail or self-sent mail', () => {
  it('covers every category the issue lists, and the four real threads', () => {
    expect(new Set(unwanted.map((f) => f.category))).toEqual(new Set([1, 2, 3, 4]))
    expect(kept.map((f) => f.name)).toEqual(['boardy_reference_ask', 'owen_follow_up', 'exa_healy_follow_up', 'guidepoint_request'])
  })

  it.each(unwanted.map((f) => [f.name, f] as const))('%s: stopped before Jev unless it relays a human', async (name, fixture) => {
    // Jev's worst case short of a confident yes: unsure.
    mock.decide.mockResolvedValue({ status: 'escalate', reason: 'uncertain' })
    const verdict = await replay(fixture)
    expect(verdict).not.toBe('draft')
    if (JEV_DECIDES.includes(name)) {
      // A no-reply sender with a human Reply-To: only Jev's confident yes drafts it.
      expect(verdict).toBe('no_reply')
      expect(mock.decide).toHaveBeenCalledTimes(1)
    } else {
      expect(verdict).toBe('no_reply')
      expect(mock.decide).not.toHaveBeenCalled()
      // Remembered for this revision: no later pass asks again.
      expect(mock.writes).toHaveLength(1)
      expect(mock.writes[0]).toMatchObject({ needs_reply: false })
    }
  })

  it.each(JEV_DECIDES)('%s is drafted only on a confident yes, which v5 withholds (the live eval)', async (name) => {
    const relayed = replayFixtures.find((f) => f.name === name)!
    mock.decide.mockResolvedValue({ status: 'accepted', value: { replyRequired: false, trust: 'safe' } })
    expect(await replay(relayed)).toBe('no_reply')
    mock.decide.mockResolvedValue({ status: 'accepted', value: { replyRequired: null, trust: 'safe' } })
    expect(await replay(relayed)).toBe('no_reply')
  })

  it('without Gmail labels (Outlook, or Primary), the rules alone still stop all but five; Jev unsure never drafts them', async () => {
    mock.decide.mockResolvedValue({ status: 'escalate', reason: 'uncertain' })
    const reachedJev: string[] = []
    for (const fixture of unwanted) {
      mock.decide.mockClear()
      expect(await replay({ ...fixture, labels: undefined }), fixture.name).not.toBe('draft')
      if (mock.decide.mock.calls.length) reachedJev.push(fixture.name)
    }
    expect(reachedJev.sort()).toEqual(['apple_license_agreement', 'doc_shared', 'inngest_usage', 'juror_email_verification', 'paypal_receipt'])
  })
})

describe('GEN-1164 replay: the real threads still get a draft', () => {
  it.each(kept.map((f) => [f.name, f] as const))('%s reaches Jev with who is asking, and is drafted on its yes', async (_name, fixture) => {
    mock.decide.mockResolvedValue({ status: 'accepted', value: { replyRequired: true, trust: 'safe' } })
    expect(await replay(fixture)).toBe('draft')
    expect(mock.decide).toHaveBeenCalledTimes(1)
    expect(mock.decide.mock.calls[0][1]).toMatchObject({ complete: true, knownSender: fixture.known === true })
    expect(mock.writes).toEqual([])
  })

  it("Healy's follow-up sits in Gmail's Updates, and passes because Liam knows Healy", async () => {
    const healy = replayFixtures.find((f) => f.name === 'exa_healy_follow_up')!
    mock.decide.mockResolvedValue({ status: 'accepted', value: { replyRequired: true, trust: 'safe' } })
    mock.known.clear()
    expect(await replay(healy)).toBe('no_reply')
    expect(mock.decide).not.toHaveBeenCalled()
  })
})
