// @vitest-environment jsdom
/**
 * The coding chat drawn as Claude Code and Codex draw one (Liam, 11-26): a run
 * of tool calls as ONE muted line that says what was done, the agent's words
 * as plain prose (an update, a question, its summary included), events as
 * small muted lines, the person's message one neutral bubble with "Queued"
 * under it, and no line for a working status ("parked").
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/message', () => ({
  MessageContent: ({ children, className }: { children: string; className?: string }) => h('div', { 'data-prose': '', className }, children),
  MessageActions: ({ children, className, ...rest }: { children?: unknown; className?: string }) => h('div', { className, ...rest }, children as never),
  MessageAction: ({ children }: { children?: unknown }) => children as never,
}))
vi.mock('@/app/account/(dashboard)/chat/read-aloud-button', () => ({ ReadAloudButton: () => null }))

import { toolRunSummary, type TranscriptItem } from '@/lib/local-agent/transcript-view'
import { drawnRows } from '../local-agent-panel'
import { InboundBubble, ToolRun, TranscriptRow } from '../transcript-rows'

const tool = (key: string, name: string, input: Record<string, unknown>, ok = true): Extract<TranscriptItem, { type: 'tool' }> => ({
  type: 'tool',
  key,
  callId: key,
  name,
  input: JSON.stringify(input),
  result: { ok, output: 'out' },
})

describe('toolRunSummary: a run of calls in words', () => {
  it('says what was done by kind, in the order each first came, files counted once', () => {
    expect(
      toolRunSummary([
        tool('1', 'shell', { command: 'npm test' }),
        tool('2', 'read_file', { path: 'a.ts' }),
        tool('3', 'apply_patch', { path: 'a.ts' }),
        tool('4', 'read_file', { path: 'a.ts' }),
        tool('5', 'read_file', { path: 'b.ts' }),
        tool('6', 'shell', { command: 'git status' }),
        tool('7', 'grep', { pattern: 'x' }),
      ]),
    ).toBe('Ran 2 commands, read 2 files, edited 1 file, searched once')
  })

  it('names the rest "other steps" beside the kinds it knows, and "steps" alone', () => {
    expect(toolRunSummary([tool('1', 'report', {}), tool('2', 'shell', { command: 'ls' })])).toBe('Took 1 other step, ran 1 command')
    expect(toolRunSummary([tool('1', 'report', {}), tool('2', 'finish', {})])).toBe('Took 2 steps')
  })

  it('counts a read or an edit naming no file as one, and searches as times', () => {
    expect(toolRunSummary([tool('1', 'read_file', {}), tool('2', 'read_file', {}), tool('3', 'glob', {}), tool('4', 'grep', {})])).toBe('Read 2 files, searched 2 times')
  })
})

describe('drawnRows: what the conversation draws', () => {
  it('leaves out every working status, "parked" too, and never splits a run on one', () => {
    const rows = drawnRows([
      tool('t1', 'shell', { command: 'a' }),
      { type: 'status', key: 's1', status: 'waiting', reason: 'parked' },
      tool('t2', 'shell', { command: 'b' }),
      { type: 'status', key: 's2', status: 'running', reason: 'resumed' },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].tools?.map((t) => t.key)).toEqual(['t1', 't2'])
  })

  it('draws a branch committed again unchanged once, and a changed one again', () => {
    const branch = (key: string, commit: string): TranscriptItem => ({ type: 'branch', key, name: 'dial8/x', commit, filesChanged: 2, insertions: 3, deletions: 1 })
    const rows = drawnRows([branch('b1', 'abc'), { type: 'assistant', key: 'a', text: 'ok', open: false }, branch('b2', 'abc'), branch('b3', 'def')])
    expect(rows.map((r) => r.key)).toEqual(['b1', 'a', 'b3'])
  })

  it('keeps an ended status (stopped, failed) as its own row', () => {
    const rows = drawnRows([{ type: 'status', key: 's', status: 'cancelled', reason: null }])
    expect(rows.map((r) => r.key)).toEqual(['s'])
  })
})

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
const draw = (el: ReturnType<typeof h>) => act(() => root.render(el))
const q = (sel: string) => container.querySelector<HTMLElement>(sel)

describe('the rows', () => {
  it('a run is one quiet line with no state icon or "Done"; it opens to its steps', () => {
    draw(h(ToolRun, { items: [tool('1', 'shell', { command: 'npm test' }), tool('2', 'read_file', { path: 'a.ts' }, false)], live: false }))
    const run = q('[data-local-agent-tool-run]')!
    expect(run.textContent).toBe('Ran 1 command, read 1 file· 1 failed')
    expect(run.textContent).not.toContain('Done')
    expect(run.querySelectorAll('svg')).toHaveLength(1) // the chevron alone
    act(() => run.querySelector('button')!.click())
    expect([...run.querySelectorAll('[data-local-agent-tool]')].map((t) => t.textContent)).toEqual(['Running npm test', 'Reading a.ts· Failed'])
  })

  it('an update, a question and the summary read as the agent’s prose: no box, no caps label', () => {
    for (const type of ['report', 'finish'] as const) {
      draw(h(TranscriptRow, { item: { type, key: type, text: `The ${type}.` }, live: false }))
      const row = q(`[data-local-agent-highlight="${type}"]`)!
      expect(row.className).not.toMatch(/border|bg-sky|bg-emerald/)
      expect(row.querySelector('[data-label]')).toBeNull()
      expect(row.querySelector('[data-prose]')!.textContent).toBe(`The ${type}.`)
    }
    draw(h(TranscriptRow, { item: { type: 'ask', key: 'q', text: 'Which one?', teammate: true }, live: false }))
    expect(q('[data-local-agent-highlight="ask"] [data-label]')!.textContent).toBe('To Native Intelligence')
    expect(q('[data-local-agent-highlight="ask"] [data-label]')!.className).not.toMatch(/uppercase|amber/)
  })

  it('the agent’s words carry no bubble', () => {
    draw(h(TranscriptRow, { item: { type: 'assistant', key: 'a', text: 'Hello.', open: false }, live: false }))
    expect(q('[data-prose]')!.className).not.toMatch(/border|rounded|shadow/)
    expect(q('[data-prose]')!.className).toContain('bg-transparent')
  })

  it('a working status ("parked") draws nothing; a stop is a small left line', () => {
    draw(h(TranscriptRow, { item: { type: 'status', key: 's', status: 'waiting', reason: 'parked' }, live: false }))
    expect(container.textContent).toBe('')
    draw(h(TranscriptRow, { item: { type: 'status', key: 's', status: 'cancelled', reason: null }, live: false }))
    const line = q('[data-local-agent-status="cancelled"]')!
    expect(line.textContent).toBe('Stopped')
    expect(line.className).not.toContain('text-center')
  })

  it('the pull request is a compact link line, not a card', () => {
    draw(h(TranscriptRow, { item: { type: 'pull_request', key: 'p', ok: true, url: 'https://github.com/o/r/pull/7', branch: 'b', via: 'gh', pushed: true, error: null }, live: false }))
    const link = q('a[data-local-agent-pull-request]') as HTMLAnchorElement
    expect(link.textContent).toBe('Pull request #7 opened')
    expect(link.className).not.toMatch(/border|rounded-xl/)
    expect(link.closest('p')!.className).toContain('text-muted-foreground')
  })

  it('the person’s message is one neutral bubble, no label above; queued says so quietly under it', () => {
    draw(h(InboundBubble, { author: 'person', text: 'Go on.', policy: 'queue' }))
    const row = q('[data-local-agent-inbound="person"]')!
    expect(row.firstElementChild!.textContent).toBe('Go on.')
    expect(row.firstElementChild!.className).not.toMatch(/bg-black/)
    expect(q('[data-local-agent-inbound-note]')!.textContent).toBe('Queued')
    draw(h(InboundBubble, { author: 'person', text: 'Go on.', policy: 'steer' }))
    expect(q('[data-local-agent-inbound-note]')).toBeNull()
  })
})
