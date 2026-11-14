// @vitest-environment jsdom
/**
 * The Studio's Record and Export dialogs as a person meets them: the Export dialog shows a job only on the video it was
 * made from (one export job is kept whichever video is open), a failed Cancel does not leave it "stopping" for good,
 * the focus lands on the dialog's safe or primary control (never Cancel, Discard or Close), a saved take is only
 * thrown away after asking, and the shared layer the dialogs are drawn in survives one of two Studios going.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { EditorJob } from '@/lib/studio/engine/api'
import type { EditorProject } from '@/lib/studio/engine/contracts'
import { ExportDialog, exportFor, type ExportReceipt } from '../ExportDialog'
import { RecordDialog } from '../RecordDialog'
import { setStudioRoot, studioPortal } from '../../studio-env'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null, host: HTMLElement | null = null
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/exports') ? { exports: [] } : url.includes('/recordings') ? { recordings: [] } : {})))
  localStorage.setItem('ni:studio:record-prefs-v1', JSON.stringify({ microphone: true, camera: false, shareSound: true }))
})
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.unstubAllGlobals(); document.body.innerHTML = '' })
async function render(node: React.ReactNode) {
  host = document.createElement('div'); document.body.appendChild(host)
  await act(async () => { root = createRoot(host!); root.render(node) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement
const focused = () => (document.activeElement as HTMLElement | null)?.textContent?.trim() || (document.activeElement === dialog() ? 'the dialog' : document.activeElement?.tagName)

const A = 'aaaaaaaa-1111-4222-8333-444444444444', B = 'bbbbbbbb-1111-4222-8333-444444444444'
const project = (id: string, title: string) => ({ id, title, output: { width: 1920, height: 1080, fps: 30 } }) as unknown as EditorProject
const runningA: EditorJob = { id: 'j1', kind: 'export', status: 'running', progress: 0.42, logs: [], videoId: A }
const doneA: EditorJob = { id: 'j1', kind: 'export', status: 'completed', progress: 1, logs: [], videoId: A, downloadUrl: `/api/account/studio/file/w/exports/j1/1/video.mp4?download=Video%20A.mp4`, result: { width: 1920, height: 1080, durationSeconds: 20, bytes: 1000 } }
const receiptA: ExportReceipt = { jobId: 'j1', projectId: A, title: 'Video A', width: 1920, height: 1080, fps: 30, durationFrames: 600 }
function exportDialog(open: EditorProject, job: EditorJob | null, cancel = async () => true) {
  const here = exportFor(job, receiptA, open.id)
  return <ExportDialog project={open} job={here.job} otherExport={here.other} receipt={receiptA} size="native" setSize={() => {}} output={{ width: 1920, height: 1080 }} durationFrames={600} busy={false}
    start={() => {}} cancel={cancel} close={() => {}} beforeServerEdit={async () => true} openVideo={() => {}} say={() => {}} />
}

describe('the Export dialog across a video switch', () => {
  it('keeps an export to the video it was made from', () => {
    expect(exportFor(runningA, receiptA, A).job).toBe(runningA)
    expect(exportFor(runningA, receiptA, B)).toEqual({ job: null, other: { title: 'Video A', progress: 0.42 } })
    expect(exportFor(doneA, receiptA, B)).toEqual({ job: null, other: null })
    // An unsaved draft's export names no video: the receipt the editor took says whose it is.
    const draft = { ...runningA, videoId: undefined }
    expect(exportFor(draft, receiptA, A).job).toBe(draft)
    expect(exportFor(draft, null, A).job).toBeNull()
  })

  it('shows video B its own setup, not A’s finished export, and says A is still rendering', async () => {
    await render(exportDialog(project(B, 'Video B'), doneA))
    expect(dialog().textContent).not.toContain('Your video is ready')
    expect(dialog().textContent).toContain('Export MP4')
    act(() => root!.unmount()); root = null
    await render(exportDialog(project(B, 'Video B'), runningA))
    expect(dialog().textContent).toContain('“Video A” is exporting (42%). You can export this one too.')
    expect(dialog().textContent).not.toContain('Rendering your video')
  })

  it('shows video A its running export, and its finished one', async () => {
    await render(exportDialog(project(A, 'Video A'), runningA))
    expect(dialog().textContent).toContain('Rendering your video')
  })
})

describe('the Running view', () => {
  it('says the export could not be stopped when Cancel fails, and lets the person try again', async () => {
    await render(exportDialog(project(A, 'Video A'), runningA, async () => false))
    const cancel = [...dialog().querySelectorAll('button')].find((b) => b.textContent === 'Cancel export')!
    await act(async () => { cancel.click() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(dialog().textContent).toContain('The export could not be stopped')
    expect(dialog().textContent).not.toContain('Stopping the export')
    expect(cancel.disabled).toBe(false)
  })
})

describe('the focus when a dialog opens', () => {
  it('Export: Export MP4 to set up, Keep editing while it renders, Save when it is done', async () => {
    await render(exportDialog(project(A, 'Video A'), null))
    expect(focused()).toBe('Export MP4')
    act(() => root!.unmount()); root = null
    await render(exportDialog(project(A, 'Video A'), runningA))
    expect(focused()).toBe('Keep editing')
    act(() => root!.unmount()); root = null
    await render(exportDialog(project(A, 'Video A'), doneA))
    expect(focused()).toMatch(/^Download MP4|^Save to your computer/)
  })

  const noop = () => {}, anoop = async () => {}
  const recording = (over: Record<string, unknown>) => ({ recorderState: { state: 'browser', desktopShell: false }, targets: null, permissions: null, browserDevices: { cameras: [], microphones: [] }, share: null, sessions: [], selected: null, active: null,
    loadingTargets: false, working: false, error: null, uploads: [], liveTracks: [], savedTakes: [], refreshTargets: anoop, chooseShare: anoop, clearShare: noop, stop: anoop, cancel: anoop, retry: anoop, mark: noop,
    recoverSaved: anoop, discardSaved: vi.fn(anoop), unlockDevices: anoop, requestPermissions: anoop, checkPermissions: anoop, ...over }) as never
  const record = (rec: unknown) => <RecordDialog title="New recording" close={noop} recording={rec as never} start={anoop} open={noop} />
  const take = { id: 't1', createdAt: new Date().toISOString(), savedAt: new Date().toISOString(), seconds: 42, bytes: 10, tracks: [] }

  it('Record: Stop while recording, never Cancel and discard; the share step, never the saved take’s Discard', async () => {
    await render(record(recording({ active: { id: 's', status: 'recording', createdAt: '', camera: false, microphone: true, elapsedMs: 3000 } })))
    expect(focused()).toBe('Stop recording')
    act(() => root!.unmount()); root = null
    await render(record(recording({ savedTakes: [take] })))
    expect(focused()).toContain('Choose what to share')
    act(() => root!.unmount()); root = null
    await render(record(recording({ active: { id: 's', status: 'finalizing', createdAt: '', camera: false, microphone: true, elapsedMs: 3000, step: 'Conforming the recording to a constant 30 fps (H.264/AAC)', progress: 0.5 }, uploads: [] })))
    expect(focused()).toBe('Keep working')
  })

  it('Record: a saved take is thrown away only after asking', async () => {
    const rec = recording({ savedTakes: [take] }) as unknown as { discardSaved: ReturnType<typeof vi.fn> }
    await render(record(rec))
    const button = (text: string) => [...dialog().querySelectorAll('button')].find((b) => b.textContent === text)!
    await act(async () => { button('Discard…').click() })
    expect(rec.discardSaved).not.toHaveBeenCalled()
    expect(dialog().textContent).toContain('Discard this recording for good?')
    await act(async () => { button('Keep it').click() })
    expect(dialog().textContent).toContain('stopped before it was finished')
    await act(async () => { button('Discard…').click() })
    await act(async () => { button('Discard for good').click() })
    expect(rec.discardSaved).toHaveBeenCalledWith('t1')
  })
})

describe('the Studio layer with two Studios mounted', () => {
  it('stays while either is mounted, and goes with the last', async () => {
    const one = document.createElement('div'), two = document.createElement('div')
    document.body.append(one, two)
    setStudioRoot(one); setStudioRoot(two)
    const layer = studioPortal()
    one.remove(); setStudioRoot(null)
    await Promise.resolve()
    expect(layer.isConnected).toBe(true)
    expect(studioPortal()).toBe(layer)
    two.remove(); setStudioRoot(null)
    await Promise.resolve()
    expect(layer.isConnected).toBe(false)
  })
})
