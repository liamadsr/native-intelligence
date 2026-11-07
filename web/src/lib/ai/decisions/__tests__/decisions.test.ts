import { beforeEach, describe, expect, it, vi } from 'vitest'
import { browserNext } from '../tasks/browser-next'
import { emailReply } from '../tasks/email-reply'
import type { ActionReviewInput } from '../tasks/action-review'
import { browserTaskSchema } from '@/lib/browser-agent/task-contract'
import type { Evaluation } from '../contracts'
import { browserEvaluation } from './browser-evaluation-result'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({ evaluate: vi.fn(), log: vi.fn(), check: vi.fn(), member: true, cached: null as unknown }))
vi.mock('../providers/jev', () => ({ evaluateJev: mocks.evaluate, JEV_MODEL: 'typesafe-ai/jev' }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: mocks.log, checkUsageLimits: mocks.check, extractGatewayCost: () => undefined }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ from: (table: string) => {
  const chain = { select: () => chain, eq: () => chain, contains: () => chain, gte: () => chain, order: () => chain, limit: () => chain, abortSignal: () => chain,
    maybeSingle: async () => ({ data: table === 'member' ? (mocks.member ? { id: 'member' } : null) : mocks.cached, error: null }) }
  return chain
} }) }))
import { runDecision, jevFallbackCost } from '../run-decision'

const mail = { mailbox: 'me@example.com', threadId: 't', revision: 'm1', complete: true,
  preferences: 'Reply if needed', messages: [{ from: 'you@example.com', to: ['me@example.com'], date: '2026-10-03', subject: 'FYI', body: 'Done. No action needed.' }] }
const ctx = { userId: 'user', workspaceId: 'workspace' }
const evaluation = (p: number) => ({ answers: { reply: { type: 'boolean', probability: p } }, usage: { inputTokens: 5000, outputTokens: 0 }, response: { modelId: 'typesafe-ai/jev' } }) as unknown as Evaluation
beforeEach(() => {
  mocks.member = true; mocks.cached = null
  mocks.evaluate.mockReset().mockResolvedValue(evaluation(0.01)); mocks.log.mockReset().mockResolvedValue('logged')
  mocks.check.mockReset().mockResolvedValue({ allowed: true })
})

describe('shared decision service', () => {
  it('meters accepted decisions once with a fresh inference ID, never logs email content', async () => {
    expect(await runDecision('email.reply_required', mail, ctx)).toMatchObject({ status: 'accepted', value: { replyRequired: false } })
    expect(mocks.log).toHaveBeenCalledTimes(1)
    const first = mocks.log.mock.calls[0][1]
    expect(first.costUsd).toBeCloseTo(0.00021)
    expect(first.metadata.usage_unknown).toBe(false)
    expect(JSON.stringify(first)).not.toContain(mail.messages[0].body)
    await runDecision('email.reply_required', mail, ctx)
    expect(mocks.log.mock.calls[1][1].idempotencyKey).not.toBe(first.idempotencyKey)
  })
  it('does not invoke models for incomplete, unauthorized or exhausted requests', async () => {
    expect(await runDecision('email.reply_required', { ...mail, complete: false }, ctx)).toMatchObject({ reason: 'incomplete_evidence' })
    mocks.member = false
    expect(await runDecision('email.reply_required', mail, ctx)).toMatchObject({ reason: 'not_authorized' })
    mocks.member = true; mocks.check.mockResolvedValue(undefined)
    expect(await runDecision('email.reply_required', mail, ctx)).toMatchObject({ reason: 'budget_unavailable' })
    expect(mocks.evaluate).not.toHaveBeenCalled()
  })
  it('does not confuse unavailable/uncertain with false', async () => {
    mocks.evaluate.mockResolvedValue(evaluation(0.3))
    expect(await runDecision('email.reply_required', mail, ctx)).toMatchObject({ status: 'escalate', reason: 'uncertain' })
    mocks.evaluate.mockRejectedValue(new Error('provider secret detail'))
    const result = await runDecision('email.reply_required', mail, ctx)
    expect(result).toMatchObject({ status: 'escalate', reason: 'unavailable' })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(mocks.log.mock.calls.at(-1)?.[1].metadata).toMatchObject({ usage_unknown: true, cost_unknown: true })
  })
  it('honors cancellation without spending and refuses unknown usage', async () => {
    const abort = new AbortController(); abort.abort()
    expect(await runDecision('email.reply_required', mail, { ...ctx, signal: abort.signal })).toMatchObject({ status: 'cancelled' })
    expect(mocks.evaluate).not.toHaveBeenCalled()
    mocks.evaluate.mockResolvedValue({ ...evaluation(0.01), usage: {} })
    expect(await runDecision('email.reply_required', mail, ctx)).toMatchObject({ reason: 'accounting_unavailable' })
  })
  it('uses scoped version/content cache keys and revalidates cached answers', async () => {
    await runDecision('email.reply_required', mail, ctx)
    const key = mocks.log.mock.calls[0][1].metadata.decision_cache_key
    await runDecision('email.reply_required', { ...mail, revision: 'm2' }, ctx)
    expect(mocks.log.mock.calls[1][1].metadata.decision_cache_key).not.toBe(key)
    await runDecision('email.reply_required', mail, { ...ctx, workspaceId: 'other' })
    expect(mocks.log.mock.calls[2][1].metadata.decision_cache_key).not.toBe(key)
    mocks.cached = { metadata: { decision_answer: evaluation(0.01), inference_id: 'prior' } }
    mocks.evaluate.mockClear()
    expect(await runDecision('email.reply_required', mail, ctx)).toMatchObject({ status: 'accepted', cached: true, inferenceId: 'prior' })
    expect(mocks.evaluate).not.toHaveBeenCalled()
  })
  it('has tested, configurable catalog pricing', () => {
    expect(jevFallbackCost(1_000_000)).toBe(0.042)
    vi.stubEnv('JEV_INPUT_USD_PER_MILLION', '0.05')
    expect(jevFallbackCost(1_000_000)).toBe(0.05)
  })
  it('preserves confidence needed to reuse a cached choice without another model call', async () => {
    const choice = { answers: { anchor: { type: 'choice', choice: 'anchor_0', probabilities: { anchor_0: 0.99, none: 0.01 } } },
      providerMetadata: { typesafe: { confidence: { anchor: 0.99 } } },
      usage: { inputTokens: 100, outputTokens: 20 }, response: { modelId: 'typesafe-ai/jev' } }
    const input = { claimText: 'Project Atlas uses JSON.', candidates: [{ entity_type: 'project', entity_id: 'atlas', name: 'Atlas', description: null }] }
    mocks.evaluate.mockResolvedValue(choice)
    expect(await runDecision('knowledge.anchor', input, ctx)).toMatchObject({ status: 'accepted', value: { anchor_id: 'atlas' } })
    const metadata = mocks.log.mock.calls.at(-1)![1].metadata
    expect(metadata.decision_answer.providerMetadata).toEqual(choice.providerMetadata)
    mocks.cached = { metadata }
    mocks.evaluate.mockClear()
    expect(await runDecision('knowledge.anchor', input, ctx)).toMatchObject({ status: 'accepted', cached: true, value: { anchor_id: 'atlas' } })
    expect(mocks.evaluate).not.toHaveBeenCalled()
  })
  it('does not return a cached answer when the caller cancels during authorization', async () => {
    mocks.cached = { metadata: { decision_answer: evaluation(0), inference_id: 'cached' } }
    const controller = new AbortController()
    const pending = runDecision('email.reply_required', mail, { ...ctx, signal: controller.signal })
    controller.abort()
    expect(await pending).toMatchObject({ status: 'cancelled' })
    expect(mocks.evaluate).not.toHaveBeenCalled()
  })
})

