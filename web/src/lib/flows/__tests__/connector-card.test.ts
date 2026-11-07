/**
 * A parked connector step's card says exactly what will happen, from the
 * call's own input (F4, flows-connectors.md §2.3).
 */
import { describe, expect, it } from 'vitest'
import { connectorCardCopy, connectorRunLine } from '../connector-card'
import { cardEffectLine, cardPrimaryLabel } from '@/lib/attention/card-copy'

describe('connectorCardCopy', () => {
  it('a Typefully queue add, a scheduled post and a post now', () => {
    expect(connectorCardCopy({ serverName: 'Typefully', tool: 'create_draft', input: { content: 'We shipped SSO', publish_at: 'next-free-slot' } }).title).toBe(
      "Add to Typefully queue: next free slot: 'We shipped SSO'",
    )
    expect(connectorCardCopy({ serverName: 'Typefully', tool: 'create_draft', input: { content: 'x', publish_at: '2026-10-21T09:00:00Z' } }).title).toBe(
      "Schedule on Typefully for 2026-10-21T09:00:00Z: 'x'",
    )
    expect(connectorCardCopy({ serverName: 'X', tool: 'create_post', input: { text: 'hello world', handle: 'liam' } }).title).toBe("Post via X as @liam: 'hello world'")
  })

  it('a comment on an issue key, a send, and anything else', () => {
    expect(connectorCardCopy({ serverName: 'Linear', tool: 'create_comment', input: { issueId: 'LIN-42', body: 'Customer asked again' } }).title).toBe(
      "Comment on LIN-42: 'Customer asked again'",
    )
    expect(connectorCardCopy({ serverName: 'Slack', tool: 'send_message', input: { text: 'hi' } }).title).toBe("Send via Slack: 'hi'")
    expect(connectorCardCopy({ serverName: 'Notion', tool: 'append_block', input: { page: 'p1' } }).title).toBe('Run append_block on Notion?')
  })

  it('clips a long quote and says what Accept, Edit and Skip do', () => {
    const copy = connectorCardCopy({ serverName: 'Typefully', tool: 'create_draft', input: { content: 'a'.repeat(300), publish: true }, flowName: 'Weekly posts' })
    expect(copy.title.length).toBeLessThan(140)
    expect(copy.title).toContain('…')
    expect(copy.why).toContain('“Weekly posts”')
    expect(copy.why).toMatch(/runs once, as you, with exactly the inputs below/)
    expect(copy.why).toMatch(/Edit them first, or skip it/)
  })
})

describe('N5 and B1: what the card and the run say', () => {
  it('a public-content card says it posts publicly, and its button says "Approve and post"', () => {
    expect(connectorCardCopy({ serverName: 'Typefully', tool: 'create_draft', input: { content: 'x', publish: true }, publicContent: true }).why).toContain('This posts publicly.')
    expect(cardPrimaryLabel({ kind: 'approval' }, { public_content: true })).toBe('Approve and post')
    expect(cardPrimaryLabel({ kind: 'approval' }, {})).toBe('Approve')
    expect(cardEffectLine({ kind: 'approval', title: 't' }, { tool: 'mcp__typefully__create_draft', public_content: true })).toMatch(/^Posts publicly/)
  })

  it('the run line names the app and how much, never what', () => {
    expect(connectorRunLine({ serverName: 'Notion', tool: 'search', chars: 2140 })).toBe('Read 2.1k chars from Notion (search)')
    expect(connectorRunLine({ serverName: 'Notion', tool: 'search', chars: 1 })).toBe('Read 1 char from Notion (search)')
    expect(connectorRunLine({ serverName: 'Typefully', tool: 'create_draft', publicContent: true })).toBe('a post via Typefully (create_draft)')
  })
})
