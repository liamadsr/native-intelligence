// @vitest-environment jsdom
/**
 * The Studio's shell as it mounts (studio-root.tsx and ./App.tsx, rendered for real; only the video player and the
 * server are stand-ins): the pages rail is first in the row and in the reading order, always there, and Projects and
 * videos is a page beside it. While that page is shown the editor and its header are inert (and hidden from
 * assistive technology), so no Tab from the rail or the page lands on the covered Undo, Record, Export or timeline.
 * jsdom does not skip inert subtrees when tabbing, so the order is checked by document position and the inert
 * attribute on every covered control's ancestry. Fixtures are made up.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { defaultCaptions, defaultPresentation, EditorProjectSchema, neutralMotion } from '@/lib/studio/engine/contracts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@remotion/player', async () => {
  const React = await import('react')
  const Player = React.forwardRef(function Player(_props: unknown, ref: React.Ref<unknown>) {
    React.useImperativeHandle(ref, () => ({ pause() {}, play() {}, seekTo() {}, isPlaying: () => false, getCurrentFrame: () => 0, addEventListener() {}, removeEventListener() {} }))
    return React.createElement('div', { 'data-player-stub': '' })
  })
  return { Player }
})

const ID = 'v-fernhill-teaser'
const frames = 600
const project = EditorProjectSchema.parse({
  schemaVersion: 4, id: ID, title: 'Fernhill spring teaser', output: { width: 1920, height: 1080, fps: 30 },
  assets: [{ id: 'screen-1', name: 'Screen take.mp4', kind: 'video', file: `assets/${'a'.repeat(64)}.mp4`, sha256: 'a'.repeat(64), bytes: 1000, width: 1920, height: 1080, sourceFps: 30, sourceFrames: frames, durationSeconds: 20, hasAudio: false, sourceCursorHidden: false }],
  clips: [{ id: 'clip-1', assetId: 'screen-1', trimStartSourceFrame: 0, trimEndSourceFrame: frames, audio: { muted: false, gain: 1 }, holdEndFrames: 0, zooms: [], motion: neutralMotion(), playbackRate: 1, dismissedActionIndices: [] }],
  presentation: structuredClone(defaultPresentation), cursor: { style: 'glass', size: 24, clickFeedback: true }, presenterTrack: null,
  audioTracks: [], transcripts: [], captions: { ...defaultCaptions }, captionCorrections: {}, voiceoverDraft: { text: '', targetClipIds: [] }, layers: [],
})
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const answer = (url: string) => {
  if (url.includes('/studio/bootstrap')) return json({ project, projectDigest: 'd1', projects: [{ id: ID, title: project.title }], presets: [], assets: project.assets, job: null })
  if (url.includes('/studio/campaigns')) return json({ campaigns: [] })
  if (url.endsWith('/studio/projects')) return json({ projects: [] })
  if (url.includes('/studio/fonts')) return json({ faces: [] })
  if (url.includes('/studio/app-profiles')) return json({ profiles: [] })
  if (url.includes('/browser/places')) return json({ places: [] })
  if (url.includes('/browser/list')) return json({ entries: [] })
  return json({})
}

let root: Root | null = null, host: HTMLElement | null = null
beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(`ni:studio:page.${ID}`, 'edit')
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => answer(String(input))))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
})
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.unstubAllGlobals() })

// The whole Studio is one large module graph. It is loaded once, with time to spare: in a full suite on a busy
// machine the first import alone has taken longer than a test's default five seconds (seen twice, as timeouts).
let StudioRoot: typeof import('../../studio-root').default
beforeAll(async () => { StudioRoot = (await import('../../studio-root')).default }, 120_000)
/** A test that mounts the whole Studio: the default five seconds is not enough on a busy machine. */
const SLOW = 30_000

async function mount() {
  await act(async () => root!.render(<StudioRoot workspaceId="ws-fernhill" />))
  await vi.waitFor(() => { if (!host!.querySelector('.app-header .hdr-title')) throw new Error('not open yet') }, { timeout: 20_000 })
  for (let i = 0; i < 3; i++) await act(async () => {})
}
const main = () => host!.querySelector<HTMLElement>('main.app')!
const editor = () => main().querySelector<HTMLElement>(':scope > .app-main')!
const rail = () => main().querySelector<HTMLElement>(':scope > nav[data-studio-rail]')!
const page = () => host!.querySelector<HTMLElement>('[data-studio-chooser]')
const before = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
/** What the Tab key could land on in the editor: its controls not under an inert ancestor. */
const reachable = (within: HTMLElement) => [...within.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select,textarea,[tabindex]:not([tabindex="-1"])')].filter(el => !el.closest('[inert]'))

describe('the Studio’s shell', () => {
  it('puts the pages rail first in the row and the reading order, before the editor, always there', async () => {
    await mount()
    expect(main().firstElementChild).toBe(rail())
    expect(before(rail(), editor())).toBe(true)
    expect(rail().querySelectorAll('[data-rail-item]')).toHaveLength(6)
    expect(editor().hasAttribute('inert')).toBe(false)
    expect(reachable(editor()).length).toBeGreaterThan(0)
  }, SLOW)

  it('Projects and videos: a page after the editor in the reading order, the editor and its header inert and hidden meanwhile; back to the video, all reachable again', async () => {
    await mount()
    await act(async () => rail().querySelector<HTMLButtonElement>('[data-rail-item="projects"]')!.click())
    for (let i = 0; i < 3; i++) await act(async () => {})
    const chooser = page()!
    expect(chooser).not.toBeNull()
    // Rail, then the covered editor (skipped), then the page.
    expect(before(rail(), chooser)).toBe(true)
    expect(before(editor(), chooser)).toBe(true)
    expect(editor().hasAttribute('inert')).toBe(true)
    expect(editor().getAttribute('aria-hidden')).toBe('true')
    // The covered header's Undo, Record and Export, and every other editor control: none reachable.
    for (const label of ['Undo (⌘Z)', 'Export']) {
      const control = [...editor().querySelectorAll<HTMLElement>('button')].find(b => b.getAttribute('aria-label') === label || b.textContent?.trim() === label)
      expect(control, label).toBeDefined()
      expect(control!.closest('[inert]'), label).not.toBeNull()
    }
    expect(reachable(editor())).toEqual([])
    // The rail and the page stay reachable.
    expect(reachable(rail()).length).toBeGreaterThan(0)
    expect(reachable(chooser).length).toBeGreaterThan(0)
    // The rail's Edit leaves the page: the editor is live again.
    await act(async () => rail().querySelector<HTMLButtonElement>('[data-rail-item="edit"]')!.click())
    for (let i = 0; i < 3; i++) await act(async () => {})
    expect(page()).toBeNull()
    expect(editor().hasAttribute('inert')).toBe(false)
    expect(reachable(editor()).length).toBeGreaterThan(0)
  }, SLOW)
})
