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

vi.mock('@/components/local-agent/changes-view', () => ({
  ChangesView: (props: { sessionId: string; branch: string | null; canMessage: boolean }) =>
    h('div', { 'data-fake-changes': props.sessionId, 'data-branch': props.branch ?? '', 'data-can-message': String(props.canMessage) }),
}))

import { CodeChangesPanel, CodeChatPanel, CodeChatSections, pullRequestOffered } from '../code-chat-sections'
import { getSidePanelState, resetSidePanelStore, setCodeDetailsOpen, setPanelChatKind } from '../side-panel-store'

const ACTION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function onJob(over: Record<string, unknown> = {}) {
  view.state = {
    selected: 's1',
    error: null,
    attempt: 0,
    live: {
      session: { id: 's1', status: 'running', lastSignal: null, mode: 'edit', branch: null, deviceName: 'Test Mac', folderLabel: 'sample-repo', worker: 'codex', ...over },
      stopping: false,
      send: vi.fn(async () => ({ ok: true })),
      stop: vi.fn(),
      promptOpen: false,
      noChanges: false,
      filesChanged: null,
      insertions: null,
      deletions: null,
      ...((over.live as object) ?? {}),
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
  resetSidePanelStore()
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

/** A finished edit job on its branch, no pull request yet: what "Open pull request" is offered for. */
const FINISHED = { status: 'waiting', lastSignal: 'finish', mode: 'edit', branch: 'dial8/sample-repo-1a2b', commitSha: '6cfa56d0000', prUrl: null, deviceId: 'd1' }
const changesCard = () => container.querySelector<HTMLElement>('[data-code-chat-section="changes"]')!

describe('the Changes card', () => {
  it('says where the files are: View changes with the file count, never the Changes tab', async () => {
    onJob({ ...FINISHED, live: { filesChanged: 3 } })
    await render()
    expect(changesCard().textContent).not.toContain('Changes tab')
    expect(changesCard().textContent).toContain('No pull request yet.')
    expect(changesCard().querySelector('[data-code-chat-view-changes]')?.textContent).toBe('View changes · 3 files')
  })

  it('carries what the transcript’s branch card did: the branch with Copy, files and lines changed, the commit, where the work is', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    onJob({ ...FINISHED, live: { filesChanged: 2, insertions: 10, deletions: 3 } })
    await render()
    expect(changesCard().querySelector('[data-code-chat-branch]')?.textContent).toBe('dial8/sample-repo-1a2b')
    expect(changesCard().querySelector('[data-code-chat-branch-stats]')?.textContent).toBe('2 files changed · +10 −3')
    expect(changesCard().querySelector('[data-code-chat-commit]')?.textContent).toBe('6cfa56d')
    expect(changesCard().textContent).toContain('On your Mac, in a separate copy')
    const copy = changesCard().querySelector<HTMLButtonElement>('[data-code-chat-branch-copy]')!
    expect(copy.getAttribute('aria-label')).toBe('Copy branch dial8/sample-repo-1a2b')
    await act(async () => copy.click())
    for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(writeText).toHaveBeenCalledWith('dial8/sample-repo-1a2b')
    expect(copy.getAttribute('aria-label')).toBe('Copied')
  })

  it('View changes opens them in the right panel, opening it when it was closed', async () => {
    act(() => {
      setPanelChatKind('code')
      setCodeDetailsOpen(false)
    })
    onJob({ ...FINISHED })
    await render()
    expect(changesCard().querySelector('[data-code-chat-view-changes]')?.textContent).toBe('View changes')
    act(() => changesCard().querySelector<HTMLButtonElement>('[data-code-chat-view-changes]')!.click())
    expect(getSidePanelState()).toMatchObject({ codeChanges: true, codeDetailsOpen: true })
  })

  it('no View changes for a read-only job, nor before a branch', async () => {
    onJob({ mode: 'read' })
    await render()
    expect(container.querySelector('[data-code-chat-view-changes]')).toBeNull()
    onJob({ mode: 'edit', branch: null })
    await render()
    expect(container.querySelector('[data-code-chat-view-changes]')).toBeNull()
  })

  it('offers Open pull request exactly when the conversation did: a finished job on a branch with work and no pull request', async () => {
    onJob({ ...FINISHED })
    await render()
    const button = changesCard().querySelector<HTMLButtonElement>('[data-local-agent-open-pr]')!
    expect(button.textContent).toBe('Open pull request')
    await act(async () => button.click())
    const live = view.state.live as { send: ReturnType<typeof vi.fn> }
    expect(live.send).toHaveBeenCalledWith(expect.stringContaining('Open a pull request for this work'), 'queue', expect.any(String))
    expect(changesCard().querySelector('[data-local-agent-pr-offer]')?.textContent).toContain('Your Mac asks you before anything is pushed.')
  })

  it('no offer while it can’t take one', async () => {
    for (const over of [
      { ...FINISHED, prUrl: 'https://github.com/fernhill/studio-site/pull/4' },
      { ...FINISHED, lastSignal: 'ask' },
      { ...FINISHED, status: 'running' },
      { ...FINISHED, status: 'cancelled' },
      { ...FINISHED, mode: 'read' },
      { ...FINISHED, live: { noChanges: true } },
      { ...FINISHED, live: { promptOpen: true } },
    ]) {
      onJob(over)
      await render()
      expect(container.querySelector('[data-local-agent-open-pr]'), JSON.stringify(over)).toBeNull()
    }
  })

  it('pullRequestOffered follows the conversation’s own rule', () => {
    const live = (session: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      ({ session: { ...FINISHED, ...session }, promptOpen: false, noChanges: false, ...extra }) as unknown as Parameters<typeof pullRequestOffered>[0]
    expect(pullRequestOffered(live({}))).toBe(true)
    expect(pullRequestOffered(live({ status: 'expired' }))).toBe(false)
    expect(pullRequestOffered(live({}, { noChanges: true }))).toBe(false)
  })
})

describe('the Changes panel', () => {
  it('draws the job’s changes with ‹ Details back, the branch, and the offer', async () => {
    act(() => {
      setPanelChatKind('code')
    })
    onJob({ ...FINISHED })
    await act(async () => root.render(h(CodeChatPanel, { changes: true })))
    const panel = container.querySelector<HTMLElement>('[data-code-changes-panel="s1"]')!
    expect(panel).not.toBeNull()
    expect(container.querySelector('[data-code-chat-sections]')).toBeNull()
    expect(panel.querySelector('[data-fake-changes="s1"]')?.getAttribute('data-branch')).toBe('dial8/sample-repo-1a2b')
    expect(panel.querySelector('[data-local-agent-open-pr]')).not.toBeNull()
    act(() => panel.querySelector<HTMLButtonElement>('[data-code-changes-back]')!.click())
    expect(getSidePanelState().codeChanges).toBe(false)
  })

  it('a job with nothing to show goes back to the details', async () => {
    act(() => {
      setPanelChatKind('code')
    })
    onJob({ ...FINISHED })
    await render()
    act(() => changesCard().querySelector<HTMLButtonElement>('[data-code-chat-view-changes]')!.click())
    expect(getSidePanelState().codeChanges).toBe(true)
    onJob({ mode: 'read' })
    await act(async () => root.render(h(CodeChangesPanel)))
    expect(container.querySelector('[data-code-changes-panel]')).toBeNull()
    expect(getSidePanelState().codeChanges).toBe(false)
  })
})
