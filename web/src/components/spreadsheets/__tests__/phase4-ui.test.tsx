// @vitest-environment jsdom
/**
 * Phase 4 dialogs and panels over a real engine controller: the Dropdown
 * dialog, the Goal Seek dialog and the conditional-formatting panel. Each is
 * rendered on its own with a WorkbookController, so the test drives the
 * component's own logic. Names and numbers are made up.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbookController } from '@/lib/spreadsheets/controller'
import { newModel } from '@/lib/spreadsheets/engine-server'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Goal Seek copies the workbook through the browser loader; the server one stands in.
vi.mock('@/lib/spreadsheets/engine-client', async () => {
  const server = await import('@/lib/spreadsheets/engine-server')
  return { openModel: async (workbook: string | null) => server.loadModel(workbook), loadEngine: async () => undefined, ENGINE_URL: '' }
})

const { DataValidationDialog } = await import('../data-validation')
const { GoalSeekDialog } = await import('../goal-seek-dialog')
const { ConditionalFormat } = await import('../conditional-format')
const { TableColumnMenu, TableOptionsPanel } = await import('../table-tools')
const { ChartDialog } = await import('../chart-dialog')
const { ChartView } = await import('../charts/chart-view')
const { FloatingObjects } = await import('../floating-objects')
const { prepareChartData } = await import('@/lib/spreadsheets/charts')

let container: HTMLDivElement
let root: Root
let workbook: WorkbookController
let messages: string[]

function open(cells: Array<[number, number, string]> = []) {
  const model = newModel()
  for (const [r, c, v] of cells) model.setUserInput(0, r, c, v)
  workbook = new WorkbookController(model)
  messages = []
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

const setInput = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const byText = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement

describe('the Dropdown dialog', () => {
  it('makes a list rule from typed choices and applies it to the range', () => {
    open()
    act(() => workbook.selectRange({ r1: 1, c1: 1, r2: 3, c2: 1 }))
    const onClose = vi.fn()
    act(() => root.render(<DataValidationDialog workbook={workbook} onMessage={(m) => messages.push(m)} focusGrid={() => {}} onClose={onClose} />))
    setInput(container.querySelector('[aria-label="Choices, one per line"]') as HTMLTextAreaElement, 'Open\nDone')
    act(() => byText('Apply').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onClose).toHaveBeenCalled()
    const view = workbook.validationView(1, 1)!
    expect(view.isList).toBe(true)
    expect(view.choices.map((c) => c.value)).toEqual(['Open', 'Done'])
    expect(view.rule.reject).toBe(true)
  })

  it('removes a dropdown', () => {
    open()
    act(() => {
      workbook.select(1, 1)
      workbook.setListValidation({ range: { r1: 1, c1: 1, r2: 1, c2: 1 }, choices: [{ value: 'x' }] })
    })
    act(() => root.render(<DataValidationDialog workbook={workbook} onMessage={(m) => messages.push(m)} focusGrid={() => {}} onClose={() => {}} />))
    act(() => byText('Remove dropdown').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(workbook.validationView(1, 1)).toBeNull()
  })
})

describe('the Goal Seek dialog', () => {
  it('finds the input and applies it', async () => {
    open([[1, 2, '1'], [1, 4, '=B1*4+2']]) // D1 = 4*B1+2
    act(() => root.render(<GoalSeekDialog workbook={workbook} onMessage={(m) => messages.push(m)} focusGrid={() => {}} onClose={() => {}} />))
    setInput(container.querySelector('[aria-label="Set cell"]') as HTMLInputElement, 'D1')
    setInput(container.querySelector('[aria-label="To value"]') as HTMLInputElement, '30')
    setInput(container.querySelector('[aria-label="By changing cell"]') as HTMLInputElement, 'B1')
    await act(async () => {
      byText('Find').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain('B1 = 7')
    act(() => byText('Apply').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(Number(workbook.input(1, 2))).toBeCloseTo(7, 4)
  })

  it('says plainly when there is no solution', async () => {
    open([[1, 2, '0'], [1, 4, '=B1*B1+1']])
    act(() => root.render(<GoalSeekDialog workbook={workbook} onMessage={(m) => messages.push(m)} focusGrid={() => {}} onClose={() => {}} />))
    setInput(container.querySelector('[aria-label="Set cell"]') as HTMLInputElement, 'D1')
    setInput(container.querySelector('[aria-label="To value"]') as HTMLInputElement, '0')
    setInput(container.querySelector('[aria-label="By changing cell"]') as HTMLInputElement, 'B1')
    await act(async () => {
      byText('Find').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toMatch(/No value/)
  })
})

describe('the conditional-formatting panel', () => {
  it('adds a cell-value rule the engine then applies', () => {
    open([[1, 1, '10'], [2, 1, '80']])
    act(() => workbook.selectRange({ r1: 1, c1: 1, r2: 2, c2: 1 }))
    act(() => root.render(<ConditionalFormat workbook={workbook} onMessage={(m) => messages.push(m)} onClose={() => {}} />))
    act(() => byText('Add rule').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const kind = container.querySelector('[aria-label="Rule kind"]') as HTMLSelectElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(kind, 'greaterThan')
      kind.dispatchEvent(new Event('change', { bubbles: true }))
    })
    setInput(container.querySelector('[aria-label="Value"]') as HTMLInputElement, '50')
    act(() => byText('Add').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(workbook.conditionalRules()).toHaveLength(1)
    // The engine applies the fill to the cell above the threshold only.
    expect(workbook.style(2, 1).fill.color).toBeTruthy()
    expect(workbook.style(1, 1).fill.color).toBeFalsy()
  })

  it('lists a rule and deletes it', () => {
    open([[1, 1, '5']])
    act(() =>
      workbook.addConditionalRule(
        { r1: 1, c1: 1, r2: 1, c2: 1 },
        { type: 'CellIs', operator: 'GreaterThan', formula: '1', formula2: null, format: { fill: { color: '#FEF3C7' } }, stop_if_true: false },
      ),
    )
    act(() => root.render(<ConditionalFormat workbook={workbook} onMessage={(m) => messages.push(m)} onClose={() => {}} />))
    expect(container.textContent).toContain('greater than 1')
    act(() => (container.querySelector('[aria-label="Delete rule"]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(workbook.conditionalRules()).toHaveLength(0)
  })
})

const setSelect = (el: HTMLSelectElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })

function tableFrom(rows: [number, number, string][], range: { r1: number; c1: number; r2: number; c2: number }) {
  open(rows)
  act(() => {
    workbook.selectRange(range)
    workbook.convertToTable()
  })
  return workbook.tables()[0]
}

const TABLE_ROWS: [number, number, string][] = [
  [1, 1, 'Region'], [1, 2, 'Amount'],
  [2, 1, 'North'], [2, 2, '10'],
  [3, 1, 'South'], [3, 2, '20'],
  [4, 1, 'East'], [4, 2, '30'],
]

describe('the table column menu', () => {
  it('sorts a column Z to A', () => {
    const table = tableFrom(TABLE_ROWS, { r1: 1, c1: 1, r2: 4, c2: 2 })
    act(() => root.render(<TableColumnMenu workbook={workbook} state={{ table, offset: 1, x: 10, y: 10 }} onMessage={(m) => messages.push(m)} onOpenOptions={() => {}} onClose={() => {}} />))
    act(() => byText('Sort Z to A').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect([workbook.text(2, 1), workbook.text(3, 1), workbook.text(4, 1)]).toEqual(['East', 'South', 'North'])
  })

  it('filters by a condition and hides the failing rows', () => {
    const table = tableFrom(TABLE_ROWS, { r1: 1, c1: 1, r2: 4, c2: 2 })
    act(() => root.render(<TableColumnMenu workbook={workbook} state={{ table, offset: 0, x: 10, y: 10 }} onMessage={(m) => messages.push(m)} onOpenOptions={() => {}} onClose={() => {}} />))
    act(() => byText('Filter…').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    setSelect(container.querySelector('[aria-label="Condition"]') as HTMLSelectElement, 'equals')
    setInput(container.querySelector('[aria-label="Condition value"]') as HTMLInputElement, 'North')
    act(() => byText('Apply').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(workbook.hiddenRows()).toEqual([3, 4])
  })
})

describe('the table options panel', () => {
  it('turns on the total row and deletes the table', () => {
    const table = tableFrom(TABLE_ROWS, { r1: 1, c1: 1, r2: 4, c2: 2 })
    const onClose = vi.fn()
    act(() => root.render(<TableOptionsPanel workbook={workbook} tableId={table.id} onMessage={(m) => messages.push(m)} focusGrid={() => {}} onClose={onClose} />))
    const totalRow = [...container.querySelectorAll('label')].find((l) => l.textContent?.includes('Total row'))?.querySelector('input') as HTMLInputElement
    act(() => totalRow.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(workbook.tables()[0].style.totalRow).toBe(true)
    act(() => byText('Delete table').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(workbook.tables()).toHaveLength(0)
    expect(onClose).toHaveBeenCalled()
  })
})

describe('charts in the UI', () => {
  it('draws an SVG for numeric data and a quiet state otherwise', () => {
    open()
    const ok = prepareChartData([[{ text: 'A', value: null }], [{ text: '10', value: 10 }], [{ text: '20', value: 20 }]], 'column')
    act(() => root.render(<ChartView type="column" title="Sales" legend prepared={ok} width={400} height={280} />))
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.textContent).toContain('Sales')
    const empty = prepareChartData([[{ text: 'a', value: null }]], 'column')
    act(() => root.render(<ChartView type="column" title="" legend={false} prepared={empty} width={400} height={280} />))
    expect(container.textContent).toContain('No numbers in this range')
  })

  it('renders a floating chart and deletes it from its handle', () => {
    open([[1, 1, 'Jan'], [1, 2, '10'], [2, 1, 'Feb'], [2, 2, '20']])
    let id = ''
    act(() => {
      workbook.selectRange({ r1: 1, c1: 1, r2: 2, c2: 2 })
      id = workbook.insertChart('column').id
    })
    act(() => root.render(<FloatingObjects workbook={workbook} sheet={0} layout={workbook.layout()} selectedId={id} onSelect={() => {}} onEditChart={() => {}} onMessage={(m) => messages.push(m)} />))
    expect(container.querySelector('[data-floating-object] svg')).not.toBeNull()
    act(() => (container.querySelector('[aria-label^="Delete"]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(workbook.charts()).toHaveLength(0)
  })

  it('edits a chart through the dialog', () => {
    open([[1, 1, '10'], [2, 1, '20']])
    let id = ''
    act(() => {
      workbook.selectRange({ r1: 1, c1: 1, r2: 2, c2: 1 })
      id = workbook.insertChart('column').id
    })
    act(() => root.render(<ChartDialog workbook={workbook} chartId={id} onMessage={(m) => messages.push(m)} focusGrid={() => {}} onClose={() => {}} />))
    setSelect(container.querySelector('[aria-label="Chart type"]') as HTMLSelectElement, 'line')
    act(() => byText('Apply').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(workbook.charts()[0].type).toBe('line')
  })
})
