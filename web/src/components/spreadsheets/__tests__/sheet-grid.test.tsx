// @vitest-environment jsdom
/**
 * The sheet grid over a real engine: what it draws, the keyboard, typing and
 * committing, the selection, the clipboard, and that a sheet of 10,000 rows
 * draws only what is in view. Names and numbers are made up.
 */
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WorkbookController } from '@/lib/spreadsheets/controller'
import { newModel } from '@/lib/spreadsheets/engine-server'
import { SheetGrid, type CaretState, type GridMenuTarget } from '../sheet-grid'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const sizes = { clientWidth: 1046, clientHeight: 526 }
const saved: Record<string, PropertyDescriptor | undefined> = {}
beforeAll(() => {
  for (const [k, v] of Object.entries(sizes)) {
    saved[k] = Object.getOwnPropertyDescriptor(Element.prototype, k)
    Object.defineProperty(Element.prototype, k, { configurable: true, get: () => v })
  }
  HTMLElement.prototype.setPointerCapture = () => {}
  HTMLElement.prototype.hasPointerCapture = () => false
  HTMLElement.prototype.releasePointerCapture = () => {}
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
let workbook: WorkbookController
let messages: string[]
let menus: GridMenuTarget[]
const caret = createRef<CaretState>() as React.MutableRefObject<CaretState>

function mount(cells: Array<[number, number, string]> = [], options: { readOnly?: boolean; showFormulas?: boolean } = {}) {
  const model = newModel()
  model.pauseEvaluation()
  for (const [r, c, v] of cells) model.setUserInput(0, r, c, v)
  model.resumeEvaluation()
  workbook = new WorkbookController(model, { readOnly: options.readOnly })
  caret.current = { start: 0, end: 0, pointed: null }
  messages = []
  menus = []
  act(() => {
    root.render(
      <div style={{ width: 1046, height: 526 }}>
        <SheetGrid workbook={workbook} caret={caret} ariaLabel="Budget: Sheet1" showFormulas={options.showFormulas} onMessage={(m) => messages.push(m)} onContextMenu={(t) => menus.push(t)} />
      </div>,
    )
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const grid = () => container.querySelector<HTMLElement>('[role="grid"]') as HTMLElement
const cell = (name: string) => container.querySelector<HTMLElement>(`[data-cell="${name}"]`)
const editor = () => container.querySelector<HTMLTextAreaElement>('textarea')
const key = (k: string, init: KeyboardEventInit = {}, target: Element = grid()) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))
  })
function typeInto(el: HTMLTextAreaElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(el, value)
    el.setSelectionRange(value.length, value.length)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
/** A pointer event at a cell's place (the grid is at the page's origin in jsdom). */
function pointer(type: string, row: number, column: number, init: PointerEventInit = {}, target?: Element) {
  const layout = workbook.layout()
  const x = 46 + (layout.columnStarts[column - 1] + layout.columnStarts[column]) / 2
  const y = 26 + (layout.rowStarts[row - 1] + layout.rowStarts[row]) / 2
  const el = target ?? (container.querySelector('.cursor-cell') as Element)
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...init }))
  })
}

