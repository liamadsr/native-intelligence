// @vitest-environment jsdom
/**
 * A take kept on this computer, as the Record dialog lists it (RecordDialog.tsx LocalTakeBanner): its size and what is
 * wrong in plain words, Try again, and Discard only after asking once more. Made-up take.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { LocalTakeBanner, RecordDialog } from '../RecordDialog'
import type { LocalTakeRow } from '../../record/local-takes'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | null = null, host: HTMLElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; document.body.innerHTML = '' })
async function render(node: React.ReactNode) {
  host = document.createElement('div'); document.body.appendChild(host)
  await act(async () => { root = createRoot(host!); root.render(node) })
}
const button = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === name)
const click = async (name: string) => act(async () => { button(name)!.click() })

const row: LocalTakeRow = { sessionId: '0f0f0f0f-1111-4222-8333-444444444444', bytes: 42_000_000, at: '2026-11-14T09:41:00.000Z', problem: 'This recording never reached the Studio (there was no connection while it recorded). Try again makes it a new video.', action: { kind: 'file-whole' }, edits: false }

describe('a take kept on this computer, in the Record dialog', () => {
  it('says its size and what is wrong; Try again files it', async () => {
    const retry = vi.fn(), discard = vi.fn()
    await render(<LocalTakeBanner row={row} retry={retry} discard={discard} />)
    expect(document.body.textContent).toContain('42 MB')
    expect(document.body.textContent).toContain('never reached the Studio')
    await click('Try again')
    expect(retry).toHaveBeenCalledWith(row)
    expect(discard).not.toHaveBeenCalled()
  })
  it('discards only after asking once more', async () => {
    const discard = vi.fn()
    await render(<LocalTakeBanner row={row} retry={vi.fn()} discard={discard} />)
    await click('Discard…')
    expect(document.body.textContent).toContain('cannot be undone')
    await click('Keep it')
    expect(discard).not.toHaveBeenCalled()
    await click('Discard…')
    await click('Discard for good')
    expect(discard).toHaveBeenCalledWith(row.sessionId)
  })
  it('Discard says the edits made to it are deleted too, when it has some', async () => {
    await render(<LocalTakeBanner row={{ ...row, edits: true }} retry={vi.fn()} discard={vi.fn()} />)
    await click('Discard…')
    expect(document.body.textContent).toContain('Its 42 MB on this computer and the edits made to it are deleted. This cannot be undone.')
  })
  it('in the Record dialog, a take being worked on (the hook’s localBusy) waits; the others do not; its second action says what it does', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/recordings') ? { recordings: [] } : {})))
    const noop = () => {}, anoop = async () => {}
    const other: LocalTakeRow = { ...row, sessionId: '1f1f1f1f-1111-4222-8333-444444444444', problem: 'Owed.', action: { kind: 'adopt', projectId: 'p-2' }, label: 'Put my edits on it', alt: { action: { kind: 'release', projectId: 'p-2', anyway: true }, label: 'Let go of the files' } }
    const retryLocal = vi.fn(anoop)
    const rec = { recorderState: { state: 'desktop' }, targets: null, permissions: null, browserDevices: null, share: null, sessions: [], selected: null, active: null,
      loadingTargets: false, working: false, error: null, uploads: [], liveTracks: [], savedTakes: [], localTakes: [row, other], localBusy: [row.sessionId], retryLocal, discardLocal: vi.fn(anoop),
      refreshTargets: anoop, chooseShare: anoop, clearShare: noop, stop: anoop, cancel: anoop, retry: anoop, mark: noop, recoverSaved: anoop, discardSaved: anoop, unlockDevices: anoop, requestPermissions: anoop, checkPermissions: anoop }
    await render(<RecordDialog title="New recording" close={noop} recording={rec as never} start={anoop} open={noop} />)
    const groups = [...document.querySelectorAll('[aria-label="A recording kept on this computer"]')] as HTMLElement[]
    const inGroup = (g: HTMLElement, name: string) => [...g.querySelectorAll('button')].find((b) => b.textContent === name)!
    expect(inGroup(groups[0]!, 'Try again').disabled).toBe(true)
    expect(inGroup(groups[0]!, 'Discard…').disabled).toBe(true)
    expect(inGroup(groups[1]!, 'Put my edits on it').disabled).toBe(false)
    // Letting go deletes the files (and maybe the only copy of the edits): asked once more first.
    await act(async () => { inGroup(groups[1]!, 'Let go of the files…').click() })
    expect(retryLocal).not.toHaveBeenCalled()
    expect(groups[1]!.textContent).toContain('Let go of this recording for good?')
    expect(groups[1]!.textContent).toContain('once the Studio holds every byte of it. Until then they are kept. This cannot be undone.')
    await act(async () => { inGroup(groups[1]!, 'Keep it').click() })
    expect(retryLocal).not.toHaveBeenCalled()
    await act(async () => { inGroup(groups[1]!, 'Let go of the files…').click() })
    await act(async () => { inGroup(groups[1]!, 'Let go for good').click() })
    expect(retryLocal).toHaveBeenCalledWith(other, true)
    await act(async () => { inGroup(groups[1]!, 'Put my edits on it').click() })
    expect(retryLocal).toHaveBeenLastCalledWith(other, undefined)
    vi.unstubAllGlobals()
  })
  it('a take nothing can be made of offers Discard only', async () => {
    await render(<LocalTakeBanner row={{ ...row, action: { kind: 'none' } }} retry={vi.fn()} discard={vi.fn()} />)
    expect(button('Try again')).toBeUndefined()
    expect(button('Discard…')).toBeDefined()
  })
})
