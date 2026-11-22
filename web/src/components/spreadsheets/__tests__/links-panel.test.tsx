// @vitest-environment jsdom
/**
 * The spreadsheet card's Links panel (phase 6): a header and a close button
 * always, "nothing links to this" while empty, and one row per reference once
 * they load (the same rows every kind's "Referenced in" draws). Fixtures are
 * made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const opened = vi.hoisted(() => [] as unknown[])
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))
vi.mock('@/lib/chat-cards/open-card', () => ({ openTarget: (t: unknown) => opened.push(t) }))

import { LinksPanel } from '../links-panel'

let container: HTMLDivElement
let root: Root
let answer: { status: number; body: unknown }
const closed = vi.fn()

beforeEach(() => {
  opened.length = 0
  closed.mockReset()
  answer = { status: 200, body: { references: [] } }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(answer.body), { status: answer.status })))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render() {
  await act(async () => root.render(<LinksPanel spreadsheetId="s-1" onClose={closed} />))
  for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

describe('LinksPanel', () => {
  it('shows the header and an empty note, and closes', async () => {
    await render()
    expect(container.querySelector('[aria-label="Links"]')).toBeTruthy()
    expect(container.textContent).toContain('Nothing links to this spreadsheet yet')
    act(() => (container.querySelector('[aria-label="Close links"]') as HTMLButtonElement).click())
    expect(closed).toHaveBeenCalledOnce()
  })

  it('reads the spreadsheet references and lists each source', async () => {
    answer = {
      status: 200,
      body: {
        references: [
          { type: 'document', id: 'doc-1', label: 'Q4 budget notes', relations: ['mentions'], created_at: new Date().toISOString(), context: null },
          { type: 'action', id: 'a-1', label: 'Reconcile the model', relations: ['about'], created_at: new Date().toISOString(), context: null },
        ],
      },
    }
    await render()
    const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(String(call[0])).toContain('/api/account/entities/spreadsheet/s-1/references')
    expect(container.textContent).toContain('Q4 budget notes')
    expect(container.textContent).toContain('Reconcile the model')
    const rows = container.querySelectorAll('[data-reference]')
    expect(rows).toHaveLength(2)
    act(() => (rows[0] as HTMLButtonElement).click())
    expect(opened).toEqual([{ type: 'document', id: 'doc-1', title: 'Q4 budget notes' }])
  })
})
