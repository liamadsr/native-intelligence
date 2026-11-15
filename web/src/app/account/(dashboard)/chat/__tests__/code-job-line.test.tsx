// @vitest-environment jsdom
/**
 * A Code tab job's one compact line in the main thread (code-job-line.tsx):
 * which agent, which folder, its state (from the shell's shared ledger rows,
 * its newest turn's row; no read of its own), and Open, by that row (the
 * Agents panel's way). Finished, it says so and still opens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const shared = vi.hoisted(() => ({ rows: null as unknown[] | null }))
vi.mock('@/components/work/agent-work-provider', () => ({
  useOptionalAgentWork: () => (shared.rows ? { work: { rows: shared.rows }, counts: {} } : null),
}))

import { CodeJobLine, codeLineState, codeTurnRowOf } from '../code-job-line'
import type { CodeJob } from '@/lib/local-agent/code-tab'

const SID = '11111111-2222-4333-8444-555555555557'
const job: CodeJob = {
  sessionId: SID, requestId: 'req-1', worker: 'claude-code', folderId: 'f-site', folderLabel: 'harbor-site', deviceName: 'Studio Mac',
  status: 'running', trackedJobId: 'tj-1', createdAt: '2026-11-14T10:00:00Z',
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
    act(() => root.render(h(CodeJobLine, { line: { key: `session:${SID}`, sessionId: SID, requestId: 'req-1', request: 'Fix it' }, job, onOpen })))
    expect(q('[data-code-line-title]')!.textContent).toBe('Claude Code in harbor-site')
    expect(q('[data-code-line-status]')!.textContent).toBe('Working')
    expect(container.textContent).not.toContain('Fix it')
    act(() => q('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onOpen).toHaveBeenCalledWith('tj-2', job)
  })

  it('asking, then finished: it says so, and still opens', () => {
    const onOpen = vi.fn()
    shared.rows = [turn('tj-1', 1, 'needs_input')]
    const draw = () => act(() => root.render(h(CodeJobLine, { line: { key: `session:${SID}`, sessionId: SID, requestId: 'req-1', request: null }, job, onOpen })))
    draw()
    expect(q('[data-code-line]')!.getAttribute('data-code-line-state')).toBe('asking')
    expect(q('[data-code-line-status]')!.textContent).toBe('Needs your answer')
    shared.rows = [turn('tj-1', 1, 'needs_review')]
    draw()
    expect(q('[data-code-line-status]')!.textContent).toBe('Finished: ready for your review')
    act(() => q('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onOpen).toHaveBeenCalledWith('tj-1', job)
  })

  it('outside the shell, or before anything names a row to open: drawn, but nothing to press', () => {
    act(() => root.render(h(CodeJobLine, { line: { key: 'request:req-9', sessionId: null, requestId: 'req-9', request: 'Fix it' }, job: null })))
    expect(q('[data-code-line-title]')!.textContent).toBe('Coding agent')
    expect((q('button') as HTMLButtonElement).disabled).toBe(true)
  })
})
