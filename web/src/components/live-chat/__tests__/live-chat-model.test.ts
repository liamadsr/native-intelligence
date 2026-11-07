/**
 * What the live chat reads from the capture conversation: the person's and
 * the agent's rows, the ambient loop's heads-ups, question and proposals card;
 * exchanges for the collapsed view; a broadcast heads-up shown once.
 */
import { describe, expect, it } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'
import {
  exchangesOf,
  lastExchanges,
  liveChatRows,
  openQuestion,
  plainText,
  proposalsRow,
  withBroadcastSays,
  withQuestionAnswered,
} from '../live-chat-model'

const user = (id: string, text: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] })
const reply = (id: string, text: string): UIMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text }] })
const say = (id: string, text: string, kind = 'reminder'): UIMessage =>
  ({ id, role: 'assistant', parts: [{ type: 'text', text }], metadata: { kind: 'say_to_user', nudge_kind: kind } }) as UIMessage
const ask = (id: string, toolCallId: string, state = 'input-available'): UIMessage =>
  ({
    id,
    role: 'assistant',
    parts: [
      {
        type: 'tool-ask_user',
        toolCallId,
        state,
        input: { questions: [{ header: 'Quick question', question: 'Which project?', options: [{ label: 'Apollo' }, { label: 'Zeus' }], multiSelect: false }] },
      },
    ],
    metadata: { kind: 'ask_user' },
  }) as unknown as UIMessage
const proposals = (ids: string[]): UIMessage =>
  ({
    id: 'proposals-cap-1',
    role: 'assistant',
    parts: [
      { type: 'text', text: "Here's what I've captured" },
      { type: 'data-proposals', data: { capture_id: 'cap-1', proposal_ids: ids } },
    ],
    metadata: { kind: 'proposals' },
  }) as unknown as UIMessage

describe('liveChatRows', () => {
  it('reads each writer’s rows', () => {
    const rows = liveChatRows([reply('g', 'Hi, I’m listening.'), proposals(['p1', 'p2']), user('u1', 'what was the price?'), reply('a1', 'They said **$40k**.'), say('s1', 'Ask about timing.'), ask('q1', 'tc-1')])
    expect(rows.map((r) => r.kind)).toEqual(['reply', 'proposals', 'user', 'reply', 'say', 'question'])
    expect(rows[4]).toMatchObject({ kind: 'say', text: 'Ask about timing.', nudgeKind: 'reminder' })
    expect(openQuestion(rows)).toMatchObject({ toolCallId: 'tc-1', open: true })
    expect(proposalsRow(rows)).toMatchObject({ captureId: 'cap-1', proposalIds: ['p1', 'p2'] })
  })

  it('has no open question once the latest is answered', () => {
    expect(openQuestion(liveChatRows([ask('q1', 'tc-1', 'output-available')]))).toBeNull()
  })

  it('groups exchanges at each of the person’s messages; collapsed is the last two', () => {
    const rows = liveChatRows([reply('g', 'hello'), user('u1', 'one'), reply('a1', 'r1'), user('u2', 'two'), say('s', 'nudge'), reply('a2', 'r2'), user('u3', 'three'), reply('a3', 'r3')])
    expect(exchangesOf(rows).map((x) => x.map((r) => r.id))).toEqual([['g'], ['u1', 'a1'], ['u2', 's', 'a2'], ['u3', 'a3']])
    expect(lastExchanges(rows).map((r) => r.id)).toEqual(['u2', 's', 'a2', 'u3', 'a3'])
  })
})

describe('withBroadcastSays', () => {
  const base = liveChatRows([user('u1', 'hi'), reply('a1', 'hello')])

  it('shows a heads-up only the broadcast brought, after the row it arrived after', () => {
    const rows = withBroadcastSays(base, [{ id: 'n1', text: 'Mention the pilot.', kind: 'suggestion', after: 'u1' }])
    expect(rows.map((r) => r.id)).toEqual(['u1', 'n1', 'a1'])
    expect(rows[1]).toMatchObject({ kind: 'say', nudgeKind: 'suggestion' })
  })

  it('leaves it out once the conversation holds its row: the same id, whatever the words', () => {
    const held = liveChatRows([user('u1', 'hi'), say('n1', 'Mention the pilot before pricing.')])
    expect(withBroadcastSays(held, [{ id: 'n1', text: 'Mention the pilot.', after: 'u1' }]).map((r) => r.id)).toEqual(['u1', 'n1'])
  })

  it('falls back to the words for a row whose id is not the broadcast’s (an older row)', () => {
    const held = liveChatRows([user('u1', 'hi'), say('s1', 'Mention  the pilot.')])
    expect(withBroadcastSays(held, [{ id: 'n1', text: 'Mention the pilot.', after: 'u1' }]).map((r) => r.id)).toEqual(['u1', 's1'])
  })

  it('keeps a broadcast whose id and words are both new', () => {
    const held = liveChatRows([user('u1', 'hi'), say('s1', 'Mention the pilot.')])
    expect(withBroadcastSays(held, [{ id: 'n2', text: 'Ask about the budget.', after: 's1' }]).map((r) => r.id)).toEqual(['u1', 's1', 'n2'])
  })
})

describe('withQuestionAnswered', () => {
  it('answers only that part', () => {
    const messages = [ask('q1', 'tc-1'), reply('a1', 'x')]
    const next = withQuestionAnswered(messages, 'tc-1', { answers: { 'Which project?': 'Apollo' } })
    expect((next[0].parts[0] as { state: string; output: unknown }).state).toBe('output-available')
    expect((next[0].parts[0] as { output: unknown }).output).toEqual({ answers: { 'Which project?': 'Apollo' } })
    expect(next[1]).toBe(messages[1])
    expect(withQuestionAnswered(messages, 'nope', {})).toBe(messages)
  })
})

it('plainText drops markdown marks', () => {
  expect(plainText('## Price\n- **$40k** for `pilot`')).toBe('Price\n• $40k for pilot')
})
