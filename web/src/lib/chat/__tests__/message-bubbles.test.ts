/**
 * A message's bubbles (message-bubbles.ts), counted as the thread draws them:
 * each text part a bubble, whitespace alone none, an agent's long reply its
 * lead and its question around the folded document (never the document), the
 * person's own text as it is. Places checked.
 */
import { describe, it, expect } from 'vitest'
import { MAX_MESSAGE_BUBBLES, messageBubbles, parseBubbleIndex, textPartPieces } from '../message-bubbles'

const story = ['Here is the summary you asked for.', ...Array.from({ length: 6 }, (_, i) => `## Part ${i}\n${'Words about it. '.repeat(20)}`), 'Want me to send it?'].join('\n\n')

describe('messageBubbles', () => {
  it('one per text part, around the tool steps; whitespace alone draws none', () => {
    const turn = { role: 'assistant', parts: [{ type: 'text', text: 'Looking.' }, { type: 'tool-list_actions' }, { type: 'text', text: '\n' }, { type: 'text', text: 'Done.' }] }
    expect(messageBubbles(turn)).toEqual(['Looking.', 'Done.'])
  })

  it('an agent’s long reply: its lead and its question, the document between them is not a bubble', () => {
    const pieces = textPartPieces(story, true)
    expect(pieces.map((p) => p.kind)).toEqual(['bubble', 'doc', 'bubble'])
    expect(messageBubbles({ role: 'assistant', parts: [{ type: 'text', text: story }] })).toEqual(['Here is the summary you asked for.', 'Want me to send it?'])
  })

  it('the person’s own text is never folded', () => {
    expect(messageBubbles({ role: 'user', parts: [{ type: 'text', text: story }] })).toEqual([story])
  })

  it('a bubble’s place: a whole number under the cap', () => {
    expect(parseBubbleIndex(0)).toBe(0)
    expect(parseBubbleIndex(MAX_MESSAGE_BUBBLES - 1)).toBe(MAX_MESSAGE_BUBBLES - 1)
    for (const bad of [-1, 1.5, MAX_MESSAGE_BUBBLES, '1', null]) expect(parseBubbleIndex(bad)).toBeNull()
  })
})
