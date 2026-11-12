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
 *     the Studio reported itself;
 *   - it tells the agent what the editor shows when a turn is sent with it in
 *     front (the video, its Studio project, the page, the playhead, the
 *     selection: card-store.ts provideLive), read then and only then, after
 *     the editor saved (settle); never for a guest, never with no video.
 *
 * The editor is a stand-in here (next/dynamic): it shows what it was given.
 * Fixtures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'

const seen = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }))
const ws = vi.hoisted(() => ({ guest: false, list: null as null | Array<Record<string, unknown>>, reads: 0 }))
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
  useIsWorkspaceGuest: () => ws.guest,
}))
vi.mock('@/app/account/(dashboard)/page-panel/studio-panel-data', () => ({
  studioList: () => ws.list,
  readStudioList: async () => {
    ws.reads += 1
  },
}))

import { makeStore, mountRoot } from './page-card-harness'
import StudioCard, { studioNavInPanel } from '../pages/studio-card'
import { __resetSubnavOnScreenForTests, setSubnavOnScreen } from '@/app/account/(dashboard)/page-panel/subnav-on-screen'
import { RAIL_MEDIA } from '@/app/account/(dashboard)/rail/rail-media'
import { __resetStudioCardsForTests, studioCardFor } from '../studio-card-controls'
import { CARD_PAGES } from '@/lib/chat-cards/page-menu'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import type { PageCardSpec } from '@/lib/chat-cards/pages'
import type { StudioNote } from '@/lib/chat-cards/studio-note'
import type { EditorChatLink } from '@/components/studio/ui/chat-note'

const PAGE_SPEC = CARD_PAGES.find((p) => p.slug === 'studio')!.spec(new Date()) as PageCardSpec
const VIDEO_SPEC = { kind: 'studio', title: 'Spring teaser', target: { type: 'studio_video', id: 'v-teaser', label: 'Spring teaser' } } as PageCardSpec

let wide = true
let mount: ReturnType<typeof mountRoot> | null = null
beforeEach(() => {
  wide = true
  seen.props = null
  ws.guest = false
  ws.list = null
  ws.reads = 0
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

describe('what the agent is told about the editor', () => {
  const HELLO: StudioNote = {
    v: { id: 'v-teaser', title: 'Spring teaser' },
    page: 'edit',
    t: 1.5,
    fmt: '1920×1080 at 60 fps',
    sel: [{ k: 'layer', id: 'layer-headline', kind: 'text', label: 'Headline', text: 'Spring is here', from: 0, to: 3 }],
  }
  function editor(initial: StudioNote | null) {
    const state = { note: initial, saved: false, flushes: 0 }
    const link: EditorChatLink = {
      note: () => (state.note ? { ...state.note, ...(state.saved ? {} : { dirty: true as const }) } : null),
      flush: async () => {
        state.flushes += 1
        state.saved = true
        return true
      },
    }
    return { state, link }
  }
  const tell = async (link: EditorChatLink | null) => {
    const onLive = seen.props!.onLive as (link: EditorChatLink | null) => void
    await act(async () => onLive(link))
  }
  const studioOf = (store: ReturnType<typeof makeStore>) => store.contextEntries()[0]?.studio

  it('at send time: the editor’s note, with the Studio project the video is in, after it saved the person’s edits', async () => {
    ws.list = [{ id: 'camp-spring', title: 'Spring launch', single: false, ads: [{ id: 'v-teaser' }] }]
    const store = await renderCard(VIDEO_SPEC)
    const { state, link } = editor(HELLO)
    await tell(link)
    // Unsaved until the send settles the card: then saved, and the note says so.
    expect(studioOf(store)?.dirty).toBe(true)
    await store.settle()
    expect(state.flushes).toBe(1)
    expect(studioOf(store)).toEqual({ ...HELLO, sp: { id: 'camp-spring', title: 'Spring launch' } })
  })

  it('reads the editor as it is at that moment, and reports nothing as the playhead or the selection move', async () => {
    const store = await renderCard(VIDEO_SPEC)
    const { state, link } = editor(HELLO)
    await tell(link)
    const update = vi.spyOn(store, 'update')
    const version = store.getVersion()
    for (let frame = 0; frame < 240; frame++) state.note = { ...HELLO, t: frame / 60 }
    state.note = { ...HELLO, t: 3.9, sel: [{ k: 'clip', id: 'clip-2', from: 3, to: 8 }] }
    expect(update).not.toHaveBeenCalled()
    expect(store.getVersion()).toBe(version)
    expect(studioOf(store)).toMatchObject({ t: 3.9, sel: [{ k: 'clip', id: 'clip-2' }] })
  })

  it('reads the Studio projects once when nothing has, not per send', async () => {
    await renderCard(VIDEO_SPEC)
    expect(ws.reads).toBe(1)
    ws.list = []
    await renderCard(VIDEO_SPEC)
    expect(ws.reads).toBe(1)
  })

  it('nothing with no video open, nor once the editor is gone', async () => {
    const store = await renderCard(PAGE_SPEC)
    const { link } = editor(null)
    await tell(link)
    expect(studioOf(store)).toBeUndefined()
    await tell(editor(HELLO).link)
    expect(studioOf(store)).toBeDefined()
    await tell(null)
    expect(studioOf(store)).toBeUndefined()
    await store.settle()
  })

  it('nothing for a guest of the workspace (the Studio refuses one)', async () => {
    ws.guest = true
    const store = await renderCard(VIDEO_SPEC)
    const { state, link } = editor(HELLO)
    await tell(link)
    expect(studioOf(store)).toBeUndefined()
    await store.settle()
    expect(state.flushes).toBe(0)
  })

  it('nothing while another card is in front, and nothing once the card is gone', async () => {
    const store = await renderCard(VIDEO_SPEC)
    await tell(editor(HELLO).link)
    store.setCards([{ id: 'card-studio', spec: VIDEO_SPEC as CardSpec }, { id: 'card-cal', spec: { kind: 'calendar', title: 'Week', calendar: { view: 'week', from: '2026-11-09', to: '2026-11-15' } } as CardSpec }])
    store.enterFullScreen('card-cal')
    expect(store.contextEntries().find((e) => e.id === 'card-studio')?.studio).toBeUndefined()
    store.exitFullScreen()
    expect(store.contextEntries().find((e) => e.id === 'card-studio')?.studio).toBeDefined()
    mount!.unmount()
    mount = null
    expect(store.contextEntries().find((e) => e.id === 'card-studio')?.studio).toBeUndefined()
  })
})
