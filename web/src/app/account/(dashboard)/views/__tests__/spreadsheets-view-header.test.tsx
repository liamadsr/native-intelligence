// @vitest-environment jsdom
/**
 * The Spreadsheets page in a card names itself once: its card's header says
 * "Spreadsheets", so the page draws no title of its own, and New spreadsheet
 * goes into that header (Liam, 11-22: "remove the duplicate title on the
 * spreadsheets page"). Outside a card it keeps its own header.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type FunctionComponent } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/spreadsheets/spreadsheet-editor', () => ({ SpreadsheetEditor: () => h('div', { 'data-stub-editor': '' }) }))
// The list is the views system's (docs/plans/views-everywhere.md); its own tests cover it.
const listed: Array<{ entityType: string; onItemSelect: (id: string, title: string) => void }> = []
vi.mock('@/components/views/unified-view-layout', () => ({
  UnifiedViewLayout: (props: { entityType: string; onItemSelect: (id: string, title: string) => void }) => {
    listed.push(props)
    return h('div', { 'data-stub-list': props.entityType }, 'Fernhill budget')
  },
}))

import { SpreadsheetsView, type SpreadsheetsCardState } from '../spreadsheets-view'
import { CardHeaderSlotsProvider } from '@/components/chat-cards/card-header-slot'

const SHEETS = [
  { id: 's1', title: 'Fernhill budget', sheet_names: ['Sheet1'], visibility: 'workspace', updated_at: new Date().toISOString() },
]

let container: HTMLDivElement
let header: HTMLDivElement
let root: Root

beforeEach(() => {
  listed.length = 0
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ spreadsheets: SHEETS }) })))
  container = document.createElement('div')
  header = document.createElement('div')
  document.body.append(header, container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  header.remove()
  vi.unstubAllGlobals()
})

const card = { openId: null, onOpen: () => {} }
/** The view with its props as a card passes them (its own signature defaults them to `{}`, which createElement reads as no props). */
const View: FunctionComponent<{ card?: SpreadsheetsCardState }> = SpreadsheetsView

describe('the Spreadsheets page’s title', () => {
  it('in a card: no title of its own, New spreadsheet in the card’s header', async () => {
    await act(async () => {
      root.render(h(CardHeaderSlotsProvider, { value: { left: null, right: header } }, h(View, { card })))
    })
    expect(container.textContent).toContain('Fernhill budget')
    expect(container.textContent).not.toContain('Spreadsheets')
    expect(container.textContent).not.toContain('New spreadsheet')
    expect(header.querySelector('[data-new-spreadsheet]')?.textContent).toBe('New spreadsheet')
    expect(listed.at(-1)?.entityType).toBe('spreadsheet')
  })

  it('a row picked in the list opens its workbook, through the card', async () => {
    const opened: Array<[string | null, string | undefined]> = []
    await act(async () => {
      root.render(h(CardHeaderSlotsProvider, { value: { left: null, right: header } }, h(View, { card: { openId: null, onOpen: (id, name) => opened.push([id, name]) } })))
    })
    act(() => listed.at(-1)!.onItemSelect('s1', 'Fernhill budget'))
    expect(opened).toEqual([['s1', 'Fernhill budget']])
    await act(async () => {
      root.render(h(CardHeaderSlotsProvider, { value: { left: null, right: header } }, h(View, { card: { openId: 's1', onOpen: () => {} } })))
    })
    expect(container.querySelector('[data-stub-editor]')).not.toBeNull()
    expect(container.querySelector('[data-stub-list]')).toBeNull()
  })

  it('outside a card: its own header, title and button', async () => {
    await act(async () => {
      root.render(h(SpreadsheetsView))
    })
    expect(container.textContent).toContain('Spreadsheets')
    expect(container.textContent).toContain('New spreadsheet')
    expect(header.childElementCount).toBe(0)
  })
})
