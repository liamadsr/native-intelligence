// @vitest-environment jsdom
/**
 * The general cell grid (../cell-grid.tsx) in a DOM: its roles, keys moving
 * the active cell and growing a range, typing to edit, copy as TSV, paste
 * and Delete handed to the owner, a click and a shift-click, only the rows
 * in view rendered, and read-only mode.
 */
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CellGrid, type CellEditorProps, type GridColumn, type PasteTarget } from '../cell-grid'
import type { CellRange } from '../selection'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Row = { id: string; cells: string[] }
const COLS: GridColumn[] = ['Name', 'Kind', 'Size'].map((label, i) => ({ id: `c${i}`, label, width: 120, header: label }))
const makeRows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, cells: [`Item ${i}`, i % 2 ? 'Chair' : 'Table', String(i)] }))

// jsdom lays nothing out: give the scroller a size so the virtualizer renders a window.
const sizes = { offsetWidth: 600, offsetHeight: 400 }
const saved: Record<string, PropertyDescriptor | undefined> = {}
beforeAll(() => {
  for (const [k, v] of Object.entries(sizes)) {
    saved[k] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => v })
  }
  HTMLElement.prototype.scrollTo = function () {} as never
})
afterAll(() => {
  for (const [k, d] of Object.entries(saved)) if (d) Object.defineProperty(HTMLElement.prototype, k, d)
})

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

interface Spy {
  onPaste: ReturnType<typeof vi.fn<(t: PasteTarget[]) => void>>
  onClear: ReturnType<typeof vi.fn<(r: CellRange) => void>>
}

function Harness({ rows, readOnly, spy }: { rows: Row[]; readOnly?: boolean; spy: Spy }) {
  const [data, setData] = useState(rows)
  return (
    <div style={{ height: 400, display: 'flex' }}>
      <CellGrid<Row>
        ariaLabel="Things"
        rows={data}
        getRowId={(r) => r.id}
        columns={COLS}
        readOnly={readOnly}
        renderCell={(r, c) => <span>{r.cells[COLS.indexOf(c)]}</span>}
        renderEditor={(r, c, i, ed: CellEditorProps) => (
          <input
            aria-label="editor"
            autoFocus
            defaultValue={ed.initial ?? r.cells[COLS.indexOf(c)]}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const value = (e.target as HTMLInputElement).value
                setData((d) => d.map((x, j) => (j === i ? { ...x, cells: x.cells.map((v, k) => (k === COLS.indexOf(c) ? value : v)) } : x)))
                ed.done('down')
              }
              if (e.key === 'Escape') ed.cancel()
            }}
          />
        )}
        copyText={(r, c) => r.cells[COLS.indexOf(c)]}
        onPaste={spy.onPaste}
        onClear={spy.onClear}
      />
    </div>
  )
}

const grid = () => container.querySelector<HTMLDivElement>('[role="grid"]')!
const activeId = () => grid().getAttribute('aria-activedescendant')
const press = (key: string, opts: KeyboardEventInit = {}, target: Element = grid()) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }))
  })
