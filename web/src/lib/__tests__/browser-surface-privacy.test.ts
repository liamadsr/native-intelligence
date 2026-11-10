// @vitest-environment jsdom
/**
 * The in-app browser's DOM ([data-ni-browser]: the browser window view and
 * every portal it renders) shows the user's browsing — titles and full URLs
 * (which can carry OAuth codes / reset tokens). Sentry's ui.click / ui.input
 * breadcrumbs serialize those from element title/aria-label, so they are
 * dropped when the event target sits inside it — and only then.
 */
import { afterEach, describe, it, expect } from 'vitest'
import { isInBrowserSurface } from '@/lib/platform'
import { shouldDropSentryBreadcrumb } from '@/lib/sentry-env'

function mount() {
  const surface = document.createElement('div')
  surface.setAttribute('data-ni-browser', '')
  surface.className = 'ph-no-capture'
  const tab = document.createElement('button')
  tab.title = 'Reset your password – https://example.com/reset?token=secret'
  const text = document.createTextNode('Example')
  tab.appendChild(text)
  surface.appendChild(tab)
  const outside = document.createElement('button')
  document.body.append(surface, outside)
  return { surface, tab, text, outside }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('isInBrowserSurface', () => {
  it('is true for an element (or the surface itself) inside [data-ni-browser]', () => {
    const { surface, tab } = mount()
    expect(isInBrowserSurface(tab)).toBe(true)
    expect(isInBrowserSurface(surface)).toBe(true)
  })

  it('is true for a Text node inside it', () => {
    const { text } = mount()
    expect(isInBrowserSurface(text)).toBe(true)
  })

  it('is false outside it, and for anything that is not a node', () => {
    const { outside } = mount()
    expect(isInBrowserSurface(outside)).toBe(false)
    expect(isInBrowserSurface(document.createTextNode('detached'))).toBe(false)
    expect(isInBrowserSurface(null)).toBe(false)
    expect(isInBrowserSurface(undefined)).toBe(false)
    expect(isInBrowserSurface('button')).toBe(false)
    expect(isInBrowserSurface(window)).toBe(false)
  })
})

describe('shouldDropSentryBreadcrumb', () => {
  it('drops click + input breadcrumbs whose target is inside the browser surface', () => {
    const { tab, text } = mount()
    expect(shouldDropSentryBreadcrumb({ category: 'ui.click' }, { event: { target: tab } })).toBe(true)
    expect(shouldDropSentryBreadcrumb({ category: 'ui.input' }, { event: { target: tab } })).toBe(true)
    expect(shouldDropSentryBreadcrumb({ category: 'ui.input' }, { event: { target: text } })).toBe(true)
    // A real DOM event, as Sentry hands it over.
    const ev = new MouseEvent('click', { bubbles: true })
    let seen: Event | null = null
    tab.addEventListener('click', (e) => (seen = e), { once: true })
    tab.dispatchEvent(ev)
    expect(shouldDropSentryBreadcrumb({ category: 'ui.click' }, { event: seen })).toBe(true)
  })

  it('keeps click + input breadcrumbs from the rest of the app', () => {
    const { outside } = mount()
    expect(shouldDropSentryBreadcrumb({ category: 'ui.click' }, { event: { target: outside } })).toBe(false)
    expect(shouldDropSentryBreadcrumb({ category: 'ui.input' }, { event: { target: outside } })).toBe(false)
  })

  it('keeps other categories, even inside the surface', () => {
    const { tab } = mount()
    expect(shouldDropSentryBreadcrumb({ category: 'navigation' }, { event: { target: tab } })).toBe(false)
    expect(shouldDropSentryBreadcrumb({ category: 'fetch' }, { event: { target: tab } })).toBe(false)
  })

  it('keeps a breadcrumb with no hint (or no event)', () => {
    expect(shouldDropSentryBreadcrumb({ category: 'ui.click' })).toBe(false)
    expect(shouldDropSentryBreadcrumb({ category: 'ui.click' }, {})).toBe(false)
  })
})