describe('A5 additions to the runner', () => {
  it('names shadow questions in the usage metadata beside the answers, and only when given', async () => {
    await runDecision('email.reply_required', mail, { ...ctx, shadowQuestions: ['phishing', 'injection'] })
    expect(mocks.log.mock.calls.at(-1)![1].metadata).toMatchObject({ decision_mode: 'enforce', shadow_questions: ['phishing', 'injection'] })
    await runDecision('email.reply_required', { ...mail, revision: 'm9' }, ctx)
    expect(mocks.log.mock.calls.at(-1)![1].metadata).not.toHaveProperty('shadow_questions')
  })

  it('records message_id (what a thumbs rating joins on) only when given', async () => {
    await runDecision('email.reply_required', { ...mail, revision: 'm10' }, { ...ctx, mode: 'shadow', messageId: 'nudge-1' })
    expect(mocks.log.mock.calls.at(-1)![1].metadata).toMatchObject({ decision_mode: 'shadow', message_id: 'nudge-1' })
    await runDecision('email.reply_required', { ...mail, revision: 'm11' }, ctx)
    expect(mocks.log.mock.calls.at(-1)![1].metadata).not.toHaveProperty('message_id')
  })

  it('action.review neither waits on the per-user cap nor counts toward it; other tasks keep it', async () => {
    const review: ActionReviewInput = { door: 'chat', tool: 'delete_action', sideEffect: 'delete', arguments: '{}', source: 'person',
      personMessages: ['Delete GEN-12'], toolsThisTurn: [] }
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    mocks.evaluate.mockImplementation(async (_state: string, questions: Record<string, unknown>) => {
      await gate
      return 'asked' in questions
        ? { answers: { asked: { type: 'boolean', probability: 0.95 } }, usage: { inputTokens: 10, outputTokens: 0 }, response: { modelId: 'typesafe-ai/jev' } }
        : evaluation(0.01)
    })
    // Three reviews in flight do not take the user's two decision slots...
    const reviews = [1, 2, 3].map(() => runDecision('action.review', review, ctx))
    const emails = [runDecision('email.reply_required', mail, ctx), runDecision('email.reply_required', { ...mail, revision: 'm2' }, ctx)]
    // ...the cap still holds for the other tasks: a third email decision is busy...
    expect(await runDecision('email.reply_required', { ...mail, revision: 'm3' }, ctx)).toMatchObject({ status: 'escalate', reason: 'temporarily_unavailable' })
    // ...and a full cap does not stop a review.
    const another = runDecision('action.review', review, ctx)
    release()
    for (const result of await Promise.all([...reviews, another])) expect(result).toMatchObject({ status: 'accepted', value: { allow: true } })
    for (const result of await Promise.all(emails)) expect(result.status).toBe('accepted')
  })

  it('action.review has its own circuit: its failures do not stop other decisions, nor theirs it', async () => {
    const review: ActionReviewInput = { door: 'chat', tool: 'delete_action', sideEffect: 'delete', arguments: '{}', source: 'person',
      personMessages: ['Delete GEN-12'], toolsThisTurn: [] }
    mocks.evaluate.mockRejectedValue(new Error('reviewer outage'))
    for (let i = 0; i < 3; i++) expect(await runDecision('action.review', review, ctx)).toMatchObject({ reason: 'unavailable' })
    expect(await runDecision('action.review', review, ctx)).toMatchObject({ reason: 'temporarily_unavailable' })
    mocks.evaluate.mockReset().mockResolvedValue(evaluation(0.01))
    expect(await runDecision('email.reply_required', { ...mail, revision: 'circuit' }, ctx)).toMatchObject({ status: 'accepted' })
  })

  it('caches an uncertain trust-only verdict for its revision, so the same thread is not asked again', async () => {
    mocks.evaluate.mockResolvedValue({ answers: { phishing: { type: 'boolean', probability: 0.5 }, injection: { type: 'boolean', probability: 0.02 } },
      usage: { inputTokens: 100, outputTokens: 0 }, response: { modelId: 'typesafe-ai/jev' } })
    const result = await runDecision('email.reply_required', { ...mail, revision: 'att-1', complete: false, trustOnly: true }, ctx)
    expect(result).toMatchObject({ status: 'accepted', value: { trust: 'uncertain', replyRequired: null } })
    expect(mocks.log.mock.calls.at(-1)![1].metadata).toHaveProperty('decision_cache_key')
  })
})

