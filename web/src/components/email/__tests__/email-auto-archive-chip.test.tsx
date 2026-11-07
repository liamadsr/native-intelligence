// @vitest-environment jsdom
/**
 * The morning tidy's message (src/lib/email/auto-archive.ts): the part it
 * reads (every field checked), what it says, and Undo, which posts to the
 * batch's undo route and then says the senders stay. A reload of an undone
 * batch says "Put back".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { EmailAutoArchiveChip } from '../email-auto-archive-chip'
import { dataPartRendererFor } from '@/app/account/(dashboard)/chat/tool-renderers'
import {
  EMAIL_AUTO_ARCHIVE_PART_TYPE,
  autoArchiveDomainsLine,
  emailAutoArchivePartData,
  senderDomains,
} from '@/lib/email/auto-archive-part'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DATA = { batch_id: '0f8a2c9e-1b2c-4d5e-8f90-123456789abc', count: 14, domains: ['amazon.com', 'gusto.com', 'uber.com'], more_domains: 3 }

describe('the part', () => {
  it('reads a batch, dropping what is not one', () => {
    expect(emailAutoArchivePartData(DATA)).toEqual(DATA)
    expect(emailAutoArchivePartData({ ...DATA, domains: ['a.com', 7, '', 'b.com', 'c.com', 'd.com'], undone: true })).toEqual({
      ...DATA,
      domains: ['a.com', 'b.com', 'c.com'],
      undone: true,
    })
    expect(emailAutoArchivePartData({ ...DATA, count: 0 })).toBeNull()
    expect(emailAutoArchivePartData({ ...DATA, batch_id: '' })).toBeNull()
    expect(emailAutoArchivePartData(['x'])).toBeNull()
    expect(emailAutoArchivePartData(null)).toBeNull()
  })

  it('names the most common sender domains first, then how many more', () => {
    expect(senderDomains(['a@uber.com', 'b@amazon.com', 'c@amazon.com', 'd@gusto.com', 'e@x.io', 'not-an-address'])).toEqual({
      domains: ['amazon.com', 'uber.com', 'gusto.com'],
      more_domains: 1,
    })
    expect(autoArchiveDomainsLine({ domains: ['amazon.com', 'gusto.com'], more_domains: 0 })).toBe('amazon.com, gusto.com')
    expect(autoArchiveDomainsLine({ domains: ['amazon.com'], more_domains: 3 })).toBe('amazon.com +3')
    expect(autoArchiveDomainsLine({ domains: [], more_domains: 0 })).toBeNull()
  })

  it('is drawn by the chat', () => {
    expect(dataPartRendererFor(EMAIL_AUTO_ARCHIVE_PART_TYPE)).toBeDefined()
  })
})

describe('EmailAutoArchiveChip', () => {
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

  const undo = async () => {
    const button = [...container.querySelectorAll('button')].find((b) => /Undo/.test(b.textContent ?? ''))!
    await act(async () => {
      button.click()
    })
  }

  it('says what it archived, and Undo puts the batch back', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ restored: 14, failed: 0 }), { status: 200 }))
    act(() => root.render(h(EmailAutoArchiveChip, { data: DATA })))
    expect(container.textContent).toContain('Inbox tidied')
    expect(container.textContent).toContain('14 threads')
    expect(container.textContent).toContain('amazon.com, gusto.com, uber.com +3')
    await undo()
    expect(fetchMock).toHaveBeenCalledWith(`/api/account/email/auto-archive/${DATA.batch_id}/undo`, { method: 'POST' })
    expect(container.textContent).toContain('Put back · 14 threads · their senders stay in your inbox')
  })

  it('a thread deleted or trashed since is not a failure: the rest went back', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ restored: 12, failed: 0, gone: 2 }), { status: 200 }))
    act(() => root.render(h(EmailAutoArchiveChip, { data: DATA })))
    await undo()
    expect(container.textContent).toContain('Put back · 14 threads')
  })

  it('a failed Undo offers a retry', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ restored: 13, failed: 1 }), { status: 200 }))
    act(() => root.render(h(EmailAutoArchiveChip, { data: DATA })))
    await undo()
    expect(container.textContent).toContain('Undo failed, retry')
    fetchMock.mockImplementation(async () => new Response('{}', { status: 500 }))
    await undo()
    expect(container.textContent).toContain('Undo failed, retry')
  })

  it('an undone batch reloads as put back, with no Undo', () => {
    act(() => root.render(h(EmailAutoArchiveChip, { data: { ...DATA, undone: true } })))
    expect(container.textContent).toContain('Put back · 14 threads')
    expect(container.querySelector('button')).toBeNull()
  })
})
