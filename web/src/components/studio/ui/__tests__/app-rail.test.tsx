// @vitest-environment jsdom
/**
 * The Studio's pages as tabs across the top (../AppRail.tsx; Liam, 11-24, of the earlier column of icons down the left
 * edge: "the buttons are just floating on the sides"; he chose tabs on top): Projects, Project, then the video's
 * Overview, Storyboard, Cast and Edit, each a pill with its short name on screen and its full name for assistive
 * technology and in its tooltip (with ⌘O where it applies); the page on screen says so; nothing to open without a
 * video; everything held while a presenter take records; any page closes the chooser. And it is always there: the
 * editor mounts it first, a row across the Studio's top, with the page's content under it (studio.css).
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

describe('the Studio’s page tabs', () => {
  it('lists Projects, Project, then the video’s pages: short names on screen, full names for assistive technology', () => {
    render()
    expect(nav().getAttribute('aria-label')).toBe('Studio pages')
    expect(items().map(b => b.dataset.railItem)).toEqual(['projects', 'project', 'overview', 'storyboard', 'cast', 'edit'])
    expect(items().map(b => b.textContent)).toEqual(['Projects', 'Project', 'Overview', 'Storyboard', 'Cast', 'Edit'])
    expect(items().map(b => b.getAttribute('aria-label'))).toEqual([RAIL_LABELS.projects, RAIL_LABELS.project, 'Overview', 'Storyboard', 'Cast', 'Edit'])
    expect(RAIL_LABELS).toEqual({ projects: 'Projects and videos', project: 'Project overview' })
    // The video's four grouped under their own name, so Overview is never taken for the Studio project's.
    expect(nav().querySelector('[role="group"]')!.getAttribute('aria-label')).toBe('Video')
  })

  it('gives Projects and videos its shortcut: ⌘O on a Mac, in its tooltip and to assistive technology', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    render()
    expect(item('projects').getAttribute('title')).toBe('Projects and videos (⌘O)')
    expect(item('projects').getAttribute('aria-keyshortcuts')).toBe('Meta+O')
    expect(item('edit').getAttribute('title')).toBe('Edit')
  })

  it('says Ctrl+O on Windows and Linux', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    render()
    expect(item('projects').getAttribute('aria-keyshortcuts')).toBe('Control+O')
    expect(item('projects').getAttribute('title')).toBe('Projects and videos (Ctrl+O)')
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
// cannot lay out (where the tabs are drawn and how they look) is checked on the stylesheet's own rules here.
describe('the tabs’ stylesheet', () => {
  const css = readFileSync(join(__dirname, '..', 'studio.css'), 'utf8')

  it('are a row across the Studio’s top in the app’s page-tab look, and the chooser under them leaves them uncovered', () => {
    expect(css).toMatch(/\.ni-studio \.app\.with-tabs\{flex-direction:column;--st-tabs-h:48px\}/)
    const row = /\.ni-studio \.studio-tabs\{([^}]*)\}/.exec(css)![1]!
    expect(row).toContain('height:var(--st-tabs-h)')
    expect(row).toContain('padding:0 10px')
    expect(row).not.toMatch(/background|box-shadow|(^|;)order:/)
    const tab = /\.ni-studio \.studio-tabs \.studio-tab\{([^}]*)\}/.exec(css)![1]!
    expect(tab).toContain('height:28px')
    expect(tab).toContain('border-radius:999px')
    expect(tab).toContain('font-size:13px')
    expect(css).toMatch(/\.ni-studio \.app\.with-tabs \.chooser-backdrop\{top:var\(--st-tabs-h\)\}/)
    expect(css).not.toMatch(/--st-rail-w|\.app-rail\b|\.rail-button\b/)
    // The chooser is a page under the tabs: no dim, no frame.
    // The ground is the app's card, not a fill of the Studio's own (Liam, 11-14): the root, the chooser and the pages
    // that fill the root paint nothing, and the editor a page covers is not drawn meanwhile.
    expect(css).toMatch(/\.ni-studio \.chooser-backdrop\{padding:0;background:transparent\}/)
    expect(css).toMatch(/\.ni-studio\.ni-studio-root\{background:transparent\}/)
    expect(css).toMatch(/\.ni-studio\.ni-studio-root \.film-pages\{background:transparent\}/)
    expect(css).toMatch(/\.ni-studio\.ni-studio-root \.app-main\[inert\]\{visibility:hidden\}/)
    // Colours from the Studio's tokens only.
    const rules = css.split('\n').filter(line => /\.studio-tab(s|s-sep|s-group)?\b/.test(line))
    expect(rules.length).toBeGreaterThan(3)
    for (const rule of rules) expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
  })
})
