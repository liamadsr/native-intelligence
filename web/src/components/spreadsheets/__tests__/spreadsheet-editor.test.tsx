// @vitest-environment jsdom
/**
 * One spreadsheet open: it loads the record and its workbook, saves a little
 * after a change against the revision it loaded, moves on to the revision a
 * save answers, stops and says so when someone else got there first, and
 * renames. Fetch is stubbed; the engine is the real one.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadModel } from '@/lib/spreadsheets/engine-server'
import { saveWorkbook } from '@/lib/spreadsheets/workbook'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }) }))
// The browser fetches the engine's binary; here the server's loader stands in for it.
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

const record = (extra: Record<string, unknown> = {}) => ({
  id: ID, workspace_id: 'ws', title: 'Hiring plan', created_by: 'm-1', last_edited_by: 'm-1', visibility: 'workspace', status: 'active',
  revision: 4, sheet_names: ['Sheet1'], created_at: '', updated_at: '', extras: {}, workbook: workbookWith([[1, 1, 'Role'], [2, 1, 'Designer']]), ...extra,
})

const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
let current: ReturnType<typeof record>
let patch: (body: Record<string, unknown>) => Response

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
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  calls.length = 0
  current = record()
  patch = (body) => {
    current = { ...current, revision: current.revision + 1, ...(body.title ? { title: String(body.title) } : {}) }
    const { workbook: _workbook, extras: _extras, ...summary } = current
    return json({ spreadsheet: summary })
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      calls.push({ url, method, body })
      if (method === 'PATCH') return patch(body ?? {})
      return json({ spreadsheet: current, member_id: 'm-1' })
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function open(onBack?: () => void) {
  await act(async () => {
    root.render(<SpreadsheetEditor spreadsheetId={ID} onBack={onBack} />)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10)
  })
}
const grid = () => container.querySelector<HTMLElement>('[role="grid"]') as HTMLElement
const key = (k: string, target: Element = grid(), init: KeyboardEventInit = {}) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))
  })
// What the save says: nothing while it goes well (Saved, Saving… and Unsaved
// changes are not shown; Liam, 11-22), only a save that needs the person.
const note = () => container.querySelector('[aria-live="polite"]')?.textContent ?? container.querySelector('[role="alert"]')?.textContent ?? ''
const patches = () => calls.filter((c) => c.method === 'PATCH')
async function typeCell(text: string) {
  key(text)
  key('Enter', container.querySelector('textarea') as Element)
}

describe('opening a spreadsheet', () => {
  it('shows a grid skeleton, then the title, the cells, the formula bar and the sheet tabs', async () => {
    act(() => {
      root.render(<SpreadsheetEditor spreadsheetId={ID} />)
    })
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect((container.querySelector('[aria-label="Spreadsheet name"]') as HTMLInputElement).value).toBe('Hiring plan')
    expect(container.querySelector('[data-cell="A2"]')?.textContent).toBe('Designer')
    expect((container.querySelector('[aria-label="Formula bar"]') as HTMLInputElement).value).toBe('Role')
    expect((container.querySelector('[aria-label="Go to cell"]') as HTMLInputElement).value).toBe('A1')
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Sheet1')
    expect(note()).toBe('')
  })

  it('says what went wrong and offers to try again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Spreadsheet not found.' }, 404)))
    await open()
    expect(container.textContent).toContain('Spreadsheet not found.')
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toContain('Try again')
  })

  it('an archived spreadsheet opens view-only', async () => {
    current = record({ status: 'archived' })
    await open()
    expect(container.textContent).toContain('Archived: view only')
    key('x')
    expect(container.querySelector('textarea')).toBeNull()
    expect(grid().getAttribute('aria-readonly')).toBe('true')
  })
})

describe('saving', () => {
  it('saves a little after a change, against the revision it loaded, then against the one the save answered', async () => {
    await open()
    await typeCell('5')
    expect(note()).toBe('')
    expect(patches()).toHaveLength(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300)
    })
    expect(patches()).toHaveLength(1)
    expect(patches()[0].body?.base_revision).toBe(4)
    const sent = loadModel(String(patches()[0].body?.workbook))
    expect(sent.getCellContent(0, 1, 1)).toBe('5')
    sent.free()
    expect(note()).toBe('')
    await typeCell('6')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300)
    })
    expect(patches()[1].body?.base_revision).toBe(5)
  })

  it('several quick changes go out as one save', async () => {
    await open()
    await typeCell('1')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    await typeCell('2')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(patches()).toHaveLength(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800)
    })
    expect(patches()).toHaveLength(1)
  })

  it('moving the selection saves nothing', async () => {
    await open()
    key('ArrowDown')
    key('ArrowRight')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(patches()).toHaveLength(0)
    expect(note()).toBe('')
  })

  it('when someone else saved first, it stops saving and offers their version', async () => {
    patch = () => json({ error: 'Someone else changed this spreadsheet since you opened it.', code: 'SPREADSHEET_REVISION_CONFLICT' }, 409)
    await open()
    await typeCell('m')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300)
    })
    expect(note()).toContain('Someone else changed this spreadsheet')
    await typeCell('n')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(patches()).toHaveLength(1)
    // Their version: the record is fetched again and the editor starts over from it.
    current = record({ revision: 9, workbook: workbookWith([[1, 1, 'Theirs']]) })
    const reload = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Load their version') as HTMLButtonElement
    await act(async () => {
      reload.click()
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(container.querySelector('[data-cell="A1"]')?.textContent).toBe('Theirs')
    expect(note()).toBe('')
  })

  it('a save that fails says so and can be tried again', async () => {
    let fail = true
    const ok = patch
    patch = (body) => (fail ? json({ error: 'down' }, 500) : ok(body))
    await open()
    await typeCell('x')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300)
    })
    expect(note()).toContain('Not saved')
    fail = false
    await act(async () => {
      ;([...container.querySelectorAll('button')].find((b) => b.textContent === 'Try again') as HTMLButtonElement).click()
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(note()).toBe('')
  })
})

describe('the title and the toolbar', () => {
  it('renames on blur, and the next save is made from the revision the rename answered', async () => {
    await open()
    const title = container.querySelector('[aria-label="Spreadsheet name"]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(title, 'Hiring plan 2027')
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      title.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(patches()[0].body).toEqual({ title: 'Hiring plan 2027' })
    await typeCell('1')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300)
    })
    expect(patches()[1].body?.base_revision).toBe(5)
  })

  it('Undo is off until something changed, and takes the change back', async () => {
    await open()
    const undo = container.querySelector('[aria-label="Undo"]') as HTMLButtonElement
    expect(undo.disabled).toBe(true)
    await typeCell('9')
    expect(undo.disabled).toBe(false)
    act(() => undo.click())
    expect(container.querySelector('[data-cell="A1"]')?.textContent).toBe('Role')
    expect((container.querySelector('[aria-label="Redo"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('Bold shows the active cell’s state and toggles it', async () => {
    await open()
    const bold = container.querySelector('[aria-label="Bold"]') as HTMLButtonElement
    expect(bold.getAttribute('aria-pressed')).toBe('false')
    act(() => bold.click())
    expect(bold.getAttribute('aria-pressed')).toBe('true')
    expect((container.querySelector('[data-cell="A1"]') as HTMLElement).style.fontWeight).toBe('600')
  })

  it('Back leaves the editor', async () => {
    const onBack = vi.fn()
    await open(onBack)
    act(() => (container.querySelector('[aria-label="Back to spreadsheets"]') as HTMLButtonElement).click())
    expect(onBack).toHaveBeenCalled()
  })
})

describe('the formula bar and Go to cell', () => {
  it('shows what the active cell holds, and typing in it edits the cell', async () => {
    current = record({ workbook: workbookWith([[1, 1, '=2+3']]) })
    await open()
    const bar = container.querySelector('[aria-label="Formula bar"]') as HTMLInputElement
    expect(bar.value).toBe('=2+3')
    expect(container.querySelector('[data-cell="A1"]')?.textContent).toBe('5')
    await act(async () => {
      bar.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(bar, '=2+30')
      bar.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector('[aria-label="Apply edit"]')).not.toBeNull()
    key('Enter', bar)
    expect(container.querySelector('[data-cell="A1"]')?.textContent).toBe('32')
  })

  it('Go to cell takes an address or a range, and refuses what is neither', async () => {
    const { toast } = await import('sonner')
    await open()
    const box = container.querySelector('[aria-label="Go to cell"]') as HTMLInputElement
    const go = async (text: string) => {
      await act(async () => {
        box.focus()
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(box, text)
        box.dispatchEvent(new Event('input', { bubbles: true }))
      })
      key('Enter', box)
    }
    await go('c7')
    expect(grid().getAttribute('data-active-cell')).toBe('C7')
    await go('B2:D4')
    expect(container.querySelector('[data-selection-range]')?.getAttribute('data-selection-range')).toBe('B2:D4')
    expect(box.value).toBe('3R × 3C')
    await go('nowhere')
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('not a cell or a range'))
  })
})

describe('sheet tabs', () => {
  it('adds a sheet and switches to it; the first sheet’s cells are not on it', async () => {
    await open()
    act(() => (container.querySelector('[aria-label="Add sheet"]') as HTMLButtonElement).click())
    const tabs = [...container.querySelectorAll('[role="tab"]')]
    expect(tabs.map((t) => t.textContent)).toEqual(['Sheet1', 'Sheet2'])
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('[data-cell="A1"]')).toBeNull()
    act(() => (tabs[0] as HTMLElement).click())
    expect(container.querySelector('[data-cell="A1"]')?.textContent).toBe('Role')
  })

  it('a double-click renames a tab in place, and a taken name is refused', async () => {
    const { toast } = await import('sonner')
    await open()
    act(() => (container.querySelector('[aria-label="Add sheet"]') as HTMLButtonElement).click())
    const second = container.querySelectorAll('[role="tab"]')[1] as HTMLElement
    act(() => second.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    const input = container.querySelector('[aria-label="Sheet name"]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Costs')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    key('Enter', input)
    expect(container.querySelectorAll('[role="tab"]')[1].textContent).toBe('Costs')
    act(() => (container.querySelectorAll('[role="tab"]')[1] as HTMLElement).dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    const again = container.querySelector('[aria-label="Sheet name"]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(again, 'sheet1')
      again.dispatchEvent(new Event('input', { bubbles: true }))
    })
    key('Enter', again)
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('already'))
    expect(container.querySelectorAll('[role="tab"]')[1].textContent).toBe('Costs')
  })

  it('a formula can point at a cell on another sheet', async () => {
    current = record({ workbook: workbookWith([[1, 1, '40']]) })
    await open()
    act(() => (container.querySelector('[aria-label="Add sheet"]') as HTMLButtonElement).click())
    key('=')
    const tabs = container.querySelectorAll('[role="tab"]')
    act(() => (tabs[0] as HTMLElement).click())
    const cells = container.querySelector('.cursor-cell') as Element
    act(() => {
      cells.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 46 + 45, clientY: 26 + 12, button: 0 }))
      cells.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 46 + 45, clientY: 26 + 12, button: 0 }))
    })
    const bar = container.querySelector('[aria-label="Formula bar"]') as HTMLInputElement
    expect(bar.value).toBe('=Sheet1!A1')
    key('Enter', bar)
    // The edit was on Sheet2: committing goes back to it.
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Sheet2')
    expect(container.querySelector('[data-cell="A1"]')?.textContent).toBe('40')
  })
})

describe('the full toolbar', () => {
  const press = (label: string) => act(() => (container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click())
  const a1 = () => container.querySelector('[data-cell="A1"]') as HTMLElement

  it('has every control of the formatting row, in order', async () => {
    await open()
    const labels = [...container.querySelectorAll('[role="toolbar"] [aria-label]')].map((el) => el.getAttribute('aria-label'))
    expect(labels).toEqual([
      'Decrease font size', 'Font size', 'Increase font size',
      'Bold', 'Italic', 'Strikethrough', 'Underline',
      'Undo', 'Redo', 'Format as currency', 'Format as percent', 'Decrease decimal places', 'Increase decimal places', 'Wrap text',
      'Find and replace',
      'Number format', 'Font', 'Text color', 'Fill color', 'Borders', 'Horizontal alignment', 'Vertical alignment', 'Functions', 'Paste special', 'Insert', 'View options', 'Format and data',
    ])
  })

  it('formats as currency and percent, and steps the decimal places', async () => {
    current = record({ workbook: workbookWith([[1, 1, '1234.5']]) })
    await open()
    press('Format as currency')
    expect(a1().textContent).toBe('$1,234.50')
    expect(container.querySelector('[aria-label="Format as currency"]')?.getAttribute('aria-pressed')).toBe('true')
    press('Increase decimal places')
    expect(a1().textContent).toBe('$1,234.500')
    press('Decrease decimal places')
    press('Decrease decimal places')
    expect(a1().textContent).toBe('$1,234.5')
    press('Format as percent')
    expect(a1().textContent).toBe('123450.00%')
  })

  it('steps the font size and takes one typed into the box', async () => {
    await open()
    const box = container.querySelector('[aria-label="Font size"]') as HTMLInputElement
    expect(box.value).toBe('12')
    press('Increase font size')
    press('Increase font size')
    expect(box.value).toBe('14')
    press('Decrease font size')
    expect(box.value).toBe('13')
    await act(async () => {
      box.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(box, '24')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    key('Enter', box)
    expect(a1().style.fontSize).toBe('26px')
  })

  it('wraps text and strikes it through', async () => {
    await open()
    press('Wrap text')
    expect(a1().className).toContain('whitespace-pre-wrap')
    press('Strikethrough')
    expect(a1().style.textDecoration).toContain('line-through')
    expect(container.querySelector('[aria-label="Wrap text"]')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('is off for a view-only spreadsheet, but find still opens', async () => {
    current = record({ status: 'archived' })
    await open()
    for (const label of ['Bold', 'Format as currency', 'Wrap text', 'Increase font size', 'Number format', 'Borders']) {
      expect((container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).disabled, label).toBe(true)
    }
    press('Find and replace')
    expect(container.querySelector('[role="search"]')).not.toBeNull()
    expect((container.querySelector('[aria-label="Replace with"]') as HTMLInputElement).disabled).toBe(true)
  })
})

describe('find and replace', () => {
  const type = async (label: string, text: string) => {
    const el = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, text)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    return el
  }
  const sheet = () => workbookWith([[1, 1, 'red pen'], [2, 1, 'Red ink'], [3, 2, 'blue'], [4, 1, '="red"&"dy"']])

  it('Ctrl+F opens it; it counts the matches and walks them with Enter and Shift+Enter', async () => {
    current = record({ workbook: sheet() })
    await open()
    key('f', grid(), { ctrlKey: true })
    const find = await type('Find', 'red')
    expect(container.querySelector('[role="search"] [aria-live="polite"]')?.textContent).toBe('1 of 3')
    expect(grid().getAttribute('data-active-cell')).toBe('A1')
    key('Enter', find)
    expect(grid().getAttribute('data-active-cell')).toBe('A2')
    key('Enter', find)
    key('Enter', find)
    expect(grid().getAttribute('data-active-cell')).toBe('A1')
    key('Enter', find, { shiftKey: true })
    expect(grid().getAttribute('data-active-cell')).toBe('A4')
  })

  it('says when nothing matches, and narrows with match case', async () => {
    current = record({ workbook: sheet() })
    await open()
    key('f', grid(), { ctrlKey: true })
    await type('Find', 'green')
    expect(container.querySelector('[role="search"] [aria-live="polite"]')?.textContent).toBe('No matches')
    await type('Find', 'Red')
    const box = [...container.querySelectorAll('[role="search"] label')].find((l) => l.textContent === 'Match case')?.querySelector('input') as HTMLInputElement
    act(() => box.click())
    expect(container.querySelector('[role="search"] [aria-live="polite"]')?.textContent).toBe('1 of 1')
  })

  it('replaces the match it is on, then all of them as one step', async () => {
    current = record({ workbook: sheet() })
    await open()
    key('f', grid(), { ctrlKey: true })
    await type('Find', 'red')
    await type('Replace with', 'green')
    const buttons = [...container.querySelectorAll('[role="search"] button')] as HTMLButtonElement[]
    act(() => buttons.find((b) => b.textContent === 'Replace')?.click())
    expect(container.querySelector('[data-cell="A1"]')?.textContent).toBe('green pen')
    expect(container.querySelector('[data-cell="A2"]')?.textContent).toBe('Red ink')
    act(() => buttons.find((b) => b.textContent === 'All')?.click())
    expect(container.querySelector('[data-cell="A2"]')?.textContent).toBe('green ink')
    expect(container.querySelector('[data-cell="A4"]')?.textContent).toBe('greendy')
    act(() => (container.querySelector('[aria-label="Undo"]') as HTMLButtonElement).click())
    expect(container.querySelector('[data-cell="A2"]')?.textContent).toBe('Red ink')
    expect(container.querySelector('[data-cell="A1"]')?.textContent).toBe('green pen')
  })

  it('Escape closes it', async () => {
    await open()
    key('f', grid(), { ctrlKey: true })
    key('Escape', container.querySelector('[aria-label="Find"]') as Element)
    expect(container.querySelector('[role="search"]')).toBeNull()
  })
})

describe('phase 4 data', () => {
  const openMenu = (label: string) =>
    act(() => {
      const trigger = container.querySelector(`[aria-label="${label}"]`) as HTMLElement
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    })
  const menuItem = (text: string) => [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent?.trim() === text) as HTMLElement

  it('Insert → Checkbox makes a checkbox and the next save carries the extras', async () => {
    await open()
    openMenu('Insert')
    act(() => menuItem('Checkbox').dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.querySelector('[data-checkbox="A1"]')).not.toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300)
    })
    const body = patches()[0].body as { extras?: { checkboxes?: unknown[] } }
    expect(body.extras?.checkboxes).toHaveLength(1)
  })

  it('an ordinary edit does not resend the extras', async () => {
    await open()
    await typeCell('9')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300)
    })
    expect(patches()[0].body?.extras).toBeUndefined()
  })
})

describe('version history', () => {
  const R1 = '55555555-5555-4555-8555-555555555555'
  const R2 = '66666666-6666-4666-8666-666666666666'
  const entries = [
    { id: R2, spreadsheet_id: ID, revision: 4, title: 'Hiring plan', sheet_names: ['Sheet1'], author_id: 'm-1', author_kind: 'human', change_summary: null, created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z', author_name: 'Dana Okafor' },
    { id: R1, spreadsheet_id: ID, revision: 2, title: 'Hiring plan', sheet_names: ['Sheet1'], author_id: 'm-2', author_kind: 'agent', change_summary: 'Filled the totals', created_at: '2026-11-18T10:00:00Z', updated_at: '2026-11-18T10:00:00Z', author_name: 'Ravi Menon' },
  ]
  function withHistory(restore: () => Response) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
        calls.push({ url, method, body })
        if (url.endsWith('/revisions')) return json({ revisions: entries })
        if (url.includes('/revisions/') && method === 'POST') return restore()
        if (method === 'PATCH') return patch(body ?? {})
        return json({ spreadsheet: current, member_id: 'm-1' })
      }),
    )
  }
  const openHistory = async () => {
    await act(async () => {
      ;(container.querySelector('button[aria-label="Version history"]') as HTMLButtonElement).click()
      await vi.advanceTimersByTimeAsync(10)
    })
  }

  it('lists who changed it and when, the newest marked as current, an agent’s change said to be one', async () => {
    withHistory(() => json({}))
    await open()
    await openHistory()
    const panel = container.querySelector('aside[aria-label="Version history"]') as HTMLElement
    const items = [...panel.querySelectorAll('li')]
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain('Dana Okafor')
    expect(items[0].textContent).toContain('Current version')
    expect(items[0].textContent).not.toContain('Restore this version')
    expect(items[1].textContent).toContain('Ravi Menon’s agent')
    expect(items[1].textContent).toContain('Filled the totals')
    expect(items[1].textContent).toContain('Restore this version')
  })

  it('restores a version after asking, from the revision the editor is at, and loads it', async () => {
    withHistory(() => {
      current = record({ revision: 5, workbook: workbookWith([[1, 1, 'As it was']]) })
      return json({ spreadsheet: { ...current, workbook: undefined } })
    })
    await open()
    await openHistory()
    const panel = () => container.querySelector('aside[aria-label="Version history"]') as HTMLElement
    act(() => ([...panel().querySelectorAll('button')].find((b) => b.textContent === 'Restore this version') as HTMLButtonElement).click())
    expect(panel().textContent).toContain('Restore this version?')
    await act(async () => {
      ;([...panel().querySelectorAll('button')].find((b) => b.textContent === 'Restore') as HTMLButtonElement).click()
      await vi.advanceTimersByTimeAsync(20)
    })
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.url).toContain(`/revisions/${R1}`)
    expect(post?.body).toEqual({ base_revision: 4 })
    expect(container.querySelector('[data-cell="A1"]')?.textContent).toBe('As it was')
    // The older workbook that was open is not saved over the restored one.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(patches()).toHaveLength(0)
  })

  it('warns that unsaved changes go when restoring, and says when someone else got there first', async () => {
    const { toast } = await import('sonner')
    withHistory(() => json({ error: 'conflict' }, 409))
    await open()
    await typeCell('z')
    await openHistory()
    const panel = () => container.querySelector('aside[aria-label="Version history"]') as HTMLElement
    act(() => ([...panel().querySelectorAll('button')].find((b) => b.textContent === 'Restore this version') as HTMLButtonElement).click())
    expect(panel().textContent).toContain('Your unsaved changes will be lost')
    await act(async () => {
      ;([...panel().querySelectorAll('button')].find((b) => b.textContent === 'Restore') as HTMLButtonElement).click()
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Someone changed this spreadsheet'))
  })

  it('a view-only spreadsheet shows its history without a way to restore', async () => {
    current = record({ status: 'archived' })
    withHistory(() => json({}))
    await open()
    await openHistory()
    expect(container.querySelector('aside[aria-label="Version history"]')?.textContent).not.toContain('Restore this version')
  })
})
