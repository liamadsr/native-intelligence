// @vitest-environment jsdom
/**
 * The chip under an update_email_thread result (GEN-1166): what it reads off
 * the result, what it says, and Undo, which posts each undo call to the
 * triage route. Nothing is drawn for a result that changed nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { EmailTriageChip, emailTriageFromToolOutput, triageLabel } from '../email-triage-chip'
import { rendererFor } from '@/app/account/(dashboard)/chat/tool-renderers'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RESULT = {
  success: true,
  changed: 2,
  threads: [
    { thread_id: 'a', status: 'changed', applied: { archive: true, read: true } },
    { thread_id: 'b', status: 'changed', applied: { archive: true } },
    { thread_id: 'c', status: 'unchanged' },
  ],
  undo: [
    { thread_ids: ['a'], archive: false, read: false },
    { thread_ids: ['b'], archive: false, confirmed_with_user: true },
  ],
}

describe('emailTriageFromToolOutput', () => {
  it('reads the change and its undo calls, dropping anything but the change fields', () => {
    expect(emailTriageFromToolOutput(RESULT)).toEqual({
      label: 'Archived and marked read',
      count: 2,
      undo: [
        { thread_ids: ['a'], change: { archive: false, read: false } },
        { thread_ids: ['b'], change: { archive: false } },
      ],
    })
  })

  it('nothing for a result that changed nothing, a refusal, or a malformed one', () => {
    expect(emailTriageFromToolOutput({ success: true, changed: 0, threads: [] })).toBeNull()
    expect(emailTriageFromToolOutput({ success: false, code: 'NEEDS_CONFIRMATION', awaiting_go_ahead: true })).toBeNull()
    expect(emailTriageFromToolOutput({ success: true, changed: 1, undo: [{ thread_ids: [], archive: false }] })).toBeNull()
    expect(emailTriageFromToolOutput('Archived')).toBeNull()
  })
})

describe('triageLabel', () => {
  it('says each change, mute standing for its archive', () => {
    expect(triageLabel({ archive: true })).toBe('Archived')
    expect(triageLabel({ mute: true, archive: true })).toBe('Muted')
    expect(triageLabel({ archive: false })).toBe('Moved to the inbox')
    expect(triageLabel({ read: false, star: true })).toBe('Marked unread and starred')
    expect(triageLabel({ add_labels: ['Receipts'], remove_labels: ['Old'], read: true })).toBe('Marked read, labeled Receipts and took off Old')
  })
})

describe('EmailTriageChip', () => {
  let container: HTMLDivElement
  let root: Root
  const fetchMock = vi.fn()

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  const click = async (label: RegExp) => {
    const button = [...container.querySelectorAll('button')].find((b) => label.test(b.textContent ?? ''))!
    await act(async () => {
      button.click()
    })
  }

  it('Undo posts each undo call, then says it is put back', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ changed: 1, threads: [{ thread_id: 'a', status: 'changed' }] }), { status: 200 }))
    act(() => root.render(h(EmailTriageChip, { data: emailTriageFromToolOutput(RESULT)! })))
    expect(container.textContent).toContain('Archived and marked read')
    expect(container.textContent).toContain('2 threads')
    await click(/^Undo$/)
    expect(fetchMock.mock.calls.map(([url, init]) => [url, JSON.parse(String((init as RequestInit).body))])).toEqual([
      ['/api/account/email/threads/triage', { thread_ids: ['a'], change: { archive: false, read: false } }],
      ['/api/account/email/threads/triage', { thread_ids: ['b'], change: { archive: false } }],
    ])
    expect(container.textContent).toContain('Put back')
  })

  it('a thread that could not be put back offers a retry', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ changed: 0, threads: [{ thread_id: 'a', status: 'failed', error: 'x' }] }), { status: 200 }))
    act(() => root.render(h(EmailTriageChip, { data: emailTriageFromToolOutput(RESULT)! })))
    await click(/^Undo$/)
    expect(container.textContent).toContain('Undo failed, retry')
  })

  it('is the chat renderer for update_email_thread', () => {
    expect(rendererFor('update_email_thread')).toBeDefined()
  })
})
