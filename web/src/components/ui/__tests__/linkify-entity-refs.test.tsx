// @vitest-environment jsdom
/**
 * Plain text with its action identifiers as live chips (../linkify.tsx,
 * `entityRefs`): a job's "What happened" in the Code view's right panel and
 * on the work item's page draws GEN-12 as the chat's own chip (EntityRefChip,
 * the one rendered Markdown draws), keeps its links, and leaves an id inside
 * a link, an unknown id, and the text without `entityRefs`, as written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KNOWN: Record<string, { id: string; identifier: string; title: string }> = {
  'GEN-12': { id: 'act-12', identifier: 'GEN-12', title: 'Fix the export button' },
  'GEN-34': { id: 'act-34', identifier: 'GEN-34', title: 'Tidy the board' },
}
const resolved = vi.fn()
vi.mock('@/components/entity-refs/use-entity-ref', () => ({
  useEntityRef: (identifier: string) => {
    resolved(identifier)
    const found = KNOWN[identifier]
    return found
      ? {
          status: 'found',
          data: { ...found, workspace_id: 'ws-1', team_id: null, status: { id: 's1', name: 'In Progress', category: 'started', color: null }, assignee: null, priority: null, due_date: null, project: null },
          refresh: async () => {},
        }
      : { status: 'missing', data: null, refresh: async () => {} }
  },
}))

import { Linkify } from '../linkify'
import { EntityRefsProvider } from '@/components/entity-refs/entity-refs-context'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  resolved.mockClear()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (node: React.ReactNode) => act(() => root.render(node))
const chips = () => Array.from(container.querySelectorAll('button')).map((b) => ({ text: b.textContent, title: b.getAttribute('title') }))

describe('Linkify with entityRefs', () => {
  it('draws each known action id as the chat’s chip, the text around it kept', () => {
    render(h('p', null, h(Linkify, { text: 'Closed GEN-12 and moved GEN-34 to Todo.', entityRefs: true })))
    expect(container.textContent).toBe('Closed GEN-12 and moved GEN-34 to Todo.')
    expect(chips()).toEqual([
      { text: 'GEN-12', title: 'Fix the export button' },
      { text: 'GEN-34', title: 'Tidy the board' },
    ])
  })

  it('keeps links as links, and an id inside a link is the link’s', () => {
    render(h('p', null, h(Linkify, { text: 'See https://example.com/GEN-12 for GEN-34', entityRefs: true })))
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/GEN-12')
    expect(chips().map((c) => c.text)).toEqual(['GEN-34'])
  })

  it('an id that is no action reads as written', () => {
    render(h('p', null, h(Linkify, { text: 'Not GEN-999.', entityRefs: true })))
    expect(container.textContent).toBe('Not GEN-999.')
    expect(chips()).toEqual([])
  })

  it('without entityRefs, or on a surface with chips off, it is plain text and resolves nothing', () => {
    render(h('p', null, h(Linkify, { text: 'Closed GEN-12.' })))
    expect(chips()).toEqual([])
    render(h(EntityRefsProvider, { enabled: false }, h('p', null, h(Linkify, { text: 'Closed GEN-12.', entityRefs: true }))))
    expect(container.textContent).toBe('Closed GEN-12.')
    expect(chips()).toEqual([])
    expect(resolved).not.toHaveBeenCalled()
  })
})