describe('feature acceptance policies', () => {
  it('does not accept incidental matching page text as goal completion', () => {
    const input = { task: browserTaskSchema.parse({ goal: 'Search for flights to Los Angeles on October 4',
      completion: [{ kind: 'text', value: 'Los Angeles' }] }), history: [],
      observation: { protocol: 'dial8-browser-decision-v1' as const, documentId: 'doc', observationId: 1,
        interactionEpoch: 0, observedAt: Date.now(), url: 'https://example.com/', title: '',
        text: 'Popular destinations: Los Angeles', elements: [] } }
    const result = browserEvaluation(input)
    expect(browserNext.prepare(input)?.questions.completion).toBeDefined()
    const missing = structuredClone(result)
    delete missing.answers.completion
    expect(browserNext.accept(missing, input)).toBeNull()
    expect(browserNext.accept({ ...result, answers: { ...result.answers,
      completion: { type: 'choice', choice: 'incomplete', probabilities: { incomplete: 1, complete: 0 } },
    } } as Evaluation, input)).toEqual({ operation: 'escalate' })
    expect(browserNext.accept({ ...result, answers: { ...result.answers,
      completion: { type: 'choice', choice: 'complete', probabilities: { complete: 1, incomplete: 0 } },
    } } as Evaluation, input)).toEqual({ operation: 'done' })
  })
  it('email errs toward drafting and rejects missing/invalid probabilities', () => {
    expect(emailReply.accept(evaluation(0.01), mail)).toMatchObject({ replyRequired: false })
    expect(emailReply.accept(evaluation(0.99), mail)).toMatchObject({ replyRequired: true })
    for (const p of [0.06, 0.5, NaN, -1, 2]) expect(emailReply.accept(evaluation(p), mail)).toBeNull()
  })
  it('requires a valid selected target distribution and membership in the observed candidate set', () => {
    const input = { task: browserTaskSchema.parse({ goal: 'Search', completion: [{ kind: 'text', value: 'Results' }] }),
      history: [], observation: { protocol: 'dial8-browser-decision-v1' as const, documentId: 'doc', observationId: 1, interactionEpoch: 0,
        observedAt: Date.now(), url: 'https://example.com/', title: '', text: '', elements: [{ ref: 'e1', name: 'Search', role: 'button', value: '', canType: false,
          disabled: false, forbidden: false, sensitive: false, context: '', destination: '' }] } }
    const result = browserEvaluation(input, { operation: { choice: 'click' }, click: { choice: 'e1' } })
    expect(browserNext.accept(result, input)).toEqual({ operation: 'click', ref: 'e1' })
    const editablePicker = { ...input, observation: { ...input.observation,
      elements: [{ ...input.observation.elements[0], role: 'combobox', name: 'Where to?', canType: true }] } }
    expect(browserNext.prepare(editablePicker)?.questions.click).toBeDefined()
    expect(browserNext.accept(result, editablePicker)).toEqual({ operation: 'click', ref: 'e1' })
    expect(browserNext.accept({ ...result, providerMetadata: {} }, input)).toBeNull()
    expect(browserNext.accept(result, { ...input, observation: { ...input.observation, elements: [] } })).toBeNull()
  })
})
