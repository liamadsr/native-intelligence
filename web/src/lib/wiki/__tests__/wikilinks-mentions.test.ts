/**
 * A document's body mentions documents (wikilinks, `[[slug]]`), actions
 * (identifiers, `GEN-42`, drawn as chips) and people and records (`@` chips,
 * `[@Maya Chen](mention://contact/<id>)`): syncDocumentLinks adds a
 * `mentions` edge for each, fenced for the editor, through the shared mention
 * helper. A save takes back only what the body's own previous text named and
 * its new text doesn't: an agent's `mentions` edges (link_entities) and
 * other relations survive, and so does an edge the editor can't see (Ana's
 * chip of her private event, when Bob saves). Fixtures are made up.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { DOCUMENT_MENTION_KINDS, parseActionIdentifiers, syncDocumentLinks } from '../wikilinks'
import { mentionMarkdown } from '@/lib/documents/mention-markdown'
import { MAX_MENTIONED_RECORDS } from '@/lib/entity-links/mentionable'
import { MENTION_PICKER_KINDS } from '@/lib/search/menu-search'

const WS = '11111111-1111-4111-8111-111111111111'
const ANA_USER = '22222222-2222-4222-8222-aaaaaaaaaaaa'
const BEN_USER = '22222222-2222-4222-8222-bbbbbbbbbbbb'
const ANA = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const BEN = '33333333-3333-4333-8333-bbbbbbbbbbbb'
const DOC = 'd0000000-0000-4000-8000-000000000001'
const PRICING = 'd0000000-0000-4000-8000-000000000002'
const BEN_PRIVATE = 'd0000000-0000-4000-8000-000000000003'
const ACTION = 'a0000000-0000-4000-8000-000000000042'
const CONTACT = 'c0000000-0000-4000-8000-000000000001'
const DEAL = 'e0000000-0000-4000-8000-000000000001'
const AGENT_DEAL = 'e0000000-0000-4000-8000-000000000002'
const BEN_CALL = 'c1000000-0000-4000-8000-000000000001'
const OPEN_FILE = 'f0000000-0000-4000-8000-000000000001'
const PRIVATE_FILE = 'f0000000-0000-4000-8000-000000000002'
const BEN_EVENT = 'e1000000-0000-4000-8000-000000000001'
const ANA_EVENT = 'e1000000-0000-4000-8000-000000000002'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>

beforeEach(() => {
  tables = {
    member: [
      { id: ANA, user_id: ANA_USER, workspace_id: WS },
      { id: BEN, user_id: BEN_USER, workspace_id: WS },
    ],
    document: [
      { id: DOC, workspace_id: WS, slug: 'launch-plan', visibility: 'workspace', created_by: ANA },
      { id: PRICING, workspace_id: WS, slug: 'pricing', visibility: 'workspace', created_by: ANA },
      { id: BEN_PRIVATE, workspace_id: WS, slug: 'ben-notes', visibility: 'private', created_by: BEN },
    ],
    actions: [{ id: ACTION, workspace_id: WS, identifier: 'GEN-42' }],
    flow: [
      { id: DEAL, workspace_id: WS, name: 'Harbor Coffee renewal' },
      { id: AGENT_DEAL, workspace_id: WS, name: 'Fernhill retainer' },
    ],
    captures: [{ id: BEN_CALL, workspace_id: WS, visibility: 'private', user_id: BEN, is_eval: false }],
    attachments: [
      { id: OPEN_FILE, workspace_id: WS, user_id: BEN, note_id: null, action_id: ACTION, file_name: 'menu.pdf' },
      { id: PRIVATE_FILE, workspace_id: WS, user_id: BEN, note_id: BEN_CALL, file_name: 'salary.xlsx' },
    ],
    local_calendar_event: [
      { id: BEN_EVENT, workspace_id: WS, user_id: BEN_USER, title: 'Dentist' },
      { id: ANA_EVENT, workspace_id: WS, user_id: ANA_USER, title: 'Ana’s offsite' },
    ],
    entity_link: [
      // An agent's links (link_entities writes 'mentions' by default): never the body's to remove.
      { id: 'agent-contact', workspace_id: WS, source_type: 'document', source_id: DOC, target_type: 'contact', target_id: CONTACT, relation: 'mentions' },
      { id: 'agent-deal', workspace_id: WS, source_type: 'document', source_id: DOC, target_type: 'flow', target_id: AGENT_DEAL, relation: 'mentions' },
      { id: 'cites-edge', workspace_id: WS, source_type: 'document', source_id: DOC, target_type: 'document', target_id: PRICING, relation: 'cites' },
    ],
  }
})

const mentions = () =>
  tables.entity_link
    .filter((e) => e.source_id === DOC && e.relation === 'mentions')
    .map((e) => `${e.target_type}:${e.target_id}`)
    .sort()
const AGENT_EDGES = [`contact:${CONTACT}`, `flow:${AGENT_DEAL}`]

describe('syncDocumentLinks', () => {
  it('reads the identifiers a body names', () => {
    expect(parseActionIdentifiers('Do GEN-42 then GEN-42 and ISO-8601; not gen-1')).toEqual(['GEN-42', 'ISO-8601'])
  })

  it('manages every kind the one @ picker finds, and the wikilinked docs and named actions', () => {
    // A deal is chipped as its pipeline's row (Tables, phase 7).
    for (const kind of [...MENTION_PICKER_KINDS.filter((k) => k !== 'deal'), 'document', 'action', 'data_row']) expect(DOCUMENT_MENTION_KINDS).toContain(kind)
    expect(DOCUMENT_MENTION_KINDS).not.toContain('deal')
  })

  it('links the wikilinked doc and the named action, never another member’s private doc', async () => {
    const db = memoryDb(tables)
    const res = await syncDocumentLinks(db, WS, DOC, 'See [[pricing]], [[ben-notes]], [[nowhere]] and GEN-42 (ISO-8601).', ANA, ANA_USER, '')
    expect(res.unresolved).toContain('nowhere')
    expect(mentions()).toEqual([`action:${ACTION}`, `document:${PRICING}`, ...AGENT_EDGES].sort())
    expect(tables.entity_link.find((e) => e.target_id === BEN_PRIVATE)).toBeUndefined()
  })

  it('an @ chip is a mention edge: a deal, a file the editor may read; never a private file or another member’s event', async () => {
    const db = memoryDb(tables)
    const body = [
      `Renewal: ${mentionMarkdown({ type: 'flow', id: DEAL, label: 'Harbor Coffee renewal' })}.`,
      `Menu ${mentionMarkdown({ type: 'attachment', id: OPEN_FILE, label: 'menu.pdf' })}`,
      `and ${mentionMarkdown({ type: 'attachment', id: PRIVATE_FILE, label: 'salary.xlsx' })}`,
      `at ${mentionMarkdown({ type: 'calendar_event', id: BEN_EVENT, label: 'Dentist' })}`,
    ].join('\n')
    await syncDocumentLinks(db, WS, DOC, body, ANA, ANA_USER, '')
    expect(mentions()).toEqual([`attachment:${OPEN_FILE}`, `flow:${DEAL}`, ...AGENT_EDGES].sort())
  })

  it('a chip in backticks is code, not a mention', async () => {
    const db = memoryDb(tables)
    await syncDocumentLinks(db, WS, DOC, `Syntax: \`${mentionMarkdown({ type: 'flow', id: DEAL, label: 'x' })}\``, ANA, ANA_USER, '')
    expect(mentions()).toEqual([...AGENT_EDGES].sort())
  })

  it('an edit takes back what its own text no longer names (a chip, a wikilink), and keeps the agent’s edges and other relations', async () => {
    const db = memoryDb(tables)
    const before = `See [[pricing]], GEN-42 and ${mentionMarkdown({ type: 'flow', id: DEAL, label: 'Renewal' })}.`
    await syncDocumentLinks(db, WS, DOC, before, ANA, ANA_USER, '')
    expect(mentions()).toContain(`flow:${DEAL}`)
    await syncDocumentLinks(db, WS, DOC, 'Only GEN-42 now.', ANA, null, before)
    expect(mentions()).toEqual([`action:${ACTION}`, ...AGENT_EDGES].sort())
    expect(tables.entity_link.map((e) => e.id)).toContain('cites-edge')
  })

  it('an agent’s edge survives every save, even one with no previous text', async () => {
    const db = memoryDb(tables)
    await syncDocumentLinks(db, WS, DOC, 'Nothing here.', ANA, ANA_USER, 'Nothing here before either.')
    await syncDocumentLinks(db, WS, DOC, 'Still nothing.', BEN, BEN_USER)
    expect(mentions()).toEqual([...AGENT_EDGES].sort())
  })

  it('Ana’s chip of her private event survives Bob’s save of the same body (a typo fixed)', async () => {
    const db = memoryDb(tables)
    const chip = mentionMarkdown({ type: 'calendar_event', id: ANA_EVENT, label: 'Ana’s offsite' })
    const anaBody = `Plan for ${chip} teh week`
    await syncDocumentLinks(db, WS, DOC, anaBody, ANA, ANA_USER, '')
    expect(mentions()).toContain(`calendar_event:${ANA_EVENT}`)
    // Bob can't read Ana's event; his save still names it, so its edge stays.
    await syncDocumentLinks(db, WS, DOC, `Plan for ${chip} the week`, BEN, BEN_USER, anaBody)
    expect(mentions()).toContain(`calendar_event:${ANA_EVENT}`)
    // Once the chip itself is gone from the text, its edge goes, whoever saves.
    await syncDocumentLinks(db, WS, DOC, 'Plan for the week', BEN, BEN_USER, `Plan for ${chip} the week`)
    expect(mentions()).not.toContain(`calendar_event:${ANA_EVENT}`)
  })

  it('chips come first: a long index of links can’t crowd them out', async () => {
    const many = Array.from({ length: MAX_MENTIONED_RECORDS + 5 }, (_, i) => `act-${i}`)
    tables.actions.push(
      ...many.map((_, i) => ({ id: `a1000000-0000-4000-8000-${String(i).padStart(12, '0')}`, workspace_id: WS, identifier: `FER-${i + 1}` })),
    )
    const identifiers = many.map((_, i) => `FER-${i + 1}`).join(' ')
    const db = memoryDb(tables)
    await syncDocumentLinks(db, WS, DOC, `${identifiers}\n\nOwner: ${mentionMarkdown({ type: 'flow', id: DEAL, label: 'Renewal' })}`, ANA, ANA_USER, '')
    const added = mentions().filter((m) => !AGENT_EDGES.includes(m))
    expect(added).toHaveLength(MAX_MENTIONED_RECORDS)
    expect(added).toContain(`flow:${DEAL}`)
  })
})
