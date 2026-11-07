// @vitest-environment jsdom
/**
 * The library card draws the real AgentsView beside the real page: the page
 * restores its remembered type (skills), the card stays on the tab it was
 * given and leaves the remembered type alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { makeStore, mountRoot } from './page-card-harness'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock('@/app/account/(dashboard)/views/agents/use-library-items', () => ({
  useLibraryItems: () => ({
    discoverItems: [],
    workspaceItems: [],
    myItems: [],
    isLoading: false,
    forking: null,
    fork: vi.fn(),
    remove: vi.fn(),
    save: vi.fn(),
    refetchOwned: vi.fn(),
  }),
}))
vi.mock('@/app/account/(dashboard)/views/agents/library-collection', () => ({
  LibraryCollection: ({ category }: { category: string }) => React.createElement('div', { 'data-collection': category }),
}))

import LibraryCard from '../pages/library-card'
import { AgentsView } from '@/app/account/(dashboard)/views/agents-view'
import type { PageCardSpec } from '@/lib/chat-cards/pages'

let mount: ReturnType<typeof mountRoot>
beforeEach(() => {
  window.localStorage.clear()
  mount = mountRoot()
})
afterEach(() => mount.unmount())

describe('LibraryCard', () => {
  it("keeps its own type, and never reads or writes the page's remembered one", async () => {
    window.localStorage.setItem('dial8-agents-type', 'skill')
    const spec: PageCardSpec = { kind: 'library', title: 'Agents' }
    await mount.render(
      React.createElement(
        'div',
        null,
        React.createElement('section', { 'data-real-page': '' }, React.createElement(AgentsView)),
        React.createElement('section', { 'data-card-page': '' }, React.createElement(LibraryCard, { toolCallId: 'l1', spec, store: makeStore('l1', spec), fullScreen: false })),
      ),
    )
    expect(mount.container.querySelector('[data-real-page] [data-collection]')?.getAttribute('data-collection')).toBe('skill')
    expect(mount.container.querySelector('[data-card-page] [data-collection]')?.getAttribute('data-collection')).toBe('agent')
    expect(window.localStorage.getItem('dial8-agents-type')).toBe('skill')
  })

  it('opens on the skills tab when that is what the agent showed', async () => {
    const spec: PageCardSpec = { kind: 'library', title: 'Skills', tab: 'skills' }
    await mount.render(React.createElement(LibraryCard, { toolCallId: 'l1', spec, store: makeStore('l1', spec), fullScreen: false }))
    expect(mount.container.querySelector('[data-collection]')?.getAttribute('data-collection')).toBe('skill')
  })
})
