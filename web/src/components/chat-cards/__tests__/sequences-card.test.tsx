// @vitest-environment jsdom
/**
 * The sequences card draws the real SequencesView: its list is a card list
 * (the real page's beside it is not), and opening a sequence moves the card,
 * kept for the next turn, never the page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot, stubFetch } from './page-card-harness'

vi.mock('@/components/views/unified-view-layout', async (orig) => (await import('./page-card-harness')).probeListModule(orig))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/app/account/(dashboard)/sequences/sequence-detail', () => ({
  SequenceDetail: ({ sequenceId, onBack }: { sequenceId: string; onBack: () => void }) =>
    React.createElement('button', { 'data-sequence-detail': sequenceId, onClick: onBack }, 'back'),
}))

import SequencesCard from '../pages/sequences-card'
import { SequencesView } from '@/app/account/(dashboard)/sequences/sequences-view'
import type { PageCardSpec } from '@/lib/chat-cards/pages'

const spec: PageCardSpec = { kind: 'sequences', title: 'Sequences' }

let mount: ReturnType<typeof mountRoot>
beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('fetch', stubFetch({ accounts: [] }).fn)
  mount = mountRoot()
})
afterEach(() => {
  mount.unmount()
  vi.unstubAllGlobals()
})

describe('SequencesCard', () => {
  it('opens a sequence inside the card and back, leaving the real page where it was', async () => {
    const store = makeStore('call-1', spec)
    const pageOpened = vi.fn()
    await mount.render(
      React.createElement(
        'div',
        null,
        React.createElement('section', { 'data-real-page': '' }, React.createElement(SequencesView, { sequenceId: null, onOpenSequence: pageOpened, onCloseDetail: vi.fn() })),
        React.createElement('section', { 'data-card-page': '' }, React.createElement(SequencesCard, { toolCallId: 'call-1', spec, store, fullScreen: false })),
      ),
    )
    expect(mount.container.querySelector('[data-real-page] [data-probe-list]')?.getAttribute('data-card')).toBe('no')
    expect(mount.container.querySelector('[data-card-page] [data-probe-list]')?.getAttribute('data-card')).toBe('yes')

    await act(async () => (mount.container.querySelector('[data-card-page] [data-probe-open]') as HTMLElement).click())
    expect(mount.container.querySelector('[data-card-page] [data-sequence-detail]')).not.toBeNull()
    expect(mount.container.querySelector('[data-real-page] [data-sequence-detail]')).toBeNull()
    expect(pageOpened).not.toHaveBeenCalled()
    expect(store.contextEntries()[0]).toMatchObject({ at: { type: 'sequence', label: 'Row one' }, moved: true })

    await act(async () => (mount.container.querySelector('[data-sequence-detail]') as HTMLElement).click())
    expect(mount.container.querySelector('[data-card-page] [data-probe-list]')).not.toBeNull()
    expect(store.contextEntries()[0].at).toBeUndefined()
  })
})
