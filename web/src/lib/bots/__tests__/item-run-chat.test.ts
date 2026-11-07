// @vitest-environment jsdom
/**
 * Items continue their run's chat (bots-v2.md): which of a bot's items have
 * a run whose chat continues them (item-run-chat.ts), for every item kind the
 * bubble pages; the conversation a bot's page finds from an item's row in
 * item view (rowConversation, bots-v4.md Phase 2).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { countByOwner } from '@/lib/work/agent-work-lanes'
import type { LightWorkRow } from '@/lib/work/queries'
import type { WorkItem } from '@/lib/work/types'
import type { BubbleCard, BubbleItem } from '../bubble-items'
import {
  ABOUT_TITLE_CHARS,
  OWN_RUN_SPEAKER,
  aboutLineLabel,
  aboutTitle,
  answerRunQuestion,
  itemAboutRef,
  itemChat,
  itemRunId,
  replyRun,
  rowConversation,
  runChatRefusalLine,
} from '../item-run-chat'

const RUN = '0b6f2c1e-9a4d-4f3e-8c2a-1d5e7f9a0b3c'

function light(id: string, over: Partial<LightWorkRow> = {}): LightWorkRow {
  return {
    id,
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'work_run',
    status: 'needs_review',
    origin: 'user',
    ai_team_member_id: 'writer',
    parent_id: null,
    root_id: null,
    flow_run_id: null,
    agent_run_id: RUN,
    source: { agent_run_id: RUN },
    opened_at: null,
    needs: null,
    created_at: '2026-10-01T08:00:00.000Z',
    teammate: null,
    ...over,
  }
}
const card = (id: string, over: Partial<BubbleCard> = {}) =>
  ({
    id,
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'action_card',
    title: `Card ${id}`,
    why: null,
    payload: { raised_by_ai_member_id: 'writer' },
    proposal_id: null,
    source_flow_run_id: null,
    status: 'pending',
    expires_at: null,
    created_at: '2026-10-01T08:00:00.000Z',
    ...over,
  }) as BubbleCard
const rowItem = (row: LightWorkRow | WorkItem): BubbleItem => ({ kind: 'row', id: row.id, row })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('which items continue a run’s chat', () => {
  it('a work run waiting on review: its run, replies go there (any origin: asked for, an attempt, a delegation, chat-delegated)', () => {
    for (const origin of ['user', 'attempt', 'delegation', 'chat'] as const) {
      const item = rowItem(light('r1', { origin }))
      expect(itemChat(item)).toEqual({ kind: 'run', itemId: 'r1', runId: RUN, workspaceId: 'w1', asking: false })
      expect(replyRun(item)?.runId).toBe(RUN)
    }
  })

  it('a work run waiting on an answer: Open shows its run (its question), and a reply goes to it as the answer', () => {
    const item = rowItem(light('q1', { status: 'needs_input' }))
    expect(itemChat(item)).toMatchObject({ kind: 'run', runId: RUN, asking: true })
    expect(replyRun(item)).toMatchObject({ runId: RUN, asking: true, workspaceId: 'w1' })
  })

  it('reads the run off the column, else the mirror’s source.agent_run_id; never a value that isn’t an id', () => {
    expect(itemRunId({ agent_run_id: RUN })).toBe(RUN)
    expect(itemRunId({ agent_run_id: null, source: { agent_run_id: 'run-2' } })).toBe('run-2')
    expect(itemRunId({ source: { agent_run_id: '../../etc' } })).toBeNull()
    expect(itemRunId({ agent_run_id: 'a b' })).toBeNull()
    expect(itemRunId({})).toBeNull()
  })

  it('everything else keeps the teammate’s own thread: coding runs, skill and loop runs, cards, and rows with no run', () => {
    expect(itemChat(rowItem(light('c', { kind: 'coding_run' })))).toEqual({ kind: 'none', itemId: 'c', why: 'coding' })
    expect(itemChat(rowItem(light('f', { kind: 'flow_run', agent_run_id: null, source: {} })))).toEqual({ kind: 'none', itemId: 'f', why: 'loop' })
    expect(itemChat(rowItem(light('s', { kind: 'skill_run' })))).toMatchObject({ kind: 'none', why: 'loop' })
    expect(itemChat(rowItem(light('e', { kind: 'email_drafts', agent_run_id: null })))).toEqual({
      kind: 'none',
      itemId: 'e',
      why: 'no-run',
    })
    // A seeded row: a work run with no run behind it.
    expect(itemChat(rowItem(light('seed', { agent_run_id: null, source: {} })))).toMatchObject({ kind: 'none', why: 'no-run' })
    expect(itemChat({ kind: 'card', id: 'k1', card: card('k1') })).toEqual({ kind: 'none', itemId: 'k1', why: 'card' })
    expect(itemChat({ kind: 'card', id: 'k2', card: card('k2', { kind: 'work_proposal' }) })).toMatchObject({ why: 'card' })
    expect(replyRun({ kind: 'card', id: 'k1', card: card('k1') })).toBeNull()
    expect(replyRun(null)).toBeNull()
  })

  it('says why a refused run chat goes to the teammate instead', () => {
    expect(runChatRefusalLine({ status: 409, code: 'NOT_NEEDS_INPUT' }, 'Ada')).toContain('isn’t waiting on an answer')
    expect(runChatRefusalLine({ status: 403, code: 'FORBIDDEN' }, 'Ada')).toBe('Someone else started this run, so this goes to Ada’s own chat.')
    expect(runChatRefusalLine({ status: 409, code: 'NOT_TERMINAL' }, 'Ada')).toContain('still on this')
    expect(runChatRefusalLine({ status: 409, code: 'NO_SESSION' }, 'Ada')).toContain('no chat to continue')
  })

  it('clips a title to one line, and falls back when it’s blank', () => {
    expect(aboutTitle('  Reply to\n Acme  ')).toBe('Reply to Acme')
    expect(aboutTitle('')).toBe('this item')
    const long = aboutTitle('x'.repeat(400))
    expect(long).toHaveLength(ABOUT_TITLE_CHARS)
    expect(long.endsWith('…')).toBe(true)
  })

})

describe('what a message to the teammate’s own thread is about (bots v3 1d, itemAboutRef)', () => {
  const JOB = '77777777-7777-4777-8777-777777777777'
  const C1 = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000011'
  const C2 = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000012'

  it('a run’s batch: its ledger row, else its first card’s run, else that card', () => {
    expect(itemAboutRef({ kind: 'batch', id: `work:${JOB}`, workItemId: JOB, cards: [card(C1), card(C2)] })).toEqual({ workItemId: JOB })
    expect(itemAboutRef({ kind: 'batch', id: 'run:k:f', workItemId: null, cards: [card(C1, { payload: { work_item_id: JOB } }), card(C2)] })).toEqual({ workItemId: JOB })
    expect(itemAboutRef({ kind: 'batch', id: 'run:k:f', workItemId: null, cards: [card(C1), card(C2)] })).toEqual({ cardId: C1 })
  })

  it('a card: the run it names, else itself; a row: itself; never a value that isn’t a uuid', () => {
    expect(itemAboutRef({ kind: 'card', id: C1, card: card(C1, { payload: { work_item_id: JOB } }) })).toEqual({ workItemId: JOB })
    expect(itemAboutRef({ kind: 'card', id: C1, card: card(C1) })).toEqual({ cardId: C1 })
    expect(itemAboutRef(rowItem(light(JOB, { kind: 'flow_run', agent_run_id: null, source: {} })))).toEqual({ workItemId: JOB })
    expect(itemAboutRef({ kind: 'card', id: 'k1', card: card('k1', { payload: { work_item_id: '../etc' } }) })).toBeNull()
    expect(itemAboutRef(rowItem(light('r1')))).toBeNull()
    expect(itemAboutRef(null)).toBeNull()
  })
})

describe('the conversation a bot’s page finds from an item’s row (rowConversation, Phase 2)', () => {
  const ITEM = '7f1c2b7a-5d4e-4c1b-9a8f-0e2d4c6b8a10'

  it('a work run: its agent run’s chat, the item attached for when that chat is refused', () => {
    expect(rowConversation(light(ITEM))).toEqual({ runId: RUN, context: { workItemId: ITEM }, asking: false, workspaceId: 'w1' })
  })

  it('a work run waiting on an answer: asking, so what’s sent answers it', () => {
    expect(rowConversation(light(ITEM, { status: 'needs_input' }))).toMatchObject({ runId: RUN, asking: true })
  })

  it('a loop run that parked its session: its loop chat; one that didn’t, a coding run, a row with no run: the teammate’s thread with the item', () => {
    expect(rowConversation(light(ITEM, { kind: 'flow_run', agent_run_id: null, source: { run_chat: true } }))).toEqual({
      runId: `loop:${ITEM}`,
      context: { workItemId: ITEM },
      asking: false,
      workspaceId: 'w1',
    })
    for (const over of [
      { kind: 'flow_run' as const, agent_run_id: null, source: {} },
      { kind: 'coding_run' as const },
      { agent_run_id: null, source: {} },
    ]) {
      expect(rowConversation(light(ITEM, over))).toEqual({ context: { workItemId: ITEM } })
    }
    // A row that isn't a work item's (a fixture): nothing to attach.
    expect(rowConversation(light('not-a-uuid', { kind: 'coding_run' }))).toBeNull()
  })
})

describe('answering a run’s question from the bubble (answerRunQuestion)', () => {
  const asking = {
    run: {
      status: 'needs_input',
      pending_input: {
        requestId: 'req-1',
        approveOptionId: 'approve',
        denyOptionId: 'cancel',
        askedAt: '2026-10-01T08:00:00.000Z',
        questions: [{ question: 'Which tone?', header: 'Tone', options: [{ label: 'Formal' }], multiSelect: false }],
      },
    },
  }
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response

  it('reads the question in the run’s workspace, then answers it through the respond route', async () => {
    const fetchMock = vi.fn(async (url: string) => (String(url).endsWith('/respond') ? json(200, { ok: true }) : json(200, asking)))
    vi.stubGlobal('fetch', fetchMock)
    await expect(answerRunQuestion(RUN, 'w2', ' use the formal tone ')).resolves.toEqual({ ok: true })
    const [readUrl, readInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(readUrl).toBe(`/api/account/agent-runs/${RUN}`)
    expect(readInit.headers).toEqual({ 'x-workspace-id': 'w2' })
    const [respondUrl, respondInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(respondUrl).toBe(`/api/account/agent-runs/${RUN}/respond`)
    expect(JSON.parse(String(respondInit.body))).toEqual({ answers: [{ question: 'Which tone?', answer: 'use the formal tone' }] })
  })

  it('a run that isn’t asking now (or waits on teammates) is a refusal; nothing is sent to respond', async () => {
    for (const run of [
      { status: 'queued', pending_input: null },
      { status: 'needs_input', pending_input: { kind: 'delegation', children: [], askedAt: 'x' } },
    ]) {
      const fetchMock = vi.fn(async () => json(200, { run }))
      vi.stubGlobal('fetch', fetchMock)
      await expect(answerRunQuestion(RUN, 'w1', 'yes')).resolves.toEqual({ ok: false, refusal: { status: 409, code: 'NOT_NEEDS_INPUT' } })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it('the route’s refusals (someone else’s run 403, gone 404, not asking 409) say so; 401, 5xx and the network fail in passing', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).endsWith('/respond') ? json(403, { code: 'FORBIDDEN' }) : json(200, asking))))
    await expect(answerRunQuestion(RUN, 'w1', 'yes')).resolves.toEqual({ ok: false, refusal: { status: 403, code: 'FORBIDDEN' } })
    vi.stubGlobal('fetch', vi.fn(async () => json(404, { error: 'Agent run not found' })))
    await expect(answerRunQuestion(RUN, 'w1', 'yes')).resolves.toMatchObject({ ok: false, refusal: { status: 404 } })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).endsWith('/respond') ? json(500, {}) : json(200, asking))))
    await expect(answerRunQuestion(RUN, 'w1', 'yes')).resolves.toEqual({ ok: false, refusal: null })
    vi.stubGlobal('fetch', vi.fn(async () => json(401, {})))
    await expect(answerRunQuestion(RUN, 'w1', 'yes')).resolves.toEqual({ ok: false, refusal: null })
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))))
    await expect(answerRunQuestion(RUN, 'w1', 'yes')).resolves.toEqual({ ok: false, refusal: null })
    await expect(answerRunQuestion('a b', 'w1', 'yes')).resolves.toEqual({ ok: false, refusal: null })
  })
})

describe('a person’s own run a bot was routed to (bots-v4 Phase 5): its chat is theirs, not the bot speaking', () => {
  const routed = light('own-1', { ai_team_member_id: 'assistant', source: { agent_run_id: RUN, teammate_routed: true } })

  it('marks the run chat as the person’s own, and only for a routed row', () => {
    expect(itemChat(rowItem(routed))).toEqual({ kind: 'run', itemId: 'own-1', runId: RUN, workspaceId: 'w1', asking: false, own: true })
    expect(replyRun(rowItem(routed))).toMatchObject({ own: true })
    expect(rowConversation(routed)).toMatchObject({ runId: RUN, own: true })
    // A teammate's own work run: the bot's, as before.
    expect(itemChat(rowItem(light('mate-1')))).not.toHaveProperty('own')
    expect(rowConversation(light('mate-1'))).not.toHaveProperty('own')
    // Still the run's own chat: nothing about where a reply goes changes.
    expect(replyRun(rowItem(routed))?.runId).toBe(RUN)
  })

  it('labels it as the person’s own run, never the bot', () => {
    expect(aboutLineLabel({ own: true })).toBe('Your run’s chat')
    expect(aboutLineLabel({ own: true, asking: true })).toBe('Your run asks')
    expect(aboutLineLabel({})).toBe('About')
    expect(aboutLineLabel({ asking: true })).toBe('Answering')
    expect(OWN_RUN_SPEAKER).toBe('Your run')
  })
})
