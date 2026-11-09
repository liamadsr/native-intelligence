/**
 * Where a card lives (P13, chat-asks.ts): For you holds delivered work only;
 * an approval or a question card is the chat's. What a chat turn's tool
 * result says when it held a call, and what a home-thread ask part carries.
 */
import { describe, expect, it } from 'vitest'
import { approvalIdOfToolOutput, askCardPartData, askCardsPartData, isChatAskCard, isForYouCard, isHomeAskMessage, splitCardsByPlace } from '../chat-asks'

const ID = '3f0c1d2e-4b5a-4c6d-8e7f-901234567890'

describe('isChatAskCard / splitCardsByPlace', () => {
  it('For you holds one kind of card, a post draft or idea; every other card asks in the chat (Liam: "\'Add this?\' is a question")', () => {
    const cards = [
      { id: 'post', kind: 'question', payload: { post_draft: { text: 'Exports are 3x faster.', surface: 'x' } } },
      { id: 'idea', kind: 'question', payload: { post_draft: { text: 'An idea for a slow week.', surface: 'linkedin', idea: true } } },
      { id: 'mail', kind: 'draft_email', payload: {} },
      { id: 'action', kind: 'action_card', payload: { change_type: 'update', entity_type: 'action' } },
      { id: 'work', kind: 'work_proposal', payload: { task: 'Draft the recap' } },
      { id: 'approval', kind: 'approval', payload: { approval_id: ID } },
      { id: 'question', kind: 'question', payload: {} },
      { id: 'empty-post', kind: 'question', payload: { post_draft: { text: '   ' } } },
    ]
    const { forYou, asks } = splitCardsByPlace(cards)
    expect(forYou.map((c) => c.id)).toEqual(['post', 'idea'])
    expect(asks.map((c) => c.id)).toEqual(['mail', 'action', 'work', 'approval', 'question', 'empty-post'])
    expect(isForYouCard(cards[0])).toBe(true)
    expect(isForYouCard({ kind: 'action_card', payload: { post_draft: { text: 'x' } } })).toBe(false)
    expect(isChatAskCard({ kind: 'approval' })).toBe(true)
    expect(isChatAskCard({ kind: 'question', payload: null })).toBe(true)
  })
})

describe('approvalIdOfToolOutput', () => {
  const GATE = { success: false, code: 'APPROVAL_REQUIRED', approval_id: ID, message: 'Nothing ran.' }
  it('only the doors that hold calls: the outward gate (any Native Intelligence tool, its exact shape), connections, the flow tools, mcp_confirm_call', () => {
    expect(approvalIdOfToolOutput('publish_post', GATE)).toBe(ID)
    expect(approvalIdOfToolOutput('disconnect', { ...GATE, loops_that_need_it: ['Weekly posts'] })).toBe(ID)
    expect(approvalIdOfToolOutput('set_tool_access', { ...GATE, waiting_on_card: ['x'] })).toBe(ID)
    expect(approvalIdOfToolOutput('mcp_confirm_call', { status: 'approval_requested', approval_id: ID, tool: 'mcp__linear__create_issue' })).toBe(ID)
    expect(approvalIdOfToolOutput('create_flow', { flow: {}, awaiting_approval: true, approval_id: ID })).toBe(ID)
    expect(approvalIdOfToolOutput('delete_flow', { ...GATE, runs_to_erase: 3 })).toBe(ID)
    // GEN-1169: a permanent document delete renders its card inline too.
    expect(approvalIdOfToolOutput('delete_document', GATE)).toBe(ID)
  })

  it('anything else: the generic chip (a connected app’s own result, a gate-like shape with extra keys, no id)', () => {
    expect(approvalIdOfToolOutput('mcp__linear__create_issue', GATE)).toBeNull()
    expect(approvalIdOfToolOutput('list_actions', { ...GATE, rows: [] })).toBeNull()
    expect(approvalIdOfToolOutput('list_actions', { status: 'approval_requested', approval_id: ID })).toBeNull()
    expect(approvalIdOfToolOutput('publish_post', { ...GATE, approval_id: null })).toBeNull()
    expect(approvalIdOfToolOutput('create_flow', { awaiting_approval: false, note: 'no card', approval_id: ID })).toBeNull()
    expect(approvalIdOfToolOutput('publish_post', { ...GATE, approval_id: 'not-an-id' })).toBeNull()
    expect(approvalIdOfToolOutput('publish_post', null)).toBeNull()
    expect(approvalIdOfToolOutput('publish_post', [ID])).toBeNull()
  })
})

describe('the home thread’s ask messages', () => {
  it('the live bridge takes an approval, a run’s suggestions and a run’s notice', () => {
    for (const kind of ['ask_card', 'ask_cards', 'ci_red']) expect(isHomeAskMessage({ metadata: { kind } })).toBe(true)
    expect(isHomeAskMessage({ metadata: { kind: 'greeting' } })).toBe(false)
    expect(isHomeAskMessage(null)).toBe(false)
  })

  it('a suggestions part: ids must be ids, at most 20, each once', () => {
    const other = '4f0c1d2e-4b5a-4c6d-8e7f-901234567890'
    expect(askCardsPartData({ card_ids: [ID, 'x', ID, other], workspace_id: 'ws-1', source: ' your call “Acme” ' })).toEqual({ card_ids: [ID, other], workspace_id: 'ws-1', source: 'your call “Acme”' })
    expect(askCardsPartData({ card_ids: ['x'] })).toBeNull()
    expect(askCardsPartData(null)).toBeNull()
  })
})

describe('askCardPartData', () => {
  it('a stored part is data: its ids must be ids, its title one capped string', () => {
    expect(askCardPartData({ card_id: ID, approval_id: ID, workspace_id: 'ws-1', title: ' Post via Typefully ', work_item_id: ID })).toEqual({
      card_id: ID,
      approval_id: ID,
      workspace_id: 'ws-1',
      title: 'Post via Typefully',
      work_item_id: ID,
    })
    expect(askCardPartData({ card_id: 'nope' })).toBeNull()
    expect(askCardPartData({ card_id: ID, approval_id: 'x', work_item_id: 7 })).toEqual({ card_id: ID, workspace_id: '' })
    expect(askCardPartData(null)).toBeNull()
  })
})
