/**
 * Output connectors (F3): the typed outputs a skill commits, and the
 * deterministic checks that refuse junk before anything is delivered.
 */
import { describe, it, expect } from 'vitest'
import {
  MAX_DOC_EDITS_PER_RUN,
  MAX_POST_DRAFTS_PER_RUN,
  OUTPUT_CONNECTORS,
  connectorInstruction,
  connectorOutputSchema,
  isStructuredConnector,
  parseConnectorOutput,
  validateDeliverConnector,
} from '../output-connectors'
import { validateRunSkillConfig } from '../queries'
import { postCardCopy, postDraftFromPayload, xIntentUrl } from '@/lib/content/post-draft'
import { writingSurface } from '@/lib/writing/surfaces'

const SKILL = '11111111-1111-4111-8111-111111111111'

describe('the connector set', () => {
  it('is the five named in flows-connectors §2.4 (P7 call_tool reuses it)', () => {
    expect([...OUTPUT_CONNECTORS].sort()).toEqual(['doc_proposals', 'document', 'email_drafts', 'notification', 'post_drafts'])
  })

  it('only the three structured connectors have an output schema', () => {
    expect(connectorOutputSchema('document')).toBeNull()
    expect(connectorOutputSchema('notification')).toBeNull()
    expect(connectorOutputSchema(undefined)).toBeNull()
    for (const to of ['post_drafts', 'doc_proposals', 'email_drafts'] as const) {
      expect(isStructuredConnector(to)).toBe(true)
      expect(connectorOutputSchema(to)).not.toBeNull()
      expect(connectorInstruction(to, { docKey: 'product', surface: 'x' }).length).toBeGreaterThan(40)
    }
  })

  it('the X surface is registered for the lint (280 characters, links last, bare)', () => {
    const x = writingSurface('x')
    expect(x?.maxChars).toBe(280)
    expect(x?.linkPlacement).toBe('end')
    expect(x?.linkStyle).toBe('bare')
  })
})

describe('parseConnectorOutput: post_drafts', () => {
  it('keeps good posts with their length and lint notes, refuses the rest with a reason', () => {
    const long = 'x'.repeat(281)
    const parsed = parseConnectorOutput('post_drafts', {
      posts: [
        { text: 'We shipped calendar sync today. It took three tries to get time zones right.', based_on: 'GEN-42 shipped' },
        { text: long },
        { text: '   ' },
        { text: 'We shipped calendar sync today.  It took three tries to get time zones right.' },
      ],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.items).toHaveLength(1)
    expect(parsed.items[0]).toMatchObject({ limit: 280, based_on: 'GEN-42 shipped' })
    expect(parsed.items[0].chars).toBe([...parsed.items[0].text].length)
    expect(parsed.refused).toEqual(['a post of 281 characters (the limit is 280)', 'an empty post', 'the same post twice'])
  })

  it(`delivers at most ${MAX_POST_DRAFTS_PER_RUN} per run`, () => {
    const parsed = parseConnectorOutput('post_drafts', { posts: Array.from({ length: 5 }, (_, i) => ({ text: `Post number ${i}` })) })
    expect(parsed.ok && parsed.items.length).toBe(MAX_POST_DRAFTS_PER_RUN)
    expect(parsed.ok && parsed.refused).toHaveLength(2)
  })

  it('a lint failure is a note on the card, never a refusal (lint informs)', () => {
    const parsed = parseConnectorOutput('post_drafts', { posts: [{ text: "In today's fast-paced world, let's delve into calendars." }] })
    expect(parsed.ok && parsed.items).toHaveLength(1)
    expect(parsed.ok && parsed.items[0].notes.length).toBeGreaterThan(0)
  })

  it('the wrong shape refuses the whole output', () => {
    expect(parseConnectorOutput('post_drafts', { drafts: [] })).toEqual({ ok: false, error: expect.stringMatching(/expected shape/) })
    expect(parseConnectorOutput('post_drafts', null)).toEqual({ ok: false, error: expect.stringMatching(/no structured output/) })
    expect(parseConnectorOutput('post_drafts', 'a post')).toMatchObject({ ok: false })
  })

  it('an empty list is a valid answer: nothing worth posting', () => {
    expect(parseConnectorOutput('post_drafts', { posts: [] })).toEqual({ ok: true, items: [], refused: [] })
  })
})

describe('parseConnectorOutput: doc_proposals', () => {
  it('keeps valid section edits, refuses empty ones', () => {
    const parsed = parseConnectorOutput('doc_proposals', {
      edits: [
        { section: 'Positioning', op: 'append', text: 'Customers compare us with a spreadsheet.', reason: 'Two calls said so' },
        { section: 'Messaging', op: 'replace', text: '', reason: 'x' },
        { section: '', op: 'append', text: 'y', reason: 'x' },
        { section: 'Open questions', op: 'remove', text: 'ignored', reason: '' },
      ],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.items).toEqual([
      { section: 'Positioning', op: 'append', text: 'Customers compare us with a spreadsheet.', reason: 'Two calls said so', removes: null },
      { section: 'Open questions', op: 'remove', text: '', reason: 'From a loop run', removes: null },
    ])
    expect(parsed.refused).toEqual(['an empty replace of Messaging', 'an edit with no section'])
  })

  it(`caps a run at ${MAX_DOC_EDITS_PER_RUN} edits and refuses an op it doesn't know`, () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ section: `S${i}`, op: 'append', text: 'a', reason: 'r' }))
    const parsed = parseConnectorOutput('doc_proposals', { edits: many })
    expect(parsed.ok && parsed.items).toHaveLength(MAX_DOC_EDITS_PER_RUN)
    expect(parseConnectorOutput('doc_proposals', { edits: [{ section: 'S', op: 'rewrite', text: 'a', reason: 'r' }] })).toMatchObject({ ok: false })
  })
})

