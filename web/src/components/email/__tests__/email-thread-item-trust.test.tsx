// @vitest-environment jsdom
/**
 * The "Suspicious" chip on a Mail row (A5 slice 1): rendered only when the
 * thread carries an email.trust mark (migration 334).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { EmailThreadItem, type EmailThread } from '../email-thread-item'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const thread: EmailThread = {
  id: 't1', provider_thread_id: 'p1', subject: 'Invoice', snippet: 'Please update our bank details',
  from_email: 'billing@example.com', from_name: 'Billing', is_unread: false, is_starred: false,
  has_attachments: false, needs_reply: false, message_count: 1, last_message_at: null,
}
let root: Root | null = null
let container: HTMLDivElement | null = null
function row(changes: Partial<EmailThread>): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(h(EmailThreadItem, { thread: { ...thread, ...changes }, isSelected: false, onClick: () => {}, onToggleStar: () => {} }))
  })
  return container
}
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('EmailThreadItem trust chip', () => {
  it.each(['suspicious', 'injection'] as const)('shows the Suspicious chip for a %s mark on the latest message', (trust) => {
    const el = row({ trust, trust_message_id: 'm2', provider_message_id: 'm2' })
    expect(el.querySelector('[data-testid="suspicious-chip"]')?.textContent).toContain('Suspicious')
  })

  it.each([null, undefined])('shows nothing for an unmarked thread (%s)', (trust) => {
    const el = row({ trust })
    expect(el.querySelector('[data-testid="suspicious-chip"]')).toBeNull()
  })

  it('hides a mark about an older message once a newer one arrives', () => {
    const el = row({ trust: 'suspicious', trust_message_id: 'm1', provider_message_id: 'm2' })
    expect(el.querySelector('[data-testid="suspicious-chip"]')).toBeNull()
  })

  it('hides a mark with no revision recorded', () => {
    const el = row({ trust: 'suspicious', trust_message_id: null, provider_message_id: 'm2' })
    expect(el.querySelector('[data-testid="suspicious-chip"]')).toBeNull()
  })
})
