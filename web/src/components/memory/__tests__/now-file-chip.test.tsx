// @vitest-environment jsdom
/**
 * The row under an `update_now` call (docs/plans/now-file.md): what it reads
 * off the result, what it says, and Open, which asks the dashboard to put the
 * note in the chat as a document card (OPEN_CARD_EVENT, the way any chip opens
 * a record). Also its place in the chat's tool renderers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { NowFileChip, nowFileFromToolOutput, nowFileLabel } from '../now-file-chip'
import { OPEN_CARD_EVENT, parseOpenCardRequest, type OpenCardRequest } from '@/lib/chat-cards/open-card'
import { rendererFor } from '@/app/account/(dashboard)/chat/tool-renderers'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DOC = 'd7b7d530-8044-4ae2-9398-fbe428f7cf81'

describe('nowFileFromToolOutput', () => {
  it('reads the note off a written result, and nothing off a refusal or a malformed one', () => {
    expect(nowFileFromToolOutput({ success: true, document_id: DOC, revision: 2, changed: [] })).toEqual({ documentId: DOC, created: false, unchanged: false })
    expect(nowFileFromToolOutput({ success: true, document_id: DOC, revision: 1, changed: [], created: true })?.created).toBe(true)
    expect(nowFileFromToolOutput({ success: true, document_id: DOC, revision: 2, changed: [], unchanged: true })?.unchanged).toBe(true)
    expect(nowFileFromToolOutput({ success: false, code: 'NOW_STALE', error: '…', conflict: true })).toBeNull()
    expect(nowFileFromToolOutput({ success: true, document_id: '' })).toBeNull()
    expect(nowFileFromToolOutput('Now file updated')).toBeNull()
  })

  it('says what the call did', () => {
    expect(nowFileLabel({ documentId: DOC, created: false, unchanged: false })).toBe('Now file updated')
    expect(nowFileLabel({ documentId: DOC, created: true, unchanged: false })).toBe('Now file started')
    expect(nowFileLabel({ documentId: DOC, created: false, unchanged: true })).toBe('Now file unchanged')
  })
})

describe('NowFileChip', () => {
  let container: HTMLDivElement
  let root: Root
  const requests: OpenCardRequest[] = []
  const onOpen = (e: Event) => {
    const parsed = parseOpenCardRequest((e as CustomEvent).detail)
    if (parsed) requests.push(parsed)
  }

  beforeEach(() => {
    requests.length = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    window.addEventListener(OPEN_CARD_EVENT, onOpen)
  })

  afterEach(() => {
    window.removeEventListener(OPEN_CARD_EVENT, onOpen)
    act(() => root.unmount())
    container.remove()
  })

  it('Open puts the note in the chat as a document card, reusing one already there', () => {
    act(() => root.render(h(NowFileChip, { data: { documentId: DOC, created: false, unchanged: false } })))
    expect(container.textContent).toContain('Now file updated')
    const open = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Open')
    expect(open).toBeTruthy()
    act(() => open!.click())
    expect(requests).toHaveLength(1)
    expect(requests[0].spec).toMatchObject({ kind: 'record', record: { type: 'document', id: DOC } })
    expect(requests[0].from).toBe('chip')
    expect(requests[0].reuse).toBe(true)
  })
})

describe('the chat renders it for update_now', () => {
  it('is the renderer for update_now', () => {
    expect(rendererFor('update_now')).toBeDefined()
  })
})
