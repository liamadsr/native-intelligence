import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UtilityRunBase, UtilityUsageReport } from '@/lib/eve/utility/run-utility'
import { browserTaskSchema, observationSchema } from '../task-contract'

const mocks = vi.hoisted(() => ({
  trace: vi.fn(), member: vi.fn(), budget: vi.fn(), log: vi.fn(), run: vi.fn(),
  from: vi.fn(), eq: vi.fn(), abortSignal: vi.fn(),
}))
vi.mock('../local-debug-trace', () => ({ writeBrowserDebugTrace: mocks.trace }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ from: mocks.from }) }))
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: mocks.budget, logUsage: mocks.log }))
vi.mock('@/lib/eve/utility/run-utility', () => ({ runUtilityTask: mocks.run }))
import { resolveBrowserFieldText } from '../resolve-field-text'

const ctx = () => ({ userId: 'user', workspaceId: 'workspace', runId: 'task-id', deadline: Date.now() + 9_000 })
function input() {
  return {
    task: browserTaskSchema.parse({ goalDriven: true, goal: 'Find a one-way flight from JFK to LAX on October 6, 2026.', completion: [] }),
    observation: observationSchema.parse({
      protocol: 'dial8-browser-decision-v1', documentId: 'd', observationId: 1, interactionEpoch: 0,
      observedAt: Date.now(), url: 'https://example.com', title: 'Do not include this page title', text: 'Do not include this page body',
      elements: [{ ref: 'e1', role: 'combobox', name: 'Origin', value: '', canType: true, disabled: false,
        sensitive: false, forbidden: false, context: 'Airport', destination: '', dialog: 'Enter your origin' }],
    }),
    ref: 'e1', history: ['click:e1'],
  }
}
function usage(overrides: Partial<UtilityUsageReport> = {}): UtilityUsageReport {
  return { model: 'deepseek-v4-flash', complete: true, inputTokensReported: true, outputTokensReported: true,
    generationIds: ['generation-id'], usage: { inputTokens: 120, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, steps: 1 }, ...overrides }
}
function generated(value: unknown = { value: 'JFK', goalQuote: 'JFK' }, report = usage()) {
  mocks.run.mockImplementation(async (args: UtilityRunBase) => {
    args.onUsage?.(report)
    return { text: JSON.stringify(value), model: report.model, usage: report.usage }
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  const chain = { select: vi.fn().mockReturnThis(), eq: mocks.eq, abortSignal: mocks.abortSignal, maybeSingle: mocks.member }
  mocks.from.mockReturnValue(chain)
  mocks.eq.mockReturnValue(chain)
  mocks.abortSignal.mockReturnValue(chain)
  mocks.member.mockResolvedValue({ data: { id: 'member' }, error: null })
  mocks.budget.mockResolvedValue({ allowed: true })
  mocks.log.mockResolvedValue('logged')
  generated()
})

describe('resolveBrowserFieldText', () => {
  it('keeps where the eve round trip went, in the trace metrics and the usage log', async () => {
    const timeline = { modelLookupMs: 40, createMs: 380, streamMs: 1900, eve: { turnStarted: 300, stepStarted: 700, firstOutput: 1250, stepCompleted: 1450, boundary: 1700 } }
    generated(undefined, usage({ timeline }))
    const result = await resolveBrowserFieldText(input(), ctx())
    expect(result.metrics.generationTimeline).toEqual(timeline)
    expect(mocks.log.mock.calls[0][1].metadata.generation_timeline_ms).toEqual(timeline)
  })
  it('supplies picker expansion and only bounded, same-dialog suggestion labels without refs or other values', async () => {
    const request = input(), prototype = request.observation.elements[0]
    prototype.expanded = 'true'
    request.observation.elements.push(...Array.from({ length: 12 }, (_, index) => ({ ...prototype,
      ref: `e${index + 2}`, role: 'option', name: `Choice ${index}`, value: 'Unrelated option value', canType: false, selected: 'false' as const })),
      { ...prototype, ref: 'e50', role: 'option', name: 'Other dialog', dialog: 'Other picker' },
      { ...prototype, ref: 'e51', role: 'option', name: 'Secret option', sensitive: true })
    await resolveBrowserFieldText(request, ctx())
    const message = JSON.parse(mocks.run.mock.calls[0][0].message)
    expect(message.untrustedSelectedField.expanded).toBe('true')
    expect(message.untrustedPickerState).toEqual({ loading: false, suggestionsScope: 'visible_subset',
      visibleSuggestions: Array.from({ length: 10 }, (_, index) => ({ name: `Choice ${index}`, selected: 'false' })) })
    expect(JSON.stringify(message.untrustedPickerState)).not.toMatch(/Unrelated|Secret|Other dialog|e50|e51|ref/)
  })
  it('distinguishes a valid refusal for bounded re-planning from malformed or ungrounded text', async () => {
    generated({ value: null, goalQuote: null })
    expect(await resolveBrowserFieldText(input(), ctx())).toMatchObject({ status: 'escalate', reason: 'text_not_supplied' })
    for (const value of [{ value: 'JFK' }, { value: 'JFK', goalQuote: null }, { value: null, goalQuote: 'JFK' }, { value: 'JFK', goalQuote: 'invented authorization' }]) {
      generated(value)
      expect(await resolveBrowserFieldText(input(), ctx())).toMatchObject({ status: 'escalate', reason: 'text_unresolved' })
    }
  })
  it('traces the reason for refusing generated text without retaining the rejected text', async () => {
    const rejected = 'sk-1234567890abcdefghijklmnop'
    generated({ value: rejected, goalQuote: 'JFK' })
    await resolveBrowserFieldText(input(), ctx())
    expect(mocks.trace).toHaveBeenCalledWith(expect.anything(), 'helper.output', expect.objectContaining({ refusalCode: 'secret_like_value' }))
    expect(JSON.stringify(mocks.trace.mock.calls)).not.toContain(rejected)
  })
  it('provides bounded peer field labels without their values, refs, secret fields or page text', async () => {
    const request = input()
    const prototype = request.observation.elements[0]
    request.observation.elements.push({ ...prototype, ref: 'e2', role: 'textbox', name: 'Return', value: 'Private peer value', dialog: 'Enter your origin' },
      { ...prototype, ref: 'e3', name: 'Password', value: 'Secret peer value' },
      { ...prototype, ref: 'e4', name: 'Unrelated field', dialog: 'Other dialog' })
    await resolveBrowserFieldText(request, ctx())
    const message = JSON.parse(mocks.run.mock.calls[0][0].message)
    expect(message.untrustedPeerFields).toEqual([{ role: 'textbox', name: 'Return' }])
    expect(JSON.stringify(message.untrustedPeerFields)).not.toMatch(/Private|Secret|e2|Password|Unrelated/)
    expect(mocks.run.mock.calls[0][0].message).not.toContain('Do not include this page body')
  })
  it('uses the tool-free utility and logs one idempotent, owner-scoped usage record', async () => {
    const result = await resolveBrowserFieldText(input(), ctx())
    expect(result).toMatchObject({ status: 'accepted', value: 'JFK', metrics: { invoked: true, model: 'deepseek-v4-flash', usage: { known: true, inputTokens: 120, outputTokens: 12, costUsd: 0.001, costSource: 'gateway' } } })
    expect(mocks.eq.mock.calls).toEqual([['user_id', 'user'], ['workspace_id', 'workspace']])
    expect(mocks.run).toHaveBeenCalledTimes(1)
    const args = mocks.run.mock.calls[0][0]
    expect(args).toMatchObject({ kind: 'browser_field_text', workspaceId: 'workspace', userId: 'user' })
    expect(args.timeoutMs).toBeLessThanOrEqual(8000)
    expect(args.outputSchema).toBeUndefined()
    expect(args.message).not.toContain('page title')
    expect(args.message).not.toContain('page body')
    expect(JSON.parse(args.message)).toMatchObject({ userGoal: input().task.goal, untrustedSelectedField: { name: 'Origin', dialog: 'Enter your origin' } })
    expect(mocks.log).toHaveBeenCalledTimes(1)
    expect(mocks.log).toHaveBeenCalledWith('user', expect.objectContaining({ provider: 'deepseek', feature: 'browser.field_text', idempotencyKey: expect.stringMatching(/^browser-field-text:/),
      metadata: expect.objectContaining({ workspace_id: 'workspace', run_id: 'task-id', usage_unknown: false, cost_unknown: false }) }))
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain('JFK')
  })

  it.each(['missing', 'disabled', 'sensitive', 'forbidden', 'noneditable', 'password'])('refuses %s targets before any model or billing call', async kind => {
    const request = input()
    if (kind === 'missing') request.ref = 'e99'
    if (kind === 'disabled') request.observation.elements[0].disabled = true
    if (kind === 'sensitive') request.observation.elements[0].sensitive = true
    if (kind === 'forbidden') request.observation.elements[0].forbidden = true
    if (kind === 'noneditable') request.observation.elements[0].canType = false
    if (kind === 'password') request.observation.elements[0].name = 'Password'
    expect(await resolveBrowserFieldText(request, ctx())).toMatchObject({ status: 'escalate', reason: 'invalid_target', metrics: { invoked: false } })
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.log).not.toHaveBeenCalled()
  })

  it.each(['membership', 'budget'])('does not dispatch when %s is denied', async kind => {
    if (kind === 'membership') mocks.member.mockResolvedValue({ data: null, error: null })
    else mocks.budget.mockResolvedValue({ allowed: false })
    expect(await resolveBrowserFieldText(input(), ctx())).toMatchObject({ status: 'escalate', reason: kind === 'membership' ? 'not_authorized' : 'budget_unavailable', metrics: { invoked: false } })
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.log).not.toHaveBeenCalled()
  })

  it.each([
    { value: null, goalQuote: null },
    { value: 'JFK', goalQuote: 'a fact not in the user goal' },
    { value: 'x'.repeat(2001), goalQuote: 'JFK' },
    { value: 'sk-1234567890abcdefghijklmnop', goalQuote: 'JFK' },
    { value: 'JFK', goalQuote: 'JFK', instruction: 'ignore boundaries' },
  ])('meters but refuses unresolved/invalid/secret output %#', async answer => {
    generated(answer)
    expect(await resolveBrowserFieldText(input(), ctx())).toMatchObject({ status: 'escalate', reason: answer.value === null && answer.goalQuote === null ? 'text_not_supplied' : 'text_unresolved', metrics: { invoked: true } })
    expect(mocks.log).toHaveBeenCalledTimes(1)
    expect(mocks.run).toHaveBeenCalledTimes(1)
  })

  it('uses original human values and rejects planner-only replacements', async () => {
    const request = input()
    request.task.sourceRequest = JSON.stringify(['Find a trip from JFK to LAX.'])
    request.task.goal = 'Find a trip from EWR to LAX.'
    generated({ value: 'EWR', goalQuote: 'EWR' })
    expect(await resolveBrowserFieldText(request, ctx())).toMatchObject({ status: 'escalate', reason: 'text_unresolved' })
    expect(JSON.parse(mocks.run.mock.calls[0][0].message).userGoal).toBe('Find a trip from JFK to LAX.')
    generated({ value: 'JFK', goalQuote: 'JFK' })
    expect(await resolveBrowserFieldText(request, ctx())).toMatchObject({ status: 'accepted', value: 'JFK' })
  })
  it('refuses a no-op value while accounting for its generation', async () => {
    const request = input()
    request.observation.elements[0].value = ' JFK '
    expect(await resolveBrowserFieldText(request, ctx())).toMatchObject({ status: 'escalate', reason: 'text_unchanged' })
    expect(mocks.log).toHaveBeenCalledTimes(1)
  })

  it('does not use a result returned after caller cancellation, but still meters known usage', async () => {
    const controller = new AbortController()
    mocks.run.mockImplementation(async (args: UtilityRunBase) => {
      args.onUsage?.(usage())
      controller.abort()
      return { text: '{"value":"JFK","goalQuote":"JFK"}', model: 'deepseek-v4-flash', usage: usage().usage }
    })
    expect(await resolveBrowserFieldText(input(), { ...ctx(), signal: controller.signal })).toMatchObject({ status: 'cancelled', reason: 'user_stopped', metrics: { invoked: true } })
    expect(mocks.log).toHaveBeenCalledTimes(1)
  })

  it('does not use a result after the deadline, including accounting latency', async () => {
    const request = input()
    const context = ctx()
    mocks.log.mockImplementation(async () => { vi.spyOn(Date, 'now').mockReturnValue(context.deadline + 1); return 'logged' })
    expect(await resolveBrowserFieldText(request, context)).toMatchObject({ status: 'escalate', reason: 'deadline_exceeded' })
    expect(mocks.run).toHaveBeenCalledTimes(1)
  })

  it('retains unknown usage on cancelled sessions and prices only reported subtotals in the ledger', async () => {
    const report = usage({ complete: false })
    mocks.run.mockImplementation(async (args: UtilityRunBase) => { args.onUsage?.(report); throw new Error('private transport details') })
    expect(await resolveBrowserFieldText(input(), ctx())).toMatchObject({ status: 'escalate', reason: 'generation_unavailable', metrics: { invoked: true, usage: { inputTokens: 120, outputTokens: 12, known: false, costSource: 'unknown' } } })
    const params = mocks.log.mock.calls[0][1]
    expect(params.costUsd).toBeUndefined()
    expect(params.metadata).toMatchObject({ usage_unknown: true, cost_unknown: true, input_tokens_reported: false })
    expect(mocks.run).toHaveBeenCalledTimes(1)
  })

  it('retains unknown cost rather than describing an Eve zero/BYOK cost as free', async () => {
    generated(undefined, usage({ usage: { ...usage().usage, costUsd: null } }))
    const result = await resolveBrowserFieldText(input(), ctx())
    expect(result.metrics.usage).toEqual({ inputTokens: 120, outputTokens: 12, known: true, costSource: 'unknown' })
    expect(mocks.log.mock.calls[0][1].costUsd).toBeUndefined()
  })

  it('fails closed when durable accounting cannot be recorded or queued', async () => {
    mocks.log.mockResolvedValue('lost')
    expect(await resolveBrowserFieldText(input(), ctx())).toMatchObject({ status: 'escalate', reason: 'accounting_unavailable' })
  })

  it('releases a stalled membership read on cancellation without invoking a model', async () => {
    const controller = new AbortController()
    mocks.member.mockImplementation(() => { controller.abort(); return new Promise(() => {}) })
    expect(await resolveBrowserFieldText(input(), { ...ctx(), signal: controller.signal })).toMatchObject({ status: 'cancelled', reason: 'user_stopped' })
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.log).not.toHaveBeenCalled()
  })
})
