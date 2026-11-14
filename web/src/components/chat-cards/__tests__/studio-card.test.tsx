// @vitest-environment jsdom
/**
 * The Studio card (pages/studio-card.tsx), one of Outreach's pages (Liam,
 * 11-13: "it should be part of the outreach page"):
 *
 *   - the editor always draws its own pages rail: nothing tells it to leave
 *     its navigation to the app's sub-nav (that is Outreach's now);
 *   - where the Studio says it is becomes the card's place, never handed back
 *     to it as a request; a new place for the card (a link, the agent) is;
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
vi.mock('@/components/studio/studio-list', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/studio/studio-list')>()),
  studioList: () => ws.list,
  readStudioList: async () => {
    ws.reads += 1
  },
}))

import { makeStore, mountRoot } from './page-card-harness'
import StudioCard from '../pages/studio-card'
import { RAIL_MEDIA } from '@/app/account/(dashboard)/rail/rail-media'
import { __resetStudioChangesForTests, noteStudioChange } from '@/components/studio/studio-changes'
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
  __resetStudioChangesForTests()
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
const stub = () => mount!.container.querySelector('[data-studio-stub]')!

describe('the Studio card’s own pages rail (Liam, 11-13)', () => {
  it('is always the editor’s: full screen or inline, wide or narrow, its own card or the agent’s on one video', async () => {
    for (const [spec, fullScreen, isWide] of [[PAGE_SPEC, true, true], [PAGE_SPEC, false, true], [PAGE_SPEC, true, false], [VIDEO_SPEC, true, true]] as const) {
      wide = isWide
      await renderCard(spec, fullScreen)
      expect(seen.props).not.toHaveProperty('navInPanel')
    }
  })
})

describe('the Studio card’s place', () => {
  it('opens the Studio on the card’s own place: a video, then what it asks next', async () => {
    await renderCard(VIDEO_SPEC)
    expect([stub().getAttribute('data-video'), stub().getAttribute('data-page'), stub().getAttribute('data-ask')]).toEqual(['v-teaser', '', '0'])
  })

  it('keeps where the Studio says it is, and never hands it back as a request', async () => {
    await renderCard(VIDEO_SPEC)
    const onPlace = seen.props!.onPlace as (p: { videoId: string | null; title: string | null; page: string }) => void
    await act(async () => onPlace({ videoId: 'v-teaser', title: 'Spring teaser', page: 'cast' }))
    expect(stub().getAttribute('data-ask')).toBe('0')
    await act(async () => onPlace({ videoId: 'v-teaser', title: 'Spring teaser', page: 'project' }))
    expect([stub().getAttribute('data-video'), stub().getAttribute('data-ask')]).toEqual(['v-teaser', '0'])
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

  it('reads the Studio projects when nothing has, when the Studio says its list changed, and when the open video is not in it; never per send', async () => {
    const store = await renderCard(VIDEO_SPEC)
    expect(ws.reads).toBe(1)
    // Listed and nothing changed: not again (a remount, a send).
    ws.list = [{ id: 'camp-spring', title: 'Spring launch', single: false, ads: [{ id: 'v-teaser' }] }]
    await renderCard(VIDEO_SPEC)
    await store.settle()
    expect(ws.reads).toBe(1)
    // A video moved into a Studio project in the Studio: read again.
    await act(async () => noteStudioChange())
    expect(ws.reads).toBe(2)
    // A video made since the last read: read again.
    ws.list = []
    await renderCard(VIDEO_SPEC)
    expect(ws.reads).toBe(3)
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
