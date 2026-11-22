// @vitest-environment jsdom
/**
 * The Import and export menu in the footer: a .csv dropped in is pasted at the
 * active cell of the open workbook, and an .xlsx becomes a new spreadsheet
 * through the import route, after which its warnings show with an offer to open
 * it. Fetch is stubbed; the engine is the real one (the server loader stands in
 * for the browser's binary).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadModel } from '@/lib/spreadsheets/engine-server'
import { saveWorkbook } from '@/lib/spreadsheets/workbook'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }) }))
vi.mock('@/lib/spreadsheets/engine-client', async () => {
  const server = await import('@/lib/spreadsheets/engine-server')
  return { openModel: async (workbook: string | null) => server.loadModel(workbook), loadEngine: async () => undefined, ENGINE_URL: '' }
})

const { SpreadsheetEditor } = await import('../spreadsheet-editor')

const ID = '33333333-3333-4333-8333-333333333333'

function workbookWith(cells: Array<[number, number, string]>): string {
  const m = loadModel(null)
  for (const [r, c, v] of cells) m.setUserInput(0, r, c, v)
  const saved = saveWorkbook(m)
  m.free()
  return saved
}

const record = () => ({
  id: ID, workspace_id: 'ws', title: 'Hiring plan', created_by: 'm-1', last_edited_by: 'm-1', visibility: 'workspace', status: 'active',
  revision: 4, sheet_names: ['Sheet1'], created_at: '', updated_at: '', extras: {}, workbook: workbookWith([[1, 1, 'Role'], [2, 1, 'Designer']]),
})

const saved: Record<string, PropertyDescriptor | undefined> = {}
beforeAll(() => {
  for (const [k, v] of Object.entries({ clientWidth: 1046, clientHeight: 526 })) {
    saved[k] = Object.getOwnPropertyDescriptor(Element.prototype, k)
    Object.defineProperty(Element.prototype, k, { configurable: true, get: () => v })
  }
  HTMLElement.prototype.setPointerCapture = () => {}
  HTMLElement.prototype.hasPointerCapture = () => false
  HTMLElement.prototype.releasePointerCapture = () => {}
  HTMLElement.prototype.scrollIntoView = () => {}
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0)) as never
  globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as never
})
afterAll(() => {
  for (const [k, d] of Object.entries(saved)) {
    if (d) Object.defineProperty(Element.prototype, k, d)
    else delete (Element.prototype as unknown as Record<string, unknown>)[k]
  }
})

let container: HTMLDivElement
let root: Root
let importResponse: { status: number; body: unknown }
beforeEach(() => {
  importResponse = { status: 201, body: { spreadsheet: { id: 'new-id', title: 'plan' }, warnings: ['Charts were left out.'] } }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST' && String(url).includes('/import')) {
        return new Response(JSON.stringify(importResponse.body), { status: importResponse.status, headers: { 'Content-Type': 'application/json' } })
      }
      if (method === 'PATCH') return new Response(JSON.stringify({ spreadsheet: { ...record(), revision: 5 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify({ spreadsheet: record(), member_id: 'm-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function open(onOpen?: (id: string, title: string) => void) {
  await act(async () => {
    root.render(<SpreadsheetEditor spreadsheetId={ID} onOpen={onOpen} />)
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10))
  })
}

function fileInput(): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement
}
async function drop(file: File) {
  const input = fileInput()
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 20))
  })
}

describe('Import and export menu', () => {
  it('has the footer button and a hidden file picker for .xlsx and .csv', async () => {
    await open()
    expect(container.querySelector('[aria-label="Import and export"]')).not.toBeNull()
    expect(fileInput().getAttribute('accept')).toContain('.csv')
    expect(fileInput().getAttribute('accept')).toContain('.xlsx')
  })

  it('pastes a dropped CSV at the active cell of the open workbook', async () => {
    await open()
    expect(container.querySelector('[data-cell="A1"]')?.textContent).toBe('Role')
    await drop(new File(['One,Two\r\nThree,Four'], 'rows.csv', { type: 'text/csv' }))
    // Pasted at A1: A1 "One", B1 "Two", A2 "Three".
    expect(container.querySelector('[data-cell="A1"]')?.textContent).toBe('One')
    expect(container.querySelector('[data-cell="B1"]')?.textContent).toBe('Two')
    expect(container.querySelector('[data-cell="A2"]')?.textContent).toBe('Three')
  })

  it('imports an .xlsx as a new spreadsheet, shows its warnings, and opens it', async () => {
    const onOpen = vi.fn()
    await open(onOpen)
    await drop(new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'book.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    expect(document.body.textContent).toContain('Charts were left out.')
    const openIt = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Open it') as HTMLButtonElement
    expect(openIt).toBeTruthy()
    act(() => openIt.click())
    expect(onOpen).toHaveBeenCalledWith('new-id', 'plan')
  })
})
