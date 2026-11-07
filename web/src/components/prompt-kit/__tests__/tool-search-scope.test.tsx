// @vitest-environment jsdom
/**
 * A finished find / deep_search shows the scope the agent searched, in the tool
 * row, so the person sees when it widened ("Past 4 weeks", "All time ·
 * transcripts"). Other tools, a running search, or a result with no scope show
 * nothing extra.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { Tool } from '../tool'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function render(props: Parameters<typeof Tool>[0]) {
  await act(async () => {
    root.render(h(Tool, props))
  })
}
const line = () => container.querySelector('[data-search-scope]')?.textContent ?? null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const scope = (over: Record<string, unknown> = {}) => ({
  scope: { window: 'past_4_weeks', since: '2026-09-10T00:00:00.000Z', until: null, transcripts: false, attachments: false, ...over },
})

describe('the search scope line', () => {
  it('find: the default window', async () => {
    await render({ name: 'find', state: 'result', result: { results: [], ...scope() } })
    expect(line()).toBe('· Past 4 weeks')
  })

  it('deep_search widened: all time, transcripts and attachments', async () => {
    await render({ name: 'deep_search', state: 'result', result: scope({ window: 'all_time', since: null, transcripts: true, attachments: true }) })
    expect(line()).toBe('· All time · transcripts · attachments')
  })

  it('nothing while running, for other tools, or without a scope', async () => {
    await render({ name: 'find', state: 'call' })
    expect(line()).toBeNull()
    await render({ name: 'list_actions', state: 'result', result: scope() })
    expect(line()).toBeNull()
    await render({ name: 'find', state: 'result', result: { results: [] } })
    expect(line()).toBeNull()
  })
})
