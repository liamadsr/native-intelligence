/**
 * A structured connector's run (F3): its session asks for the connector's
 * output schema, the server validates what it committed, and delivery gets
 * the run's provenance from the server (the tools the stream saw), never the
 * model. deliver-connector.ts is mocked: this isolates what the run hands it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { WorkHandle } from '@/lib/work/recorder'

const h = vi.hoisted(() => ({
  deliverConnectorItems: vi.fn(),
  logUsage: vi.fn(async () => {}),
}))

vi.mock('eve/client', () => ({ Client: vi.fn(() => ({})) }))
vi.mock('@/lib/eve/task-session', () => ({ createTaskSession: vi.fn(), cancelTaskSession: vi.fn() }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/ai/system-prompt', () => ({ buildSystemPrompt: async () => '' }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: h.logUsage }))
vi.mock('../deliver-connector', () => ({ deliverConnectorItems: h.deliverConnectorItems }))

const { deliverConnectorRun } = await import('../run-skill')
const { runOutputSchema } = await import('../run-skill-eve')
const { postDraftsOutputSchema, docProposalsOutputSchema } = await import('../output-connectors')
const { verdictOutputSchema } = await import('../verdict-schema')
const { classifyToolRead } = await import('@/lib/safety/outside-text')

const SPEC = {
  runAsUserId: 'user-1',
  workspaceId: 'ws-1',
  skillId: 'skill-1',
  skillName: 'Weekly posts',
  userMessage: 'Run your skill now.',
  model: 'deepseek/deepseek-v4-flash',
  mode: 'report' as const,
  outputContract: 'prose' as const,
  outputConnector: 'post_drafts' as const,
  connectorTarget: { docKey: null, surface: 'x' as const },
  deliver: { to: 'post_drafts' as const },
  provenance: { skillName: 'Weekly posts', captureTitle: 'Acme sync', captureId: 'cap-1', flowId: 'flow-1' },
}

function db(member: boolean = true) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq']) c[m] = () => c
  c.maybeSingle = async () => ({ data: member ? { id: 'm-1' } : null, error: null })
  return { from: () => c } as unknown as SupabaseClient
}

const EVE = (structured: unknown, toolNames: string[] = ['get_capture_content']) => ({
  structured,
  // What the stream tap keeps: each call's name and result, judged.
  toolReads: toolNames.map((n) => classifyToolRead(n, { ok: true })),
  usage: { inputTokens: 100, outputTokens: 20 },
  costUsd: null,
  webSearchCostUsd: null,
  toolCalls: toolNames.length,
  steps: 2,
})

function run(eve: ReturnType<typeof EVE>, extra: { work?: WorkHandle; dryRun?: boolean; member?: boolean } = {}) {
  return deliverConnectorRun({
    supabase: db(extra.member !== false),
    spec: SPEC as never,
    fireId: 'evt-1',
    captureTitle: 'Acme sync',
    actionId: 'a-1',
    startedAt: Date.now(),
    durationMs: 10,
    work: extra.work,
    eve,
    ...(extra.dryRun ? { dryRun: true } : {}),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.deliverConnectorItems.mockResolvedValue({ to: 'post_drafts', delivered: 1, refused: [], summary: '1 X post for you' })
})

describe('the session asks for the right output', () => {
  it('a connector run asks for its connector schema; a verdict run for the verdict; prose for nothing', () => {
    expect(runOutputSchema({ outputContract: 'prose', outputConnector: 'post_drafts' })).toBe(postDraftsOutputSchema)
    expect(runOutputSchema({ outputContract: 'prose', outputConnector: 'doc_proposals' })).toBe(docProposalsOutputSchema)
    expect(runOutputSchema({ outputContract: 'verdict' })).toBe(verdictOutputSchema)
    expect(runOutputSchema({ outputContract: 'prose' })).toBeNull()
  })
})

describe('deliverConnectorRun', () => {
  it('validates, then delivers as the flow owner with the destination from the config', async () => {
    const out = await run(EVE({ posts: [{ text: 'We shipped calendar sync.' }, { text: 'y'.repeat(300) }] }))
    expect(h.logUsage).toHaveBeenCalledTimes(1)
    const [to, items, ctx, refused] = h.deliverConnectorItems.mock.calls[0]
    expect(to).toBe('post_drafts')
    expect(items).toHaveLength(1)
    expect(refused).toEqual(['a post of 300 characters (the limit is 280)'])
    expect(ctx).toMatchObject({ workspaceId: 'ws-1', runAsUserId: 'user-1', memberId: 'm-1', runKey: 'evt-1', flowId: 'flow-1', captureId: 'cap-1', surface: 'x', readOutside: false })
    expect(out).toMatchObject({ status: 'success', response_body_preview: '1 X post for you', delivered: { delivered: 1 } })
  })

  it('a run with no record of its reads fails closed: readOutside', async () => {
    const eve = EVE({ posts: [{ text: 'A post' }] })
    delete (eve as { toolReads?: unknown }).toolReads
    await run(eve)
    expect(h.deliverConnectorItems.mock.calls[0][2]).toMatchObject({ readOutside: true })
  })

  it('the provenance is the stream\'s: a run that searched the web delivers with readOutside', async () => {
    await run(EVE({ posts: [{ text: 'A post' }] }, ['get_capture_content', 'web_search']))
    expect(h.deliverConnectorItems.mock.calls[0][2]).toMatchObject({ readOutside: true })
  })

  it('junk in the wrong shape fails the run and delivers nothing', async () => {
    const out = await run(EVE('Here are your posts: ...'))
    expect(h.deliverConnectorItems).not.toHaveBeenCalled()
    expect(out).toMatchObject({ status: 'failed', error_message: 'The run returned no structured output.' })
  })

  it('a dry run is passed through: nothing is delivered for real', async () => {
    await run(EVE({ posts: [{ text: 'A post' }] }), { dryRun: true })
    expect(h.deliverConnectorItems.mock.calls[0][2]).toMatchObject({ dryRun: true })
  })

  it('the cards carry the run\'s teammate and ledger row', async () => {
    const work = { id: 'job-1', inert: false, aiTeamMemberId: 'tm-1', mute: vi.fn() } as unknown as WorkHandle
    await run(EVE({ posts: [{ text: 'A post' }] }), { work })
    expect(h.deliverConnectorItems.mock.calls[0][2]).toMatchObject({ teammateId: 'tm-1', workItemId: 'job-1' })
  })

  it('an owner who left the workspace gets nothing delivered', async () => {
    const out = await run(EVE({ posts: [{ text: 'A post' }] }), { member: false })
    expect(out.status).toBe('failed')
    expect(h.deliverConnectorItems).not.toHaveBeenCalled()
  })
})
