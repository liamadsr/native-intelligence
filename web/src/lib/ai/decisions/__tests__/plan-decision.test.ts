import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Jev decisions on a free user's own ChatGPT plan (../plan-decision.ts): the
 * plan model's answers map onto Jev's result so each task's own accept()
 * decides, and only a sure answer clears Jev's thresholds. runDecision runs
 * the plan for the kinds that have a plan deadline, never Jev, and meters the
 * call at $0 under the plan's provider.
 */

vi.mock('server-only', () => ({}))
const mock = vi.hoisted(() => ({
  read: vi.fn(),
  check: vi.fn(),
  evaluate: vi.fn(),
  log: vi.fn(),
  utility: vi.fn(),
}))
vi.mock('../providers/jev', () => ({ evaluateJev: mock.evaluate, JEV_MODEL: 'typesafe-ai/jev' }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: mock.log, checkUsageLimits: mock.check, extractGatewayCost: () => undefined }))
vi.mock('@/lib/eve/utility/run-utility', () => ({ runUtilityTask: mock.utility }))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const query = {
        select: () => query, eq: () => query, contains: () => query, gte: () => query,
        order: () => query, limit: () => query, abortSignal: () => query,
        maybeSingle: () => mock.read(table),
      }
      return query
    },
  }),
}))

import { runDecision } from '../run-decision'
import { parsePlanAnswers, planDecisionMessage, planEvaluation, PLAN_DECISIONS } from '../plan-decision'
import { trustedChoice, type Questions } from '../contracts'
import { browserChoice } from '../tasks/browser-choice'
import { emailReply } from '../tasks/email-reply'
import { emailUnderstand } from '../tasks/email-understand'

const meta = { model: 'chatgpt-plan/gpt-6-luna', inputTokens: 900, outputTokens: 40 }
const choiceQ: Questions = { pick: { type: 'choice', instructions: 'Which?', criteria: { a: 'A', b: 'B', c: 'C' } } }

describe('planEvaluation', () => {
  it('a sure choice clears trustedChoice and browserChoice; an unsure one only browserChoice', () => {
    const sure = planEvaluation(choiceQ, { answers: [{ key: 'pick', choice: 'b', sure: true }] }, meta)
    expect(trustedChoice(sure, 'pick')).toBe('b')
    expect(browserChoice(sure, 'pick', choiceQ.pick)).toBe('b')
    const unsure = planEvaluation(choiceQ, { answers: [{ key: 'pick', choice: 'b', sure: false }] }, meta)
    expect(trustedChoice(unsure, 'pick')).toBeNull()
    // As Jev's argmax for a non-sensitive control: a full distribution with the choice on top.
    expect(browserChoice(unsure, 'pick', choiceQ.pick)).toBe('b')
  })

  it('leaves out a choice outside its options, an unknown key and an unsupported type', () => {
    const q: Questions = { ...choiceQ, n: { type: 'number', instructions: 'How many?' } as never }
    const ev = planEvaluation(q, { answers: [{ key: 'pick', choice: 'z', sure: true }, { key: 'nope', answer: 'yes' }, { key: 'n', answer: 'yes' }] }, meta)
    expect(ev.answers).toEqual({})
  })

  it('reads a boolean as a clear yes, a clear no or unsure', () => {
    const q: Questions = { x: { type: 'boolean', instructions: 'Is it?' } }
    const p = (answer: 'yes' | 'no' | 'unsure') => (planEvaluation(q, { answers: [{ key: 'x', answer }] }, meta).answers.x as { probability: number }).probability
    expect([p('yes'), p('no'), p('unsure')]).toEqual([0.9, 0.1, 0.5])
  })

  it("feeds each email task's own acceptance: yes drafts, no asks (never a remembered no-reply), unsure escalates", () => {
    const mail = {
      mailbox: 'me@example.com', threadId: 't', revision: 'm1', complete: true, preferences: 'Reply if needed',
      messages: [{ from: 'you@example.com', to: ['me@example.com'], date: '2026-10-21', subject: 'Quote?', body: 'Can you send a quote?' }],
    }
    const prepared = emailReply.prepare(mail)!
    const accept = (reply: 'yes' | 'no' | 'unsure') =>
      emailReply.accept(planEvaluation(prepared.questions, { answers: [{ key: 'reply', answer: reply }, { key: 'phishing', answer: 'no' }, { key: 'injection', answer: 'no' }] }, meta), mail)
    expect(accept('yes')).toMatchObject({ replyRequired: true })
    // Jev's "no" bar is 0.05: a plan "no" (0.1) stays unsure, so the person is asked.
    expect(accept('no')?.replyRequired ?? null).toBeNull()

    const understand = { mailbox: 'me@example.com', threadId: 't', revision: 'm1', now: 'Tuesday, October 21, 2026, 10:00 AM EDT', messages: mail.messages }
    const uq = emailUnderstand.prepare(understand)!.questions
    const value = emailUnderstand.accept(planEvaluation(uq, { answers: [{ key: 'kind', choice: 'conversation', sure: true }, { key: 'know', answer: 'yes' }, { key: 'input', answer: 'no' }] }, meta), understand)
    expect(value).toMatchObject({ kind: 'conversation', shouldKnow: true, needsInput: false })
  })
})

