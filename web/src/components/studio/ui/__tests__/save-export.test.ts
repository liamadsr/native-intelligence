/**
 * Saving a finished export onto the computer (../save-export.ts), through the real lib/download.ts: the desktop app's
 * Save panel only for a file small enough to hand over as the released app's array of numbers, a larger one through a
 * short-lived link opened in the person's browser; a browser's save picker (the file streams into the place chosen);
 * or a plain download. Every way checks the file is still kept before it claims anything was saved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const saveFile = vi.fn()
const openInSystemBrowser = vi.fn()
const pickDestination = vi.fn()
const saveParts = vi.fn()
vi.mock('@/lib/tauri-bridge', async (actual) => ({ studioRefusal: (await actual<typeof import('@/lib/tauri-bridge')>()).studioRefusal, tauriBridge: { saveFile: (...args: unknown[]) => saveFile(...args) }, studioLocalExport: { pickDestination: (...args: unknown[]) => pickDestination(...args), saveParts: (...args: unknown[]) => saveParts(...args) } }))
vi.mock('@/lib/open-external', () => ({ openInSystemBrowser: (...args: unknown[]) => openInSystemBrowser(...args) }))
import { DESKTOP_SAVE_LIMIT, exportFileName, saveExport, saveWay } from '../save-export'
import { isAccountRedirectPath, resolvePostAuthRedirect } from '@/lib/auth/login-redirect'

const WS = '0b0b0b0b-1111-4222-8333-444444444444'
const URL_ = `/api/account/studio/file/${WS}/exports/j1/1/video.mp4?download=Spring%20launch.mp4`
const FILE = { url: URL_, fileName: 'Spring launch.mp4' }
const GONE = 'This export is no longer kept: exports are kept for 30 days. Export the video again.'
let clicked: { href: string; download: string }[]
let calls: { url: string; method: string; body?: string }[]
/** The server: HEAD and GET of the file (`bytes` long, or gone), POST of a download link. */
function server(bytes: number | 'gone', extra: { lengthHeader?: boolean } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url: input, method, ...(typeof init?.body === 'string' ? { body: init.body } : {}) })
    if (bytes === 'gone') return Response.json({ error: GONE }, { status: 404 })
    const headers: Record<string, string> = extra.lengthHeader === false ? {} : { 'content-length': String(bytes) }
    return new Response(method === 'HEAD' ? null : new Uint8Array(bytes).fill(3), { headers })
  }))
}
beforeEach(() => {
  clicked = []; calls = []
  const link = { href: '', download: '', rel: '', click() { clicked.push({ href: this.href, download: this.download }) }, remove() {} }
  vi.stubGlobal('window', { location: { origin: 'https://app.example' } })
  vi.stubGlobal('document', { createElement: () => link, body: { appendChild: () => undefined, removeChild: () => undefined } })
})
afterEach(() => { vi.unstubAllGlobals(); saveFile.mockReset(); openInSystemBrowser.mockReset(); pickDestination.mockReset(); saveParts.mockReset() })
const desktop = () => vi.stubGlobal('window', { __TAURI__: {}, location: { origin: 'https://app.example' } })

describe('names and keys', () => {
  it('takes the name the link asks for, else the title made safe', () => {
    expect(exportFileName(URL_, 'ignored')).toBe('Spring launch.mp4')
    expect(exportFileName('/x/video.mp4', 'Q3 / review: final')).toBe('Q3 review final.mp4')
  })
})

