/**
 * @vitest-environment jsdom
 *
 * A demo page is on the site's own domain. Unless its storage is its own, the
 * app it mounts leaves the demo workspace's id and settings in the storage a
 * real, signed-in visit reads next.
 */
import { describe, expect, it } from 'vitest'
import { installDemoStorage, isDemoStorage } from '../demo-storage'
import { isDemoRequest } from '../demo-fetch'

describe('installDemoStorage', () => {
  it('gives the page storage of its own, and leaves the real one as it was', () => {
    const real = window.localStorage
    real.setItem('ni-workspace-id', 'the-visitors-own')
    expect(isDemoStorage(real)).toBe(false)

    expect(installDemoStorage()).toBe(true)
    expect(isDemoStorage(window.localStorage)).toBe(true)
    expect(isDemoStorage(window.sessionStorage)).toBe(true)

    // Empty at the start: the app there sees nothing of the visitor's.
    expect(window.localStorage.getItem('ni-workspace-id')).toBeNull()
    expect(localStorage.length).toBe(0)

    // What the app writes stays in the page.
    localStorage.setItem('ni-workspace-id', 'the-demo-workspace')
    expect(localStorage.getItem('ni-workspace-id')).toBe('the-demo-workspace')
    expect(localStorage.key(0)).toBe('ni-workspace-id')
    expect(real.getItem('ni-workspace-id')).toBe('the-visitors-own')

    localStorage.removeItem('ni-workspace-id')
    expect(localStorage.length).toBe(0)

    // Asking twice keeps the same storage.
    const first = window.localStorage
    expect(installDemoStorage()).toBe(true)
    expect(window.localStorage).toBe(first)
  })

  it('says no where the browser will not let storage be replaced', () => {
    const locked = {} as Window
    Object.defineProperty(locked, 'localStorage', { value: {}, configurable: false, writable: false })
    expect(installDemoStorage(locked)).toBe(false)
  })
})

describe('a demo page sends nothing of the app’s to our server', () => {
  const origin = 'https://site.example'
  it('answers every request to our own API and agents itself', () => {
    for (const path of ['/api/account/workspace', '/api/presence', '/api/ai/complete', '/api/version', '/api/calendar/events', '/eve/chat-agent/v1/session']) {
      expect(isDemoRequest('/demo/app', origin, path), path).toBe(true)
    }
  })
  it('lets the public page’s own sky through, and anything on another host', () => {
    expect(isDemoRequest('/demo/app', origin, '/api/sky?tz=UTC')).toBe(false)
    expect(isDemoRequest('/demo/app', origin, 'https://database.example/rest/v1/contact')).toBe(false)
    expect(isDemoRequest('/demo/app', origin, '/_next/static/chunk.js')).toBe(false)
  })
})
