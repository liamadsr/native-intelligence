// @vitest-environment jsdom
/**
 * A Code tab job's one compact line in the main thread (code-job-line.tsx):
 * which agent, which folder, its state (from the shell's shared ledger rows,
 * its newest turn's row; no read of its own), and Open, by that row (the
 * Agents panel's way). Finished, it says so and still opens. Before the
 * list knows the job, what its request's row names (agent, folder, session,
 * an excerpt), and it opens by the session. The drawn line renders again
 * only when its own row changes, not on every ledger push.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const shared = vi.hoisted(() => ({ rows: null as unknown[] | null }))
vi.mock('@/components/work/agent-work-provider', () => ({
  useOptionalAgentWork: () => (shared.rows ? { work: { rows: shared.rows }, counts: {} } : null),
}))
// The drawn line calls cn on each render (the wrapper doesn't): its renders, counted.
const draws = vi.hoisted(() => ({ n: 0 }))
vi.mock('@/lib/utils', async (orig) => {
  const real = await orig<typeof import('@/lib/utils')>()
  return { ...real, cn: (...a: Parameters<typeof real.cn>) => (draws.n++, real.cn(...a)) }
})

import { CodeJobLine, codeLineState, codeTurnRowOf } from '../code-job-line'
import type { CodeJob } from '@/lib/local-agent/code-tab'

const SID = '11111111-2222-4333-8444-555555555557'
const job: CodeJob = {
  sessionId: SID, requestId: 'req-1', worker: 'claude-code', folderId: 'f-site', folderLabel: 'harbor-site', deviceName: 'Studio Mac',
  status: 'running', trackedJobId: 'tj-1', asking: false, createdAt: '2026-11-14T10:00:00Z',
}
const turn = (id: string, n: number, status: string) => ({ id, kind: 'local_agent', status, created_at: `2026-11-14T10:0${n}:00Z`, source: { local_agent_session_id: SID, turn: n, local_agent_code: true } })

let container: HTMLDivElement
let root: Root
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null

beforeEach(() => {
  shared.rows = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('its state', () => {
  it('the newest turn’s row, by turn number', () => {
    const rows = [turn('tj-1', 1, 'needs_review'), turn('tj-2', 2, 'running'), { id: 'other', kind: 'work_run', status: 'running', source: {} }]
    expect(codeTurnRowOf(rows, SID)?.id).toBe('tj-2')
    expect(codeTurnRowOf(rows, 'nope')).toBeNull()
  })

  it('from its row when there is one, else from the job as the list read it', () => {
    expect(codeLineState({ status: 'running' }, null)).toBe('working')
    expect(codeLineState({ status: 'needs_input' }, null)).toBe('asking')
    expect(codeLineState({ status: 'needs_review' }, null)).toBe('review')
    expect(codeLineState({ status: 'canceled' }, null)).toBe('stopped')
    expect(codeLineState(null, { status: 'waiting' })).toBe('done')
    expect(codeLineState(null, { status: 'queued' })).toBe('starting')
    expect(codeLineState(null, { status: 'expired' })).toBe('failed')
  })
})

describe('the line', () => {
  it('working: agent and folder, its state, and Open by its newest turn’s row', () => {
    const onOpen = vi.fn()
    shared.rows = [turn('tj-1', 1, 'done'), turn('tj-2', 2, 'running')]
    act(() => root.render(h(CodeJobLine, { line: { key: `session:${SID}`, sessionId: SID, requestId: 'req-1', request: 'Fix it', folder: null }, job, onOpen })))
    expect(q('[data-code-line-title]')!.textContent).toBe('Claude Code in harbor-site')
    expect(q('[data-code-line-excerpt]')!.textContent).toBe('Fix it')
    expect(q('[data-code-line-status]')!.textContent).toBe('Working')
    act(() => q('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onOpen).toHaveBeenCalledWith('tj-2', SID)
  })

  it('asking, then finished: it says so, and still opens', () => {
    const onOpen = vi.fn()
    shared.rows = [turn('tj-1', 1, 'needs_input')]
    const draw = () => act(() => root.render(h(CodeJobLine, { line: { key: `session:${SID}`, sessionId: SID, requestId: 'req-1', request: null, folder: null }, job, onOpen })))
    draw()
    expect(q('[data-code-line]')!.getAttribute('data-code-line-state')).toBe('asking')
    expect(q('[data-code-line-status]')!.textContent).toBe('Needs your answer')
    shared.rows = [turn('tj-1', 1, 'needs_review')]
    draw()
    expect(q('[data-code-line-status]')!.textContent).toBe('Finished: ready for your review')
    act(() => q('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onOpen).toHaveBeenCalledWith('tj-1', SID)
    expect(q('[data-code-line-excerpt]')).toBeNull()
  })

  it('outside the shell, or a row that names no job: drawn, but nothing to press', () => {
    act(() => root.render(h(CodeJobLine, { line: { key: 'request:req-9', sessionId: null, requestId: 'req-9', request: 'Fix it', folder: null }, job: null, onOpen: vi.fn() })))
    expect(q('[data-code-line-title]')!.textContent).toBe('Coding agent')
    expect((q('button') as HTMLButtonElement).disabled).toBe(true)
    act(() => root.render(h(CodeJobLine, { line: { key: `session:${SID}`, sessionId: SID, requestId: 'req-1', request: 'Fix it', folder: 'harbor-site', worker: 'claude-code' }, job: null })))
    expect((q('button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('before the list knows its job: the agent and folder its request row names, and Open by its session', () => {
    const onOpen = vi.fn()
    act(() => root.render(h(CodeJobLine, { line: { key: `session:${SID}`, sessionId: SID, requestId: 'req-1', request: 'Fix the date picker', folder: 'harbor-site', worker: 'claude-code' }, job: null, onOpen })))
    expect(q('[data-code-line-title]')!.textContent).toBe('Claude Code in harbor-site')
    expect(q('[data-code-line]')!.getAttribute('data-code-line')).toBe(SID)
    act(() => q('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onOpen).toHaveBeenCalledWith(null, SID)
    // Our own agent named by the row (worker null).
    act(() => root.render(h(CodeJobLine, { line: { key: `session:${SID}`, sessionId: SID, requestId: 'req-1', request: 'x', folder: 'notes', worker: null }, job: null, onOpen })))
    expect(q('[data-code-line-title]')!.textContent).toBe('Native Intelligence in notes')
  })

  it('another job’s ledger push doesn’t draw the line again; its own row’s change does', () => {
    const onOpen = vi.fn()
    const line = { key: `session:${SID}`, sessionId: SID, requestId: 'req-1', request: 'Fix it', folder: null }
    shared.rows = [turn('tj-1', 1, 'running')]
    const draw = () => act(() => root.render(h(CodeJobLine, { line: { ...line }, job, onOpen })))
    draw()
    const first = draws.n
    shared.rows = [turn('tj-1', 1, 'running'), { id: 'other', kind: 'work_run', status: 'running', source: {} }]
    draw()
    shared.rows = [turn('tj-1', 1, 'running'), { id: 'other', kind: 'work_run', status: 'done', source: {} }]
    draw()
    expect(draws.n).toBe(first)
    shared.rows = [turn('tj-1', 1, 'needs_review')]
    draw()
    expect(draws.n).toBeGreaterThan(first)
    expect(q('[data-code-line-status]')!.textContent).toBe('Finished: ready for your review')
  })
})
