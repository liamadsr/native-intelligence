// @vitest-environment jsdom
/**
 * Text selected in a doc or a capture open in a card reaches the chat (the
 * shell's `dial8:editor-selection` listener), as it did from the old page
 * windows: only from the tab in front, and cleared when the panel goes away
 * (the card folded, Back, the tab closed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { panels, stub } = vi.hoisted(() => {
  const panels = { report: null as null | ((s: unknown) => void) }
  const stub = (name: string) => () => ({
    [name]: (props: { onSelectionChange?: (s: unknown) => void }) => {
      panels.report = props.onSelectionChange ?? null
      return null
    },
  })
  return { panels, stub }
})
vi.mock('@/app/account/(dashboard)/views/document-detail-panel', stub('DocumentDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/capture-detail-panel', stub('CaptureDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/action-detail-panel', stub('ActionDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/contact-detail-panel', stub('ContactDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/company-detail-panel', stub('CompanyDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/project-detail-panel', stub('ProjectDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/initiative-detail-panel', stub('InitiativeDetailPanel'))
vi.mock('@/components/views/unified-view-layout', () => ({ UnifiedViewLayout: () => null, WindowFocusProvider: ({ children }: { children: unknown }) => children }))
vi.mock('../pages/page-card', () => ({ PageGate: () => null }))

import { CardRecordPanel } from '../card-body'
import { EDITOR_SELECTION_EVENT } from '../editor-selection'

const SEL = { entityType: 'document', entityId: 'doc-1', field: 'content', selectedText: 'the pricing line' }

let container: HTMLDivElement
let root: Root
let heard: unknown[] = []
const onSel = (e: Event) => heard.push((e as CustomEvent).detail)

function render(type: 'document' | 'capture') {
  act(() => root.render(h(CardRecordPanel, { record: { type, id: `${type}-1` }, onOpen: () => {}, onClose: () => {} })))
}

beforeEach(() => {
  heard = []
  panels.report = null
  window.addEventListener(EDITOR_SELECTION_EVENT, onSel)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.removeEventListener(EDITOR_SELECTION_EVENT, onSel)
})

describe('a record panel in a card hands its selection to the chat', () => {
  it.each(['document', 'capture'] as const)('a %s’s selection reaches the chat', (type) => {
    render(type)
    expect(panels.report).toBeTypeOf('function')
    act(() => panels.report!(SEL))
    expect(heard).toEqual([SEL])
  })

  it('the panel going away (the card folded, Back) clears it', () => {
    render('document')
    act(() => panels.report!(SEL))
    act(() => root.render(h('div')))
    expect(heard).toEqual([SEL, null])
  })
})