describe('in the desktop app', () => {
  it('hands a small file to the Save panel through the real download path', async () => {
    desktop(); server(1000)
    saveFile.mockResolvedValueOnce('/Users/someone/Movies/Spring launch.mp4')
    expect(saveWay(1000)).toBe('desktop')
    expect(await saveExport({ ...FILE, bytes: 1000 })).toEqual({ kind: 'saved', where: '/Users/someone/Movies/Spring launch.mp4' })
    const [name, contents] = saveFile.mock.calls[0] as [string, number[]]
    expect(name).toBe('Spring launch.mp4')
    expect(contents).toHaveLength(1000)
    expect(openInSystemBrowser).not.toHaveBeenCalled()
  })

  const VIDEO = 'aaaaaaaa-1111-4222-8333-444444444444', JOB = 'bbbbbbbb-1111-4222-8333-444444444444', SPACE = 'cccccccc-1111-4222-8333-444444444444'
  const ARRIVAL = { videoId: VIDEO, jobId: JOB, workspaceId: SPACE }

  it('never builds a number array for a large export: the browser opens the Studio on it, signed in there', async () => {
    desktop(); server(75 * 1024 * 1024)
    openInSystemBrowser.mockResolvedValue(true)
    expect(saveWay(DESKTOP_SAVE_LIMIT + 1)).toBe('desktop-browser')
    expect(await saveExport({ ...FILE, bytes: 75 * 1024 * 1024, arrival: ARRIVAL })).toEqual({ kind: 'browser', name: 'Spring launch.mp4' })
    expect(saveFile).not.toHaveBeenCalled()
    // Nothing is fetched here: not the file, not a link.
    expect(calls).toEqual([])
    const opened = new URL(openInSystemBrowser.mock.calls[0]![0] as string)
    expect(opened.origin + opened.pathname).toBe('https://app.example/login')
    // Sign-in sends the person on to the video's deep link with the export, in its workspace.
    const back = opened.searchParams.get('redirect')!
    expect(back).toBe(`/account?page=studio&video=${VIDEO}&export=${JOB}&workspace=${SPACE}`)
    expect(isAccountRedirectPath(back)).toBe(true)
    expect(resolvePostAuthRedirect(back, 'https://app.example')).toBe(back)
  })

  it('opens a large stored file that is not an export at its own link in the browser', async () => {
    desktop(); server(75 * 1024 * 1024)
    openInSystemBrowser.mockResolvedValue(true)
    expect((await saveExport({ ...FILE, bytes: 75 * 1024 * 1024 })).kind).toBe('browser')
    expect(openInSystemBrowser).toHaveBeenCalledWith(`https://app.example${URL_}`)
    expect(saveFile).not.toHaveBeenCalled()
  })

  it('asks the size when the job did not say it, and says so when the file is gone', async () => {
    desktop(); server(30 * 1024 * 1024)
    openInSystemBrowser.mockResolvedValue(true)
    expect((await saveExport({ ...FILE, arrival: ARRIVAL })).kind).toBe('browser')
    expect(calls.map((c) => c.method)).toEqual(['HEAD'])
    calls = []; server(2000)
    saveFile.mockResolvedValueOnce(null)
    expect(await saveExport(FILE)).toEqual({ kind: 'cancelled' })
    expect(saveFile).toHaveBeenCalledTimes(1)
    server('gone')
    await expect(saveExport(FILE)).rejects.toThrow('exports are kept for 30 days')
  })

  it('opens nothing but a stored Studio file of this site in the browser', async () => {
    desktop(); server(75 * 1024 * 1024)
    openInSystemBrowser.mockResolvedValue(true)
    for (const url of ['https://evil.example/api/account/studio/file/w/x.mp4', '/somewhere/else.mp4', 'javascript:alert(1)'])
      await expect(saveExport({ url, fileName: 'x.mp4', bytes: 75 * 1024 * 1024 }), url).rejects.toThrow('This file cannot be opened in your browser from here.')
    expect(openInSystemBrowser).not.toHaveBeenCalled()
  })

  it('says the browser could not be opened', async () => {
    desktop(); server(75 * 1024 * 1024)
    openInSystemBrowser.mockResolvedValue(false)
    await expect(saveExport({ ...FILE, bytes: 75 * 1024 * 1024, arrival: ARRIVAL })).rejects.toThrow('Your browser could not be opened')
  })
})

