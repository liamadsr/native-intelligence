// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { OPEN_SEARCH_EVENT, openSearch, searchButton } from '../open-search'
import { SEARCH_FLIGHT_KEY, flightWaiting } from '../card-reply-flight'

/**
 * The top bar's search button asks the main composer for the `/` palette
 * (OPEN_SEARCH_EVENT); the composer that answers cancels the event. No one
 * answering: nothing opens, and no flight is left held.
 */
const listeners: Array<(e: Event) => void> = []
afterEach(() => {
  for (const l of listeners.splice(0)) window.removeEventListener(OPEN_SEARCH_EVENT, l)
})

describe('openSearch', () => {
  it('is answered by the composer that cancels the event', () => {
    const seen: Event[] = []
    const answer = (e: Event) => {
      seen.push(e)
      e.preventDefault()
    }
    listeners.push(answer)
    window.addEventListener(OPEN_SEARCH_EVENT, answer)
    expect(openSearch()).toBe(true)
    expect(seen).toHaveLength(1)
  })

  it('opens nothing and holds no flight when no composer answers', () => {
    const button = document.createElement('button')
    document.body.append(button)
    expect(openSearch(button)).toBe(false)
    expect(flightWaiting(SEARCH_FLIGHT_KEY)).toBe(false)
    expect(document.querySelector('[data-card-reply-flight]')).toBeNull()
    button.remove()
  })
})

/**
 * The button the palette flies out of: the top bar's, or the app rail's while
 * the top bar is hidden under a full-screen page (rail/app-rail.tsx).
 */
describe('searchButton', () => {
  const made: HTMLElement[] = []
  afterEach(() => {
    for (const el of made.splice(0)) el.remove()
  })
  const button = (value: string, opts: { laidOut: boolean; hidden?: boolean }) => {
    const host = document.createElement('div')
    if (opts.hidden) host.style.visibility = 'hidden'
    const b = document.createElement('button')
    b.setAttribute('data-search-button', value)
    // jsdom lays nothing out: a button "on screen" reports a box.
    if (opts.laidOut) b.getClientRects = () => [{ width: 36, height: 36 }] as unknown as DOMRectList
    host.append(b)
    document.body.append(host)
    made.push(host)
    return b
  }

  it('is the top bar’s while it shows, with the rail’s there too', () => {
    const rail = button('rail', { laidOut: true })
    const bar = button('', { laidOut: true })
    expect(searchButton()).toBe(bar)
    expect(searchButton()).not.toBe(rail)
  })

  it('is the rail’s while the top bar is hidden under a page', () => {
    const rail = button('rail', { laidOut: true })
    button('', { laidOut: true, hidden: true })
    expect(searchButton()).toBe(rail)
  })

  it('is the top bar’s where nothing can be measured (as before the rail)', () => {
    button('rail', { laidOut: false })
    const bar = button('', { laidOut: false })
    expect(searchButton()).toBe(bar)
  })

  it('is none with no search button', () => {
    expect(searchButton()).toBeNull()
  })
})
