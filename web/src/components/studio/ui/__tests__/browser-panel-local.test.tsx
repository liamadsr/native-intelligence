// @vitest-environment jsdom
/**
 * The Browser panel's folders on this computer (../BrowserPanel.tsx with ../local-folders.ts), with the browser's
 * folder input stood in for: the place appears under "This computer", its files list and search here, a long folder
 * says it was cut, a file is added by its button or a double-click and uploaded through the same import as a dropped
 * file, and after a reload a folder the browser only gave for one visit offers "Choose it again" instead of looking
 * linked. Made-up folders only; nothing touches a real disk or the server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const importFile = vi.fn(async (file: File) => ({ asset: { id: 'a1', kind: 'image', name: file.name } }))
vi.mock('../client', () => ({
  request: async (path: string) => {
    if (path.endsWith('/browser/places')) return { places: [{ id: 'library', name: 'Studio library', path: '', available: true }, { id: 'files', name: 'Files', path: '', available: true }] }
    if (path.includes('/browser/list')) return { entries: [] }
    throw new Error(`unexpected ${path}`)
  },
  finishedJob: async () => { throw new Error('unexpected job') },
  importFile: (file: File) => importFile(file),
}))

let root: Root | null = null, host: HTMLElement | null = null
const flush = async (ms = 0) => { await act(async () => { await new Promise(r => setTimeout(r, ms)) }) }
const file = (path: string, size: number) => { const f = new File([], path.split('/').at(-1)!); Object.defineProperty(f, 'size', { value: size }); Object.defineProperty(f, 'webkitRelativePath', { value: path }); return f }
const text = () => host!.textContent ?? ''
const button = (label: string) => [...host!.querySelectorAll('button')].find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)
const row = (name: string) => [...host!.querySelectorAll<HTMLElement>('[role=treeitem]')].find(r => r.querySelector('.ab-name')?.firstChild?.textContent === name)

async function render(add = vi.fn()) {
  vi.resetModules()
  const { BrowserPanel, browserImport } = await import('../BrowserPanel')
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => { root!.render(<BrowserPanel add={add} disabled={false} notify={() => {}} />) })
  await flush()
  return { add, browserImport }
}
/** The folder the person "chooses" in the hidden folder input the panel opens. */
async function choose(files: File[]) {
  const input = document.body.querySelector<HTMLInputElement>('input[type=file]')!
  expect(input).toBeTruthy()
  Object.defineProperty(input, 'files', { value: files })
  await act(async () => { input.dispatchEvent(new Event('change')) })
  await flush()
}

beforeEach(() => {
  localStorage.clear()
  // A browser (or the desktop app's WebKit view) whose file input takes folders but which has no folder handles.
  Object.defineProperty(HTMLInputElement.prototype, 'webkitdirectory', { value: false, writable: true, configurable: true })
  HTMLInputElement.prototype.click = function click() {}
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() })
})
afterEach(() => { act(() => root?.unmount()); host?.remove(); document.body.innerHTML = ''; root = null; host = null; importFile.mockClear() })

