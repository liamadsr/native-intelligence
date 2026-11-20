// @vitest-environment jsdom
/**
 * The coding chat's details (../code-chat-sections.tsx): the action a job
 * works, first (Liam, 11-20: "a two way connection where I can start an
 * action items work from the action item then I can go to the coding view
 * and see it's chat and go to the action item from it's properties panel"):
 *
 *   • a job an action's Start made shows the action, its identifier and
 *     title, read once from the action's own route (never in each poll of the
 *     conversation), and a press opens it, as any action opens;
 *   • any other job has no such card, and reads nothing;
 *   • an action that can't be read (gone, another workspace's) shows none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const view = vi.hoisted(() => ({ state: { selected: null as string | null, live: null as unknown, error: null as string | null, attempt: 0 } }))
vi.mock('../../chat/use-code-view', () => ({ useCodeView: () => view.state }))
vi.mock('@/components/work/agent-work-provider', () => ({ useOptionalAgentWorkShared: () => null }))
vi.mock('@/components/work/work-item-detail-panel', () => ({ WorkItemDetailPanel: () => null }))
const opened = vi.hoisted(() => ({ calls: [] as unknown[] }))
vi.mock('@/lib/chat-cards/open-card', () => ({
  openTarget: (target: unknown, opts: unknown) => {
    opened.calls.push({ target, opts })
    return true
  },
}))

import { CodeChatSections } from '../code-chat-sections'

const ACTION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function onJob(over: Record<string, unknown> = {}) {
  view.state = {
    selected: 's1',
    error: null,
    attempt: 0,
    live: {
      session: { id: 's1', status: 'running', lastSignal: null, mode: 'edit', branch: null, deviceName: 'Test Mac', folderLabel: 'sample-repo', worker: 'codex', ...over },
      stopping: false,
      send: vi.fn(),
      stop: vi.fn(),
    },
  }
}

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  opened.calls = []
  fetchMock = vi.fn(async (url: string) =>
    url.endsWith(ACTION)
      ? new Response(JSON.stringify({ action: { id: ACTION, identifier: 'ENG-42', title: 'Fix the board pagination' } }), { status: 200 })
      : new Response('{}', { status: 404 }),
  )
  vi.stubGlobal('fetch', fetchMock)
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
  await act(async () => root.render(h(CodeChatSections)))
  // The action's read lands.
  for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}
const card = () => container.querySelector<HTMLElement>('[data-code-chat-section="action"]')

describe('the action a coding job works', () => {
  it('comes first, with its identifier and title, read once; a press opens it', async () => {
    onJob({ actionId: ACTION })
    await render()
    expect(container.querySelector('[data-code-chat-sections] > section')?.getAttribute('data-code-chat-section')).toBe('action')
    expect(card()!.textContent).toContain('ENG-42')
    expect(card()!.textContent).toContain('Fix the board pagination')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Another poll of the conversation: the same job, no second read.
    await render()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    act(() => container.querySelector<HTMLButtonElement>(`[data-code-chat-action="${ACTION}"]`)!.click())
    expect(opened.calls).toEqual([{ target: { type: 'action', id: ACTION, title: 'Fix the board pagination' }, opts: { from: 'code-view' } }])
  })

  it('a job with no action: no card, and nothing read', async () => {
    onJob()
    await render()
    expect(card()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an action that can’t be read shows none', async () => {
    onJob({ actionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })
    await render()
    expect(card()).toBeNull()
  })
})