describe('in a desktop app with its own save (studio_export_save_parts)', () => {
  const VIDEO = 'aaaaaaaa-1111-4222-8333-444444444444', JOB = 'bbbbbbbb-1111-4222-8333-444444444444', SPACE = 'cccccccc-1111-4222-8333-444444444444'
  const ARRIVAL = { videoId: VIDEO, jobId: JOB, workspaceId: SPACE }
  const partsRoute = `/api/account/studio/projects/${VIDEO}/exports/${JOB}/parts`
  function partsServer(answer: Response) {
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => { calls.push({ url: input, method: init?.method ?? 'GET' }); return input === partsRoute ? answer.clone() : new Response('no', { status: 500 }) }))
  }

  it('picks the place, then the app streams the parts there, whatever the size: nothing is held in the page', async () => {
    desktop()
    partsServer(Response.json({ name: 'Spring launch.mp4', bytes: 2_400_000_000, sha256: 'ab'.repeat(32), from: 0, expiresAt: '', parts: [{ index: 0, url: 'https://store.example/p0', bytes: 2_000_000_000 }, { index: 1, url: 'https://store.example/p1', bytes: 400_000_000 }] }))
    pickDestination.mockResolvedValue({ destinationId: 'd1', name: 'Spring launch.mp4' })
    saveParts.mockResolvedValue({ name: 'Spring launch.mp4' })
    expect(saveWay(2_400_000_000, true)).toBe('desktop-parts')
    expect(await saveExport({ ...FILE, bytes: 2_400_000_000, arrival: ARRIVAL }, 'desktop-parts')).toEqual({ kind: 'saved', where: 'Spring launch.mp4', destinationId: 'd1' })
    expect(pickDestination).toHaveBeenCalledWith('Spring launch.mp4')
    expect(saveParts).toHaveBeenCalledWith({ destinationId: 'd1', workspaceId: SPACE, videoId: VIDEO, jobId: JOB, parts: [{ url: 'https://store.example/p0', bytes: 2_000_000_000 }, { url: 'https://store.example/p1', bytes: 400_000_000 }], bytes: 2_400_000_000, sha256: 'ab'.repeat(32) })
    expect(calls.map((c) => c.url)).toEqual([partsRoute])
    expect(saveFile).not.toHaveBeenCalled()
    expect(openInSystemBrowser).not.toHaveBeenCalled()
  })

  it('the app asks for new links in the workspace the Studio is open in; without one it is given none of the three', async () => {
    desktop()
    partsServer(Response.json({ name: 'Spring launch.mp4', bytes: 1000, from: 0, expiresAt: '', parts: [{ index: 0, url: 'https://store.example/p0', bytes: 1000 }] }))
    pickDestination.mockResolvedValue({ destinationId: 'd1', name: 'Spring launch.mp4' })
    saveParts.mockResolvedValue({ name: 'Spring launch.mp4' })
    await saveExport({ ...FILE, arrival: ARRIVAL }, 'desktop-parts')
    expect(saveParts.mock.calls[0]![0]).toMatchObject({ workspaceId: SPACE, videoId: VIDEO, jobId: JOB })
    await saveExport({ ...FILE, arrival: { ...ARRIVAL, workspaceId: null } }, 'desktop-parts')
    const second = saveParts.mock.calls[1]![0] as Record<string, unknown>
    expect(second).not.toHaveProperty('workspaceId')
    expect(second).not.toHaveProperty('videoId')
    expect(second).not.toHaveProperty('jobId')
  })

  it('a closed panel saves nothing; an app without the command saves as before', async () => {
    desktop()
    partsServer(Response.json({ name: 'Spring launch.mp4', bytes: 1000, from: 0, expiresAt: '', parts: [{ index: 0, url: 'https://store.example/p0', bytes: 1000 }] }))
    pickDestination.mockResolvedValueOnce(null)
    expect(await saveExport({ ...FILE, bytes: 1000, arrival: ARRIVAL }, 'desktop-parts')).toEqual({ kind: 'cancelled' })
    pickDestination.mockRejectedValueOnce(new Error('Command studio_export_pick_destination not found'))
    vi.stubGlobal('fetch', vi.fn(async (input: string) => input === partsRoute
      ? Response.json({ name: 'Spring launch.mp4', bytes: 1000, from: 0, expiresAt: '', parts: [] })
      : new Response(new Uint8Array(1000), { headers: { 'content-length': '1000' } })))
    saveFile.mockResolvedValueOnce('/Users/someone/Movies/Spring launch.mp4')
    expect(await saveExport({ ...FILE, bytes: 1000, arrival: ARRIVAL }, 'desktop-parts')).toEqual({ kind: 'saved', where: '/Users/someone/Movies/Spring launch.mp4' })
  })

  it('tells the dialog the place picked (its save events name it); a cancelled save saves nothing; links that expired are asked for again, once', async () => {
    desktop()
    partsServer(Response.json({ name: 'Spring launch.mp4', bytes: 1000, from: 0, expiresAt: '', parts: [{ index: 0, url: 'https://store.example/p0', bytes: 1000 }] }))
    pickDestination.mockResolvedValue({ destinationId: 'd7', name: 'Spring launch.mp4' })
    const onPicked = vi.fn()
    saveParts.mockRejectedValueOnce(new Error('cancelled: The save was stopped.'))
    expect(await saveExport({ ...FILE, arrival: ARRIVAL }, 'desktop-parts', { onPicked })).toEqual({ kind: 'cancelled' })
    expect(onPicked).toHaveBeenCalledWith('d7')
    calls = []
    saveParts.mockRejectedValueOnce(new Error('links-expired: The links ran out.')).mockResolvedValueOnce({ name: 'Spring launch.mp4' })
    expect(await saveExport({ ...FILE, arrival: ARRIVAL }, 'desktop-parts')).toEqual({ kind: 'saved', where: 'Spring launch.mp4', destinationId: 'd7' })
    expect(calls.map((c) => c.url)).toEqual([partsRoute, partsRoute])
    // Expired twice, or any other refusal: its sentence alone, without the code.
    saveParts.mockReset().mockRejectedValue(new Error('links-expired: The links ran out.'))
    await expect(saveExport({ ...FILE, arrival: ARRIVAL }, 'desktop-parts')).rejects.toThrow(/^The links ran out\.$/)
    saveParts.mockReset().mockRejectedValue(new Error('io: The disk is full.'))
    await expect(saveExport({ ...FILE, arrival: ARRIVAL }, 'desktop-parts')).rejects.toThrow(/^The disk is full\.$/)
  })

  it('says the server’s words when there is nothing to save, and a plain sentence for a bad request', async () => {
    desktop()
    pickDestination.mockResolvedValue({ destinationId: 'd1', name: 'x.mp4' })
    partsServer(Response.json({ error: 'This export was kept on the computer it was made on: there is nothing on the server to download.', code: 'KEPT_ON_COMPUTER' }, { status: 409 }))
    await expect(saveExport({ ...FILE, arrival: ARRIVAL }, 'desktop-parts')).rejects.toThrow('kept on the computer it was made on')
    partsServer(Response.json({ error: 'from is a part number from 0 to 1.', code: 'INVALID' }, { status: 400 }))
    await expect(saveExport({ ...FILE, arrival: ARRIVAL }, 'desktop-parts')).rejects.toThrow('The video could not be saved. Try again.')
    partsServer(Response.json({ error: GONE }, { status: 404 }))
    await expect(saveExport({ ...FILE, arrival: ARRIVAL }, 'desktop-parts')).rejects.toThrow('exports are kept for 30 days')
    expect(saveParts).not.toHaveBeenCalled()
  })
})

