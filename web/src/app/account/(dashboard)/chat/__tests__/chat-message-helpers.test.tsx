// @vitest-environment jsdom
/**
 * A `helpers` call (A4 slice 3, quick helpers) draws one row: "3 helpers
 * working · 1/3 done" with each task's label while it runs (from the call's
 * input, then its preliminary progress output), and the outcome once done. A
 * refusal or an error keeps the generic tool chip.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { helpersRowModel } from '../helpers-row'
import type { ToolPart } from '../tool-renderers'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/work/agent-work-provider', () => ({
  useAgentWorkShared: () => ({ work: { rows: [], cardRows: [], roster: [] }, attention: { items: [] }, counts: new Map() }),
}))
vi.mock('../../main-chat/main-chat-context', () => ({
  buildEntryForDetail: (view: string, detailPanel: unknown) => ({ location: { kind: 'view', view }, view, detailPanel }),
}))
vi.mock('../../../workspace-switcher', () => ({
  useWorkspaceEdition: () => 'full',
  useWorkspaces: () => ({ workspaces: [], currentId: 'ws-1', refresh: () => {} }),
}))
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))

import { ChatMessage } from '../chat-message'

const INPUT = { tasks: [{ label: 'Acme', task: 'a' }, { label: 'Globex', task: 'b' }, { label: 'Initech', task: 'c' }] }

const part = (extra: Record<string, unknown>) =>
  ({ type: 'dynamic-tool', toolName: 'helpers', toolCallId: 'h-1', input: INPUT, ...extra }) as unknown as ToolPart

function message(p: ToolPart): UIMessage {
  return { id: 'a1', role: 'assistant', parts: [p] } as unknown as UIMessage
}

describe('helpersRowModel', () => {
  it('before any progress: the labels from the input, all working', () => {
    expect(helpersRowModel(part({ state: 'input-available' }))).toEqual({
      running: true,
      headline: '3 helpers working · 0/3 done',
      tasks: [
        { label: 'Acme', status: 'working' },
        { label: 'Globex', status: 'working' },
        { label: 'Initech', status: 'working' },
      ],
    })
  })

  it('a preliminary snapshot counts what settled', () => {
    const progress = { kind: 'helpers-progress', total: 3, done: 1, tasks: [{ label: 'Acme', status: 'done' }, { label: 'Globex', status: 'working' }, { label: 'Initech', status: 'working' }] }
    const model = helpersRowModel(part({ state: 'output-available', preliminary: true, output: progress }))
    expect(model?.headline).toBe('3 helpers working · 1/3 done')
    expect(model?.running).toBe(true)
    expect(model?.tasks[0]).toEqual({ label: 'Acme', status: 'done' })
  })

  it('the final results: all done, or how many finished', () => {
    const all = { results: INPUT.tasks.map((t) => ({ label: t.label, status: 'done', output: 'x' })) }
    expect(helpersRowModel(part({ state: 'output-available', output: all }))).toMatchObject({ running: false, headline: '3 helpers done' })
    const some = { results: [{ label: 'Acme', status: 'done', output: 'x' }, { label: 'Globex', status: 'timed_out', output: '' }, { label: 'Initech', status: 'failed', output: 'e' }] }
    expect(helpersRowModel(part({ state: 'output-available', output: some }))).toMatchObject({
      headline: '3 helpers finished · 1/3 done',
      tasks: [{ status: 'done' }, { status: 'timed_out' }, { status: 'failed' }],
    })
  })

  it('a refusal, an error or an unreadable result falls through to the generic chip', () => {
    expect(helpersRowModel(part({ state: 'output-available', output: { results: [], refused: 'Not here.' } }))).toBeNull()
    expect(helpersRowModel(part({ state: 'output-error', errorText: 'boom' }))).toBeNull()
    expect(helpersRowModel(part({ state: 'output-available', output: 'text' }))).toBeNull()
  })
})

describe('ChatMessage — helpers', () => {
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
  const render = (m: UIMessage) => act(() => root.render(h(ChatMessage, { message: m, userAvatarUrl: null, userInitials: 'LA' })))

  it('draws the row with each label while the helpers run', () => {
    const progress = { kind: 'helpers-progress', total: 3, done: 1, tasks: [{ label: 'Acme', status: 'done' }, { label: 'Globex', status: 'working' }, { label: 'Initech', status: 'working' }] }
    render(message(part({ state: 'output-available', preliminary: true, output: progress })))
    const row = container.querySelector('[data-testid="helpers-row"]')
    expect(row?.textContent).toContain('3 helpers working · 1/3 done')
    expect(row?.textContent).toContain('Acme')
    expect(row?.textContent).toContain('Initech')
    expect(row?.hasAttribute('data-running')).toBe(true)
  })

  it('keeps the generic chip for a refusal', () => {
    render(message(part({ state: 'output-available', output: { results: [], refused: 'Helpers are not available on a device ask.' } })))
    expect(container.querySelector('[data-testid="helpers-row"]')).toBeNull()
    expect(container.textContent).toContain('helpers')
  })
})
