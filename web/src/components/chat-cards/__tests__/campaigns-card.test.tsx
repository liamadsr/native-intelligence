// @vitest-environment jsdom
/**
 * The campaigns card draws the real CampaignsView with its own fetch and
 * tells the card's header how many there are.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { makeStore, mountRoot, stubFetch } from './page-card-harness'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import CampaignsCard from '../pages/campaigns-card'
import type { PageCardSpec } from '@/lib/chat-cards/pages'

const spec: PageCardSpec = { kind: 'campaigns', title: 'Campaigns' }
let mount: ReturnType<typeof mountRoot>
let fetchStub: ReturnType<typeof stubFetch>
beforeEach(() => {
  fetchStub = stubFetch({ campaigns: [{ id: 'c1', name: 'Launch week', status: 'active', channels: [], tags: [] }] })
  vi.stubGlobal('fetch', fetchStub.fn)
  mount = mountRoot()
})
afterEach(() => {
  mount.unmount()
  vi.unstubAllGlobals()
})

describe('CampaignsCard', () => {
  it('lists the campaigns and reports their count', async () => {
    const onCount = vi.fn()
    await mount.render(React.createElement(CampaignsCard, { toolCallId: 'c', spec, store: makeStore('c', spec), fullScreen: false, onCount }))
    expect(fetchStub.calls).toContain('/api/account/campaigns')
    expect(mount.container.textContent).toContain('Launch week')
    expect(onCount).toHaveBeenLastCalledWith(1)
  })
})