describe('in a browser', () => {
  it('with a save picker, streams the file into the place the person chose', async () => {
    const written: Uint8Array[] = []
    const writable = new WritableStream<Uint8Array>({ write: (chunk) => { written.push(chunk) } })
    const picker = vi.fn(async () => ({ name: 'Spring launch.mp4', createWritable: async () => writable }))
    vi.stubGlobal('window', { showSaveFilePicker: picker, location: { origin: 'https://app.example' } })
    server(3)
    expect(saveWay()).toBe('picker')
    expect(await saveExport(FILE)).toEqual({ kind: 'saved', where: 'Spring launch.mp4' })
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'Spring launch.mp4', types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] }))
    expect(written.flatMap((chunk) => [...chunk])).toEqual([3, 3, 3])
  })

  it('takes the empty file the picker made away again when the export is gone', async () => {
    const remove = vi.fn(async () => undefined)
    vi.stubGlobal('window', { showSaveFilePicker: async () => ({ name: 'a.mp4', createWritable: async () => new WritableStream(), remove }), location: { origin: 'https://app.example' } })
    server('gone')
    await expect(saveExport(FILE)).rejects.toThrow('exports are kept for 30 days')
    expect(remove).toHaveBeenCalled()
    vi.stubGlobal('window', { showSaveFilePicker: async () => { throw Object.assign(new Error('closed'), { name: 'AbortError' }) }, location: { origin: 'https://app.example' } })
    expect(await saveExport(FILE)).toEqual({ kind: 'cancelled' })
  })

  it('otherwise downloads plainly, but only after checking the file is still kept', async () => {
    server(10)
    expect(saveWay()).toBe('downloads')
    expect(await saveExport(FILE)).toEqual({ kind: 'downloads', name: 'Spring launch.mp4' })
    expect(clicked).toEqual([{ href: URL_, download: 'Spring launch.mp4' }])
    server('gone')
    await expect(saveExport(FILE)).rejects.toThrow('exports are kept for 30 days')
    expect(clicked).toHaveLength(1)
  })
})
