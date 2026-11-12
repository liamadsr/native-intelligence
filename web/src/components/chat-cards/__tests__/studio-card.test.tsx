// @vitest-environment jsdom
/**
 * The Studio card (pages/studio-card.tsx) and its sub-nav beside the rail
 * (Liam, 11-12: the Studio "needs to match the rest of our app"):
 *
 *   - it draws its own rail only while the Studio page's sub-nav is not on
 *     screen (page-panel/subnav-on-screen.ts): full screen where the rail is,
 *     as the page's own card, the sub-nav there (or still being decided), the
 *     editor gets `navInPanel`; inline, below `md`, the panel closed, or as
 *     the agent's card on one video, it keeps its rail;
 *   - it says where the Studio is (studio-card-controls.ts), and the
 *     sub-nav's asks reach the Studio as new requests, never echoing a place
 *     the Studio reported itself.
 *
 * The editor is a stand-in here (next/dynamic): it shows what it was given.
 * Fixtures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'

const seen = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }))
vi.mock('next/dynamic', () => ({
  default: () =>
    function StudioRootStub(props: Record<string, unknown>) {
      seen.props = props
      return React.createElement('div', {
        'data-studio-stub': '',
        'data-nav': props.navInPanel ? 'panel' : 'rail',
        'data-video': String(props.videoId ?? ''),
        'data-page': String(props.page ?? ''),
        'data-ask': String(props.ask ?? ''),
      })
    },
}))
vi.mock('@/app/account/workspace-switcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/account/workspace-switcher')>()),
  useWorkspaceId: () => 'ws-fernhill',
}))

import { makeStore, mountRoot } from './page-card-harness'
import StudioCard, { studioNavInPanel } from '../pages/studio-card'
import { __resetSubnavOnScreenForTests, setSubnavOnScreen } from '@/app/account/(dashboard)/page-panel/subnav-on-screen'
import { RAIL_MEDIA } from '@/app/account/(dashboard)/rail/rail-media'
import { __resetStudioCardsForTests, studioCardFor } from '../studio-card-controls'
import { CARD_PAGES } from '@/lib/chat-cards/page-menu'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import type { PageCardSpec } from '@/lib/chat-cards/pages'

const PAGE_SPEC = CARD_PAGES.find((p) => p.slug === 'studio')!.spec(new Date()) as PageCardSpec
const VIDEO_SPEC = { kind: 'studio', title: 'Spring teaser', target: { type: 'studio_video', id: 'v-teaser', label: 'Spring teaser' } } as PageCardSpec

let wide = true
let mount: ReturnType<typeof mountRoot> | null = null
beforeEach(() => {
  wide = true
  seen.props = null
  __resetSubnavOnScreenForTests()
  __resetStudioCardsForTests()
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === RAIL_MEDIA ? wide : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
})
afterEach(() => {
  mount?.unmount()
  mount = null
  vi.unstubAllGlobals()
})

async function renderCard(spec: PageCardSpec, fullScreen = true) {
  const store = makeStore('card-studio', spec as CardSpec)
  mount?.unmount()
  mount = mountRoot()
  await mount.render(React.createElement(StudioCard, { toolCallId: 'card-studio', spec, store, fullScreen }))
  for (let i = 0; i < 3; i++) await act(async () => {})
  return store
}
const nav = () => mount!.container.querySelector('[data-studio-stub]')!.getAttribute('data-nav')
const stub = () => mount!.container.querySelector('[data-studio-stub]')!

describe('the Studio card’s own rail', () => {
  it('the rule: only full screen, where the rail is, as the page’s own card, with its sub-nav on screen', () => {
    const on = { fullScreen: true, railShown: true, ownCard: true, subnavShown: true }
    expect(studioNavInPanel(on)).toBe(true)
    expect(studioNavInPanel({ ...on, fullScreen: false })).toBe(false)
    expect(studioNavInPanel({ ...on, railShown: false })).toBe(false)
    expect(studioNavInPanel({ ...on, ownCard: false })).toBe(false)
    expect(studioNavInPanel({ ...on, subnavShown: false })).toBe(false)
  })

  it('hidden while undecided (a refresh: nothing shows then goes) and while the Studio sub-nav is on screen; back when the panel is closed or another page’s shows', async () => {
    await renderCard(PAGE_SPEC)
    expect(nav()).toBe('panel')
    act(() => setSubnavOnScreen('studio'))
    expect(nav()).toBe('panel')
    act(() => setSubnavOnScreen(null))
    expect(nav()).toBe('rail')
    act(() => setSubnavOnScreen('home'))
    expect(nav()).toBe('rail')
    act(() => setSubnavOnScreen('studio'))
    expect(nav()).toBe('panel')
  })

  it('kept inline in the chat, below `md`, and as the agent’s card on one video', async () => {
    act(() => setSubnavOnScreen('studio'))
    await renderCard(PAGE_SPEC, false)
    expect(nav()).toBe('rail')
    wide = false
    await renderCard(PAGE_SPEC)
    expect(nav()).toBe('rail')
    wide = true
    await renderCard(VIDEO_SPEC)
    expect(nav()).toBe('rail')
  })
})

describe('the Studio card and its sub-nav', () => {
  it('says where the Studio is: the card’s own place first, then what the Studio reports (its title, its page)', async () => {
    await renderCard(VIDEO_SPEC)
    expect(studioCardFor('card-studio')).toMatchObject({ cardId: 'card-studio', workspaceId: 'ws-fernhill', videoId: 'v-teaser', title: 'Spring teaser', page: null })
    const onPlace = seen.props!.onPlace as (p: { videoId: string | null; title: string | null; page: string }) => void
    await act(async () => onPlace({ videoId: 'v-teaser', title: 'Spring teaser, final', page: 'project' }))
    expect(studioCardFor('card-studio')).toMatchObject({ videoId: 'v-teaser', title: 'Spring teaser, final', page: 'project' })
    // The Studio's own report is not handed back to it as a request.
    expect(stub().getAttribute('data-ask')).toBe('0')
    await act(async () => onPlace({ videoId: 'v-teaser', title: 'Spring teaser, final', page: 'cast' }))
    expect(stub().getAttribute('data-ask')).toBe('0')
    expect(studioCardFor('card-studio')!.page).toBe('cast')
  })

  it('an ask from the sub-nav is a new request each time, its Studio project’s overview included, even for a place asked before', async () => {
    await renderCard(VIDEO_SPEC)
    const card = () => studioCardFor('card-studio')!
    await act(async () => card().go('v-recap', 'project'))
    expect([stub().getAttribute('data-video'), stub().getAttribute('data-page'), stub().getAttribute('data-ask')]).toEqual(['v-recap', 'project', '1'])
    // The Studio moved away by itself; the same place asked again is asked again.
    const onPlace = seen.props!.onPlace as (p: { videoId: string | null; title: string | null; page: string }) => void
    await act(async () => onPlace({ videoId: 'v-recap', title: 'Workshop recap', page: 'edit' }))
    await act(async () => card().go('v-recap', 'project'))
    expect(stub().getAttribute('data-ask')).toBe('2')
    // A video on the page it was last on: no page asked.
    await act(async () => card().go('v-tour', null))
    expect([stub().getAttribute('data-video'), stub().getAttribute('data-page')]).toEqual(['v-tour', ''])
  })

  it('gone with the card', async () => {
    await renderCard(PAGE_SPEC)
    expect(studioCardFor(null)).not.toBeNull()
    mount!.unmount()
    mount = null
    expect(studioCardFor(null)).toBeNull()
  })
})