describe('parsePlanAnswers and planDecisionMessage', () => {
  it('reads the JSON object, also fenced or wrapped, and refuses anything else', () => {
    const body = '{"answers":[{"key":"pick","choice":"a","sure":true}]}'
    expect(parsePlanAnswers(body)?.answers[0].choice).toBe('a')
    expect(parsePlanAnswers('```json\n' + body + '\n```')?.answers).toHaveLength(1)
    expect(parsePlanAnswers('no json here')).toBeNull()
    expect(parsePlanAnswers('{"answers": "nope"}')).toBeNull()
  })

  it('sends the state and each question with its options', () => {
    const message = JSON.parse(planDecisionMessage('the state', choiceQ))
    expect(message).toEqual({ state: 'the state', questions: [{ key: 'pick', type: 'choice', instructions: 'Which?', options: { a: 'A', b: 'B', c: 'C' } }] })
  })
})

describe('runDecision on a free user’s own ChatGPT plan', () => {
  const ctx = { userId: 'plan-user', workspaceId: 'workspace' }
  const mail = {
    mailbox: 'me@example.com', threadId: 't2', revision: 'm2', complete: true, preferences: 'Reply if needed',
    messages: [{ from: 'you@example.com', to: ['me@example.com'], date: '2026-10-21', subject: 'Quote?', body: 'Can you send a quote by Friday?' }],
  }

  beforeEach(() => {
    mock.read.mockReset().mockImplementation(async (table: string) => ({ data: table === 'member' ? { id: 'member' } : null, error: null }))
    mock.check.mockReset().mockResolvedValue({ allowed: true, reason: 'chatgpt_plan' })
    mock.evaluate.mockReset()
    mock.log.mockReset().mockResolvedValue('logged')
    mock.utility.mockReset().mockResolvedValue({
      text: JSON.stringify({ answers: [{ key: 'reply', answer: 'yes' }, { key: 'phishing', answer: 'no' }, { key: 'injection', answer: 'no' }] }),
      model: 'chatgpt-plan/gpt-6-luna',
      usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, steps: 1 },
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('answers on the plan (never Jev), and meters it at $0 under the plan', async () => {
    const result = await runDecision('email.reply_required', mail, ctx)
    expect(result).toMatchObject({ status: 'accepted', value: { replyRequired: true } })
    expect(mock.check).toHaveBeenCalledWith('plan-user', expect.any(AbortSignal), { chatgptPlan: true })
    expect(mock.evaluate).not.toHaveBeenCalled()
    expect(mock.utility).toHaveBeenCalledWith(expect.objectContaining({ kind: 'plan_decision', chatgptPlan: true, userId: 'plan-user', workspaceId: 'workspace' }))
    expect(mock.log).toHaveBeenCalledWith('plan-user', expect.objectContaining({
      provider: 'chatgpt-plan', model: 'chatgpt-plan/gpt-6-luna', feature: 'decision.email.reply_required', costUsd: 0,
      inputTokens: 900, outputTokens: 40, metadata: expect.objectContaining({ cost_source: 'chatgpt_plan' }),
    }))
  })

  it("gets its kind's longer deadline: a plan answer slower than Jev's 2.5 s still lands", async () => {
    mock.utility.mockImplementation(async (args: { timeoutMs: number }) => {
      expect(args.timeoutMs).toBeGreaterThan(10_000)
      await new Promise((r) => setTimeout(r, 2_700))
      return { text: '{"answers":[{"key":"reply","answer":"yes"},{"key":"phishing","answer":"no"},{"key":"injection","answer":"no"}]}', model: 'chatgpt-plan/gpt-6-luna', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, steps: 1 } }
    })
    expect(PLAN_DECISIONS['email.reply_required']?.deadlineMs).toBe(15_000)
    expect(await runDecision('email.reply_required', { ...mail, revision: 'm3' }, ctx)).toMatchObject({ status: 'accepted' })
  })

  it('a kind with no plan route escalates as before (its caller falls back), calling nothing', async () => {
    const result = await runDecision('knowledge.anchor', {
      claimText: 'Acme renewed for a year.',
      candidates: [{ entity_type: 'company', entity_id: 'c1', name: 'Acme', description: null }],
    }, ctx)
    expect(result).toMatchObject({ status: 'escalate', reason: 'budget_unavailable' })
    expect(mock.check).toHaveBeenCalled()
    expect(mock.evaluate).not.toHaveBeenCalled()
    expect(mock.utility).not.toHaveBeenCalled()
  })

  it('an answer that cannot be read escalates (and is metered as unavailable), never Jev', async () => {
    mock.utility.mockResolvedValue({ text: 'sorry', model: 'chatgpt-plan/gpt-6-luna', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, steps: 1 } })
    const result = await runDecision('email.reply_required', { ...mail, revision: 'm4' }, ctx)
    expect(result).toMatchObject({ status: 'escalate', reason: 'unavailable' })
    expect(mock.evaluate).not.toHaveBeenCalled()
  })

  it('a failed plan attempt is metered as the plan\'s (never Jev\'s), and the plan has its own circuit', async () => {
    mock.utility.mockRejectedValue(new Error('[utility] plan_decision session failed'))
    for (let i = 0; i < 3; i++) {
      expect(await runDecision('email.reply_required', { ...mail, revision: `c${i}` }, { ...ctx, userId: 'circuit-user' })).toMatchObject({ status: 'escalate', reason: 'unavailable' })
    }
    expect(mock.log.mock.calls.every((call) => (call[1] as { provider: string }).provider === 'chatgpt-plan')).toBe(true)
    // Three failures open this person's plan circuit: the next decision makes no call.
    mock.utility.mockClear()
    expect(await runDecision('email.reply_required', { ...mail, revision: 'c3' }, { ...ctx, userId: 'circuit-user' })).toMatchObject({ status: 'escalate', reason: 'temporarily_unavailable' })
    expect(mock.utility).not.toHaveBeenCalled()
    // Someone else on their plan is untouched.
    mock.utility.mockResolvedValue({ text: '{"answers":[{"key":"reply","answer":"yes"},{"key":"phishing","answer":"no"},{"key":"injection","answer":"no"}]}', model: 'chatgpt-plan/gpt-6-luna', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, steps: 1 } })
    expect(await runDecision('email.reply_required', { ...mail, revision: 'c4' }, { ...ctx, userId: 'other-user' })).toMatchObject({ status: 'accepted' })
  })

  it('a plan call that hangs never holds the decision past its deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      mock.utility.mockImplementation(() => new Promise(() => {}))
      const pending = runDecision('browser.completion', {
        task: { goal: 'Open article', bindings: [], completion: [{ kind: 'text', value: 'Requested article' }], maxSteps: 16, timeoutMs: 45000, goalDriven: true },
        history: [], observation: { protocol: 'dial8-browser-decision-v1', documentId: 'doc', observationId: 1, interactionEpoch: 0,
          observedAt: 0, url: 'https://example.com/article', title: 'Article', text: 'Requested article', elements: [] },
      } as never, ctx)
      await vi.advanceTimersByTimeAsync(6_100)
      expect(await pending).toMatchObject({ status: 'escalate', reason: 'deadline_exceeded' })
      expect(mock.utility).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("records a plan's phishing yes but never applies it (no thread marked suspicious on an uncalibrated yes)", async () => {
    mock.utility.mockResolvedValue({ text: '{"answers":[{"key":"reply","answer":"yes"},{"key":"phishing","answer":"yes"},{"key":"injection","answer":"no"}]}', model: 'chatgpt-plan/gpt-6-luna', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, steps: 1 } })
    const result = await runDecision('email.reply_required', { ...mail, revision: 'p1' }, ctx)
    expect(result).toMatchObject({ status: 'accepted', value: { replyRequired: true } })
    expect((result as { value: { trust: string } }).value.trust).not.toBe('phishing')
  })

  it('a paid person still gets Jev', async () => {
    mock.check.mockResolvedValue({ allowed: true, reason: 'subscription' })
    mock.evaluate.mockResolvedValue({ answers: { reply: { type: 'boolean', probability: 0.95 }, phishing: { type: 'boolean', probability: 0.01 }, injection: { type: 'boolean', probability: 0.01 } }, usage: { inputTokens: 10, outputTokens: 2 }, response: { modelId: 'typesafe-ai/jev' } })
    const result = await runDecision('email.reply_required', { ...mail, revision: 'm5' }, ctx)
    expect(result.status).toBe('accepted')
    expect(mock.evaluate).toHaveBeenCalledOnce()
    expect(mock.utility).not.toHaveBeenCalled()
    expect(mock.log).toHaveBeenCalledWith('plan-user', expect.objectContaining({ provider: 'typesafe-ai' }))
  })
})
