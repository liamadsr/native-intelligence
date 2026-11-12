// @vitest-environment jsdom
/**
 * The Studio page's panel: its sub-nav (studio-panel.tsx; Liam, 11-12: the
 * Studio "needs to match the rest of our app"). Registered for `studio`: it
 * holds the slot while the Studio page's own card is in front, its headings
 * from its first commit. Its rows move the Studio through what the card says
 * (studio-card-controls.ts); the lit row follows where the Studio says it
 * is, not the click. Its list is read when the page is selected and when the
 * Studio says it changed, never on a timer. A guest never has it. Fixtures
 * are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, useSyncExternalStore } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-fernhill' }))
vi.mock('@/components/desktop-titlebar', () => ({ useHasTrafficLights: () => false, useIsDesktop: () => false }))
// The person's role here: a member, or a guest.
const who = vi.hoisted(() => ({ role: 'member' }))
vi.mock('@/app/account/workspace-switcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/account/workspace-switcher')>()),
  useWorkspaceId: () => 'ws-fernhill',
  useWorkspaces: () => ({ workspaces: [{ id: 'ws-fernhill', name: 'Fernhill Studio', role: who.role }], currentId: 'ws-fernhill' }),
}))
vi.mock('../../side-panels/side-panels', async () => {
  const store = await import('../../side-panels/side-panel-store')
  return {
    PANEL_TOP: '6px',
    SLIDE_CLASS: 'transition-[translate,visibility]',
    SLIDE_STYLE: {},
    useComposerReserve: () => 0,
    useSidePanelState: () => useSyncExternalStore(store.subscribeSidePanels, store.getSidePanelState, store.getServerSidePanelState),
  }
})

import { PAGE_PANELS, PagePanelHost } from '../page-panel'
import { StudioPanel } from '../studio-panel'
import { __resetStudioListsForTests } from '../studio-panel-data'
import * as store from '../../side-panels/side-panel-store'
import { holdFrontCard } from '@/components/chat-cards/front-card'
import {
  __resetStudioCardsForTests,
  publishStudioCard,
  unpublishStudioCard,
  type StudioCardControls,
} from '@/components/chat-cards/studio-card-controls'
import { __resetStudioChangesForTests, noteStudioChange } from '@/components/studio/studio-changes'
import { CARD_PAGES } from '@/lib/chat-cards/page-menu'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import type { CampaignSummary } from '@/lib/studio/engine/api'
import { KEEP_PLACE_ATTR, __resetSelectedPlaceForTests, selectedPlace } from '../../rail/selected-place'

const STUDIO_CARD = 'card-studio-page'
const studioSpec = () => CARD_PAGES.find((p) => p.slug === 'studio')!.spec(new Date()) as CardSpec

const ad = (id: string, title: string): CampaignSummary['ads'][number] => ({
  id,
  title,
  updatedAt: '2026-11-10T10:00:00.000Z',
  durationSeconds: 15,
  clipCount: 1,
  hasCamera: false,
  hasSlides: false,
  thumbnail: { assetId: 'a', seconds: 0 },
  width: 1080,
  height: 1920,
  castCount: 0,
  status: 'draft',
})
const CAMPAIGNS: CampaignSummary[] = [
  { id: 'p-spring', title: 'Fernhill spring', createdAt: '', updatedAt: '', single: false, castCount: 0, ads: [ad('v-teaser', 'Spring teaser'), ad('v-recap', 'Workshop recap')] },
  { id: 'single-v-hello', title: 'Hello Studio', createdAt: '', updatedAt: '', single: true, castCount: 0, ads: [ad('v-hello', 'Hello Studio')] },
  { id: 'p-autumn', title: 'Autumn open day', createdAt: '', updatedAt: '', single: false, castCount: 0, ads: [ad('v-tour', 'Studio tour')] },
]

let container: HTMLDivElement
let root: Root
let releases: Array<() => void> = []
const calls: string[] = []
let reads = 0
let campaigns: CampaignSummary[] = CAMPAIGNS

function controls(over: Partial<StudioCardControls> = {}): StudioCardControls {
  return {
    cardId: STUDIO_CARD,
    workspaceId: 'ws-fernhill',
    videoId: 'v-teaser',
    title: 'Spring teaser',
    page: 'edit',
    go: (videoId, page) => calls.push(`go:${videoId}:${page}`),
    show: () => calls.push('show'),
    ...over,
  }
}

beforeEach(() => {
  calls.length = 0
  reads = 0
  campaigns = CAMPAIGNS
  who.role = 'member'
  releases = []
  window.localStorage.clear()
  __resetSelectedPlaceForTests()
  __resetStudioCardsForTests()
  __resetStudioListsForTests()
  __resetStudioChangesForTests()
  store.resetSidePanelStore()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/account/studio/campaigns')) {
        reads += 1
        return { ok: true, json: async () => ({ campaigns }) } as Response
      }
      return { ok: true, json: async () => ({ entries: [], next_cursor: null }) } as Response
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  for (const release of releases) act(() => release())
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {})
}

/** The row as the plan answers it: room while the panel is wanted. */
function Row() {
  const state = useSyncExternalStore(store.subscribeSidePanels, store.getSidePanelState, store.getServerSidePanelState)
  return <PagePanelHost mode={store.pagePanelWanted(state) ? 'room' : 'off'} />
}

