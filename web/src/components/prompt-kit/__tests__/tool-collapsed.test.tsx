// @vitest-environment jsdom
/**
 * A generic tool call is ONE collapsed line: the label shimmers while the call
 * runs and is static once it settles (a search's scope line kept), and its
 * input / output (or a failure's message) appear only when the row is opened.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Tool } from '../tool'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

function render(props: Parameters<typeof Tool>[0]) {
  const tool = h(Tool, props)
  act(() => {
    root.render(tool)
  })
}
const trigger = () => container.querySelector('button')!
function toggle() {
  act(() => {
    trigger().dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const findResult = {
  results: [{ title: 'Pricing call with Acme', snippet: 'A LONG CHUNK OF RESULT TEXT' }],
  scope: { window: 'past_4_weeks', since: '2026-09-10T00:00:00.000Z', until: null, transcripts: false, attachments: false },
}

describe('generic tool row', () => {
  it('running: the label shimmers, nothing else in the thread', () => {
    render({ name: 'find', state: 'call', args: { query: 'acme pricing' } })
    const shimmer = container.querySelector('.shimmer-text')
    expect(shimmer?.textContent).toBe('Search workspace')
    expect(container.textContent).toContain('Running…')
    expect(container.textContent).not.toContain('acme pricing')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('args still streaming in: shimmers too', () => {
    render({ name: 'list_actions', state: 'partial-call' })
    expect(container.querySelector('.shimmer-text')?.textContent).toBe('List actions')
  })

  it('done: a static label, "Done" and the scope line, the results collapsed', () => {
    render({ name: 'find', state: 'result', args: { query: 'acme pricing' }, result: findResult })
    expect(container.querySelector('.shimmer-text')).toBeNull()
    expect(container.textContent).toContain('Search workspace')
    expect(container.textContent).toContain('Done')
    expect(container.querySelector('[data-search-scope]')?.textContent).toBe('· Past 4 weeks')
    expect(container.textContent).not.toContain('A LONG CHUNK OF RESULT TEXT')
  })

  it('expanding shows the input and output, collapsing hides them again', () => {
    render({ name: 'find', state: 'result', args: { query: 'acme pricing' }, result: findResult })
    toggle()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('acme pricing')
    expect(container.textContent).toContain('A LONG CHUNK OF RESULT TEXT')
    toggle()
    expect(container.textContent).not.toContain('A LONG CHUNK OF RESULT TEXT')
  })

  it('error: a quiet status, the message on expand', () => {
    render({ name: 'find', state: 'error', args: { query: 'q' }, result: 'Search backend timed out' })
    expect(container.textContent).toContain('Error')
    expect(container.querySelector('.text-red-500')).toBeNull()
    expect(container.textContent).not.toContain('Search backend timed out')
    toggle()
    expect(container.textContent).toContain('Search backend timed out')
  })
})