describe('what the grid draws', () => {
  it('shows values and calculated formulas, numbers to the right', () => {
    mount([[1, 1, 'Paper'], [1, 2, '12'], [1, 3, '=B1*4.5']])
    expect(cell('A1')?.textContent).toBe('Paper')
    expect(cell('C1')?.textContent).toBe('54')
    expect(cell('C1')?.style.justifyContent).toBe('flex-end')
    expect(cell('A1')?.style.justifyContent).toBe('flex-start')
  })

  it('names the grid and its size for a screen reader, and letters its columns', () => {
    mount()
    expect(grid().getAttribute('aria-label')).toBe('Budget: Sheet1')
    expect(grid().getAttribute('aria-rowcount')).toBe('200')
    expect(grid().getAttribute('aria-colcount')).toBe('26')
    const letters = [...container.querySelectorAll('[role="columnheader"]')].map((h) => h.textContent)
    expect(letters.slice(0, 3)).toEqual(['A', 'B', 'C'])
    expect(container.querySelector('[role="rowheader"]')?.textContent).toBe('1')
  })

  it('draws an error in the error color and formulas as typed when asked', () => {
    mount([[1, 1, '=1/0'], [2, 1, '=1+1']], { showFormulas: true })
    expect(cell('A1')?.textContent).toBe('=1/0')
    expect(cell('A2')?.textContent).toBe('=1+1')
    act(() => root.unmount())
    root = createRoot(container)
    mount([[1, 1, '=1/0']])
    expect(cell('A1')?.textContent).toBe('#DIV/0!')
    expect(cell('A1')?.className).toContain('text-destructive')
  })

  it('draws a cell’s bold, fill and text color', () => {
    mount([[1, 1, 'Total']])
    act(() => {
      workbook.select(1, 1)
      workbook.setStyle('font.b', 'true')
      workbook.setStyle('fill.fg_color', '#DDEEFF')
      workbook.setStyle('font.color', '#C00000')
    })
    const el = cell('A1') as HTMLElement
    expect(el.style.fontWeight).toBe('600')
    expect(el.style.backgroundColor).toBe('rgb(221, 238, 255)')
    expect(el.style.color).toBe('rgb(192, 0, 0)')
  })

  it('lets long text run over the empty cells beside it, up to the next filled one', () => {
    mount([[1, 1, 'A long label that does not fit in one column'], [1, 4, 'stop'], [2, 1, 'Short'], [2, 2, 'next']])
    expect(cell('A1')?.style.width).toBe('270px')
    expect(cell('A2')?.style.width).toBe('90px')
  })

  it('draws only what is in view of a sheet of 10,000 rows', async () => {
    const cells: Array<[number, number, string]> = []
    for (let r = 1; r <= 10000; r++) cells.push([r, 1, `Row ${r}`], [r, 2, String(r)], [r, 3, `=B${r}*2`])
    const started = Date.now()
    mount(cells)
    expect(grid().getAttribute('aria-rowcount')).toBe('10050')
    const drawn = container.querySelectorAll('[role="gridcell"]').length
    expect(drawn).toBeGreaterThan(40)
    expect(drawn).toBeLessThan(120)
    expect(container.querySelectorAll('[role="rowheader"]').length).toBeLessThan(40)
    expect(cell('C5')?.textContent).toBe('10')
    expect(cell('A9000')).toBeNull()
    // Scroll to the far end: the last rows are drawn, the first are gone.
    await act(async () => {
      const scroller = container.querySelector('[data-sheet-scroller]') as HTMLElement
      scroller.scrollTop = 9980 * 25
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(cell('C9990')?.textContent).toBe('19980')
    expect(cell('A1')).toBeNull()
    expect(container.querySelectorAll('[role="gridcell"]').length).toBeLessThan(120)
    expect(Date.now() - started).toBeLessThan(8000)
  })
})

describe('the keyboard', () => {
  it('moves with the arrows and Tab, and marks the active cell', () => {
    mount()
    key('ArrowDown')
    key('ArrowRight')
    key('Tab')
    expect(grid().getAttribute('data-active-cell')).toBe('C2')
    key('Tab', { shiftKey: true })
    key('Home')
    expect(grid().getAttribute('data-active-cell')).toBe('A2')
    key('Home', { ctrlKey: true })
    expect(grid().getAttribute('data-active-cell')).toBe('A1')
  })

  it('stretches the selection with Shift and selects everything with Ctrl+A', () => {
    mount()
    key('ArrowDown', { shiftKey: true })
    key('ArrowRight', { shiftKey: true })
    expect(container.querySelector('[data-selection-range]')?.getAttribute('data-selection-range')).toBe('A1:B2')
    key('a', { ctrlKey: true })
    expect(workbook.selectedBand()).toEqual({ rows: true, columns: true })
  })

  it('typing starts an edit that replaces the cell; Enter commits and moves down', () => {
    mount([[1, 1, 'old']])
    key('7')
    const el = editor() as HTMLTextAreaElement
    expect(el.value).toBe('7')
    expect(el.getAttribute('aria-label')).toBe('Editing A1')
    typeInto(el, '75')
    key('Enter', {}, el)
    expect(editor()).toBeNull()
    expect(cell('A1')?.textContent).toBe('75')
    expect(grid().getAttribute('data-active-cell')).toBe('A2')
  })

  it('Enter and F2 edit what the cell holds; Escape leaves it as it was', () => {
    mount([[1, 1, '=2*3']])
    key('F2')
    expect(editor()?.value).toBe('=2*3')
    typeInto(editor() as HTMLTextAreaElement, '=2*30')
    key('Escape', {}, editor() as Element)
    expect(cell('A1')?.textContent).toBe('6')
    key('Enter')
    expect(editor()?.value).toBe('=2*3')
  })

  it('Tab in the editor commits and moves right', () => {
    mount()
    key('x')
    key('Tab', {}, editor() as Element)
    expect(cell('A1')?.textContent).toBe('x')
    expect(grid().getAttribute('data-active-cell')).toBe('B1')
  })

  it('Delete clears the selection; Ctrl+Z brings it back and Ctrl+Shift+Z clears it again', () => {
    mount([[1, 1, 'keep']])
    key('Delete')
    expect(cell('A1')).toBeNull()
    key('z', { ctrlKey: true })
    expect(cell('A1')?.textContent).toBe('keep')
    key('z', { ctrlKey: true, shiftKey: true })
    expect(cell('A1')).toBeNull()
  })

  it('Ctrl+B makes the selection bold and Ctrl+D fills down', () => {
    mount([[1, 1, '=ROW()']])
    key('b', { ctrlKey: true })
    expect(workbook.style(1, 1).font.b).toBe(true)
    key('ArrowDown', { shiftKey: true })
    key('ArrowDown', { shiftKey: true })
    key('d', { ctrlKey: true })
    expect(cell('A3')?.textContent).toBe('3')
  })

  it('does not edit a view-only workbook', () => {
    mount([[1, 1, 'fixed']], { readOnly: true })
    key('x')
    expect(editor()).toBeNull()
    key('Delete')
    expect(cell('A1')?.textContent).toBe('fixed')
    expect(messages[0]).toMatch(/view/)
    expect(container.querySelector('[data-fill-handle]')).toBeNull()
  })
})

describe('the mouse', () => {
  it('a press selects a cell, a drag selects a range, Shift+press stretches', () => {
    mount()
    pointer('pointerdown', 3, 2)
    expect(grid().getAttribute('data-active-cell')).toBe('B3')
    pointer('pointermove', 5, 4)
    pointer('pointerup', 5, 4)
    expect(workbook.selection().range).toEqual({ r1: 3, c1: 2, r2: 5, c2: 4 })
    pointer('pointerdown', 1, 1)
    pointer('pointerup', 1, 1)
    pointer('pointerdown', 2, 2, { shiftKey: true })
    expect(workbook.selection().range).toEqual({ r1: 1, c1: 1, r2: 2, c2: 2 })
  })

  it('dragging over cells does not select their text as a page does', () => {
    mount([[1, 1, 'Paper']])
    expect((container.querySelector('.cursor-cell') as HTMLElement).className).toContain('select-none')
  })

  it('a double-click edits the cell in place', () => {
    mount([[2, 2, 'hello']])
    pointer('pointerdown', 2, 2)
    pointer('pointerup', 2, 2)
    pointer('dblclick', 2, 2)
    expect(editor()?.value).toBe('hello')
  })

  it('a press on another cell commits what was being typed', () => {
    mount()
    key('4')
    pointer('pointerdown', 4, 4)
    expect(cell('A1')?.textContent).toBe('4')
    expect(grid().getAttribute('data-active-cell')).toBe('D4')
  })

  it('while a formula waits for a reference, a press points at a cell and a drag at a range', () => {
    mount([[1, 1, '5'], [2, 1, '6']])
    act(() => workbook.select(1, 3))
    key('=')
    const el = editor() as HTMLTextAreaElement
    typeInto(el, '=SUM(')
    act(() => {
      caret.current = { start: 5, end: 5, pointed: null }
    })
    pointer('pointerdown', 1, 1)
    expect(workbook.editing?.draft).toBe('=SUM(A1')
    pointer('pointermove', 2, 1)
    pointer('pointerup', 2, 1)
    expect(workbook.editing?.draft).toBe('=SUM(A1:A2')
    typeInto(editor() as HTMLTextAreaElement, '=SUM(A1:A2)')
    key('Enter', {}, editor() as Element)
    expect(cell('C1')?.textContent).toBe('11')
  })

  it('dragging the fill handle continues the selection downward', () => {
    mount([[1, 1, '1'], [2, 1, '2']])
    act(() => workbook.selectRange({ r1: 1, c1: 1, r2: 2, c2: 1 }))
    const handle = container.querySelector('[data-fill-handle]') as Element
    pointer('pointerdown', 2, 1, {}, handle)
    pointer('pointermove', 5, 1, {}, handle)
    pointer('pointerup', 5, 1, {}, handle)
    expect([3, 4, 5].map((r) => cell(`A${r}`)?.textContent)).toEqual(['3', '4', '5'])
  })

  it('a press on a column letter selects the column, on a row number the row, on the corner everything', () => {
    mount()
    const headers = container.querySelector('[data-column-headers]') as Element
    const layout = workbook.layout()
    act(() => {
      headers.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 46 + layout.columnStarts[2] + 40, clientY: 10, button: 0 }))
      headers.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 46 + layout.columnStarts[2] + 40, clientY: 10, button: 0 }))
    })
    expect(workbook.selectedBand()).toEqual({ rows: false, columns: true })
    expect(workbook.selection().range.c1).toBe(3)
    const rows = container.querySelector('[data-row-headers]') as Element
    act(() => {
      rows.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 26 + 25 * 4 + 10, button: 0 }))
      rows.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 10, clientY: 26 + 25 * 4 + 10, button: 0 }))
    })
    expect(workbook.selectedBand().rows).toBe(true)
    expect(workbook.selection().range.r1).toBe(5)
    act(() => {
      container.querySelector('[aria-label="Select all cells"]')?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    expect(workbook.selectedBand()).toEqual({ rows: true, columns: true })
  })

  it('dragging a column letter’s right edge resizes the column', () => {
    mount()
    const headers = container.querySelector('[data-column-headers]') as Element
    act(() => {
      headers.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 46 + 90 - 2, clientY: 10, button: 0 }))
      headers.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 46 + 90 + 58, clientY: 10, button: 0 }))
    })
    act(() => {
      headers.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 46 + 90 + 58, clientY: 10, button: 0 }))
    })
    expect(workbook.layout().columnStarts[1]).toBe(150)
  })

  it('a right-click says what it was on, and keeps a selection it lands inside', () => {
    mount()
    act(() => workbook.selectRange({ r1: 1, c1: 1, r2: 3, c2: 3 }))
    pointer('pointerdown', 2, 2, { button: 2 })
    pointer('contextmenu', 2, 2, { button: 2 })
    expect(menus).toEqual([{ kind: 'cell' }])
    expect(workbook.selection().range).toEqual({ r1: 1, c1: 1, r2: 3, c2: 3 })
    pointer('pointerdown', 6, 6, { button: 2 })
    expect(grid().getAttribute('data-active-cell')).toBe('F6')
  })
})

