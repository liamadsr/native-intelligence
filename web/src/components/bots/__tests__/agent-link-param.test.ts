// @vitest-environment jsdom
/** A connect link lands on /account?agent-link=<id>: People opens on that request, once, and the param comes off. */
import { describe, expect, it } from 'vitest'
import { takeAgentLinkParam } from '../agent-editor'

describe('takeAgentLinkParam', () => {
  it('gives the id once and takes it off the address, keeping the rest', () => {
    window.history.replaceState(null, '', '/account?tab=home&agent-link=l-123#top')
    expect(takeAgentLinkParam()).toBe('l-123')
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/account?tab=home#top')
    expect(takeAgentLinkParam()).toBeNull()
  })
})
