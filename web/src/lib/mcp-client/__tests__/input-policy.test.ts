/**
 * Input-aware approval (F4, pattern P7): the rule reads the CALL, not only
 * the tool name. Posts and public content always ask (decision 2, a hard
 * rule nothing relaxes); a Typefully draft CREATE whose input proves it
 * cannot publish is inert; anything else on Typefully asks; any other
 * connector falls back to P5's tool-level answer.
 */
import { describe, expect, it } from 'vitest'
import {
  connectorCallPolicy,
  inputHasNoPublishKey,
  inputPublishes,
  isDraftCreateName,
  isPublicContentCall,
  schemaDefaultsPublish,
} from '../input-policy'

const TYPEFULLY = 'https://mcp.typefully.com/mcp'
const LINEAR = 'https://mcp.linear.app/mcp'
const UNKNOWN = 'https://mcp.example-tools.dev/mcp'
const draftSchema = { type: 'object', properties: { content: { type: 'string' }, social_set_id: { type: 'string' } }, required: ['content'] }

describe('posts and public content ALWAYS take a card (decision 2)', () => {
  it('a publishing tool asks even when P5 would let it run (an approval-free choice, a trusted hint)', () => {
    for (const name of ['publish_post', 'createPost', 'send_message', 'create_comment', 'tweet', 'schedule_draft', 'share_page', 'add_to_queue']) {
      const d = connectorCallPolicy({ serverUrl: UNKNOWN, tool: { name, annotations: { readOnlyHint: true } }, input: {}, requiresApproval: false })
      expect(d, name).toMatchObject({ policy: 'ask', rule: 'public_content', publicContent: true })
    }
  })

  it('any input that sets a publish-shaped field asks, on any server', () => {
    for (const input of [{ publish_at: 'next-free-slot' }, { publish: true }, { schedule: { at: '2026-10-21T09:00:00Z' } }, { nested: { scheduledAt: 'now' } }, { share: true }]) {
      const d = connectorCallPolicy({ serverUrl: TYPEFULLY, tool: { name: 'create_draft', inputSchema: draftSchema }, input: { content: 'hi', ...input }, requiresApproval: false })
      expect(d.policy, JSON.stringify(input)).toBe('ask')
      expect(d.publicContent).toBe(true)
    }
  })

  it('a plain read is never public content', () => {
    expect(isPublicContentCall({ name: 'list_posts' }, {})).toBe(false)
    expect(isPublicContentCall({ name: 'get_comments' }, {})).toBe(false)
  })
})

describe('Typefully: a proven draft-only save is inert', () => {
  it('create_draft with text only, a known schema with no publish default → inert, and says so', () => {
    const d = connectorCallPolicy({ serverUrl: TYPEFULLY, tool: { name: 'create_draft', inputSchema: draftSchema }, input: { content: 'A thought from the call' }, requiresApproval: true })
    expect(d).toMatchObject({ policy: 'inert', rule: 'typefully_draft', publicContent: false })
    expect(d.reason).toMatch(/draft/i)
    // Other naming styles of a create.
    for (const name of ['createDraft', 'save-draft', 'new_draft', 'AddDraft']) expect(isDraftCreateName(name), name).toBe(true)
  })

  it('fails closed: a publish key at all, even empty or null, asks', () => {
    for (const extra of [{ publish_at: null }, { publish_at: '' }, { publish: false }, { schedule: null }]) {
      const d = connectorCallPolicy({ serverUrl: TYPEFULLY, tool: { name: 'create_draft', inputSchema: draftSchema }, input: { content: 'x', ...extra }, requiresApproval: true })
      expect(d.policy, JSON.stringify(extra)).toBe('ask')
    }
  })

  it('an edit, a delete or a non-draft tool asks (an edit of a scheduled draft changes what goes out)', () => {
    for (const name of ['edit_draft', 'update_draft', 'delete_draft', 'create_draft_and_publish', 'duplicate_draft']) {
      const d = connectorCallPolicy({ serverUrl: TYPEFULLY, tool: { name, inputSchema: draftSchema }, input: { content: 'x' }, requiresApproval: true })
      expect(d.policy, name).toBe('ask')
    }
  })

  it('an unknown schema, or one that defaults a publish field, asks', () => {
    expect(connectorCallPolicy({ serverUrl: TYPEFULLY, tool: { name: 'create_draft' }, input: { content: 'x' }, requiresApproval: true }).policy).toBe('ask')
    const defaulting = { type: 'object', properties: { content: { type: 'string' }, publish_at: { type: 'string', default: 'next-free-slot' } } }
    expect(schemaDefaultsPublish(defaulting)).toBe(true)
    expect(connectorCallPolicy({ serverUrl: TYPEFULLY, tool: { name: 'create_draft', inputSchema: defaulting }, input: { content: 'x' }, requiresApproval: true }).policy).toBe('ask')
  })

  it('a $ref with a malformed percent-escape is not proven (asks), it does not throw', () => {
    const badRef = { type: 'object', properties: { content: { $ref: '#/$defs/%E0%A4%A' } }, $defs: {} }
    expect(schemaDefaultsPublish(badRef)).toBe(true)
    expect(connectorCallPolicy({ serverUrl: TYPEFULLY, tool: { name: 'create_draft', inputSchema: badRef }, input: { content: 'x' }, requiresApproval: true }).policy).toBe('ask')
  })

  it('a Typefully read still runs', () => {
    expect(connectorCallPolicy({ serverUrl: TYPEFULLY, tool: { name: 'list_drafts' }, input: {}, requiresApproval: false }).policy).toBe('read')
  })
})

describe('any other connector: P5\'s tool-level answer', () => {
  it('a write asks; a read runs', () => {
    expect(connectorCallPolicy({ serverUrl: LINEAR, tool: { name: 'create_issue' }, input: { title: 'x' }, requiresApproval: true })).toMatchObject({ policy: 'ask', rule: 'tool_level' })
    expect(connectorCallPolicy({ serverUrl: LINEAR, tool: { name: 'list_issues' }, input: {}, requiresApproval: false })).toMatchObject({ policy: 'read', rule: 'tool_level' })
    // A "draft" on a connector with no rule is not inert: only Typefully's rule proves that.
    expect(connectorCallPolicy({ serverUrl: UNKNOWN, tool: { name: 'create_draft', inputSchema: draftSchema }, input: { content: 'x' }, requiresApproval: true }).policy).toBe('ask')
  })
})

describe('the input readers', () => {
  it('see keys deep, in any naming style', () => {
    expect(inputPublishes({ posts: [{ text: 'a', publishAt: '2026-10-21' }] })).toBe(true)
    expect(inputHasNoPublishKey({ posts: [{ text: 'a' }] })).toBe(true)
    expect(inputHasNoPublishKey({ posts: [{ text: 'a', publish_at: null }] })).toBe(false)
  })
})
