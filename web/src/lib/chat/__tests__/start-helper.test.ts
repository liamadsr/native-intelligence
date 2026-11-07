/**
 * Background helpers (always-on-agent §4, A4 slice 4): start_helper's
 * admission, mirror and dispatch; stop_helper on the Stop button's path; and
 * Jev's helper.choice in shadow. (The RPC itself is migration 332; its text is
 * pinned in src/lib/work/__tests__/migration-332.test.ts.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHECK_IN_HELPER_MODEL,
  checkInHelperModel,
  genericHelperCandidate,
  helperCandidates,
  recoverQueuedChatHelpers,
  renderHelperTask,
  shadowHelperChoice,
  startChatHelper,
  startServerHelper,
  stopChatHelper,
  type ChatHelperLaunch,
} from '../start-helper'
import { createChatHelperTools, startHelperSchema } from '@/lib/ai/tools/chat-helpers'
import { ceilingForWorkRun, computeDraftingCeiling, runStartSection, serverHelperChatCeiling, snapshotChatCeiling, SERVER_HELPER_WRITE_TOOLS } from '@/lib/agent-run/run-work-spec-rebuild'
import { getToolSideEffect } from '@/lib/ai/tool-registry'
import { GENERIC_HELPER_ID } from '@/lib/ai/decisions/tasks/helper-choice'
import type { ChatRunTokenClaims } from '../chat-run-token'
import { nowLineHash } from '@/lib/now/now-file'
import { helperModelEntry } from '@/lib/ai/models'

const h = vi.hoisted(() => ({ mirror: vi.fn(), snapshot: vi.fn(), ownItem: vi.fn(), reach: vi.fn(), paused: vi.fn() }))
vi.mock('@/lib/work/agent-paused', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/work/agent-paused')>()),
  helperStartPaused: h.paused,
}))
vi.mock('@/lib/work/agent-run-mirror', () => ({ ensureWorkForAgentRun: h.mirror }))
vi.mock('@/lib/work/start-work-item', () => ({ snapshotResources: h.snapshot, workRunDispatchEventId: (id: string) => `work-run-requested:${id}` }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/bots/bot-work-server', () => ({ findOwnItem: h.ownItem }))
vi.mock('@/lib/chat/teammate-access', () => ({ callerReachableTeammateIds: h.reach }))

const claims = { userId: 'owner', workspaceId: 'workspace', conversationId: 'conversation' } as ChatRunTokenClaims
const input = { task: 'Find pricing', context: 'Acme', hand_back: 'A sourced document' }
const at = (callId: string, extra: Partial<ChatHelperLaunch> = {}): ChatHelperLaunch => ({ callId, turnId: 'turn-1', sessionId: 'wrun_1', chatCeiling: null, ...extra })

function db(opts: { result?: unknown; error?: unknown; status?: string; readError?: unknown; teammate?: string | null } = {}) {
  const rpc = vi.fn().mockResolvedValue({ data: opts.result ?? { run_id: 'run', teammate_id: null, reused: false }, error: opts.error ?? null })
  const row = { id: 'run', workspace_id: 'workspace', triggered_by: 'owner', chat_conversation_id: 'conversation', task_prompt: 'stored task', origin: 'chat', kind: 'workspace', status: opts.status ?? 'queued', ai_team_member_id: opts.teammate ?? null }
  const c = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: row, error: opts.readError ?? null }) }
  c.select.mockReturnValue(c); c.eq.mockReturnValue(c)
  return { client: { rpc, from: vi.fn().mockReturnValue(c) }, rpc, c, row }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  h.mirror.mockResolvedValue({ id: 'item', inert: false })
  h.snapshot.mockResolvedValue([])
  h.ownItem.mockResolvedValue(null)
  h.paused.mockResolvedValue(false)
})

describe('startServerHelper (A6 slice 5)', () => {
  const start = { kind: 'meeting_prep' as const, workspaceId: 'workspace', userId: 'owner', conversationId: 'conversation', scope: 'meeting-prep', subject: 'cap-1', callId: 'prep' }

  it('admits through the same RPC under its own key, with the drafting ceiling and its own task; mirrors with the capture, muted', async () => {
    const f = db(); const send = vi.fn().mockResolvedValue({}); const mute = vi.fn()
    h.mirror.mockResolvedValue({ id: 'item', inert: false, mute })
    const out = await startServerHelper(f.client as never, { ...start, sourceCaptureId: 'cap-1', quiet: true, taskPrompt: 'Prep it.' }, input, { send })
    expect(f.rpc).toHaveBeenCalledWith('start_chat_helper', expect.objectContaining({
      p_user_id: 'owner', p_workspace_id: 'workspace', p_conversation_id: 'conversation',
      p_turn_id: 'meeting-prep:cap-1', p_call_id: 'prep', p_teammate_id: null, p_task_prompt: 'Prep it.', p_server_helper: 'meeting_prep',
    }))
    expect((f.rpc.mock.calls[0][1] as { p_chat_ceiling: string[] }).p_chat_ceiling).toEqual(serverHelperChatCeiling())
    expect(h.mirror).toHaveBeenCalledWith(f.client, { ...f.row, source_capture_id: 'cap-1' })
    expect(mute).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledOnce()
    expect(out).toMatchObject({ status: 'started', run_id: 'run', work_item_id: 'item' })
  })

  it('a server start is held to Think: its tier decision carries maxTier think and no person\'s message', async () => {
    const f = db(); const decideTier = vi.fn().mockResolvedValue({ route: { tier: 'think', by: 'cap', signals: ['server_start'] }, undecided: false })
    await startServerHelper(f.client as never, start, input, { send: vi.fn(), decideTier })
    expect(decideTier).toHaveBeenCalledWith(f.client, expect.objectContaining({ maxTier: 'think', defaultTier: 'think' }))
    expect(decideTier.mock.calls[0][1]).not.toHaveProperty('turnExcerpt')
  })

  it('a refusal is the RPC’s code and reason; a key that could parse two ways is refused before it', async () => {
    const f = db({ result: { code: 'LIVE_HELPERS' } })
    expect(await startServerHelper(f.client as never, start, input, { send: vi.fn() })).toMatchObject({ status: 'refused', code: 'LIVE_HELPERS' })
    expect(h.mirror).not.toHaveBeenCalled()
    await expect(startServerHelper(f.client as never, { ...start, subject: 'a:b' }, input)).rejects.toThrow()
    await expect(startServerHelper(f.client as never, { ...start, callId: '' }, input)).rejects.toThrow()
  })
})

describe('start_helper', () => {
  it('calls start_chat_helper with token tenancy, eve ids, no teammate by default, the areas and the chat bound; mirrors then dispatches', async () => {
    const f = db(); const send = vi.fn().mockResolvedValue({})
    const out = await startChatHelper(f.client as never, claims, at('eve-call'), { ...input, areas: ['crm', 'crm', 'mail'] as never }, { send })
    expect(f.rpc).toHaveBeenCalledWith('start_chat_helper', expect.objectContaining({
      p_user_id: 'owner', p_workspace_id: 'workspace', p_conversation_id: 'conversation',
      p_turn_id: 'wrun_1:turn-1', p_call_id: 'eve-call', p_teammate_id: null, p_expects: [], p_areas: ['crm', 'mail'],
    }))
    const args = f.rpc.mock.calls[0][1] as { p_task_prompt: string; p_chat_ceiling: string[] }
    expect(args.p_task_prompt).toContain('Find pricing')
    expect(args.p_task_prompt).toContain('### Context\nAcme')
    expect(args.p_task_prompt).toContain('### What to hand back\nA sourced document')
    expect(args.p_chat_ceiling).toEqual([...computeDraftingCeiling()].sort())
    expect(h.mirror).toHaveBeenCalledWith(f.client, f.row)
    expect(f.c.eq.mock.calls).toEqual([['id', 'run'], ['workspace_id', 'workspace'], ['triggered_by', 'owner'], ['chat_conversation_id', 'conversation']])
    expect(h.mirror.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0])
    expect(send).toHaveBeenCalledWith({ id: 'work-run-requested:run', name: 'work/run.requested', data: { agent_run_id: 'run', workspace_id: 'workspace' } })
    expect(out).toMatchObject({ status: 'started', run_id: 'run', work_item_id: 'item', reused: false })
    expect(out).not.toHaveProperty('agent_id')
    expect(String(out.note)).toContain('not the completed result')
    expect(String(out.note)).toContain('send_bot_message')
  })

  it('decides the run\'s tier at admission and stores it before dispatch; a replay keeps the first one', async () => {
    const f = db(); const send = vi.fn().mockResolvedValue({})
    const upd = { update: vi.fn(), eq: vi.fn(), is: vi.fn().mockResolvedValue({ error: null }) }
    upd.update.mockReturnValue(upd); upd.eq.mockReturnValue(upd)
    f.client.from.mockReturnValueOnce(upd)
    const decideTier = vi.fn().mockResolvedValue({ route: { tier: 'strong', by: 'rule', signals: ['sql'] }, undecided: false })
    await startChatHelper(f.client as never, claims, at('eve-call', { personMessage: 'use the best model' }), input, { send, decideTier })
    expect(decideTier).toHaveBeenCalledWith(f.client, {
      userId: 'owner', workspaceId: 'workspace', key: 'run:run', surface: 'background_helper',
      task: 'Find pricing\nAcme', turnExcerpt: 'use the best model', defaultTier: 'think',
    })
    // The rules' Strong runs on Sonnet: its roster key is stored beside the tier.
    expect(upd.update).toHaveBeenCalledWith({ model_tier: 'strong', model_tier_by: 'rule', helper_model: 'sonnet' })
    expect(upd.eq.mock.calls).toEqual([['id', 'run'], ['workspace_id', 'workspace']])
    expect(upd.is).toHaveBeenCalledWith('model_tier', null)
    expect(upd.update.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0])

    const replay = db({ result: { run_id: 'run', teammate_id: null, reused: true } })
    const again = vi.fn()
    await startChatHelper(replay.client as never, claims, at('eve-call'), input, { send: vi.fn(), decideTier: again })
    expect(again).not.toHaveBeenCalled()
  })

  it('passes the main agent\'s chosen model, stores the model granted, and names it in the answer', async () => {
    const f = db(); const send = vi.fn().mockResolvedValue({})
    const upd = { update: vi.fn(), eq: vi.fn(), is: vi.fn().mockResolvedValue({ error: null }) }
    upd.update.mockReturnValue(upd); upd.eq.mockReturnValue(upd)
    f.client.from.mockReturnValueOnce(upd)
    const decideTier = vi.fn().mockResolvedValue({ route: { tier: 'fast', by: 'agent', signals: ['chose_haiku'], model: 'haiku' }, undecided: false })
    const out = await startChatHelper(f.client as never, claims, at('eve-call'), { ...input, model: 'haiku' }, { send, decideTier })
    expect(decideTier).toHaveBeenCalledWith(f.client, expect.objectContaining({ requested: 'haiku', defaultTier: 'think' }))
    expect(upd.update).toHaveBeenCalledWith({ model_tier: 'fast', model_tier_by: 'agent', helper_model: 'haiku' })
    expect(out).toMatchObject({ status: 'started', model: 'haiku', model_name: "Claude Haiku 5.5, the main chat's own model" })
  })

  it('before migration 439 it stores the tier alone (no helper_model column, no agent decider)', async () => {
    const f = db(); const send = vi.fn().mockResolvedValue({})
    const first = { update: vi.fn(), eq: vi.fn(), is: vi.fn().mockResolvedValue({ error: { code: 'PGRST204', message: "Could not find the 'helper_model' column of 'agent_run' in the schema cache" } }) }
    first.update.mockReturnValue(first); first.eq.mockReturnValue(first)
    const retry = { update: vi.fn(), eq: vi.fn(), is: vi.fn().mockResolvedValue({ error: null }) }
    retry.update.mockReturnValue(retry); retry.eq.mockReturnValue(retry)
    f.client.from.mockReturnValueOnce(first).mockReturnValueOnce(retry)
    const decideTier = vi.fn().mockResolvedValue({ route: { tier: 'strong', by: 'agent', signals: ['chose_opus'], model: 'opus' }, undecided: false })
    await startChatHelper(f.client as never, claims, at('eve-call'), { ...input, model: 'opus' }, { send, decideTier })
    expect(retry.update).toHaveBeenCalledWith({ model_tier: 'strong', model_tier_by: 'rule' })
  })

  it('a tier that cannot be stored never stops the start (the run reads Think)', async () => {
    const f = db(); const send = vi.fn().mockResolvedValue({})
    const decideTier = vi.fn().mockRejectedValue(new Error('down'))
    const out = await startChatHelper(f.client as never, claims, at('c'), input, { send, decideTier })
    expect(out).toMatchObject({ status: 'started', run_id: 'run' })
    expect(send).toHaveBeenCalledOnce()
  })

  it('a named custom agent rides as p_teammate_id, and the answer names it', async () => {
    const f = db({ result: { run_id: 'run', teammate_id: 'agent-1', teammate_name: 'SDR', reused: false }, teammate: 'agent-1' })
    const out = await startChatHelper(f.client as never, claims, at('c'), { ...input, agent_id: '11111111-1111-4111-8111-111111111111' }, { send: vi.fn() })
    expect((f.rpc.mock.calls[0][1] as { p_teammate_id: string }).p_teammate_id).toBe('11111111-1111-4111-8111-111111111111')
    expect(out).toMatchObject({ agent_id: 'agent-1', agent_name: 'SDR' })
  })

  it('the kill switch: autonomy off refuses AGENT_PAUSED before anything is written (no snapshot, no RPC, no dispatch)', async () => {
    h.paused.mockResolvedValue(true)
    const f = db(); const send = vi.fn()
    const out = await startChatHelper(f.client as never, claims, at('call'), input, { send })
    expect(out).toMatchObject({ status: 'refused', code: 'AGENT_PAUSED' })
    expect(String(out.reason)).toContain('switched off')
    expect(h.paused).toHaveBeenCalledWith(f.client, 'workspace')
    expect(h.snapshot).not.toHaveBeenCalled()
    expect(f.rpc).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('refusals never mirror or dispatch, and each says why in words', async () => {
    for (const code of ['NOT_A_MEMBER', 'CONVERSATION_UNAVAILABLE', 'DAY_BUDGET', 'LIVE_HELPERS', 'CALL_ID_CONFLICT', 'AGENT_NOT_FOUND', 'AGENT_CANNOT_DRAFT', 'AUTONOMY_OFF', 'USAGE_LIMIT', 'INVALID_BRIEF']) {
      const f = db({ result: { code } }); const send = vi.fn()
      const out = await startChatHelper(f.client as never, claims, at('call'), input, { send })
      expect(out).toMatchObject({ status: 'refused', code })
      expect(String(out.reason)).not.toContain('could not be read')
      expect(send).not.toHaveBeenCalled()
    }
    expect(h.mirror).not.toHaveBeenCalled()
  })

  it('fails closed before admission: no call, turn or session id, a device or teammate token, an RPC failure', async () => {
    const f = db(); const send = vi.fn()
    await expect(startChatHelper(f.client as never, claims, at(''), input, { send })).rejects.toThrow('call id')
    for (const turnId of ['', 'a:b', 'x'.repeat(201)]) await expect(startChatHelper(f.client as never, claims, at('c', { turnId }), input, { send })).rejects.toThrow('turn id')
    for (const sessionId of [undefined, '', 'a:b']) await expect(startChatHelper(f.client as never, claims, at('c', { sessionId: sessionId as string }), input, { send })).rejects.toThrow('session id')
    await expect(startChatHelper(f.client as never, { ...claims, surface: 'device_ask' }, at('c'), input, { send })).rejects.toThrow('main chat')
    await expect(startChatHelper(f.client as never, { ...claims, teammateId: 'bot' }, at('c'), input, { send })).rejects.toThrow('main chat')
    await expect(startChatHelper(f.client as never, { ...claims, relay: 'relay-1' }, at('c'), input, { send })).rejects.toThrow('main chat')
    await expect(startChatHelper(f.client as never, { ...claims, server: 'idle_compaction' } as ChatRunTokenClaims, at('c'), input, { send })).rejects.toThrow('main chat')
    expect(f.rpc).not.toHaveBeenCalled()
    await expect(startChatHelper(db({ error: { message: 'no function' } }).client as never, claims, at('c'), input, { send })).rejects.toThrow('safely')
    expect(h.mirror).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
  })

  it('a home turn may start the generic helper (away helpers): its own budget (kind home_turn), its own task, the eve ids as its key', async () => {
    const f = db(); const send = vi.fn().mockResolvedValue({})
    const out = await startChatHelper(f.client as never, { ...claims, server: 'home_turn' } as ChatRunTokenClaims, at('eve-call'), input, { send })
    expect(f.rpc).toHaveBeenCalledWith('start_chat_helper', expect.objectContaining({
      p_user_id: 'owner', p_workspace_id: 'workspace', p_conversation_id: 'conversation',
      p_turn_id: 'wrun_1:turn-1', p_call_id: 'eve-call', p_teammate_id: null, p_server_helper: 'home_turn',
    }))
    const args = f.rpc.mock.calls[0][1] as { p_task_prompt: string; p_chat_ceiling: string[] }
    // Reads plus three review-pile writes: never an in-place write (a published document, a capture, a claim).
    expect(args.p_chat_ceiling).toEqual(serverHelperChatCeiling())
    expect(args.p_task_prompt).toContain('started this on its own')
    expect(args.p_task_prompt).toContain('Never ask the person anything')
    expect(args.p_task_prompt).not.toContain('The person asked for this')
    // The model-written brief is fenced as untrusted data.
    expect(args.p_task_prompt).toContain('[UNTRUSTED WORKSPACE CONTENT')
    expect(args.p_task_prompt.indexOf('Find pricing')).toBeGreaterThan(args.p_task_prompt.indexOf('[UNTRUSTED WORKSPACE CONTENT'))
    expect(send).toHaveBeenCalledOnce()
    expect(out).toMatchObject({ status: 'started', run_id: 'run' })
  })

  it('a home turn never starts a named agent, and the kill switch and the budget refuse it as they do the person', async () => {
    const send = vi.fn()
    const named = db()
    expect(await startChatHelper(named.client as never, { ...claims, server: 'home_turn' } as ChatRunTokenClaims, at('c'), { ...input, agent_id: '11111111-1111-4111-8111-111111111111' }, { send })).toMatchObject({
      status: 'refused',
      code: 'SERVER_TURN_GENERIC_ONLY',
    })
    expect(named.rpc).not.toHaveBeenCalled()
    for (const code of ['SERVER_LIVE', 'SERVER_DAY_BUDGET']) {
      const f = db({ result: { code } })
      expect(await startChatHelper(f.client as never, { ...claims, server: 'home_turn' } as ChatRunTokenClaims, at('c'), input, { send })).toMatchObject({ status: 'refused', code })
    }
    h.paused.mockResolvedValue(true)
    const paused = db()
    expect(await startChatHelper(paused.client as never, { ...claims, server: 'home_turn' } as ChatRunTokenClaims, at('c'), input, { send })).toMatchObject({ status: 'refused', code: 'AGENT_PAUSED' })
    expect(paused.rpc).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('a text starts only the generic helper (the route skips the reviewer for it); a Slack DM may name an agent', async () => {
    const send = vi.fn()
    const named = { ...input, agent_id: '11111111-1111-4111-8111-111111111111' }
    const text = db()
    expect(await startChatHelper(text.client as never, { ...claims, server: 'channel_turn', surface: 'sms' } as ChatRunTokenClaims, at('c'), named, { send })).toMatchObject({
      status: 'refused',
      code: 'TEXT_TURN_GENERIC_ONLY',
    })
    expect(text.rpc).not.toHaveBeenCalled()
    // The generic helper from a text: the person's own helper, not a server one.
    const generic = db()
    await startChatHelper(generic.client as never, { ...claims, server: 'channel_turn', surface: 'sms' } as ChatRunTokenClaims, at('c'), input, { send })
    expect(generic.rpc).toHaveBeenCalledWith('start_chat_helper', expect.objectContaining({ p_teammate_id: null }))
    expect((generic.rpc.mock.calls[0][1] as { p_server_helper?: unknown }).p_server_helper ?? null).toBeNull()
    const slack = db()
    await startChatHelper(slack.client as never, { ...claims, server: 'channel_turn', surface: 'slack' } as ChatRunTokenClaims, at('c'), named, { send })
    expect(slack.rpc).toHaveBeenCalledWith('start_chat_helper', expect.objectContaining({ p_teammate_id: named.agent_id }))
  })

  it('never reports failure once admitted: read, ledger and dispatch failures answer queued for the reaper', async () => {
    const failures: Array<[string, () => { client: unknown; send: ReturnType<typeof vi.fn> }]> = [
      ['read', () => ({ client: db({ readError: { message: 'read failed' } }).client, send: vi.fn() })],
      ['ledger', () => { h.mirror.mockResolvedValueOnce({ id: null, inert: true }); return { client: db().client, send: vi.fn() } }],
      ['dispatch', () => ({ client: db().client, send: vi.fn().mockRejectedValue(new Error('offline')) })],
    ]
    for (const [label, make] of failures) {
      const { client, send } = make()
      const out = await startChatHelper(client as never, claims, at('same'), input, { send })
      expect(out, label).toMatchObject({ status: 'queued', run_id: 'run', reused: false })
      expect(String(out.note), label).toMatch(/do not start it again/i)
      expect(out.work_item_id, label).toBeUndefined()
    }
  })

  it('a completed replay never dispatches again', async () => {
    const send = vi.fn().mockResolvedValue({})
    const complete = db({ status: 'completed', result: { run_id: 'run', reused: true } })
    expect(await startChatHelper(complete.client as never, claims, at('same'), input, { send })).toMatchObject({ status: 'completed', reused: true })
    expect(send).not.toHaveBeenCalled()
  })

  it('records only the drafting tools this chat could call', async () => {
    const f = db(); const send = vi.fn().mockResolvedValue({})
    await startChatHelper(f.client as never, claims, at('c', { chatCeiling: new Set(['create_document', 'get_document', 'create_action', 'mcp__linear__create_issue']) }), input, { send })
    expect((f.rpc.mock.calls[0][1] as { p_chat_ceiling: string[] }).p_chat_ceiling).toEqual(['create_document', 'get_document'])
  })

  it('has no generic executor; the schema caps areas at two known ones', () => {
    const tools = createChatHelperTools()
    expect(tools.start_helper.execute).toBeUndefined()
    expect(tools.stop_helper.execute).toBeUndefined()
    expect(startHelperSchema.safeParse({ task: 'x', areas: ['crm', 'mail'] }).success).toBe(true)
    expect(startHelperSchema.safeParse({ task: 'x', areas: ['crm', 'mail', 'actions'] }).success).toBe(false)
    expect(startHelperSchema.safeParse({ task: 'x', areas: ['nope'] }).success).toBe(false)
    expect(startHelperSchema.safeParse({ task: 'x', areas: [] }).success).toBe(false)
  })

  it('the task tells the helper it reports back to the assistant, and the run prompt carries the promotion rule', () => {
    expect(renderHelperTask({ task: 'Do it' })).toMatch(/report, and waits for their review/)
    const prompt = runStartSection('chat')
    expect(prompt).toContain('background helper')
    expect(prompt).toMatch(/becomes an action only when it needs a person, is a commitment for later, spans days or another owner, or the person asked for a task/)
    expect(prompt).toContain('suggest_changes')
    expect(prompt).not.toContain('Needs you')
  })
})

describe('a helper with no agent is the drafting ceiling bounded by the chat; a named agent keeps its limits', () => {
  it('no teammate: drafting tools within the chat bound, never a board write or a chat-native tool', () => {
    const ceiling = ceilingForWorkRun('chat', null, snapshotChatCeiling(null))
    expect([...ceiling].sort()).toEqual([...computeDraftingCeiling()].sort())
    expect(ceiling).not.toContain('create_action')
    expect(ceiling).not.toContain('start_helper')
    expect(ceiling).toContain('create_document')
  })
  it('a read-only custom agent narrows it to reads', () => {
    expect(ceilingForWorkRun('chat', { allowed_side_effects: ['read'] }, snapshotChatCeiling(null))).not.toContain('create_document')
  })
  it('a restricted persona chat bounds it', () => {
    const bounded = ceilingForWorkRun('chat', null, snapshotChatCeiling(new Set(['create_document', 'get_document', 'find'])))
    expect([...bounded].sort()).toEqual(['create_document', 'find', 'get_document'])
  })
})

describe('stop_helper', () => {
  const RUN = '44444444-4444-4444-8444-444444444444'
  const ITEM = '11111111-1111-4111-8111-111111111111'
  function runDb(run: Record<string, unknown> | null) {
    const c = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: run, error: null }) }
    c.select.mockReturnValue(c); c.eq.mockReturnValue(c)
    return { client: { from: vi.fn().mockReturnValue(c) }, c }
  }

  it('stops the run behind one of the caller\'s own items, on the Stop button\'s path, fenced on the caller and workspace', async () => {
    h.ownItem.mockResolvedValue({ kind: 'row', row: { agent_run_id: RUN, source: null }, bot: null })
    const f = runDb({ id: RUN, status: 'running', kind: 'workspace', origin: 'chat', chat_conversation_id: 'conversation' })
    const requestCancel = vi.fn().mockResolvedValue(true)
    const out = await stopChatHelper(f.client as never, claims, { job: ITEM }, { requestCancel })
    expect(requestCancel).toHaveBeenCalledWith({ runId: RUN, workspaceId: 'workspace' })
    expect(f.c.eq.mock.calls).toEqual([['id', RUN], ['workspace_id', 'workspace'], ['triggered_by', 'owner'], ['origin', 'chat'], ['chat_conversation_id', 'conversation']])
    expect(out).toMatchObject({ status: 'stopping', run_id: RUN })
  })

  it('takes a run id directly; a finished run says so and nothing is cancelled', async () => {
    const requestCancel = vi.fn()
    expect(await stopChatHelper(runDb({ id: RUN, status: 'completed', kind: 'workspace', origin: 'chat', chat_conversation_id: 'conversation' }).client as never, claims, { job: RUN }, { requestCancel })).toMatchObject({ status: 'already_finished' })
    expect(await stopChatHelper(runDb({ id: RUN, status: 'canceling', kind: 'workspace', origin: 'chat', chat_conversation_id: 'conversation' }).client as never, claims, { job: RUN }, { requestCancel })).toMatchObject({ status: 'stopping' })
    expect(requestCancel).not.toHaveBeenCalled()
  })

  it('refuses a run that is not the caller\'s, not a work run, a card, junk, or a surface token', async () => {
    const requestCancel = vi.fn()
    expect(await stopChatHelper(runDb(null).client as never, claims, { job: RUN }, { requestCancel })).toMatchObject({ status: 'refused', code: 'NOT_FOUND' })
    expect(await stopChatHelper(runDb({ id: RUN, status: 'running', kind: 'coding' }).client as never, claims, { job: RUN }, { requestCancel })).toMatchObject({ status: 'refused', code: 'NOT_FOUND' })
    h.ownItem.mockResolvedValueOnce({ kind: 'card', card: {}, bot: null })
    expect(await stopChatHelper(runDb(null).client as never, claims, { job: ITEM }, { requestCancel })).toMatchObject({ status: 'refused', code: 'NOT_A_HELPER' })
    expect(await stopChatHelper(runDb(null).client as never, claims, { job: 'nope' }, { requestCancel })).toMatchObject({ status: 'refused', code: 'NOT_FOUND' })
    expect(await stopChatHelper(runDb(null).client as never, { ...claims, surface: 'device_ask' }, { job: RUN }, { requestCancel })).toMatchObject({ status: 'refused', code: 'NOT_MAIN_CHAT' })
    expect(await stopChatHelper(runDb(null).client as never, { ...claims, server: 'home_turn' } as ChatRunTokenClaims, { job: RUN }, { requestCancel })).toMatchObject({ status: 'refused', code: 'NOT_MAIN_CHAT' })
    expect(await stopChatHelper(runDb(null).client as never, { ...claims, relay: 'relay-1' }, { job: RUN }, { requestCancel })).toMatchObject({ status: 'refused', code: 'NOT_MAIN_CHAT' })
    // A run the person started from a Start button, a loop, or another chat's helper: not this conversation's helper.
    for (const run of [
      { id: RUN, status: 'running', kind: 'workspace', origin: 'user', chat_conversation_id: null },
      { id: RUN, status: 'running', kind: 'workspace', origin: 'chat', chat_conversation_id: 'another-conversation' },
    ]) {
      expect(await stopChatHelper(runDb(run).client as never, claims, { job: RUN }, { requestCancel }), JSON.stringify(run)).toMatchObject({ status: 'refused', code: 'NOT_FOUND' })
    }
    expect(requestCancel).not.toHaveBeenCalled()
  })
})

describe('helper.choice in shadow', () => {
  const agent = (id: string, over: Record<string, unknown> = {}) => ({
    id, workspace_id: 'workspace', name: `Agent ${id}`, team_id: 'team', allowed_side_effects: ['read', 'internal-write'],
    agent: { description: `Does ${id} things` }, ai_team_member_skill: [{ sort_order: 1, skill: { name: 'Skill B' } }, { sort_order: 0, skill: { name: 'Skill A' } }], ...over,
  })
  function agentsDb(rows: unknown[]) {
    const c: Record<string, ReturnType<typeof vi.fn>> = {}
    for (const n of ['select', 'eq', 'neq', 'order']) c[n] = vi.fn().mockReturnValue(c)
    c.limit = vi.fn().mockResolvedValue({ data: rows, error: null })
    return { client: { from: vi.fn().mockReturnValue(c) }, c }
  }

  it('candidates: the general helper first, then each reachable custom agent that may draft, skills in order', async () => {
    h.reach.mockResolvedValue(new Set(['a1', 'a3']))
    const f = agentsDb([agent('a1'), agent('a2'), agent('a3'), agent('a4', { allowed_side_effects: ['read'] })])
    const out = await helperCandidates(f.client as never, claims, ['crm'])
    expect(out.map((c) => c.id)).toEqual([GENERIC_HELPER_ID, 'a1', 'a3'])
    expect(out[0]).toMatchObject({ name: 'General helper', skills: ['CRM playbook'] })
    expect(out[1]).toMatchObject({ name: 'Agent a1', description: 'Does a1 things', skills: ['Skill A', 'Skill B'] })
    expect(f.c.neq.mock.calls).toEqual([['is_system', true], ['autonomy', 'off']])
  })

  it('runs only with two or more candidates, after the answer, in shadow, never blocking', async () => {
    const decide = vi.fn().mockResolvedValue({ status: 'accepted' })
    const deferred: Promise<unknown>[] = []
    const defer = (w: Promise<unknown>) => { deferred.push(w) }
    shadowHelperChoice({ supabase: {} as never, claims, input: { task: 'Research leads' }, runId: 'run' }, { candidates: async () => [genericHelperCandidate(null)], decide, defer })
    await Promise.all(deferred)
    expect(decide).not.toHaveBeenCalled()

    const sdr = { id: 'a1', name: 'SDR', description: 'Prospecting', skills: [] }
    shadowHelperChoice({ supabase: {} as never, claims, input: { task: 'Research leads', agent_id: 'a1' as never }, runId: 'run' }, { candidates: async () => [genericHelperCandidate(null), sdr], decide, defer })
    await Promise.all(deferred)
    expect(decide).toHaveBeenCalledWith(
      { task: 'Research leads', picked: 'a1', candidates: [genericHelperCandidate(null), sdr] },
      { userId: 'owner', workspaceId: 'workspace', runId: 'run' },
    )
  })

  it('asks the tier question only when the tier rules could not tell: on helper.choice v2, or model.tier alone with one candidate', async () => {
    const decide = vi.fn().mockResolvedValue({ status: 'accepted' })
    const decideTier = vi.fn().mockResolvedValue({ status: 'accepted' })
    const deferred: Promise<unknown>[] = []
    const defer = (w: Promise<unknown>) => { deferred.push(w) }
    const sdr = { id: 'a1', name: 'SDR', description: 'Prospecting', skills: [] }
    // "Plan the offsite" is neither clearly Strong nor clearly Fast work.
    shadowHelperChoice({ supabase: {} as never, claims, input: { task: 'Plan the offsite' }, runId: 'run' }, { candidates: async () => [genericHelperCandidate(null)], decide, decideTier, defer })
    shadowHelperChoice({ supabase: {} as never, claims, input: { task: 'Plan the offsite', agent_id: 'a1' as never }, runId: 'run' }, { candidates: async () => [genericHelperCandidate(null), sdr], decide, decideTier, defer })
    await Promise.all(deferred)
    expect(decideTier).toHaveBeenCalledWith('Plan the offsite', { userId: 'owner', workspaceId: 'workspace', runId: 'run' })
    expect(decide).toHaveBeenCalledWith(
      { task: 'Plan the offsite', picked: 'a1', candidates: [genericHelperCandidate(null), sdr], askTier: true },
      { userId: 'owner', workspaceId: 'workspace', runId: 'run' },
    )
    // A clearly Strong task asks no tier question (the rules decided it).
    decideTier.mockClear()
    shadowHelperChoice({ supabase: {} as never, claims, input: { task: 'Fix the bug in src/lib/a.ts' }, runId: 'run' }, { candidates: async () => [genericHelperCandidate(null)], decide, decideTier, defer })
    await Promise.all(deferred)
    expect(decideTier).not.toHaveBeenCalled()
  })

  it('a failure inside the shadow is swallowed', async () => {
    const deferred: Promise<unknown>[] = []
    shadowHelperChoice({ supabase: {} as never, claims, input: { task: 'x' }, runId: 'run' }, { candidates: async () => { throw new Error('db down') }, defer: (w) => { deferred.push(w) } })
    await expect(Promise.all(deferred)).resolves.toBeDefined()
  })
})

describe('queued-helper crash recovery', () => {
  it('only scans never-started queued roots, repairs the ledger, and sends stable events', async () => {
    const f = db(); const send = vi.fn().mockResolvedValue({})
    const runQuery: Record<string, ReturnType<typeof vi.fn>> = {}
    for (const name of ['select', 'eq', 'is', 'lt', 'order']) runQuery[name] = vi.fn().mockReturnValue(runQuery)
    runQuery.limit = vi.fn().mockResolvedValue({ data: [f.row], error: null })
    const policyQuery = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: { settings: {} }, error: null }) }
    policyQuery.select.mockReturnValue(policyQuery); policyQuery.eq.mockReturnValue(policyQuery)
    const client = { from: vi.fn((table: string) => table === 'agent_run' ? runQuery : policyQuery) }
    expect(await recoverQueuedChatHelpers(client as never, Date.parse('2026-10-01T00:00:00Z'), { send })).toBe(1)
    expect(runQuery.eq.mock.calls).toEqual([['origin', 'chat'], ['kind', 'workspace'], ['status', 'queued']])
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: 'work-run-requested:run' }))
    policyQuery.maybeSingle.mockResolvedValue({ data: { settings: { agent_autonomy: { mode: 'off' } } }, error: null })
    expect(await recoverQueuedChatHelpers(client as never, Date.now(), { send })).toBe(0)
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('a server-started helper\'s ceiling (A6 review: read and draft only)', () => {
  it('reads plus create_email_draft, create_document and propose_document_edit; no in-place write; the run is bound to it', () => {
    const bound = serverHelperChatCeiling()
    for (const name of bound) expect([name, getToolSideEffect(name) === 'read' || SERVER_HELPER_WRITE_TOOLS.includes(name)]).toEqual([name, true])
    for (const name of SERVER_HELPER_WRITE_TOOLS) expect(bound).toContain(name)
    for (const name of ['update_document', 'edit_document_content', 'edit_document_lines', 'replace_section', 'append_to_section', 'remove_section', 'insert_section_after', 'restore_document_revision', 'edit_capture_content', 'update_capture', 'confirm_claim', 'dismiss_claim', 'supersede_claim', 'attach_chat_file', 'create_capture', 'tell_note_taker']) {
      expect(bound).not.toContain(name)
      // The run's ceiling (origin chat, bound to it) never holds one either.
      expect(ceilingForWorkRun('chat', null, bound).has(name)).toBe(false)
    }
    expect(ceilingForWorkRun('chat', null, bound).has('create_email_draft')).toBe(true)
  })
})

describe('start_helper from a check-in (docs/plans/now-file.md, migration 443)', () => {
  const W = '66666666-6666-4666-8666-666666666666'
  const LINE = '- Retrying the API docs run (Oct 26)'
  const NOTE_ROW = {
    id: 'doc-now',
    workspace_id: 'workspace',
    created_by: 'm-1',
    content: ['## In flight', LINE].join('\n'),
    revision: 2,
    frontmatter: { now: { tracks: [{ kind: 'work', id: W, hash: nowLineHash(LINE), added_at: '' }] } },
    updated_at: '2026-10-27T09:00:00.000Z',
  }
  const checkIn = { ...claims, server: 'home_turn', homeTurnReason: 'check_in' } as ChatRunTokenClaims

  /** The RPC, the person's member row and Now file, the stored run, and the tier's write. */
  function checkInDb(result: unknown = { run_id: 'run', teammate_id: null, reused: false }) {
    const rpc = vi.fn().mockResolvedValue({ data: result, error: null })
    const run = { id: 'run', workspace_id: 'workspace', triggered_by: 'owner', chat_conversation_id: 'conversation', task_prompt: 'stored', origin: 'chat', kind: 'workspace', status: 'queued', ai_team_member_id: null }
    const updates: Array<Record<string, unknown>> = []
    const from = vi.fn((table: string) => {
      const chain: Record<string, unknown> = {}
      for (const op of ['select', 'eq', 'neq']) chain[op] = () => chain
      chain.update = (u: Record<string, unknown>) => (updates.push(u), chain)
      chain.is = async () => ({ error: null })
      chain.maybeSingle = async () => ({ data: table === 'member' ? { id: 'm-1' } : table === 'document' ? NOTE_ROW : run, error: null })
      return chain
    })
    return { client: { rpc, from }, rpc, updates }
  }

  it('is kind check_in, names its tracked item, starts from the server-turn brief and the drafting bound, and runs light, fixed in code', async () => {
    for (const [model, runsOn] of [['sonnet', 'flash'], ['opus', 'flash'], ['flash-thinking', 'flash'], ['haiku', 'haiku'], [undefined, 'flash']] as const) {
      const f = checkInDb()
      const decideTier = vi.fn()
      await startChatHelper(f.client as never, checkIn, at('call'), { ...input, item: `work:${W}`, ...(model ? { model } : {}) }, { send: vi.fn(), decideTier })
      const args = f.rpc.mock.calls[0][1] as Record<string, unknown>
      expect([model, args.p_server_helper, args.p_server_helper_item]).toEqual([model, 'check_in', `work:${W}`])
      expect(args.p_chat_ceiling).toEqual(serverHelperChatCeiling())
      expect(String(args.p_task_prompt)).toContain('started this on its own')
      // Never the rules' tier: no decision, the light model stored as fixed.
      expect(decideTier).not.toHaveBeenCalled()
      expect([model, f.updates[0]]).toEqual([model, { model_tier: 'fast', model_tier_by: 'fixed', helper_model: runsOn }])
    }
    expect(checkInHelperModel(undefined)).toBe(CHECK_IN_HELPER_MODEL)
    expect(helperModelEntry(CHECK_IN_HELPER_MODEL).tier).toBe('fast')
  })

  it('names one item the Now file tracks, or nothing starts (refused before the RPC)', async () => {
    const f = checkInDb()
    expect(await startChatHelper(f.client as never, checkIn, at('call'), input, { send: vi.fn() })).toMatchObject({ status: 'refused', code: 'CHECK_IN_ITEM_REQUIRED' })
    expect(await startChatHelper(f.client as never, checkIn, at('call'), { ...input, item: 'work:someone-elses' }, { send: vi.fn() })).toMatchObject({ status: 'refused', code: 'CHECK_IN_ITEM_UNKNOWN' })
    expect(f.rpc).not.toHaveBeenCalled()
  })

  it('names the item in its one spelling: the same item in another case is the same retry key', async () => {
    const f = checkInDb()
    await startChatHelper(f.client as never, checkIn, at('call'), { ...input, item: ` work:${W.toUpperCase()} ` }, { send: vi.fn() })
    expect((f.rpc.mock.calls[0][1] as Record<string, unknown>).p_server_helper_item).toBe(`work:${W}`)
  })

  it('the caps are migration 443’s, each refusal saying what to do instead', async () => {
    for (const [code, says] of [['SERVER_ITEM_RETRIED', 'Tell the person'], ['SERVER_TURN_BUDGET', 'already started its one helper'], ['SERVER_DAY_BUDGET', 'daily limit'], ['SERVER_LIVE', 'already working']] as const) {
      const f = checkInDb({ code })
      const out = await startChatHelper(f.client as never, checkIn, at('call'), { ...input, item: `work:${W}` }, { send: vi.fn() })
      expect(out).toMatchObject({ status: 'refused', code })
      expect([code, String(out.reason)]).toEqual([code, expect.stringContaining(says)])
    }
  })

  it('any other home turn stays kind home_turn, and an item it names is never sent (the RPC refuses one there)', async () => {
    const f = checkInDb()
    await startChatHelper(f.client as never, { ...claims, server: 'home_turn', homeTurnReason: 'event' } as ChatRunTokenClaims, at('call'), { ...input, item: `work:${W}` }, { send: vi.fn(), decideTier: vi.fn().mockResolvedValue({ route: { tier: 'think', by: 'cap', signals: [] }, undecided: false }) })
    const args = f.rpc.mock.calls[0][1] as Record<string, unknown>
    expect(args.p_server_helper).toBe('home_turn')
    expect(args).not.toHaveProperty('p_server_helper_item')
  })

  it('the tool’s schema takes the item, as a check-in only field', () => {
    expect(startHelperSchema.safeParse({ task: 'x', item: `work:${W}` }).success).toBe(true)
    expect(startHelperSchema.shape.item.description).toContain('Only in your check-in')
  })
})
