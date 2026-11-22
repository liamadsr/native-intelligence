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
