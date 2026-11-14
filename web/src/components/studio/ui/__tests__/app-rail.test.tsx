// @vitest-environment jsdom
/**
 * The Studio's pages rail (../AppRail.tsx; Liam, 11-13: "a panel … where you saw all the different pages like overview
 * storyboard cast edit"; "we don't need the page names lets only show it on hover"): Projects and videos, Project
 * overview, then the video's Overview, Storyboard, Cast and Edit, icons only, each named for assistive technology and in
 * the app's tooltip on hover and keyboard focus (with ⌘O where it applies); the page on screen says so; nothing to open
 * without a video; everything held while a presenter take records; any page closes the chooser. And it is always
 * there: the editor mounts it first in its row, down the Studio's left edge, on the page's own ground (Liam, 11-13: "the
 * side panel should be on the left side and … integrated within the overall panel"; studio.css).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AppRail, RAIL_LABELS } from '../AppRail'
import type { FilmPage } from '../FilmPages'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null, host: HTMLElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks() })

type Props = Parameters<typeof AppRail>[0]
function render(over: Partial<Props> = {}) {
  const props: Props = { page: 'edit', hasProject: true, chooserOpen: false, settingsOpen: false, locked: false, openProjects: vi.fn(), openPage: vi.fn(), ...over }
  host = host ?? document.body.appendChild(document.createElement('div'))
  root = root ?? createRoot(host)
  act(() => root!.render(<AppRail {...props} />))
  return props
}
const nav = () => host!.querySelector<HTMLElement>('nav[data-studio-rail]')!
const items = () => [...nav().querySelectorAll<HTMLButtonElement>('[data-rail-item]')]
const item = (id: string) => nav().querySelector<HTMLButtonElement>(`[data-rail-item="${id}"]`)!
const current = () => items().filter(b => b.getAttribute('aria-current') === 'page').map(b => b.dataset.railItem)

describe('the Studio’s pages rail', () => {
  it('lists Projects and videos, Project overview, then the video’s pages: icons only, each named', () => {
    render()
    expect(nav().getAttribute('aria-label')).toBe('Studio pages')
    expect(items().map(b => b.dataset.railItem)).toEqual(['projects', 'project', 'overview', 'storyboard', 'cast', 'edit'])
    expect(items().map(b => b.getAttribute('aria-label'))).toEqual([RAIL_LABELS.projects, RAIL_LABELS.project, 'Overview', 'Storyboard', 'Cast', 'Edit'])
    expect(RAIL_LABELS).toEqual({ projects: 'Projects and videos', project: 'Project overview' })
    // The video's four grouped under their own name, so Overview is never taken for the Studio project's.
    expect(nav().querySelector('[role="group"]')!.getAttribute('aria-label')).toBe('Video')
    // No names on screen, no caption: an icon each, and no browser tooltip doubling the app's.
    expect(nav().textContent).toBe('')
    for (const b of items()) {
      expect(b.querySelector('svg.lucide')).not.toBeNull()
      expect(b.hasAttribute('title')).toBe(false)
    }
  })

  it('shows a page’s name in the app’s tooltip on keyboard focus, with ⌘O for Projects and videos on a Mac', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    render()
    await act(async () => { item('projects').focus() })
    const tip = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-rail-tooltip="projects"]')
      if (!el) throw new Error('no tooltip yet')
      return el
    })
    expect(tip.textContent).toContain('Projects and videos⌘O')
    expect(tip.querySelector('kbd')!.textContent).toBe('⌘O')
    expect(item('projects').getAttribute('aria-keyshortcuts')).toBe('Meta+O')
  })

  it('says Ctrl+O on Windows and Linux, in the tooltip and to assistive technology', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    render()
    expect(item('projects').getAttribute('aria-keyshortcuts')).toBe('Control+O')
    await act(async () => { item('projects').focus() })
    const tip = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-rail-tooltip="projects"] kbd')
      if (!el) throw new Error('no tooltip yet')
      return el
    })
    expect(tip.textContent).toBe('Ctrl+O')
  })

  it('says which page is on screen, and only that one', () => {
    for (const page of ['project', 'overview', 'storyboard', 'cast', 'edit'] as FilmPage[]) {
      render({ page })
      expect(current()).toEqual([page])
      expect(item(page).classList.contains('active')).toBe(true)
    }
    // The chooser open (or no video at all): Projects and videos is the page.
    render({ page: 'edit', chooserOpen: true })
    expect(current()).toEqual(['projects'])
    // Apps setup: none of them.
    render({ page: 'edit', settingsOpen: true })
    expect(current()).toEqual([])
  })

  it('opens what is pressed; keeps ⌘O on Projects and videos', () => {
    const props = render()
    act(() => item('storyboard').click())
    expect(props.openPage).toHaveBeenCalledWith('storyboard')
    act(() => item('project').click())
    expect(props.openPage).toHaveBeenCalledWith('project')
    act(() => item('projects').click())
    expect(props.openProjects).toHaveBeenCalledTimes(1)
  })

  it('without a video: only Projects and videos; during a presenter take: nothing', () => {
    render({ hasProject: false, chooserOpen: true })
    expect(items().filter(b => !b.disabled).map(b => b.dataset.railItem)).toEqual(['projects'])
    render({ locked: true })
    expect(items().every(b => b.disabled)).toBe(true)
  })
})

// Mounting, order and the chooser as a page are checked on the rendered shell (./studio-shell.test.tsx). What jsdom
// cannot lay out (where the rail is drawn and how it looks) is checked on the stylesheet's own rules here.
describe('the rail’s stylesheet', () => {
  const css = readFileSync(join(__dirname, '..', 'studio.css'), 'utf8')

  it('is drawn down the Studio’s left edge on the page’s own ground (no fill, no edge, no reordering), and the chooser beside it leaves it uncovered', () => {
    const rail = /\.ni-studio \.app-rail\{([^}]*)\}/.exec(css)![1]!
    expect(rail).toContain('background:transparent')
    expect(rail).toContain('border:0')
    expect(rail).not.toMatch(/(^|;)order:|box-shadow/)
    expect(css).not.toMatch(/\.app-rail\{([^}]*;)?order:/)
    expect(css).toMatch(/\.ni-studio \.app\.with-rail \.chooser-backdrop\{left:var\(--st-rail-w\)\}/)
    // The chooser is a page beside the rail: no dim, no frame.
    expect(css).toMatch(/\.ni-studio \.chooser-backdrop\{padding:0;background:var\(--st-bg\)\}/)
    // One slim width at every size (the app rail's feel), with nothing that switches it at a breakpoint.
    expect(css).toMatch(/\.ni-studio \.app\.with-rail\{flex-direction:row;--st-rail-w:52px\}/)
    expect(css).not.toMatch(/--st-rail-w:(?!52px)\d/)
    expect(css).not.toMatch(/\.rail-(label|caption)\b/)
    // Colours from the Studio's tokens only.
    const rules = css.split('\n').filter(line => /\.(app-rail|rail-button|rail-slot|rail-sep)\b/.test(line))
    for (const rule of rules) expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
  })
})
