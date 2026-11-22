// @vitest-environment jsdom
/**
 * Comment threads in the editor (phase 5): a corner marker on a cell with an
 * open thread, opening the thread, replying, resolving, the side panel, and
 * anchors following a row insert. Fetch is stubbed; the engine is the real one.
 */
import { act, useCallback, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbookController } from '@/lib/spreadsheets/controller'
import { loadModel, newModel } from '@/lib/spreadsheets/engine-server'
import { saveWorkbook } from '@/lib/spreadsheets/workbook'
import { useSpreadsheetComments } from '../comments'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }) }))
vi.mock('@/lib/spreadsheets/engine-client', async () => {
  const server = await import('@/lib/spreadsheets/engine-server')
  return { openModel: async (workbook: string | null) => server.loadModel(workbook), loadEngine: async () => undefined, ENGINE_URL: '' }
})

const { SpreadsheetEditor } = await import('../spreadsheet-editor')

const ID = '33333333-3333-4333-8333-333333333333'
const TID = 'aaaaaaaa-1111-4111-8111-111111111111'

function blankWithSheetId(): { workbook: string; sheetId: number } {
  const m = newModel()
  m.setUserInput(0, 2, 2, 'target')
  const workbook = saveWorkbook(m)
  const sheetId = m.getWorksheetsProperties()[0].sheet_id
  m.free()
  return { workbook, sheetId }
}

const { workbook: WB, sheetId: SHEET_ID } = blankWithSheetId()

const record = () => ({
  id: ID, workspace_id: 'ws', title: 'Plan', created_by: 'm-1', last_edited_by: 'm-1', visibility: 'workspace', status: 'active',
  revision: 4, sheet_names: ['Sheet1'], created_at: '', updated_at: '', extras: {}, workbook: WB,
})

function thread(extra: Record<string, unknown> = {}) {
  const root = { id: TID, spreadsheet_id: ID, workspace_id: 'ws', parent_id: null, sheet_id: SHEET_ID, anchor: 'B2', body: 'Needs a number', mentions: [], author_id: 'm-1', author_name: 'Dana Okafor', resolved_at: null, resolved_by: null, created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z' }
  return { id: TID, sheet_id: SHEET_ID, anchor: 'B2', resolved_at: null, resolved_by: null, resolved_by_name: null, root, replies: [], reply_count: 0, ...extra }
}

const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
let threads: Array<Record<string, unknown>>

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      calls.push({ url, method, body })
      if (url.endsWith('/comments')) {
        if (method === 'POST') return json({ comment: {} }, 201)
        return json({ threads })
      }
      if (url.includes('/comments/')) return json({ comment: {} })
      if (url.endsWith('/revision')) return json({ revision: 4 })
      if (method === 'PATCH') return json({ spreadsheet: { ...record(), revision: 5, workbook: undefined, extras: undefined } })
      return json({ spreadsheet: record(), member_id: 'm-1' })
    }),
  )
}

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
  calls.length = 0
  threads = [thread()]
  stubFetch()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function open() {
  await act(async () => {
    root.render(<SpreadsheetEditor spreadsheetId={ID} />)
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
}
const marker = () => container.querySelector('[data-comment-marker="2:2"]')
const commentCalls = () => calls.filter((c) => c.url.includes('/comments'))

describe('comment markers and the thread card', () => {
  it('draws a corner marker on a cell with an open thread, none on a resolved one', async () => {
    await open()
    expect(marker()).not.toBeNull()
  })

  it('shows no marker for a resolved thread', async () => {
    threads = [thread({ resolved_at: '2026-11-21T00:00:00Z', root: { ...thread().root, resolved_at: '2026-11-21T00:00:00Z' } })]
    await open()
    expect(marker()).toBeNull()
  })

  it('opens the thread when the marker is clicked, and replies with Enter', async () => {
    await open()
    await act(async () => {
      marker()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    const card = container.querySelector('[data-comment-thread]') as HTMLElement
    expect(card).not.toBeNull()
    expect(card.textContent).toContain('Needs a number')
    const reply = card.querySelector('[aria-label="Reply"]') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(reply, 'Done')
      reply.dispatchEvent(new Event('input', { bubbles: true }))
      reply.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 10))
    })
    const posted = commentCalls().find((c) => c.method === 'POST')
    expect(posted?.body).toMatchObject({ parent_id: TID, body: 'Done' })
  })

  it('resolves the thread', async () => {
    await open()
    await act(async () => {
      marker()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    const card = container.querySelector('[data-comment-thread]') as HTMLElement
    await act(async () => {
      ;(card.querySelector('[aria-label="Resolve thread"]') as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 10))
    })
    const patched = commentCalls().find((c) => c.method === 'PATCH')
    expect(patched?.url).toContain(`/comments/${TID}`)
    expect(patched?.body).toEqual({ resolved: true })
  })
})

describe('the comments panel', () => {
  it('lists the threads grouped by sheet when the header button is clicked', async () => {
    await open()
    const button = container.querySelector('[aria-label="Comments (1 open)"]') as HTMLButtonElement
    expect(button).not.toBeNull()
    await act(async () => {
      button.click()
      await new Promise((r) => setTimeout(r, 10))
    })
    const panel = container.querySelector('aside[aria-label="Comments"]') as HTMLElement
    expect(panel).not.toBeNull()
    expect(panel.textContent).toContain('Sheet1')
    expect(panel.textContent).toContain('Needs a number')
  })
})

describe('anchors follow a row insert', () => {
  function Harness({ workbook }: { workbook: WorkbookController }) {
    const onError = useCallback(() => {}, [])
    const comments = useSpreadsheetComments(ID, onError)
    useEffect(() => workbook.onStructural((c) => comments.shiftAnchors(c)), [workbook, comments])
    return null
  }

  it('shifts and saves the anchor of a thread below an inserted row', async () => {
    const workbook = new WorkbookController(loadModel(WB))
    await act(async () => {
      root.render(<Harness workbook={workbook} />)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    calls.length = 0
    await act(async () => {
      workbook.insertRows(1, 1) // a row above B2 pushes the thread to B3
      await new Promise((r) => setTimeout(r, 10))
    })
    const moved = calls.find((c) => c.method === 'PATCH' && c.url.includes(`/comments/${TID}`))
    expect(moved?.body).toEqual({ anchor: 'B3' })
    // Undo moves it back.
    calls.length = 0
    await act(async () => {
      workbook.undo()
      await new Promise((r) => setTimeout(r, 10))
    })
    const back = calls.find((c) => c.method === 'PATCH' && c.url.includes(`/comments/${TID}`))
    expect(back?.body).toEqual({ anchor: 'B2' })
    workbook.dispose()
  })
})
