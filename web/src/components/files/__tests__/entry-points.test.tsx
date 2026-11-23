// @vitest-environment jsdom
/**
 * The places a file opens from hand the viewer the file as the caller reads
 * it (docs/plans/drive-files.md, phase 1): a mail attachment through its own
 * attachment route (the bytes it would download), a team chat file through
 * its channel's signed link, signed again when it has run out. Made-up names.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { ViewerFile } from '@/lib/files/viewer-file'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  opened: [] as ViewerFile[],
  download: vi.fn(async () => 'saved'),
  cached: new Map<string, string>(),
  sign: vi.fn(async (path: string) => `https://files.test/fresh/${path}`),
}))
vi.mock('@/components/files/file-viewer', () => ({
  useFileViewer: () => ({ open: (f: ViewerFile) => hoisted.opened.push(f), viewer: null }),
}))
vi.mock('@/lib/download', () => ({ downloadFile: hoisted.download }))
vi.mock('@/lib/team-chat/upload-client', () => ({
  cachedTeamChatFileUrl: (path: string) => hoisted.cached.get(path) ?? null,
  teamChatFileUrl: hoisted.sign,
}))

import { EmailAttachments, emailViewerFile } from '@/components/email/email-attachments'
import { MessageAttachments, teamChatViewerFile } from '@/app/account/(dashboard)/views/team-chat-message-parts'

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  hoisted.opened.length = 0
  hoisted.cached.clear()
  hoisted.download.mockClear()
  hoisted.sign.mockClear()
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.unstubAllGlobals()
})

describe('a mail attachment', () => {
  it('opens in the viewer from its chip, read through the attachment route it downloads from', async () => {
    const href = '/api/account/email/threads/t1/attachment?message=m1&name=plan.pdf'
    act(() => root.render(h(EmailAttachments, { attachments: [{ name: 'plan.pdf', size: 2048, mimeType: 'application/pdf' }], hrefFor: () => href })))
    act(() => el.querySelector<HTMLButtonElement>('[data-email-attachment-open]')!.click())
    expect(hoisted.opened).toHaveLength(1)
    const file = hoisted.opened[0]
    expect(file).toMatchObject({ name: 'plan.pdf', mimeType: 'application/pdf', size: 2048, sourceLabel: 'Email attachment' })
    expect(file.url).toBeUndefined()
    const fetchMock = vi.fn(async () => new Response(new Blob(['%PDF']), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await file.load!()
    expect(fetchMock).toHaveBeenCalledWith(href, { credentials: 'same-origin' })
    await file.download!()
    expect(hoisted.download).toHaveBeenCalledWith(href, 'plan.pdf')
  })

  it('a chip with nowhere to read from (a draft) is listed only', () => {
    act(() => root.render(h(EmailAttachments, { attachments: [{ name: 'draft.pdf', size: 1, mimeType: 'application/pdf' }], hrefFor: () => null })))
    expect(el.querySelector('[data-email-attachment-open]')).toBeNull()
  })

  it('says why when the route refuses', async () => {
    const file = emailViewerFile({ name: 'big.mov', size: 1, mimeType: 'video/quicktime' }, '/x')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Attachment too large' }), { status: 413 })))
    await expect(file.load!()).rejects.toThrow('Attachment too large')
  })
})

describe('a team chat file', () => {
  const doc = { path: 'ch-1/u-1/a.pdf', name: 'notes.pdf', size: 900, type: 'application/pdf' }

  it('opens in the viewer through the channel’s signed link, signed again when it has run out', async () => {
    act(() => root.render(h(MessageAttachments, { attachments: [doc] })))
    await act(async () => el.querySelector<HTMLAnchorElement>('[data-team-chat-file]')!.click())
    expect(hoisted.sign).toHaveBeenCalledWith('ch-1/u-1/a.pdf')
    expect(hoisted.opened[0]).toMatchObject({ name: 'notes.pdf', url: 'https://files.test/fresh/ch-1/u-1/a.pdf', sourceLabel: 'Team chat' })
  })

  it('uses the cached link when it is still good', async () => {
    hoisted.cached.set(doc.path, 'https://files.test/cached')
    const file = teamChatViewerFile(doc, 'https://files.test/cached')
    await file.download!()
    expect(hoisted.sign).not.toHaveBeenCalled()
    expect(hoisted.download).toHaveBeenCalledWith('https://files.test/cached', 'notes.pdf')
  })
})