/** The Studio page's own card in front, as the rail opens it. */
async function openStudioPage(id = STUDIO_CARD, spec: CardSpec = studioSpec()) {
  act(() => {
    releases.push(holdFrontCard({ id, spec, close: () => {} }))
  })
  await flush()
}

const panel = () => container.querySelector<HTMLElement>('aside[data-page-panel="studio"]')
const rows = () => [...container.querySelectorAll<HTMLButtonElement>('[data-studio-row]')]
const labelOf = (r: HTMLElement) => r.querySelector('[data-studio-label]')!.textContent
const row = (label: string) => rows().find((r) => labelOf(r) === label)!
const rowByKey = (key: string) => container.querySelector<HTMLButtonElement>(`[data-studio-row="${key}"]`)!
const lit = () => rows().filter((r) => r.getAttribute('aria-current') === 'true').map(labelOf)
const headings = () => [...container.querySelectorAll('[data-studio-section] h3')].map((h) => h.textContent)

describe('the Studio sub-nav', () => {
  it('is the Studio’s registered panel', () => {
    expect(PAGE_PANELS.studio).toBe(StudioPanel)
  })

  it('holds the slot on the Studio page from its first commit, its headings and “+” before the card says anything; the list comes with its read', async () => {
    campaigns = []
    let release: (() => void) | null = null
    const slow = new Promise<void>((resolve) => (release = resolve))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (!String(url).endsWith('/api/account/studio/campaigns')) return { ok: true, json: async () => ({ entries: [], next_cursor: null }) } as Response
        reads += 1
        await slow
        return { ok: true, json: async () => ({ campaigns: CAMPAIGNS }) } as Response
      }),
    )
    act(() => root.render(<Row />))
    await openStudioPage()
    expect(selectedPlace()).toBe('studio')
    expect(panel()!.getAttribute('data-page-panel-mode')).toBe('room')
    expect(panel()!.getAttribute('aria-label')).toBe('Studio')
    expect(store.getSidePanelState()).toMatchObject({ pagePanel: true, pagePanelPage: true })
    // Not read yet: the headings alone (no rows that then go, no “nothing yet” that then goes).
    expect(headings()).toEqual(['Studio projects', 'Videos'])
    expect(rows()).toEqual([])
    expect(container.querySelector('[data-studio-note]')).toBeNull()
    expect(container.querySelector('[data-studio-add="projects"]')!.getAttribute('aria-label')).toBe('New Studio project')
    expect(container.querySelector('[data-studio-add="videos"]')!.getAttribute('aria-label')).toBe('New video')
    expect(reads).toBe(1)
    await act(async () => release!())
    await flush()
    expect(rows().map(labelOf)).toEqual(['Fernhill spring', 'Autumn open day', 'Hello Studio'])
    // A press in it keeps the page selected (rail/selected-place.ts).
    expect(rows()[0]!.closest(`[${KEEP_PLACE_ATTR}]`)).not.toBeNull()
  })

  it('exactly one row lit, following where the Studio says it is (not the click); the open video’s project open with its pages', async () => {
    act(() => root.render(<Row />))
    await openStudioPage()
    act(() => publishStudioCard(controls()))
    await flush()
    expect(rows().map(labelOf)).toEqual([
      'Fernhill spring', 'Project overview', 'Spring teaser', 'Overview', 'Storyboard', 'Cast', 'Edit', 'Workshop recap',
      'Autumn open day',
      'Hello Studio',
    ])
    expect(lit()).toEqual(['Edit'])
    // A click alone lights nothing new: the Studio hasn't moved.
    act(() => row('Storyboard').click())
    expect(calls).toEqual(['go:v-teaser:storyboard'])
    expect(lit()).toEqual(['Edit'])
    // The Studio moved (by the panel or its own controls): the row follows.
    act(() => publishStudioCard(controls({ page: 'storyboard' })))
    expect(lit()).toEqual(['Storyboard'])
    act(() => publishStudioCard(controls({ page: 'project' })))
    expect(lit()).toEqual(['Project overview'])
    act(() => publishStudioCard(controls({ videoId: 'v-hello', title: 'Hello Studio', page: 'cast' })))
    await flush()
    expect(lit()).toEqual(['Cast'])
    expect(rowByKey('page:v-hello:cast')).toBeTruthy()
  })

  it('rows move the Studio: a page, a video (on the page it was last on), a project’s overview; the lit row and the open video do nothing more', async () => {
    act(() => root.render(<Row />))
    await openStudioPage()
    act(() => publishStudioCard(controls()))
    await flush()
    act(() => row('Edit').click())
    act(() => row('Spring teaser').click())
    act(() => row('Cast').click())
    act(() => row('Workshop recap').click())
    act(() => row('Project overview').click())
    act(() => row('Hello Studio').click())
    expect(calls).toEqual(['go:v-teaser:cast', 'go:v-recap:null', 'go:v-teaser:project', 'go:v-hello:null'])
  })

  it('a project row opens or closes its folder without moving anything', async () => {
    act(() => root.render(<Row />))
    await openStudioPage()
    act(() => publishStudioCard(controls()))
    await flush()
    const autumn = () => rowByKey('project:p-autumn')
    expect(autumn().getAttribute('aria-expanded')).toBe('false')
    act(() => autumn().click())
    expect(autumn().getAttribute('aria-expanded')).toBe('true')
    expect(rows().map(labelOf)).toContain('Studio tour')
    // The open video's project closed: its project carries the light.
    act(() => rowByKey('project:p-spring').click())
    expect(rows().map(labelOf)).not.toContain('Spring teaser')
    expect(lit()).toEqual(['Fernhill spring'])
    expect(calls).toEqual([])
    // Another project's overview opens its first video on it.
    act(() => row('Project overview').click())
    expect(calls).toEqual(['go:v-tour:project'])
  })

  it('a row pressed before the card says where it is: the latest move waits, then moves the Studio once it says', async () => {
    act(() => root.render(<Row />))
    await openStudioPage()
    expect(rows().map(labelOf)).toEqual(['Fernhill spring', 'Autumn open day', 'Hello Studio'])
    act(() => rowByKey('project:p-autumn').click())
    act(() => row('Studio tour').click())
    expect(calls).toEqual([])
    act(() => publishStudioCard(controls()))
    await flush()
    expect(calls).toEqual(['go:v-tour:null'])
  })

  it('a record opened over the page as its own card in front: the page stays selected, a row puts the Studio card back first', async () => {
    act(() => root.render(<Row />))
    await openStudioPage()
    act(() => publishStudioCard(controls()))
    await flush()
    act(() => {
      rows()[0]!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    await openStudioPage('card-record', { kind: 'record', title: 'Send the Fernhill quote', record: { type: 'action', id: 'a0000000-0000-4000-8000-000000000001' } } as CardSpec)
    expect(selectedPlace()).toBe('studio')
    act(() => row('Cast').click())
    expect(calls).toEqual(['show', 'go:v-teaser:cast'])
    // Where the Studio is already: only back in front.
    calls.length = 0
    act(() => row('Edit').click())
    expect(calls).toEqual(['show'])
  })

  it('reads its list again when the Studio says it changed, and when another video opens; never otherwise', async () => {
    act(() => root.render(<Row />))
    await openStudioPage()
    act(() => publishStudioCard(controls()))
    await flush()
    const before = reads
    campaigns = [...CAMPAIGNS, { id: 'single-v-new', title: 'Studio walk-through', createdAt: '', updatedAt: '', single: true, castCount: 0, ads: [ad('v-new', 'Studio walk-through')] }]
    act(() => noteStudioChange())
    await flush()
    expect(reads).toBe(before + 1)
    expect(rows().map(labelOf)).toContain('Studio walk-through')
    act(() => publishStudioCard(controls({ page: 'cast' })))
    await flush()
    expect(reads).toBe(before + 1)
    act(() => publishStudioCard(controls({ videoId: 'v-new', title: 'Studio walk-through', page: 'edit' })))
    await flush()
    expect(reads).toBe(before + 2)
  })

  it('the card gone (its page still selected): the list stays, nothing lit', async () => {
    act(() => root.render(<Row />))
    await openStudioPage()
    act(() => publishStudioCard(controls()))
    await flush()
    act(() => unpublishStudioCard(STUDIO_CARD))
    await flush()
    expect(panel()!.getAttribute('data-page-panel-mode')).toBe('room')
    expect(rows().map(labelOf)).toEqual(['Fernhill spring', 'Autumn open day', 'Hello Studio'])
    expect(lit()).toEqual([])
  })

  it('a workspace with no video: its headings with their “+”, and one line saying so', async () => {
    campaigns = []
    act(() => root.render(<Row />))
    await openStudioPage()
    expect(headings()).toEqual(['Studio projects', 'Videos'])
    expect(rows()).toEqual([])
    expect(container.querySelector('[data-studio-note]')!.textContent).toBe('No videos yet')
  })

  it('the starts: a “+” offers the Studio’s shapes; picked, the Studio’s own route makes it and the Studio opens it', async () => {
    const posts: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url)
        if (init?.method === 'POST') {
          posts.push({ url: u, body: JSON.parse(String(init.body)) })
          if (u.endsWith('/campaigns')) return { ok: true, json: async () => ({ campaign: { id: 'p-new' } }) } as Response
          return { ok: true, json: async () => ({ project: { id: 'v-made' } }) } as Response
        }
        if (u.endsWith('/api/account/studio/campaigns')) return { ok: true, json: async () => ({ campaigns }) } as Response
        return { ok: true, json: async () => ({ entries: [], next_cursor: null }) } as Response
      }),
    )
    act(() => root.render(<Row />))
    await openStudioPage()
    act(() => publishStudioCard(controls()))
    await flush()
    const pick = async (trigger: Element, shape: string) => {
      act(() => {
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      await flush()
      const item = [...document.querySelectorAll<HTMLElement>('[data-studio-shape]')].find((el) => el.textContent === shape)!
      expect(item).toBeTruthy()
      act(() => item.click())
      await flush()
    }
    // A video on its own.
    await pick(container.querySelector('[data-studio-add="videos"]')!, 'Square (1:1)')
    expect(posts).toEqual([{ url: '/api/account/studio/projects/blank', body: { title: 'Untitled video', width: 1080, height: 1080 } }])
    expect(calls).toEqual(['go:v-made:edit'])
    // A video in a Studio project (its row's own “+”).
    posts.length = 0
    calls.length = 0
    await pick(container.querySelector('[data-studio-add-video="p-autumn"]')!, 'Landscape (16:9)')
    expect(posts).toEqual([{ url: '/api/account/studio/campaigns/p-autumn/new-ad', body: { title: 'Untitled video', width: 1920, height: 1080 } }])
    expect(calls).toEqual(['go:v-made:edit'])
    // A Studio project, with its first video, opened on the project's overview (where it is named).
    posts.length = 0
    calls.length = 0
    await pick(container.querySelector('[data-studio-add="projects"]')!, 'Reel or Story (9:16)')
    expect(posts).toEqual([
      { url: '/api/account/studio/campaigns', body: { title: 'Untitled Studio project', projectIds: [] } },
      { url: '/api/account/studio/campaigns/p-new/new-ad', body: { title: 'Untitled video', width: 1080, height: 1920 } },
    ])
    expect(calls).toEqual(['go:v-made:project'])
  })

  it('a guest never has it: nothing to show, the slot left empty, nothing read', async () => {
    who.role = 'guest'
    act(() => root.render(<Row />))
    await openStudioPage()
    expect(panel()).toBeNull()
    expect(store.getSidePanelState()).toMatchObject({ pagePanel: false })
    expect(reads).toBe(0)
  })
})
