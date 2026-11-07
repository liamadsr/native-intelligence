// @vitest-environment jsdom
/**
 * A photo in a chat message (../chat-file-part.tsx): its upload's link dies an
 * hour after it was sent, so a chat reopened later showed a broken image. An
 * expired link is swapped for a fresh one (a placeholder chip meanwhile); a
 * good one, or any other link, is shown as is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatFilePart } from '../chat-file-part'
import { resetFreshUploadUrlsForTests } from '@/lib/chat/fresh-upload-url'

const opened = vi.hoisted(() => ({
  external: vi.fn(async (_url: string, _opts?: { background?: boolean }) => {}),
  system: vi.fn(async (_url: string) => {}),
}))
vi.mock('@/lib/open-external', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/open-external')>()),
  openExternalUrl: opened.external,
  openInSystemBrowser: opened.system,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const USER = '11111111-1111-4111-8111-111111111111'
const PATH = `${USER}/chat-uploads/a.png`

function signedLink(path: string, expMs: number, sig = 'sig'): string {
  const payload = btoa(JSON.stringify({ url: `attachments/${path}`, exp: Math.floor(expMs / 1000) }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `https://ref.supabase.co/storage/v1/object/sign/attachments/${path}?token=h.${payload}.${sig}`
}

let root: Root
let host: HTMLDivElement
const fetchMock = vi.fn()

beforeEach(() => {
  resetFreshUploadUrlsForTests()
  opened.external.mockClear()
  opened.system.mockClear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const photo = (url: string) => ({ type: 'file' as const, mediaType: 'image/png', url, filename: 'a.png' })
const img = () => host.querySelector('img')
const flush = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('ChatFilePart', () => {
  it('a link still good is shown as is, with no request', async () => {
    const good = signedLink(PATH, Date.now() + 3_600_000)
    act(() => root.render(h(ChatFilePart, { part: photo(good) })))
    await flush()
    expect(img()?.getAttribute('src')).toBe(good)
    expect(host.querySelector('a')?.getAttribute('href')).toBe(good)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an expired link: a chip while a fresh one is fetched, then the fresh one', async () => {
    const dead = signedLink(PATH, Date.now() - 60_000)
    const fresh = signedLink(PATH, Date.now() + 3_600_000, 'fresh')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ urls: { [PATH]: fresh } }), { status: 200 }))
    act(() => root.render(h(ChatFilePart, { part: photo(dead) })))
    expect(img()).toBeNull()
    expect(host.querySelector('[data-file-chip]')?.textContent).toContain('a.png')
    await flush()
    expect(img()?.getAttribute('src')).toBe(fresh)
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ paths: [PATH] })
  })

  it('no fresh link to be had: the old one, as before', async () => {
    const dead = signedLink(PATH, Date.now() - 60_000)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ urls: {} }), { status: 200 }))
    act(() => root.render(h(ChatFilePart, { part: photo(dead) })))
    await flush()
    expect(img()?.getAttribute('src')).toBe(dead)
  })

  it('a link that is no chat upload (a blob, another site) is shown as is', async () => {
    act(() => root.render(h(ChatFilePart, { part: photo('blob:http://localhost/abc') })))
    await flush()
    expect(img()?.getAttribute('src')).toBe('blob:http://localhost/abc')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  describe('a click on a link that went stale while shown (a tab left open past the hour)', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    /** What the desktop shell plugin's script on <body> sees of the link: it opens any target=_blank one. */
    function shellPluginSees(): string[] {
      const seen: string[] = []
      document.body.addEventListener('click', (e) => {
        const a = (e.target as Element).closest('a')
        if (a) seen.push(a.target)
      })
      return seen
    }

    async function staleClick(part: ReturnType<typeof photo>) {
      vi.useFakeTimers({ toFake: ['Date'] })
      act(() => root.render(h(ChatFilePart, { part })))
      await flush()
      // An hour later, the link it shows has expired.
      vi.setSystemTime(Date.now() + 2 * 3_600_000)
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ urls: { [PATH]: signedLink(PATH, Date.now() + 3_600_000, 'fresh') } }), { status: 200 }))
      const seen = shellPluginSees()
      const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
      act(() => void host.querySelector('a')!.dispatchEvent(click))
      await flush()
      return { click, seen }
    }

    it('a photo: the shell plugin sees no target, and the fresh link is opened once, where links go', async () => {
      const { click, seen } = await staleClick(photo(signedLink(PATH, Date.now() + 3_600_000)))
      expect(click.defaultPrevented).toBe(true)
      expect(seen).toEqual([''])
      expect(opened.external).toHaveBeenCalledTimes(1)
      expect(opened.external.mock.calls[0][0]).toContain('.fresh')
      expect(opened.system).not.toHaveBeenCalled()
      // The target is back for the next click.
      expect(host.querySelector('a')!.target).toBe('_blank')
    })

    it('a file marked for the user’s browser opens there', async () => {
      const file = { type: 'file' as const, mediaType: 'text/markdown', url: signedLink(PATH, Date.now() + 3_600_000), filename: 'n.md' }
      await staleClick(file as ReturnType<typeof photo>)
      expect(opened.system).toHaveBeenCalledTimes(1)
      expect(opened.external).not.toHaveBeenCalled()
    })

    it('a link still good is left to open as it always did', async () => {
      act(() => root.render(h(ChatFilePart, { part: photo(signedLink(PATH, Date.now() + 3_600_000)) })))
      await flush()
      const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
      act(() => void host.querySelector('a')!.dispatchEvent(click))
      expect(click.defaultPrevented).toBe(false)
      expect(opened.external).not.toHaveBeenCalled()
    })
  })

  it('no link at all (a run chat’s replay): a plain chip', () => {
    act(() => root.render(h(ChatFilePart, { part: photo('') })))
    expect(host.querySelector('a')).toBeNull()
    expect(host.querySelector('[data-file-chip]')).not.toBeNull()
  })
})