describe('parseConnectorOutput: email_drafts', () => {
  it('keeps a well-formed draft (addresses lower-cased, each once)', () => {
    const parsed = parseConnectorOutput('email_drafts', {
      drafts: [{ to: ['Ana@Acme.com', 'ana@acme.com'], subject: 'It shipped', body: 'Hi Ana, the export you asked for is live.' }],
    })
    expect(parsed).toEqual({ ok: true, items: [{ to: ['ana@acme.com'], cc: [], subject: 'It shipped', body: 'Hi Ana, the export you asked for is live.' }], refused: [] })
  })

  it('refuses a malformed address, a no-reply one, and an empty body', () => {
    const parsed = parseConnectorOutput('email_drafts', {
      drafts: [
        { to: ['Ana <ana@acme.com>'], subject: 's', body: 'b' },
        { to: ['no-reply@acme.com'], subject: 's', body: 'b' },
        { to: ['ana@acme.com'], subject: 's', body: '  ' },
        { to: [], subject: 's', body: 'b' },
      ],
    })
    expect(parsed.ok && parsed.items).toEqual([])
    expect(parsed.ok && parsed.refused).toEqual([
      'a draft with a missing or malformed address',
      'a draft to a no-reply address',
      'a draft with no subject or no body',
      'a draft with a missing or malformed address',
    ])
  })
})

describe('the flow config: deliver.to and its destination', () => {
  it('doc_proposals needs a canon key; post_drafts defaults to X; unknown connectors are refused', () => {
    expect(validateDeliverConnector({ to: 'doc_proposals' })).toBeInstanceOf(Error)
    expect(validateDeliverConnector({ to: 'doc_proposals', doc_key: 'Product' })).toEqual({ to: 'doc_proposals', doc_key: 'product' })
    expect(validateDeliverConnector({ to: 'post_drafts' })).toEqual({ to: 'post_drafts', surface: 'x' })
    // P8: the four post surfaces with a compose page; anything else is refused.
    for (const surface of ['linkedin', 'threads', 'bluesky']) expect(validateDeliverConnector({ to: 'post_drafts', surface })).toEqual({ to: 'post_drafts', surface })
    expect(validateDeliverConnector({ to: 'post_drafts', surface: 'mastodon' })).toBeInstanceOf(Error)
    expect(validateDeliverConnector({ to: 'tweet' })).toBeInstanceOf(Error)
    // A destination that doesn't belong to the connector is dropped.
    expect(validateDeliverConnector({ to: 'email_drafts', doc_key: 'product', surface: 'x' })).toEqual({ to: 'email_drafts' })
    expect(validateDeliverConnector({})).toEqual({})
  })

  it('validateRunSkillConfig stores the connector with the rest of deliver', () => {
    const ok = validateRunSkillConfig({ skill_id: SKILL, mode: 'report', deliver: { to: 'doc_proposals', doc_key: 'product', notification: false } })
    expect(ok).toEqual({ skill_id: SKILL, mode: 'report', deliver: { notification: false, to: 'doc_proposals', doc_key: 'product' } })
    expect(validateRunSkillConfig({ skill_id: SKILL, deliver: { to: 'doc_proposals' } })).toBeInstanceOf(Error)
  })
})

describe('post-draft card payload (client-safe)', () => {
  it('the X intent link carries the text, encoded', () => {
    expect(xIntentUrl('Shipped it & it works #dev')).toBe('https://x.com/intent/post?text=Shipped%20it%20%26%20it%20works%20%23dev')
  })

  it('reads a card payload and words the card: Post on X, the text, its length, what it is based on', () => {
    const payload = { post_draft: { text: 'We shipped calendar sync.', surface: 'x', chars: 25, limit: 280, based_on: 'GEN-42 shipped', notes: [] } }
    expect(postDraftFromPayload(payload)).toMatchObject({ text: 'We shipped calendar sync.', limit: 280 })
    const copy = postCardCopy(payload)
    expect(copy?.verb).toBe('Post')
    expect(copy?.sentence).toBe('on X: “We shipped calendar sync.”')
    // The text shows once (the sentence); the details don't repeat it (review N4).
    expect(copy?.details).not.toContain('We shipped calendar sync.')
    expect(copy?.details[0]).toBe('25/280 characters · Based on: GEN-42 shipped')
    expect(copy?.details.at(-1)).toMatch(/nothing is posted until you post it there/)
  })

  it('any other card is not a post', () => {
    expect(postCardCopy({ canon_edit: { section: 'x' } })).toBeNull()
    expect(postDraftFromPayload({ post_draft: { text: '   ' } })).toBeNull()
  })
})
