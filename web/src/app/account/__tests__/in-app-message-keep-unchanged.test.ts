/**
 * The in-app message refetch (every window focus + a 5-minute poll) keeps the
 * previous array when the server sent back exactly the same messages, so the
 * provider's memoized value — and every consumer — stays put. Anything that
 * differs, down to a nested response or a column outside the TS type, must
 * still come through.
 */
import { describe, it, expect } from 'vitest'
import { keepIfUnchanged, type InAppMessage } from '../in-app-message-context'

function msg(id: string, extra: Partial<InAppMessage> & Record<string, unknown> = {}): InAppMessage {
  return {
    id,
    message_title: `t-${id}`,
    message_body: 'b',
    message_type: 'announcement',
    cta_text: null,
    cta_action: null,
    cta_url: null,
    priority: 'normal',
    status: 'delivered',
    created_at: '2026-09-01T00:00:00Z',
    message_responses: [],
    ...extra,
  } as InAppMessage
}

// A refetch parses fresh JSON: equal content, new objects.
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

describe('keepIfUnchanged', () => {
  it('keeps the previous array when the refetch is structurally identical', () => {
    const prev = [msg('a', { expires_at: null }), msg('b')]
    expect(keepIfUnchanged(prev, clone(prev))).toBe(prev)
  })

  it('takes the new array on a status, content, order or length change', () => {
    const prev = [msg('a'), msg('b')]
    for (const next of [
      [msg('a', { status: 'read' }), msg('b')],
      [msg('a', { message_title: 'edited' }), msg('b')],
      [msg('b'), msg('a')],
      [msg('a')],
      [msg('a'), msg('b'), msg('c')],
    ]) {
      expect(keepIfUnchanged(prev, next)).toBe(next)
    }
  })

  it('takes the new array when a nested response or an untyped column changed', () => {
    const prev = [msg('a', { updated_at: '1' })]
    const withResponse = [
      msg('a', {
        updated_at: '1',
        message_responses: [
          { id: 'r1', rating: 5, response_text: null, feature_request_id: null, created_at: 'x' },
        ],
      }),
    ]
    const bumped = [msg('a', { updated_at: '2' })]
    expect(keepIfUnchanged(prev, withResponse)).toBe(withResponse)
    expect(keepIfUnchanged(prev, bumped)).toBe(bumped)
  })
})