describe('the clipboard', () => {
  function clip(type: 'copy' | 'cut' | 'paste', data: Record<string, string> = {}) {
    const store: Record<string, string> = { ...data }
    const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
    event.clipboardData = { getData: (t: string) => store[t] ?? '', setData: (t: string, v: string) => void (store[t] = v) }
    act(() => {
      grid().dispatchEvent(event)
    })
    return store
  }

  it('copies as tab-separated text and a table, and pastes its own copy with the formula shifted', () => {
    mount([[1, 1, '4'], [1, 2, '=A1*2'], [2, 1, '6']])
    act(() => workbook.select(1, 2))
    const copied = clip('copy')
    expect(copied['text/plain']).toBe('8')
    expect(copied['text/html']).toBe('<table><tr><td>8</td></tr></table>')
    act(() => workbook.select(2, 2))
    clip('paste', copied)
    expect(workbook.input(2, 2)).toBe('=A2*2')
    expect(cell('B2')?.textContent).toBe('12')
  })

  it('pastes rows copied from another spreadsheet, as text or as a table', () => {
    mount()
    clip('paste', { 'text/plain': 'Item\tCost\r\nPaper\t12.5\r\n' })
    expect([cell('A1')?.textContent, cell('B2')?.textContent]).toEqual(['Item', '12.5'])
    act(() => workbook.select(5, 1))
    clip('paste', { 'text/html': '<table><tr><td>From</td><td>a table</td></tr></table>' })
    expect(cell('B5')?.textContent).toBe('a table')
  })

  it('a cut moves the cells on paste', () => {
    mount([[1, 1, 'move me']])
    const cut = clip('cut')
    act(() => workbook.select(3, 3))
    clip('paste', cut)
    expect(cell('A1')).toBeNull()
    expect(cell('C3')?.textContent).toBe('move me')
  })
})

