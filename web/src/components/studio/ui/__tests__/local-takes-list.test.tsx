// @vitest-environment jsdom
/**
 * A take kept on this computer, as the Record dialog lists it (RecordDialog.tsx LocalTakeBanner): its size and what is
 * wrong in plain words, Try again, and Discard only after asking once more. Made-up take.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { LocalTakeBanner } from '../RecordDialog'
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

const row: LocalTakeRow = { sessionId: '0f0f0f0f-1111-4222-8333-444444444444', bytes: 42_000_000, at: '2026-11-14T09:41:00.000Z', problem: 'This recording never reached the Studio (there was no connection while it recorded). Try again makes it a new video.', action: { kind: 'file-whole' } }

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
  it('a take nothing can be made of offers Discard only', async () => {
    await render(<LocalTakeBanner row={{ ...row, action: { kind: 'none' } }} retry={vi.fn()} discard={vi.fn()} />)
    expect(button('Try again')).toBeUndefined()
    expect(button('Discard…')).toBeDefined()
  })
})
