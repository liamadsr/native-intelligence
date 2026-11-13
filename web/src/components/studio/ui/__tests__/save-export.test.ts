/**
 * Saving a finished export onto the computer: the desktop app's Save panel, a browser's save picker (the file streams
 * into the place the person chose), or a plain download into the browser's downloads folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const downloadFile = vi.fn()
vi.mock('@/lib/download', () => ({ downloadFile: (...args: unknown[]) => downloadFile(...args) }))
import { exportFileName, saveExport, saveWay } from '../save-export'

const URL_ = '/api/account/studio/file/ws/exports/j/1/video.mp4?download=Spring%20launch.mp4'
let clicked: { href: string; download: string }[]
beforeEach(() => {
  clicked = []
  const link = { href: '', download: '', rel: '', click() { clicked.push({ href: this.href, download: this.download }) }, remove() {} }
  vi.stubGlobal('window', {})
  vi.stubGlobal('document', { createElement: () => link, body: { appendChild: () => undefined } })
})
afterEach(() => { vi.unstubAllGlobals(); downloadFile.mockReset() })

describe('exportFileName', () => {
  it('takes the name the link asks for, else the title made safe', () => {
    expect(exportFileName(URL_, 'ignored')).toBe('Spring launch.mp4')
    expect(exportFileName('/x/video.mp4', 'Q3 / review: final')).toBe('Q3 review final.mp4')
    expect(exportFileName('/x/video.mp4', '  ')).toBe('video.mp4')
  })
})

describe('saveExport', () => {
  it('in the desktop app, goes through its Save panel and says the path (or that it was cancelled)', async () => {
    vi.stubGlobal('window', { __TAURI__: {} })
    expect(saveWay()).toBe('desktop')
    downloadFile.mockResolvedValueOnce('/Users/someone/Movies/Spring launch.mp4').mockResolvedValueOnce(null)
    expect(await saveExport(URL_, 'Spring launch.mp4')).toEqual({ kind: 'saved', where: '/Users/someone/Movies/Spring launch.mp4' })
    expect(downloadFile).toHaveBeenCalledWith(URL_, 'Spring launch.mp4')
    expect(await saveExport(URL_, 'Spring launch.mp4')).toEqual({ kind: 'cancelled' })
  })

  it('with a save picker, streams the file into the place the person chose', async () => {
    const written: Uint8Array[] = []
    const writable = new WritableStream<Uint8Array>({ write: (chunk) => { written.push(chunk) } })
    const picker = vi.fn(async () => ({ name: 'Spring launch.mp4', createWritable: async () => writable }))
    vi.stubGlobal('window', { showSaveFilePicker: picker })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))))
    expect(saveWay()).toBe('picker')
    expect(await saveExport(URL_, 'Spring launch.mp4')).toEqual({ kind: 'saved', where: 'Spring launch.mp4' })
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'Spring launch.mp4' }))
    expect(written.flatMap((chunk) => [...chunk])).toEqual([1, 2, 3])
    expect(clicked).toEqual([])
  })

  it('says a cancelled picker is cancelled, and the server’s sentence when the file is gone', async () => {
    vi.stubGlobal('window', { showSaveFilePicker: async () => { throw Object.assign(new Error('closed'), { name: 'AbortError' }) } })
    expect(await saveExport(URL_, 'a.mp4')).toEqual({ kind: 'cancelled' })
    vi.stubGlobal('window', { showSaveFilePicker: async () => ({ name: 'a.mp4', createWritable: async () => new WritableStream() }) })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'This export is no longer kept: exports are kept for 30 days. Export the video again.' }), { status: 404 })))
    await expect(saveExport(URL_, 'a.mp4')).rejects.toThrow('exports are kept for 30 days')
  })

  it('in any other browser, downloads it plainly into the downloads folder; so does a refused picker', async () => {
    expect(saveWay()).toBe('downloads')
    expect(await saveExport(URL_, 'Spring launch.mp4')).toEqual({ kind: 'downloads', name: 'Spring launch.mp4' })
    vi.stubGlobal('window', { showSaveFilePicker: async () => { throw Object.assign(new Error('not allowed'), { name: 'SecurityError' }) } })
    expect(await saveExport(URL_, 'Spring launch.mp4')).toEqual({ kind: 'downloads', name: 'Spring launch.mp4' })
    expect(clicked).toEqual([{ href: URL_, download: 'Spring launch.mp4' }, { href: URL_, download: 'Spring launch.mp4' }])
  })
})