describe('checkboxes', () => {
  it('draws a checkbox, toggles it on click and on Space, as a boolean', () => {
    mount()
    act(() => workbook.insertCheckboxes({ r1: 1, c1: 1, r2: 1, c2: 1 }))
    const box = container.querySelector('[data-checkbox="A1"]') as HTMLButtonElement
    expect(box).not.toBeNull()
    expect(box.getAttribute('aria-checked')).toBe('false')
    act(() => box.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect((container.querySelector('[data-checkbox="A1"]') as HTMLElement).getAttribute('aria-checked')).toBe('true')
    // Space on the active cell toggles it back.
    act(() => workbook.select(1, 1))
    key(' ')
    expect((container.querySelector('[data-checkbox="A1"]') as HTMLElement).getAttribute('aria-checked')).toBe('false')
  })
})

describe('dropdowns and validation', () => {
  it('draws an arrow, opens a list and writes a chosen value', () => {
    mount()
    act(() => workbook.setListValidation({ range: { r1: 1, c1: 1, r2: 1, c2: 1 }, choices: [{ value: 'Open' }, { value: 'Done' }], reject: true }))
    const arrow = container.querySelector('[data-dropdown-arrow="A1"]') as HTMLButtonElement
    expect(arrow).not.toBeNull()
    act(() => arrow.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const options = [...container.querySelectorAll('[role="option"]')].map((o) => o.textContent)
    expect(options).toEqual(['Open', 'Done'])
    act(() => (container.querySelectorAll('[role="option"]')[1] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(cell('A1')?.textContent).toBe('Done')
  })

  it('Alt+Down opens the list on the active cell', () => {
    mount()
    act(() => workbook.setListValidation({ range: { r1: 1, c1: 1, r2: 1, c2: 1 }, choices: [{ value: 'Yes' }], reject: true }))
    act(() => workbook.select(1, 1))
    key('ArrowDown', { altKey: true })
    expect(container.querySelector('[role="listbox"]')).not.toBeNull()
  })

  it('marks a non-rejecting value with a warning', () => {
    mount([[1, 1, 'Nope']])
    act(() => workbook.setListValidation({ range: { r1: 1, c1: 1, r2: 1, c2: 1 }, choices: [{ value: 'Yes' }], reject: false }))
    expect(container.querySelector('[data-validation-warning="A1"]')).not.toBeNull()
  })
})

describe('conditional formatting marks', () => {
  it('draws a data bar behind a value', () => {
    mount([[1, 1, '10'], [2, 1, '50']])
    act(() =>
      workbook.addConditionalRule(
        { r1: 1, c1: 1, r2: 2, c2: 1 },
        { type: 'DataBar', min: null, max: null, positive_color: '#638EC6', negative_color: '#FF0000', is_gradient: true, show_value: true },
      ),
    )
    expect(container.querySelectorAll('[data-data-bar]').length).toBeGreaterThan(0)
  })

  it('draws an icon from an icon-set rule', () => {
    mount([[1, 1, '10'], [2, 1, '90']])
    act(() =>
      workbook.addConditionalRule(
        { r1: 1, c1: 1, r2: 2, c2: 1 },
        { type: 'IconSet', thresholds: [{ icon: 'Circle', cfvo: 'Min', color: '#FF0000', is_strict: false }, { icon: 'Circle', cfvo: { Percent: 50 }, color: '#00FF00', is_strict: false }], show_value: true },
      ),
    )
    expect(container.querySelectorAll('[data-cf-icon]').length).toBeGreaterThan(0)
  })
})
