/**
 * Block pages (exit/block-page.ts): the sites' own titles and wording, never
 * an article that mentions them.
 */
import { describe, expect, it } from 'vitest'
import { blockPage } from '../block-page'

describe('blockPage', () => {
  it('knows the block and challenge pages the spike met', () => {
    expect(blockPage({ title: 'Access Denied', text: 'You don\'t have permission to access "http://www.uniqlo.com/us/en/" on this server. Reference #18.2b' })).toBe('blocked')
    expect(blockPage({ title: 'Just a moment...', text: 'Verify you are human by completing the action below.' })).toBe('blocked')
    expect(blockPage({ title: 'Attention Required! | Cloudflare', text: 'Sorry, you have been blocked' })).toBe('blocked')
    expect(blockPage({ title: 'Amazon.com', text: 'Continued access by an unauthorized AI agent violates Amazon\'s Conditions of Use, to which our customers have agreed.' })).toBe('agent_ban')
  })

  it('leaves ordinary pages alone, including ones about blocking', () => {
    expect(blockPage({ title: 'Women’s Clothing & Accessories | UNIQLO US', text: 'Shop new arrivals' })).toBeNull()
    expect(blockPage({ title: 'How Cloudflare decides who sees "Access Denied" pages', text: 'An article about access denied pages.' })).toBeNull()
    expect(blockPage({ title: 'Resy', text: '' })).toBeNull()
  })

  it('never takes a long page that quotes the wording (a forum thread, an issue) for a block', () => {
    const thread = `Issue #42: our scraper now sees "Continued access by an unauthorized AI agent violates Amazon's Conditions of Use". ${'Comment. '.repeat(400)}`
    expect(blockPage({ title: 'Scraper blocked · Issue #42 · acme/scraper', text: thread })).toBeNull()
    expect(blockPage({ title: 'r/webdev', text: `Sorry, you have been blocked, it says. ${'Reply. '.repeat(400)}` })).toBeNull()
  })
})
