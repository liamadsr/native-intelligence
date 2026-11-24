// @vitest-environment jsdom
/**
 * The campaigns card draws the real CampaignsView. Its list is the views
 * system's (docs/plans/views-everywhere.md), stubbed here: the page mounts it
 * on `campaign`, as the card's own list (it reports what it shows), and a row
 * it picks opens the page's own editor on that campaign.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot, stubFetch } from './page-card-harness'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const CAMPAIGN = { id: 'c1', name: 'Launch week', status: 'active', channels: [], tags: [], objective: null, description: null, starts_on: null, ends_on: null, owner_member_id: null, metadata: {}, sequence_id: null, audience: null, rolling: false, recipe: null, launched_at: null, launched_by: null, refreshed_at: null, stats: {}, created_at: '', updated_at: '' }
const listed: Array<{ entityType: string; onItemSelect: (id: string, title: string, e?: unknown, item?: Record<string, unknown>) => void }> = []
vi.mock('@/components/views/unified-view-layout', async (orig) => ({
  ...(await orig<object>()),
  UnifiedViewLayout: (props: (typeof listed)[number]) => {
    listed.push(props)
    return React.createElement('div', { 'data-stub-list': props.entityType })
  },
}))

import CampaignsCard from '../pages/campaigns-card'
import { pageEntities, type PageCardSpec } from '@/lib/chat-cards/pages'

const spec: PageCardSpec = { kind: 'campaigns', title: 'Campaigns' }
let mount: ReturnType<typeof mountRoot>
beforeEach(() => {
  listed.length = 0
  vi.stubGlobal('fetch', stubFetch({}).fn)
  mount = mountRoot()
})
afterEach(() => {
  mount.unmount()
  vi.unstubAllGlobals()
})

describe('CampaignsCard', () => {
  it('lists the campaigns as the card’s own views list, and a row opens the editor', async () => {
    await mount.render(React.createElement(CampaignsCard, { toolCallId: 'c', spec, store: makeStore('c', spec), fullScreen: false }))
    expect(listed.at(-1)?.entityType).toBe('campaign')
    expect(pageEntities('campaigns').has('campaign')).toBe(true)
    await act(async () => listed.at(-1)!.onItemSelect('c1', 'Launch week', undefined, CAMPAIGN))
    expect(document.querySelector('input[value="Launch week"]')).not.toBeNull()
  })
})
