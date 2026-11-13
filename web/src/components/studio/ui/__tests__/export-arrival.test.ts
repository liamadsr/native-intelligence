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
import { ARRIVAL_WORDS, arriveAtExport, clearExportArrival, exportArrivalLink, readExportArrival } from '../export-arrival'

const VIDEO = 'aaaaaaaa-1111-4222-8333-444444444444', OTHER = 'dddddddd-1111-4222-8333-444444444444', JOB = 'bbbbbbbb-1111-4222-8333-444444444444'
const done: EditorJob = { id: JOB, kind: 'export', status: 'completed', progress: 1, logs: [], videoId: VIDEO, downloadUrl: `/api/account/studio/file/w/exports/${JOB}/1/video.mp4?download=Spring%20launch.mp4` }
afterEach(() => { sessionStorage.clear(); window.history.replaceState(null, '', '/') })

describe('the arrival link and parameter', () => {
  it('reads only an id, and leaves the address without it once handled', () => {
    expect(readExportArrival(`?export=${JOB}`)).toBe(JOB)
    expect(readExportArrival('?export=../../etc')).toBeNull()
    window.history.replaceState(null, '', `/account?keep=1&export=${JOB}#x`)
    clearExportArrival()
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/account?keep=1#x')
  })

  it('goes through sign-in to the video deep link with the export', () => {
    const link = new URL(exportArrivalLink('https://app.example', { videoId: VIDEO, jobId: JOB, workspaceId: null }))
    expect(link.pathname).toBe('/login')
    expect(link.searchParams.get('redirect')).toBe(`/account?page=studio&video=${VIDEO}&export=${JOB}`)
  })
})

describe('arriving', () => {
  const deps = (over: Partial<Parameters<typeof arriveAtExport>[2]> = {}) => ({ getJob: vi.fn(async () => done), download: vi.fn(async () => undefined), ...over })

  it('downloads once, and only once from the same tab', async () => {
    const first = deps()
    expect(await arriveAtExport(JOB, VIDEO, first)).toEqual({ kind: 'started', job: done })
    expect(first.download).toHaveBeenCalledTimes(1)
    const again = deps()
    expect(await arriveAtExport(JOB, VIDEO, again)).toEqual({ kind: 'again', job: done })
    expect(again.download).not.toHaveBeenCalled()
    expect(ARRIVAL_WORDS.started).toBe('Your download has started. It goes to this browser’s downloads folder.')
  })

  it('opens the video the export was made from when another is open', async () => {
    const other = deps()
    expect(await arriveAtExport(JOB, OTHER, other)).toEqual({ kind: 'open-video', videoId: VIDEO })
    expect(other.download).not.toHaveBeenCalled()
  })

  it('says so when the export is not in this workspace, gone, or never finished', async () => {
    expect(await arriveAtExport(JOB, VIDEO, deps({ getJob: async () => { throw new Error('Job not found') } }))).toEqual({ kind: 'not-found', text: ARRIVAL_WORDS.notFound })
    const gone = 'This export is no longer kept: exports are kept for 30 days. Export the video again.'
    expect(await arriveAtExport(JOB, VIDEO, deps({ download: async () => { throw new Error(gone) } }))).toMatchObject({ kind: 'gone', text: gone })
    expect(await arriveAtExport(JOB, VIDEO, deps({ getJob: async () => ({ ...done, downloadUrl: undefined }), before: () => false }))).toMatchObject({ kind: 'gone', text: ARRIVAL_WORDS.gone })
    expect(await arriveAtExport(JOB, VIDEO, deps({ getJob: async () => ({ ...done, status: 'failed' as const }) }))).toMatchObject({ kind: 'gone', text: ARRIVAL_WORDS.unfinished })
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
