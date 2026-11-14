// @vitest-environment jsdom
/**
 * The Export dialog in the desktop app with the computer export (../ExportDialog.tsx, ../ExportLocal.tsx), the app
 * stubbed: where it will run and save, the first-time download, an export that waits for this computer, and where it
 * was saved. And the same dialog with an app that has none of it: as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { EditorJob } from '@/lib/studio/engine/api'
import type { EditorProject } from '@/lib/studio/engine/contracts'
import { STUDIO_RENDER_VERSION } from '@/lib/studio/engine/render-version'

const app = vi.hoisted(() => ({ status: vi.fn(), prepare: vi.fn(), onPrepare: vi.fn(), start: vi.fn(), cancel: vi.fn(), events: vi.fn(), onProgress: vi.fn(), pickDestination: vi.fn(), saveParts: vi.fn(), reveal: vi.fn(), onSave: vi.fn(), saveCancel: vi.fn() }))
vi.mock('@/lib/tauri-bridge', async (actual) => ({ studioRefusal: (await actual<typeof import('@/lib/tauri-bridge')>()).studioRefusal, studioLocalExport: app, tauriBridge: {} }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => true }))
const { ExportDialog } = await import('../ExportDialog')
const { forgetLocalCapability } = await import('../ExportLocal')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const ready = { available: true, platform: 'macos', arch: 'arm64', components: { runtime: 'ready', chrome: 'ready', ffmpeg: 'ready' }, downloadBytes: 0, renderVersion: STUDIO_RENDER_VERSION }
const JOB = 'bbbbbbbb-1111-4222-8333-444444444444', VIDEO = 'aaaaaaaa-1111-4222-8333-444444444444'
const project = { id: VIDEO, title: 'Spring launch', layers: [], output: { width: 1920, height: 1080, fps: 30 } } as unknown as EditorProject

let root: Root | null = null, host: HTMLElement | null = null
beforeEach(() => {
  forgetLocalCapability()
  for (const fn of Object.values(app)) fn.mockReset()
  app.onPrepare.mockReturnValue(() => {}); app.onProgress.mockReturnValue(() => {}); app.events.mockResolvedValue([]); app.reveal.mockResolvedValue(undefined); app.onSave.mockReturnValue(() => {})
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ exports: [], presets: [] })))
})
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.unstubAllGlobals(); localStorage.clear(); document.body.innerHTML = '' })
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0)) })
async function render(job: EditorJob | null, start = vi.fn(), extra: Record<string, unknown> = {}) {
  host = document.createElement('div'); document.body.appendChild(host)
  await act(async () => { root = createRoot(host!); root.render(<ExportDialog project={project} job={job} receipt={null} size="native" setSize={() => {}} output={{ width: 1920, height: 1080 }} durationFrames={600} busy={false}
    start={start} cancel={async () => true} close={() => {}} beforeServerEdit={async () => true} openVideo={() => {}} say={() => {}} {...extra} />) })
  await settle()
  return start
}
const text = () => document.querySelector('[role="dialog"]')!.textContent ?? ''
const button = (label: string) => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.includes(label)) as HTMLButtonElement

describe('before Export', () => {
  it('says it exports on this computer, asks where to save, then starts it there', async () => {
    app.status.mockResolvedValue(ready)
    app.pickDestination.mockResolvedValue({ destinationId: 'd1', name: 'Spring launch.mp4' })
    const start = await render(null)
    expect(text()).toContain('Exports on this computer. You choose where to save it.')
    expect(text()).not.toContain('When it is ready')
    await act(async () => { button('Export MP4').click() })
    await settle()
    expect(app.pickDestination).toHaveBeenCalledWith('Spring launch.mp4')
    expect(start).toHaveBeenCalledWith({ where: 'computer', destination: { destinationId: 'd1', name: 'Spring launch.mp4' } })
  })

  it('a second export in the same dialog asks where to save again: the app takes a place once', async () => {
    app.status.mockResolvedValue(ready)
    app.pickDestination.mockResolvedValueOnce({ destinationId: 'd1', name: 'Spring launch.mp4' }).mockResolvedValueOnce({ destinationId: 'd2', name: 'Spring launch 2.mp4' })
    const start = await render(null)
    await act(async () => { button('Export MP4').click() })
    await settle()
    expect(text()).toContain('You choose where to save it.')
    await act(async () => { button('Export MP4').click() })
    await settle()
    expect(app.pickDestination).toHaveBeenCalledTimes(2)
    expect(start).toHaveBeenLastCalledWith({ where: 'computer', destination: { destinationId: 'd2', name: 'Spring launch 2.mp4' } })
  })

  it('the app’s refusals show their sentence only, never the code', async () => {
    app.status.mockResolvedValue(ready)
    app.pickDestination.mockRejectedValue(new Error('busy: The app is saving another file. Try again in a moment.'))
    const start = await render(null)
    await act(async () => { button('Choose…').click() })
    await settle()
    expect(text()).toContain('The app is saving another file. Try again in a moment.')
    expect(text()).not.toContain('busy:')
    expect(start).not.toHaveBeenCalled()
  })

  it('an app without the computer export says why, and exports on our server as before', async () => {
    app.status.mockRejectedValue(new Error('Command studio_local_status not found'))
    const start = await render(null)
    expect(text()).toContain('older than the Studio, so this video exports on our server')
    await act(async () => { button('Export MP4').click() })
    expect(start).toHaveBeenCalledWith()
    expect(app.pickDestination).not.toHaveBeenCalled()
  })

  it('first use: asks once with the size, downloads with progress, then exports here; or exports on our server instead', async () => {
    app.status.mockResolvedValueOnce({ ...ready, components: { runtime: 'missing', chrome: 'missing', ffmpeg: 'ready' }, downloadBytes: 412_000_000 }).mockResolvedValue(ready)
    app.pickDestination.mockResolvedValue({ destinationId: 'd1', name: 'Spring launch.mp4' })
    let progress: ((event: { component: string; receivedBytes: number; totalBytes: number }) => void) | null = null
    app.onPrepare.mockImplementation((cb) => { progress = cb; return () => {} })
    let finish: () => void = () => {}
    app.prepare.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    const start = await render(null)
    expect(text()).toContain('one-time download of 412 MB')
    expect(button('Export on our server instead')).toBeTruthy()
    await act(async () => { button('Download 412 MB and export').click() })
    await settle()
    await act(async () => { progress!({ component: 'chrome', receivedBytes: 103_000_000, totalBytes: 412_000_000 }) })
    expect(text()).toContain('103 MB of 412 MB')
    expect(start).not.toHaveBeenCalled()
    await act(async () => { finish() })
    await settle()
    expect(start).toHaveBeenCalledWith({ where: 'computer', destination: { destinationId: 'd1', name: 'Spring launch.mp4' } })
  })
})

describe('while it runs and after', () => {
  const running: EditorJob = { id: JOB, kind: 'export', where: 'computer', status: 'running', progress: 0.3, logs: [], videoId: VIDEO }

  it('waiting for this computer offers to continue here or finish on the server', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval'] })
    try {
      app.status.mockResolvedValue(ready)
      // Started on this computer: it knows where the file goes.
      localStorage.setItem('ni:studio:local-export-destinations', JSON.stringify({ [JOB]: { destinationId: 'd1', name: 'Spring launch.mp4' } }))
      const continueHere = vi.fn(async () => null), moveToServer = vi.fn(async () => 'Our server could not take it just now. Try again.')
      await render(running, vi.fn(), { continueHere, moveToServer })
      expect(text()).toContain('Exporting on this computer')
      await act(async () => { vi.advanceTimersByTime(35_000) })
      expect(text()).toContain('The export is waiting for this computer')
      await act(async () => { button('Finish on the server').click() })
      await settle()
      expect(moveToServer).toHaveBeenCalledWith(JOB)
      expect(text()).toContain('could not take it just now')
      await act(async () => { button('Continue on this computer').click() })
      await settle()
      expect(continueHere).toHaveBeenCalledWith(JOB, 'Spring launch.mp4')
    } finally { vi.useRealTimers() }
  })

  it('on another computer: its own words, no stall, Cancel, Finish on the server and Keep editing', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval'] })
    try {
      app.status.mockResolvedValue(ready)
      const moveToServer = vi.fn(async () => null)
      await render({ ...running, progress: 0.42 }, vi.fn(), { moveToServer })
      expect(text()).toContain('Exporting on another computer')
      expect(text()).toContain('42%')
      expect(text()).toContain('It runs in the Native Intelligence app on the computer that started it, and is saved there.')
      expect(text()).not.toContain('this computer')
      expect(document.activeElement?.textContent).toBe('Keep editing')
      await act(async () => { vi.advanceTimersByTime(10 * 60_000) })
      expect(text()).not.toContain('waiting for this computer')
      expect(button('Cancel export')).toBeTruthy()
      await act(async () => { button('Finish on the server').click() })
      await settle()
      expect(moveToServer).toHaveBeenCalledWith(JOB)
    } finally { vi.useRealTimers() }
  })

  it('lists kept-only exports: the file name and Show in Finder only where this device saved it', async () => {
    app.status.mockResolvedValue(ready)
    localStorage.setItem('ni:studio:local-export-destinations', JSON.stringify({ k1: { destinationId: 'd9', name: 'Spring launch (cut 2).mp4' } }))
    const row = (id: string, over: Partial<EditorJob>) => ({ id, kind: 'export', status: 'completed', progress: 1, logs: [], videoId: VIDEO, title: 'Spring launch', finishedAt: new Date().toISOString(), result: { width: 1920, height: 1080, durationSeconds: 20, bytes: 41_900_000 }, ...over })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/exports') ? { exports: [
      row('s1', { where: 'server', downloadUrl: '/api/account/studio/file/w/exports/s1/1/video.mp4?download=Spring%20launch.mp4' }),
      row('k1', { where: 'computer', kept: 'computer' }),
      row('k2', { where: 'computer', kept: 'computer' }),
    ] } : { presets: [] })))
    await render(null)
    const rows = [...document.querySelectorAll('.xd-finished li')]
    expect(rows).toHaveLength(3)
    // The server is where exports are made unless said otherwise: only a computer's export says where.
    expect(rows[0]!.textContent).not.toContain('Made on')
    expect(rows[0]!.textContent).toContain('Save…')
    expect(rows[1]!.textContent).toContain('Saved here as Spring launch (cut 2).mp4')
    expect(rows[1]!.textContent).toContain('Show in Finder')
    expect(rows[2]!.textContent).toContain('Kept on the computer it was made on')
    expect(rows[2]!.querySelector('button')).toBeNull()
    await act(async () => { (rows[1]!.querySelector('button') as HTMLButtonElement).click() })
    expect(app.reveal).toHaveBeenCalledWith('d9')
  })

  it('done: where it was saved, Show in Finder, and also in the Studio; or kept here only', async () => {
    app.status.mockResolvedValue(ready)
    localStorage.setItem('ni:studio:local-export-destinations', JSON.stringify({ [JOB]: { destinationId: 'd1', name: 'Spring launch.mp4' } }))
    await render({ ...running, status: 'completed', progress: 1, downloadUrl: '/api/account/studio/file/w/exports/x/1/video.mp4', result: { bytes: 1000 } })
    expect(text()).toContain('Saved to Spring launch.mp4')
    expect(text()).toContain('Also in the Studio, kept for 30 days')
    await act(async () => { button('Show in Finder').click() })
    expect(app.reveal).toHaveBeenCalledWith('d1')
    act(() => root!.unmount()); root = null
    await render({ ...running, status: 'completed', progress: 1, kept: 'computer' })
    expect(text()).toContain('Kept on this computer only')
  })

  it('saved here but the upload failed: saved, kept on this computer only, the app’s sentence in small text; never failed', async () => {
    app.status.mockResolvedValue(ready)
    localStorage.setItem('ni:studio:local-export-destinations', JSON.stringify({ [JOB]: { destinationId: 'd1', name: 'Spring launch.mp4' } }))
    app.events.mockResolvedValue([
      { jobId: JOB, seq: 1, kind: 'started' }, { jobId: JOB, seq: 2, kind: 'done', savedName: 'Spring launch.mp4' },
      { jobId: JOB, seq: 3, kind: 'upload-failed', message: 'The upload stopped: the network went away.' },
    ])
    for (const job of [running, { ...running, status: 'failed' as const, error: 'The upload did not arrive.' }]) {
      await render(job)
      expect(text()).toContain('Saved to Spring launch.mp4')
      expect(text()).toContain('Kept on this computer only.')
      expect(document.querySelector('.xd-local-note')?.textContent).toBe('The upload stopped: the network went away.')
      expect(text()).not.toContain('did not finish')
      expect(button('Show in Finder')).toBeTruthy()
      act(() => root!.unmount()); root = null
    }
  })

  it('a kept-only file the app no longer knows: said once in the row, no error banner', async () => {
    app.status.mockResolvedValue(ready)
    app.reveal.mockRejectedValue(new Error('unknown-destination: No such place.'))
    localStorage.setItem('ni:studio:local-export-destinations', JSON.stringify({ k1: { destinationId: 'd9', name: 'Spring launch.mp4' } }))
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/exports') ? { exports: [
      { id: 'k1', kind: 'export', status: 'completed', progress: 1, logs: [], videoId: VIDEO, title: 'Spring launch', finishedAt: new Date().toISOString(), where: 'computer', kept: 'computer' },
    ] } : { presets: [] })))
    await render(null)
    await act(async () => { button('Show in Finder').click() })
    await settle()
    const row = document.querySelector('.xd-finished li')!
    expect(row.textContent).toContain('The app no longer knows where this file is.')
    expect(row.querySelector('button')).toBeNull()
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('saving a server export through the app: bytes of total with a thin bar, and Cancel leaves the row as it was', async () => {
    app.status.mockResolvedValue(ready)
    const parts = { name: 'Spring launch.mp4', bytes: 412_000_000, from: 0, expiresAt: '', parts: [{ index: 0, url: 'https://store.example/p0', bytes: 412_000_000 }] }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/parts') ? parts : url.includes('/exports') ? { exports: [] } : { presets: [] })))
    let emit: ((event: { destinationId: string; receivedBytes: number; totalBytes: number }) => void) | null = null
    app.onSave.mockImplementation((cb) => { emit = cb; return () => { emit = null } })
    app.pickDestination.mockResolvedValue({ destinationId: 'd5', name: 'Spring launch.mp4' })
    let refuse: (error: Error) => void = () => {}
    app.saveParts.mockImplementation(() => new Promise((_, reject) => { refuse = reject }))
    app.saveCancel.mockImplementation(async () => { refuse(new Error('cancelled: The save was stopped.')) })
    await render({ ...running, where: 'server', status: 'completed', progress: 1, downloadUrl: '/api/account/studio/file/w/exports/x/1/video.mp4', result: { bytes: 412_000_000 } })
    await act(async () => { button('Save to your computer…').click() })
    await settle()
    expect(app.saveParts).toHaveBeenCalledWith(expect.objectContaining({ destinationId: 'd5', videoId: VIDEO, jobId: JOB }))
    await act(async () => { emit!({ destinationId: 'other', receivedBytes: 1, totalBytes: 2 }) })
    expect(document.querySelector('.xd-save-progress')).toBeNull()
    await act(async () => { emit!({ destinationId: 'd5', receivedBytes: 103_000_000, totalBytes: 412_000_000 }) })
    expect(document.querySelector('.xd-save-progress')!.textContent).toContain('103 MB of 412 MB')
    expect(document.querySelector('.xd-save-progress [role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('25')
    await act(async () => { button('Cancel').click() })
    await settle()
    expect(app.saveCancel).toHaveBeenCalledWith('d5')
    expect(document.querySelector('.xd-save-progress')).toBeNull()
    expect(button('Save to your computer…').disabled).toBe(false)
    expect(text()).not.toContain('Saved to')
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('failed on this computer: its sentence, and export on our server instead', async () => {
    app.status.mockResolvedValue(ready)
    const start = await render({ ...running, status: 'failed', error: 'The video engine stopped: out of memory.' })
    expect(text()).toContain('The video engine stopped: out of memory.')
    await act(async () => { button('Export on our server instead').click() })
    expect(start).toHaveBeenCalledWith()
  })
})
