// @vitest-environment jsdom
/**
 * The owner's crash (Sentry JAVASCRIPT-NEXTJS-CR, 11-24): in the desktop app
 * (WKWebView) `matchMedia(q)` answered null, and the side panel's agent face
 * (AgentLookButton > AgentBot > bot-avatars' BotAvatar, which reads
 * `matchMedia("(prefers-reduced-motion: reduce)").matches` while it renders)
 * threw `null is not an object`. The dashboard's boundary remounted
 * everything and the person landed on Home.
 *
 * Here the REAL package renders (no stub) with matchMedia answering null, as
 * do the app's own readers of it on that path: no throw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const realMatchMedia = window.matchMedia
let root: Root
let host: HTMLElement
let errors: unknown[]

beforeEach(() => {
  // WebKit's answer while a view is detached: null.
  window.matchMedia = vi.fn(() => null) as unknown as typeof window.matchMedia
  vi.stubGlobal('fetch', async () => new Response('{}'))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host, { onCaughtError: (e) => errors.push(e), onUncaughtError: (e) => errors.push(e), onRecoverableError: (e) => errors.push(e) })
  errors = []
  // jsdom has no canvas: the package draws nothing, which is fine here.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.matchMedia = realMatchMedia
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function settle() {
  for (let i = 0; i < 50; i++) await act(async () => void (await Promise.resolve()))
}

describe('matchMedia answering null (WebKit)', () => {
  it("bot-avatars' BotAvatar renders without a throw", async () => {
    const { BotAvatar } = await import('bot-avatars')
    await act(async () => root.render(h(BotAvatar, { type: 'clover', state: 'default', size: 56 } as never)))
    await settle()
    expect(errors).toEqual([])
    expect(host.querySelector('canvas')).not.toBeNull()
  })

  it('the side panel’s agent face (AgentLookButton, the real AgentBot) renders without a throw', async () => {
    const { AgentLookButton } = await import('../agent-editor')
    await act(async () => root.render(h(AgentLookButton, { name: 'Agent', state: 'default', active: true, size: 56 })))
    await settle()
    expect(errors).toEqual([])
    expect(host.querySelector('[data-agent-bot]')).not.toBeNull()
  })

  it('the rail’s and the window’s hooks read it as "can\'t tell", without a throw', async () => {
    const { useRailShown } = await import('@/app/account/(dashboard)/rail/rail-media')
    const { useMedia } = await import('@/hooks/use-media')
    const seen: unknown[] = []
    function Probe() {
      seen.push([useRailShown(), useMedia('(min-width: 1024px)')])
      return null
    }
    await act(async () => root.render(h(Probe)))
    expect(errors).toEqual([])
    expect(seen.at(-1)).toEqual([expect.any(Boolean), false])
  })

  it('the page panel’s entrance (playEntrance) and the theme listener run without a throw', async () => {
    const { playEntrance } = await import('@/lib/motion/palette-entrance')
    const el = document.createElement('div')
    ;(el as unknown as { animate: unknown }).animate = vi.fn(() => ({}))
    expect(() => playEntrance(el)).not.toThrow()
    expect(el.animate).toHaveBeenCalled()
    const { SystemThemeListener } = await import('@/components/system-theme-listener')
    await act(async () => root.render(h(SystemThemeListener)))
    expect(errors).toEqual([])
  })
})
