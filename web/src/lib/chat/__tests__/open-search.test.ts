// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { OPEN_SEARCH_EVENT, openSearch } from '../open-search'
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
