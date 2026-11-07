// @vitest-environment jsdom
/**
 * Bots v3 Phase 4 — Reply and Open in Dial8 on a LOOP item continue the exact
 * chat its run used, when that run parked its session (`source.run_chat` on its
 * ledger row). Pinned here:
 *   - a loop run's chat id (`loop:<row>`) and its route (/api/account/activity/[id]/chat);
 *   - a loop run's row, its one card and its batch of cards route to that chat,
 *     found through the rows the cards point at (cardRows);
 *   - runs from before this phase (no flag) keep the bot's thread plus about;
 *   - the item view on a batch's run (its bot's page, bots-v4.md Phase 2)
 *     finds the loop chat from that row;
 *   - the transport talks to the activity route for a loop id, the agent-run
 *     route otherwise.
 */
import { describe, expect, it, vi } from 'vitest'
import { cardLookupRows, countByOwner } from '@/lib/work/agent-work-lanes'
import type { LightWorkRow } from '@/lib/work/queries'
import { bubbleItems, rowHasRunChat, type BubbleCard, type BubbleItem } from '../bubble-items'
import { itemAboutRef, itemChat, replyRun, rowConversation } from '../item-run-chat'
import { LOOP_RUN_CHAT_PREFIX, loopRunChatId, loopRunWorkItemId, runChatRoute } from '@/lib/agent-run/run-chat-ref'
import { loadRunChatHistory } from '@/lib/agent-run/run-chat-transport'

const JOB = '3f1c2b7a-5d4e-4c1b-9a8f-0e2d4c6b8a10'

function loopRow(id: string, over: Partial<LightWorkRow> = {}): LightWorkRow {
  return {
    id,
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'flow_run',
    status: 'needs_review',
    origin: 'loop',
    ai_team_member_id: 'triage',
    parent_id: null,
    root_id: null,
    flow_run_id: `fr-${id}`,
    agent_run_id: null,
    source: { flow_id: 'flow-1', run_chat: true },
    opened_at: null,
    needs: null,
    created_at: '2026-10-02T08:00:00.000Z',
    teammate: null,
    ...over,
  } as LightWorkRow
}

const card = (id: string, workItemId: string): BubbleCard =>
  ({
    id,
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'action_card',
    title: `Card ${id}`,
    why: null,
    payload: { raised_by_ai_member_id: 'triage', work_item_id: workItemId },
    proposal_id: null,
    source_flow_run_id: null,
    status: 'pending',
    expires_at: null,
    created_at: '2026-10-02T08:00:00.000Z',
  }) as unknown as BubbleCard

/** The bubble's items for Triage, from the open rows, the cards and the rows the cards point at. */
function triageItems(rows: LightWorkRow[], cards: BubbleCard[], cardRows: LightWorkRow[]): BubbleItem[] {
  const counts = countByOwner(rows, cards, cardLookupRows(rows, cardRows))
  return bubbleItems('triage', counts, rows, cards, cardRows)
}

describe('a loop run’s chat id and route', () => {
  it('prefixes the ledger row and maps it to the activity route; a work run keeps its own', () => {
    expect(loopRunChatId(JOB)).toBe(`${LOOP_RUN_CHAT_PREFIX}${JOB}`)
    expect(loopRunWorkItemId(loopRunChatId(JOB))).toBe(JOB)
    expect(loopRunWorkItemId('run-1')).toBeNull()
    expect(runChatRoute(loopRunChatId(JOB))).toBe(`/api/account/activity/${JOB}/chat`)
    expect(runChatRoute('run-1')).toBe('/api/account/agent-runs/run-1/chat')
    // Passes the run-id check every run-chat surface makes.
    expect(/^[\w:.-]{1,128}$/.test(loopRunChatId(JOB))).toBe(true)
  })

  it('the transport reads a loop run’s replay from the activity route', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }))
    await loadRunChatHistory(loopRunChatId(JOB), { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe(`/api/account/activity/${JOB}/chat`)
  })
})

describe('which loop items continue their run’s chat', () => {
  it('a loop run’s row that parked its session: that chat, never asking', () => {
    const row = loopRow(JOB)
    const item: BubbleItem = { kind: 'row', id: row.id, row }
    expect(rowHasRunChat(row)).toBe(true)
    expect(itemChat(item)).toEqual({ kind: 'run', itemId: JOB, runId: loopRunChatId(JOB), workspaceId: 'w1', asking: false })
    expect(replyRun(item)?.runId).toBe(loopRunChatId(JOB))
  })

  it('a loop run from before this phase (no flag) keeps the bot’s thread plus about', () => {
    const row = loopRow(JOB, { source: { flow_id: 'flow-1' } })
    const item: BubbleItem = { kind: 'row', id: row.id, row }
    expect(itemChat(item)).toEqual({ kind: 'none', itemId: JOB, why: 'loop' })
    expect(itemAboutRef(item)).toEqual({ workItemId: JOB })
  })

  it('a verdict run’s batch of cards: found through the row the cards point at', () => {
    const cards = [card('k1', JOB), card('k2', JOB)]
    const items = triageItems([], cards, [loopRow(JOB, { status: 'done' })])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'batch', workItemId: JOB, runChat: true })
    expect(itemChat(items[0])).toEqual({ kind: 'run', itemId: `work:${JOB}`, runId: loopRunChatId(JOB), workspaceId: 'w1', asking: false })
    // What goes to the bot's own thread is still about the run.
    expect(itemAboutRef(items[0])).toEqual({ workItemId: JOB })
  })

  it('a run’s one card continues the same chat', () => {
    const items = triageItems([], [card('k1', JOB)], [loopRow(JOB, { status: 'done' })])
    expect(items[0]).toMatchObject({ kind: 'card', runChat: true })
    expect(replyRun(items[0])?.runId).toBe(loopRunChatId(JOB))
  })

  it('cards whose run never parked keep the bot’s thread', () => {
    const items = triageItems([], [card('k1', JOB), card('k2', JOB)], [loopRow(JOB, { status: 'done', source: {} })])
    expect(items[0]).not.toHaveProperty('runChat')
    expect(itemChat(items[0])).toEqual({ kind: 'none', itemId: `work:${JOB}`, why: 'loop' })
  })
})

describe('the item view on a loop run’s batch', () => {
  it('finds the conversation from its run’s row: its parked loop chat', () => {
    const cardRows = [loopRow(JOB, { status: 'done' })]
    expect(rowConversation(cardRows[0])).toEqual({ runId: loopRunChatId(JOB), context: { workItemId: JOB }, asking: false, workspaceId: 'w1' })
  })
})
