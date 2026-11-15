// @vitest-environment jsdom
/**
 * Projects and videos (../ProjectChooser.tsx) is one of the Studio rail's pages, drawn beside the rail (Liam, 11-13): a
 * page, not a dialog. No close button and no Cancel; "Back to the video" when another video is picked, the primary
 * button's own words when the open one is; Esc goes back to the video; Tab is not held inside it, so the rail beside it
 * stays in reach. Its starts: New recording, New blank video, New Studio project. Fixtures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { setStudioRoot } from '../../studio-env'
import { ProjectChooser } from '../ProjectChooser'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = new Date('2026-11-12T10:00:00Z').toISOString()
const video = (id: string, title: string) => ({ id, title, updatedAt: now, durationSeconds: 20, clipCount: 1, hasCamera: false, hasSlides: false, thumbnail: { assetId: 'a', seconds: 1 }, width: 1920, height: 1080, castCount: 0, status: 'draft' })
const campaigns = [
  { id: 'camp-spring', title: 'Spring launch', single: false, castCount: 0, updatedAt: now, ads: [video('v-teaser', 'Spring teaser')] },
  { id: 'single-v-tour', title: 'Product tour', single: true, castCount: 0, updatedAt: now, ads: [video('v-tour', 'Product tour')] },
]

let root: Root | null = null, host: HTMLElement | null = null
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/campaigns') ? { campaigns } : { projects: campaigns.flatMap(c => c.ads) }), { status: 200 })))
  host = document.body.appendChild(document.createElement('div'))
  host.getClientRects = () => [host!.getBoundingClientRect()] as unknown as DOMRectList
  setStudioRoot(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root?.unmount()); setStudioRoot(null); host?.remove(); root = null; host = null; vi.unstubAllGlobals() })

async function render(over: Partial<Parameters<typeof ProjectChooser>[0]> = {}) {
  const props = { currentProjectId: 'v-teaser', refreshKey: '1', disabled: false, canClose: true, close: vi.fn(), onProject: vi.fn(), onRecord: vi.fn(), onNew: vi.fn(), onRenameCurrent: vi.fn(), onDeleted: vi.fn(), ...over }
  await act(async () => root!.render(<ProjectChooser {...props} />))
  for (let i = 0; i < 3; i++) await act(async () => {})
  return props
}
const buttons = () => [...host!.querySelectorAll('button')].map(b => b.textContent?.trim())

describe('Projects and videos, a page of the Studio', () => {
  it('is a page beside the rail, not a dialog: no close button, no Cancel', async () => {
    await render()
    const page = host!.querySelector<HTMLElement>('[data-studio-chooser]')!
    expect(page.tagName).toBe('SECTION')
    expect(page.getAttribute('aria-label')).toBe('Projects and videos')
    expect(host!.querySelector('[role="dialog"],[aria-modal]')).toBeNull()
    expect(host!.querySelector('[aria-label="Close"]')).toBeNull()
    expect(buttons()).not.toContain('Cancel')
    // The open video picked: the primary button goes back to it.
    expect(host!.querySelector('.chooser-foot .primary')!.textContent).toBe('Back to the video')
  })

  it('offers its three starts', async () => {
    const props = await render()
    const starts = [...host!.querySelectorAll('.chooser-start b')].map(b => b.textContent)
    expect(starts).toEqual(['New recording', 'New blank video', 'New Studio project'])
    act(() => host!.querySelector<HTMLButtonElement>('.chooser-start.record')!.click())
    expect(props.onRecord).toHaveBeenCalled()
  })

  it('Esc goes back to the video; Tab is never held inside it', async () => {
    const props = await render()
    const search = host!.querySelector<HTMLInputElement>('.chooser-search')!
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    act(() => { search.dispatchEvent(tab) })
    expect(tab.defaultPrevented).toBe(false)
    act(() => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(props.close).toHaveBeenCalledTimes(1)
  })

  it('with no video to go back to: no way back offered, Esc does nothing', async () => {
    const props = await render({ currentProjectId: null, canClose: false })
    expect(buttons()).not.toContain('Back to the video')
    act(() => { host!.querySelector('.chooser-search')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(props.close).not.toHaveBeenCalled()
  })
})