describe('Browser panel: a folder on this computer', () => {
  it('offers to add a folder under the places, and says nothing leaves the computer first', async () => {
    await render()
    expect(text()).toContain('This computer')
    expect(button('Add a folder from this computer')).toBeTruthy()
    expect(text()).toContain('Nothing leaves this computer until you add a file.')
  })

  it('lists, searches and adds files from a chosen folder, uploading only what is added', async () => {
    const { add, browserImport } = await render()
    await act(async () => { button('Add a folder from this computer')!.click() })
    const map = file('Holiday/stills/map.png', 120_000)
    await choose([file('Holiday/clip 2.mp4', 3_000_000), map, file('Holiday/theme.aiff', 10), file('Holiday/.DS_Store', 1)])

    const place = [...host!.querySelectorAll('.ab-place.local')]
    expect(place.map(p => p.textContent)).toEqual(['Holiday'])
    expect([...host!.querySelectorAll('[role=treeitem] .ab-name')].map(n => n.textContent)).toEqual(['stills', 'clip 2.mp4', 'theme.aiff'])
    expect(row('clip 2.mp4')!.querySelector('.ab-size')!.textContent).toBe('2.9 MB')
    expect(text()).toContain('Linked until the page reloads.')

    // A file that can't be added says how to make it addable, and can't be dragged.
    await act(async () => { row('theme.aiff')!.click() })
    expect(text()).toContain('Save it as WAV, MP3 or M4A to add it')
    expect(row('theme.aiff')!.getAttribute('draggable')).toBe('false')

    // Search looks through the subfolders.
    const search = host!.querySelector<HTMLInputElement>('input[aria-label="Search the Browser"]')!
    await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; set.call(search, 'map'); search.dispatchEvent(new Event('input', { bubbles: true })) })
    await flush(220)
    expect([...host!.querySelectorAll('[role=treeitem] .ab-name')].map(n => n.firstChild?.textContent)).toEqual(['map.png'])

    // Selecting previews it from an object URL; the button adds it.
    await act(async () => { row('map.png')!.click() })
    await flush()
    expect(host!.querySelector<HTMLImageElement>('.ab-stage img')!.getAttribute('src')).toBe('blob:preview')
    await act(async () => { button('Use as background')!.click() })
    const item = add.mock.calls[0]![0]
    expect(item).toMatchObject({ path: 'stills/map.png', name: 'map.png', kind: 'image' })
    expect(item.place).toMatch(/^local:/)
    expect(row('map.png')!.getAttribute('draggable')).toBe('true')

    // Adding uploads that file through the editor's own import, and nothing before that.
    expect(importFile).not.toHaveBeenCalled()
    expect(await browserImport(item)).toEqual({ asset: expect.objectContaining({ id: 'a1' }) })
    expect(importFile).toHaveBeenCalledWith(map)
  })

  it('says when a long folder is cut', async () => {
    await render()
    await act(async () => { button('Add a folder from this computer')!.click() })
    await choose(Array.from({ length: 2005 }, (_, i) => file(`Frames/frame ${i}.png`, 10)))
    expect(host!.querySelectorAll('[role=treeitem]')).toHaveLength(2000)
    expect(text()).toContain('Showing 2,000 of 2,005 items. Search to find the rest.')
  })

  it('after a reload, a folder given for one visit offers “Choose it again”, then opens what is chosen', async () => {
    localStorage.setItem('ni:studio:browser.local-folders.v1', JSON.stringify([{ id: 'local:trip', name: 'Holiday', mode: 'session' }]))
    localStorage.setItem('ni:studio:browser.place', JSON.stringify('local:trip'))
    await render()
    expect(host!.querySelector('.ab-place.local')!.className).toContain('s-choose-again')
    expect(text()).toContain('“Holiday” was linked until the page reloaded.')
    expect(host!.querySelectorAll('[role=treeitem]')).toHaveLength(0)

    await act(async () => { button('Choose it again')!.click() })
    await choose([file('Holiday/clip 2.mp4', 3)])
    expect(host!.querySelector('.ab-place.local')!.className).not.toContain('s-choose-again')
    expect([...host!.querySelectorAll('[role=treeitem] .ab-name')].map(n => n.textContent)).toEqual(['clip 2.mp4'])
  })

  it('removes a folder from the Browser', async () => {
    localStorage.setItem('ni:studio:browser.local-folders.v1', JSON.stringify([{ id: 'local:trip', name: 'Holiday', mode: 'session' }]))
    await render()
    await act(async () => { button('Remove Holiday from the Browser')!.click() })
    await flush()
    expect(host!.querySelector('.ab-place.local')).toBeNull()
    expect(JSON.parse(localStorage.getItem('ni:studio:browser.local-folders.v1')!)).toEqual([])
  })
})