const cellAt = (r: number, c: number) => container.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`)!
const selected = () => [...container.querySelectorAll('[role="gridcell"][aria-selected="true"]')].map((el) => `${(el as HTMLElement).dataset.r},${(el as HTMLElement).dataset.c}`)
function clipboardEvent(type: 'copy' | 'paste' | 'cut', text = '') {
  const store: Record<string, string> = { 'text/plain': text }
  const e = new Event(type, { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
  e.clipboardData = { getData: (t: string) => store[t] ?? '', setData: (t: string, v: string) => (store[t] = v) }
  return { e, store }
}
const spy = (): Spy => ({ onPaste: vi.fn(), onClear: vi.fn() })

async function mount(rows: Row[], opts: { readOnly?: boolean; s?: Spy } = {}) {
  const s = opts.s ?? spy()
  await act(async () => root.render(<Harness rows={rows} readOnly={opts.readOnly} spy={s} />))
  return s
}

describe('CellGrid', () => {
  it('is a grid of rows, column headers and gridcells, with the active cell named', async () => {
    await mount(makeRows(5))
    expect(grid().getAttribute('aria-rowcount')).toBe('6')
    expect(grid().getAttribute('aria-colcount')).toBe('3')
    expect([...container.querySelectorAll('[role="columnheader"]')].map((h) => h.getAttribute('aria-label'))).toEqual(['Name', 'Kind', 'Size'])
    expect(container.querySelectorAll('[role="row"]').length).toBe(6)
    expect(document.getElementById(activeId()!)?.textContent).toBe('Item 0')
  })

  it('renders only the rows in view out of 10,000', async () => {
    await mount(makeRows(10_000))
    const rendered = container.querySelectorAll('[role="row"]').length
    expect(rendered).toBeGreaterThan(5)
    expect(rendered).toBeLessThan(60)
    expect(grid().getAttribute('aria-rowcount')).toBe('10001')
  })

  it('moves with the arrows and Tab, and grows a range with shift', async () => {
    await mount(makeRows(5))
    await press('ArrowDown')
    await press('ArrowRight')
    expect(document.getElementById(activeId()!)?.textContent).toBe('Chair')
    await press('Tab')
    expect(document.getElementById(activeId()!)?.textContent).toBe('1')
    await press('Tab')
    expect(document.getElementById(activeId()!)?.textContent).toBe('Item 2')
    await press('ArrowDown', { shiftKey: true })
    await press('ArrowRight', { shiftKey: true })
    expect(selected().sort()).toEqual(['2,0', '2,1', '3,0', '3,1'])
    await press('Escape')
    expect(selected()).toEqual(['2,0'])
  })

  it('selects with a click and a range with shift-click', async () => {
    await mount(makeRows(5))
    await act(async () => {
      cellAt(1, 1).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    })
    await act(async () => {
      cellAt(3, 2).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, shiftKey: true }))
    })
    window.dispatchEvent(new MouseEvent('mouseup'))
    expect(selected().length).toBe(6)
  })

  it('a typed key starts an edit with itself; Enter saves and moves down; Esc leaves it', async () => {
    await mount(makeRows(3))
    await press('k')
    const input = container.querySelector<HTMLInputElement>('input[aria-label="editor"]')!
    expect(input.value).toBe('k')
    await press('Enter', {}, input)
    expect(cellAt(0, 0).textContent).toBe('k')
    expect(document.getElementById(activeId()!)?.textContent).toBe('Item 1')
    await press('Enter')
    await press('Escape', {}, container.querySelector('input[aria-label="editor"]')!)
    expect(container.querySelector('input[aria-label="editor"]')).toBeNull()
    expect(cellAt(1, 0).textContent).toBe('Item 1')
  })

  it('copies the range as TSV', async () => {
    await mount(makeRows(3))
    await press('ArrowDown', { shiftKey: true })
    await press('ArrowRight', { shiftKey: true })
    const { e, store } = clipboardEvent('copy')
    await act(async () => {
      grid().dispatchEvent(e)
    })
    expect(store['text/plain']).toBe('Item 0\tTable\nItem 1\tChair')
    expect(e.defaultPrevented).toBe(true)
  })

  it('hands a paste to the owner as target cells (past the last row too), and selects what it filled', async () => {
    const s = await mount(makeRows(2))
    await press('ArrowDown')
    const { e } = clipboardEvent('paste', 'a\tb\nc\td\n')
    await act(async () => {
      grid().dispatchEvent(e)
    })
    expect(s.onPaste).toHaveBeenCalledWith([
      { row: 1, col: 0, text: 'a' },
      { row: 1, col: 1, text: 'b' },
      { row: 2, col: 0, text: 'c' },
      { row: 2, col: 1, text: 'd' },
    ])
    expect(selected()).toEqual(expect.arrayContaining(['1,0', '1,1']))
  })

  it('Delete hands the range to the owner to clear; a cut copies then clears', async () => {
    const s = await mount(makeRows(3))
    await press('ArrowRight', { shiftKey: true })
    await press('Delete')
    expect(s.onClear).toHaveBeenCalledWith({ top: 0, left: 0, bottom: 0, right: 1 })
    const { e, store } = clipboardEvent('cut')
    await act(async () => {
      grid().dispatchEvent(e)
    })
    expect(store['text/plain']).toBe('Item 0\tTable')
    expect(s.onClear).toHaveBeenCalledTimes(2)
  })

  it('read-only: selects and copies, but never edits, pastes or clears', async () => {
    const s = await mount(makeRows(3), { readOnly: true })
    expect(grid().getAttribute('aria-readonly')).toBe('true')
    await press('x')
    await press('Enter')
    expect(container.querySelector('input[aria-label="editor"]')).toBeNull()
    await press('Delete')
    const { e } = clipboardEvent('paste', 'z')
    await act(async () => {
      grid().dispatchEvent(e)
    })
    expect(s.onClear).not.toHaveBeenCalled()
    expect(s.onPaste).not.toHaveBeenCalled()
    const copy = clipboardEvent('copy')
    await act(async () => {
      grid().dispatchEvent(copy.e)
    })
    expect(copy.store['text/plain']).toBe('Item 0')
  })
})
