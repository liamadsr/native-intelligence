// @vitest-environment jsdom
/**
 * What the agents learned at work, in What Native Intelligence has learned (trust layer P2;
 * decision 16 as apply with undo): nothing renders when there is nothing to
 * show or the viewer may not manage it (hide empty widgets); every entry is
 * live, with its teammate and when, and Remove with an Undo that restores it;
 * one learned after reading outside text carries a quiet label. There is no
 * held section and no Accept or Dismiss.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { AgentsLearned, type AgentMemoryEntry } from '../what-dial8-learned'
import { outsideReadLabel } from '@/lib/safety/outside-label'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

const entry = (over: Partial<AgentMemoryEntry>): AgentMemoryEntry => ({
  id: 'e', teammateId: 'mate-1', teammateName: 'Quill', text: 'Dana likes bullets.', outsideReads: [], createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), ...over,
})

let root: Root
let el: HTMLDivElement
let calls: Array<{ url: string; method: string; body: unknown }>
function serve(listing: Record<string, unknown>) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined })
    const data = (init.method ?? 'GET') === 'GET' ? listing : { ok: true, status: 'active' }
    return new Response(JSON.stringify(data), { status: 200 })
  }))
}
async function mount() {
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  await act(async () => { root.render(h(AgentsLearned)) })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.unstubAllGlobals()
})

describe('AgentsLearned', () => {
  it('renders nothing when there is nothing to show', async () => {
    serve({ canManage: true, entries: [] })
    await mount()
    expect(el.innerHTML).toBe('')
  })

  it('renders nothing for a viewer who may not manage it', async () => {
    serve({ canManage: false, entries: [entry({})] })
    await mount()
    expect(el.innerHTML).toBe('')
  })

  it('each entry shows its teammate and when, with Remove; Undo restores it; nothing to accept', async () => {
    serve({ canManage: true, entries: [entry({ id: 'm-live' })] })
    await mount()
    expect(el.textContent).toContain('Quill: Dana likes bullets.')
    expect(el.textContent).toContain('2d ago')
    expect(button('Accept')).toBeUndefined()
    expect(button('Dismiss')).toBeUndefined()
    expect(el.querySelector('[data-testid="agent-memory-outside"]')).toBeNull()
    await act(async () => { button('Remove')!.click() })
    expect(calls.at(-1)).toMatchObject({ url: '/api/account/agent-memory', method: 'PATCH', body: { id: 'm-live', action: 'remove' } })
    expect(el.innerHTML).toBe('')
    const undo = toastMock.success.mock.calls[0][1].action.onClick as () => Promise<void>
    await act(async () => { await undo() })
    expect(calls.at(-1)).toMatchObject({ body: { id: 'm-live', action: 'restore' } })
    expect(el.textContent).toContain('Dana likes bullets.')
  })

  it('an entry learned after reading outside text is live, labelled quietly, and removable', async () => {
    serve({ canManage: true, entries: [entry({ id: 'm-web', text: 'Acme moved to annual billing.', outsideReads: ['web_fetch'] })] })
    await mount()
    expect(el.querySelector('[data-testid="agent-memory-outside"]')!.textContent).toContain('learned from a web page')
    await act(async () => { button('Remove')!.click() })
    expect(calls.at(-1)).toMatchObject({ body: { id: 'm-web', action: 'remove' } })
  })

  it('outsideReadLabel says where the outside text came from', () => {
    expect(outsideReadLabel(['web_search'])).toBe('a web page')
    expect(outsideReadLabel(['read_email'])).toBe('an outside email')
    expect(outsideReadLabel(['mcp__linear__list_issues'])).toBe('a connected app')
    expect(outsideReadLabel(['ingest_reference'])).toBe('a file')
    expect(outsideReadLabel(['agent'])).toBe('outside text')
  })
})
