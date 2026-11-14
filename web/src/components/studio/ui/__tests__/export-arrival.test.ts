// @vitest-environment jsdom
/**
 * Arriving in the browser to download a large export the desktop app could not save (../export-arrival.ts): the video
 * it was made from is opened, the download starts once (never again from the same arrival), the parameter leaves the
 * address, and a gone export or one of another workspace says so. And the public download link this replaced is gone
 * from the code.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditorJob } from '@/lib/studio/engine/api'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ARRIVAL_TTL_MS, ARRIVAL_WORDS, arriveAtExport, arrivedBefore, exportArrivalLink, markArrived, stashExportArrival, takeExportArrival, takeExportFromAddress, useExportArrival, type ArrivalShown } from '../export-arrival'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const VIDEO = 'aaaaaaaa-1111-4222-8333-444444444444', OTHER = 'dddddddd-1111-4222-8333-444444444444', JOB = 'bbbbbbbb-1111-4222-8333-444444444444'
const done: EditorJob = { id: JOB, kind: 'export', status: 'completed', progress: 1, logs: [], videoId: VIDEO, downloadUrl: `/api/account/studio/file/w/exports/${JOB}/1/video.mp4?download=Spring%20launch.mp4` }
afterEach(() => { sessionStorage.clear(); localStorage.clear() })

describe('the arrival link and the address', () => {
  it('puts export= inside the redirect, as part of the video deep link', () => {
    const link = new URL(exportArrivalLink('https://app.example', { videoId: VIDEO, jobId: JOB, workspaceId: null }))
    expect(link.pathname).toBe('/login')
    expect([...link.searchParams.keys()]).toEqual(['redirect'])
    expect(link.searchParams.get('redirect')).toBe(`/account?page=studio&video=${VIDEO}&export=${JOB}`)
  })

  it('keeps export= for the Studio only beside page=studio&video=, and takes it off the address always', () => {
    const alone = new URLSearchParams(`export=${JOB}&keep=1`)
    expect(takeExportFromAddress(alone)).toBe(true)
    expect(alone.toString()).toBe('keep=1')
    expect(takeExportArrival()).toBeNull()
    const made = new URLSearchParams(`export=../x&page=studio&video=${VIDEO}`)
    expect(takeExportFromAddress(made)).toBe(true)
    expect(takeExportArrival()).toBeNull()
    const right = new URLSearchParams(`page=studio&video=${VIDEO}&export=${JOB}`)
    expect(takeExportFromAddress(right)).toBe(true)
    expect(right.toString()).toBe(`page=studio&video=${VIDEO}`)
    expect(takeExportArrival()).toMatchObject({ videoId: VIDEO, jobId: JOB })
    // Read once.
    expect(takeExportArrival()).toBeNull()
    expect(takeExportFromAddress(new URLSearchParams('page=studio'))).toBe(false)
  })

  it('drops an arrival the Studio did not take in time', () => {
    stashExportArrival({ videoId: VIDEO, jobId: JOB }, 1000)
    expect(takeExportArrival(1000 + ARRIVAL_TTL_MS + 1)).toBeNull()
  })

  it('remembers a downloaded job across tabs for a while, then forgets it', () => {
    markArrived(JOB, 5000)
    expect(arrivedBefore(JOB, 5000 + 1000)).toBe(true)
    expect(arrivedBefore(JOB, 5000 + ARRIVAL_TTL_MS + 1)).toBe(false)
  })
})

describe('arriving', () => {
  const deps = (over: Partial<Parameters<typeof arriveAtExport>[2]> = {}) => ({ getJob: vi.fn(async () => done), download: vi.fn(async () => undefined), ...over })

  it('downloads once, and not again from this or another tab', async () => {
    const first = deps()
    expect(await arriveAtExport(JOB, VIDEO, first)).toEqual({ kind: 'started', job: done })
    expect(first.download).toHaveBeenCalledTimes(1)
    const again = deps()
    expect(await arriveAtExport(JOB, VIDEO, again)).toEqual({ kind: 'again', job: done })
    expect(again.download).not.toHaveBeenCalled()
  })

  it('says so when the export is not in this workspace, gone, or never finished', async () => {
    expect(await arriveAtExport(JOB, VIDEO, deps({ getJob: async () => { throw new Error('Job not found') } }))).toEqual({ kind: 'not-found', text: ARRIVAL_WORDS.notFound })
    const gone = 'This export is no longer kept: exports are kept for 30 days. Export the video again.'
    expect(await arriveAtExport(JOB, VIDEO, deps({ download: async () => { throw new Error(gone) } }))).toMatchObject({ kind: 'gone', text: gone })
    expect(await arriveAtExport(JOB, VIDEO, deps({ getJob: async () => ({ ...done, downloadUrl: undefined }), before: () => false }))).toMatchObject({ kind: 'gone', text: ARRIVAL_WORDS.gone })
    expect(await arriveAtExport(JOB, VIDEO, deps({ getJob: async () => ({ ...done, status: 'failed' as const }), before: () => false }))).toMatchObject({ kind: 'gone', text: ARRIVAL_WORDS.unfinished })
  })
})

describe('the Studio’s wiring (useExportArrival, as App.tsx calls it)', () => {
  let root: Root | null = null, host: HTMLElement | null = null
  afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null })
  type Deps = Parameters<typeof useExportArrival>[1]
  function Studio({ projectId, deps }: { projectId: string | null; deps: Deps }) { useExportArrival(projectId, deps); return null }
  const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
  async function show(projectId: string | null, deps: Deps) {
    if (!root) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) }
    await act(async () => { root!.render(createElement(Studio, { projectId, deps })) })
    await settle()
  }
  const wiring = (over: Partial<Deps> = {}) => ({ getJob: vi.fn(async () => done), download: vi.fn(async () => undefined), openVideo: vi.fn(async () => true), show: vi.fn((_: ArrivalShown) => {}), ...over })

  it('downloads the export of the video it opened on, once, and shows it', async () => {
    stashExportArrival({ videoId: VIDEO, jobId: JOB })
    const d = wiring()
    await show(VIDEO, d)
    expect(d.download).toHaveBeenCalledTimes(1)
    expect(d.show).toHaveBeenCalledWith({ kind: 'started', job: done })
    // Another video opened later: nothing waits to act.
    await show(OTHER, d)
    await show(VIDEO, d)
    expect(d.download).toHaveBeenCalledTimes(1)
    expect(d.openVideo).not.toHaveBeenCalled()
  })

  it('opens the right video first, and arrives there', async () => {
    stashExportArrival({ videoId: VIDEO, jobId: JOB })
    const d = wiring()
    await show(OTHER, d)
    expect(d.openVideo).toHaveBeenCalledWith(VIDEO)
    expect(d.download).not.toHaveBeenCalled()
    await show(VIDEO, d)
    expect(d.download).toHaveBeenCalledTimes(1)
  })

  it('ends the arrival when its video cannot be opened: no pulling back on later switches', async () => {
    stashExportArrival({ videoId: VIDEO, jobId: JOB })
    const d = wiring({ openVideo: vi.fn(async () => false) })
    await show(OTHER, d)
    expect(d.show).toHaveBeenCalledWith({ kind: 'not-found', text: ARRIVAL_WORDS.noVideo })
    expect(arrivedBefore(JOB)).toBe(true)
    await show(VIDEO, d)
    await show(OTHER, d)
    expect(d.openVideo).toHaveBeenCalledTimes(1)
    expect(d.download).not.toHaveBeenCalled()
  })

  it('does nothing for an address that had export= without the Studio deep link', async () => {
    takeExportFromAddress(new URLSearchParams(`export=${JOB}`))
    const d = wiring()
    await show(VIDEO, d)
    expect(d.getJob).not.toHaveBeenCalled()
    expect(d.show).not.toHaveBeenCalled()
  })
})

describe('the public download link it replaced', () => {
  it('is referenced nowhere in the app', () => {
    const root = join(__dirname, '../../../..')
    const hits: string[] = []
    const walk = (dir: string) => { for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) { if (name !== 'node_modules') walk(path); continue }
      if (!/\.(ts|tsx)$/.test(name) || path === __filename) continue
      const text = readFileSync(path, 'utf8')
      for (const gone of ['api/studio/download', 'file-links', 'download-links', 'mintFileLink', 'DOWNLOAD_LINKS']) if (text.includes(gone)) hits.push(`${path.slice(root.length)}: ${gone}`)
    } }
    walk(root)
    expect(hits).toEqual([])
  })
})
