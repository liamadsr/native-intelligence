// @vitest-environment jsdom
/**
 * The teams card draws the real TeamsView; opening a team moves the card
 * (kept for the next turn), and Back to the teams moves it back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot, stubFetch } from './page-card-harness'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/views/unified-view-layout', async (orig) => (await import('./page-card-harness')).probeListModule(orig))

import TeamsCard from '../pages/teams-card'
import type { PageCardSpec } from '@/lib/chat-cards/pages'

const TEAM = '00000000-0000-4000-8000-000000000101'
const spec: PageCardSpec = { kind: 'teams', title: 'Teams' }
let mount: ReturnType<typeof mountRoot>
beforeEach(() => {
  vi.stubGlobal('fetch', stubFetch({
    teams: [{ id: TEAM, name: 'Platform', identifier: 'PLA', member_count: 2, action_count: 3 }],
    team: { id: TEAM, name: 'Platform', issue_prefix: 'PLA', is_private: false },
    members: [],
    aiMembers: [],
    states: [],
  }).fn)
  mount = mountRoot()
})
afterEach(() => {
  mount.unmount()
  vi.unstubAllGlobals()
})

describe('TeamsCard', () => {
  it('opens a team inside the card, keeping it for the next turn', async () => {
    const store = makeStore('t1', spec)
    await mount.render(React.createElement(TeamsCard, { toolCallId: 't1', spec, store, fullScreen: false }))
    const name = Array.from(mount.container.querySelectorAll('span')).find((el) => el.textContent === 'Platform') as HTMLElement
    await act(async () => (name.closest('button') as HTMLElement).click())
    expect(store.contextEntries()[0]).toMatchObject({ at: { type: 'team', id: TEAM }, moved: true })
  })
})
