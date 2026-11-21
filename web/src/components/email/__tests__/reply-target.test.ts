/**
 * Mail's R (email-thread-detail.tsx replyTargetOf): it replies to the newest
 * message someone else sent, never a draft, never the person's own.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { replyTargetOf } from '../email-thread-detail'
import type { EmailMessageData } from '../email-message'

const msg = (id: string, email: string, isDraft = false) => ({ id, from: { name: 'Someone', email }, isDraft }) as unknown as EmailMessageData

describe('replyTargetOf', () => {
  const own = new Set(['me@example.com'])

  it('the newest message from someone else', () => {
    const messages = [msg('1', 'ana@example.com'), msg('2', 'ben@example.com'), msg('3', 'me@example.com')]
    expect(replyTargetOf(messages, own)?.id).toBe('2')
  })

  it('never a draft', () => {
    const messages = [msg('1', 'ana@example.com'), msg('2', 'ben@example.com', true)]
    expect(replyTargetOf(messages, own)?.id).toBe('1')
  })

  it('only the person’s own: the newest of those; none at all: null', () => {
    expect(replyTargetOf([msg('1', 'me@example.com'), msg('2', 'ME@example.com ')], own)?.id).toBe('2')
    expect(replyTargetOf([], own)).toBeNull()
  })
})
