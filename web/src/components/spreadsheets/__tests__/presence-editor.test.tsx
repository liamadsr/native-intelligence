// @vitest-environment jsdom
/**
 * Presence wired into the open spreadsheet: it joins a private Realtime room for
 * the spreadsheet's id, a heard peer shows a face in the header and a rectangle
 * on the grid, moving the selection says the new range, and unmounting leaves.
 * Fetch and the Supabase client are stubbed; the engine is the real one.
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

// A fake Supabase client the editor's createClient() returns; records the rooms it opens.
const sb = vi.hoisted(() => {
  interface Ch { topic: string; config: unknown; status: (s: string) => void; hear: (p: unknown) => void; sent: Array<Record<string, unknown>>; removed: boolean }
  interface FakeChan { entry: Ch; on(t: unknown, f: unknown, cb: (m: { payload?: unknown }) => void): FakeChan; subscribe(cb: (s: string) => void): void; send(m: { payload: Record<string, unknown> }): void }
  const channels: Ch[] = []
  return {
    channels,
    reset: () => void (channels.length = 0),
    client: {
      realtime: { setAuth: () => Promise.resolve() },
      channel(topic: string, o: { config: unknown }) {
        const entry: Ch = { topic, config: o.config, status: () => {}, hear: () => {}, sent: [], removed: false }
        channels.push(entry)
        const ch: FakeChan = {
          entry,
          on(_t, _f, cb) {
            entry.hear = (p) => cb({ payload: p })
            return ch
          },
          subscribe(cb) {
            entry.status = cb
          },
          send(m) {
            entry.sent.push(m.payload)
          },
        }
        return ch
      },
      removeChannel(ch: unknown) {
        ;(ch as { entry: Ch }).entry.removed = true
      },
      auth: { getUser: () => Promise.resolve({ data: { user: { id: 'u-self', user_metadata: { full_name: 'Me' }, email: 'me@fixture.test' } } }) },
    },
  }
})
vi.mock('@/lib/supabase/client', () => ({ createClient: () => sb.client }))

const { SpreadsheetEditor } = await import('../spreadsheet-editor')

const ID = '44444444-4444-4444-8444-444444444444'

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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

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
  sb.reset()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/comments') ? json({ threads: [] }) : json({ spreadsheet: record(), member_id: 'm-1' }))))
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

async function open() {
  await act(async () => {
    root.render(<SpreadsheetEditor spreadsheetId={ID} />)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10)
  })
}
const grid = () => container.querySelector<HTMLElement>('[role="grid"]') as HTMLElement
const room = () => sb.channels[0]
const heard = (extra: Record<string, unknown>) => act(() => room().hear({ key: 'peer-1', userId: 'u-other', name: 'Priya Chandra', color: '#2563eb', ...extra }))

describe('presence in the editor', () => {
  it('joins a private room for this spreadsheet and says where it is once subscribed', async () => {
    await open()
    expect(sb.channels).toHaveLength(1)
    expect(room().topic).toBe(`spreadsheet-presence:${ID}`)
    expect(room().config).toEqual({ private: true, broadcast: { self: false } })
    act(() => room().status('SUBSCRIBED'))
    expect(room().sent).toHaveLength(1)
    expect(room().sent[0]).toMatchObject({ userId: 'u-self', name: 'Me', range: { r1: 1, c1: 1, r2: 1, c2: 1 } })
  })

  it('a heard peer shows a face and a rectangle on the sheet it is on', async () => {
    await open()
    act(() => room().status('SUBSCRIBED'))
    const sheetId = room().sent[0].sheetId as number
    heard({ sheetId, range: { r1: 2, c1: 2, r2: 3, c2: 3 }, active: { row: 2, column: 2 } })
    expect(container.querySelector('[data-spreadsheet-peers]')?.getAttribute('title')).toBe('Priya Chandra')
    expect(container.querySelector('[data-spreadsheet-peer="u-other"]')?.textContent).toBe('Priya Chandra')
    const border = [...container.querySelectorAll('[data-spreadsheet-presence] div')].find((d) => /2px solid/.test((d as HTMLElement).style.border))
    expect(border).toBeTruthy()
  })

  it('says the new range when the selection moves', async () => {
    await open()
    act(() => room().status('SUBSCRIBED'))
    expect(room().sent).toHaveLength(1)
    await act(async () => {
      grid().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(room().sent.at(-1)).toMatchObject({ range: { r1: 2, c1: 1, r2: 2, c2: 1 }, active: { row: 2, column: 1 } })
  })

  it('leaves the room on unmount', async () => {
    await open()
    act(() => room().status('SUBSCRIBED'))
    act(() => root.unmount())
    expect(room().sent.at(-1)).toEqual({ key: expect.any(String), gone: true })
    expect(room().removed).toBe(true)
  })
})
