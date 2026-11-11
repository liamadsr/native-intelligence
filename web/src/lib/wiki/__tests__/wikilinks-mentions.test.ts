/**
 * A document's body mentions documents (wikilinks, `[[slug]]`), actions
 * (identifiers, `GEN-42`, drawn as chips) and people and records (`@` chips,
 * `[@Maya Chen](mention://contact/<id>)`): syncDocumentLinks keeps its
 * `mentions` edges to those kinds matched to the body, as a diff, through the
 * shared mention helper, each target fenced for the editor. A `mentions` edge
 * to a kind no body writes (an agent's link_entities to a decision) and other
 * relations survive. Fixtures are made up.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { DOCUMENT_MENTION_KINDS, parseActionIdentifiers, syncDocumentLinks } from '../wikilinks'
import { mentionMarkdown } from '@/lib/documents/mention-markdown'
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
const DECISION = 'e0000000-0000-4000-8000-0000000000de'
const BEN_CALL = 'c1000000-0000-4000-8000-000000000001'
const OPEN_FILE = 'f0000000-0000-4000-8000-000000000001'
const PRIVATE_FILE = 'f0000000-0000-4000-8000-000000000002'
const BEN_EVENT = 'e1000000-0000-4000-8000-000000000001'

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
    // Visible to Ana (contact-visibility's fence reads these through its RPC: absent here, so only
    // the kinds below are asserted).
    deal: [{ id: DEAL, workspace_id: WS, name: 'Harbor Coffee renewal' }],
    captures: [{ id: BEN_CALL, workspace_id: WS, visibility: 'private', user_id: BEN, is_eval: false }],
    attachments: [
      { id: OPEN_FILE, workspace_id: WS, user_id: BEN, note_id: null, action_id: ACTION, file_name: 'menu.pdf' },
      { id: PRIVATE_FILE, workspace_id: WS, user_id: BEN, note_id: BEN_CALL, file_name: 'salary.xlsx' },
    ],
    local_calendar_event: [{ id: BEN_EVENT, workspace_id: WS, user_id: BEN_USER, title: 'Dentist' }],
    entity_link: [
      // An agent's link to a decision, same relation: not a kind any body writes, so not the body's to remove.
      { id: 'agent-edge', workspace_id: WS, source_type: 'document', source_id: DOC, target_type: 'decision', target_id: DECISION, relation: 'mentions' },
      { id: 'cites-edge', workspace_id: WS, source_type: 'document', source_id: DOC, target_type: 'document', target_id: PRICING, relation: 'cites' },
    ],
  }
})

const mentions = () =>
  tables.entity_link
    .filter((e) => e.source_id === DOC && e.relation === 'mentions')
    .map((e) => `${e.target_type}:${e.target_id}`)
    .sort()

describe('syncDocumentLinks', () => {
  it('reads the identifiers a body names', () => {
    expect(parseActionIdentifiers('Do GEN-42 then GEN-42 and ISO-8601; not gen-1')).toEqual(['GEN-42', 'ISO-8601'])
  })

  it('manages every kind the one @ picker finds, and the wikilinked docs and named actions', () => {
    for (const kind of [...MENTION_PICKER_KINDS, 'document', 'action']) expect(DOCUMENT_MENTION_KINDS).toContain(kind)
    expect(DOCUMENT_MENTION_KINDS).not.toContain('decision')
  })

  it('links the wikilinked doc and the named action, never another member’s private doc', async () => {
    const db = memoryDb(tables)
    const res = await syncDocumentLinks(db, WS, DOC, 'See [[pricing]], [[ben-notes]], [[nowhere]] and GEN-42 (ISO-8601).', ANA, ANA_USER)
    expect(res.unresolved).toContain('nowhere')
    expect(mentions()).toEqual([`action:${ACTION}`, `decision:${DECISION}`, `document:${PRICING}`].sort())
    expect(tables.entity_link.find((e) => e.target_id === BEN_PRIVATE)).toBeUndefined()
  })

  it('an @ chip in the body is a mention edge: a deal, a file the editor may read; never a private file or another member’s event', async () => {
    const db = memoryDb(tables)
    const body = [
      `Renewal: ${mentionMarkdown({ type: 'deal', id: DEAL, label: 'Harbor Coffee renewal' })}.`,
      `Menu ${mentionMarkdown({ type: 'attachment', id: OPEN_FILE, label: 'menu.pdf' })}`,
      `and ${mentionMarkdown({ type: 'attachment', id: PRIVATE_FILE, label: 'salary.xlsx' })}`,
      `at ${mentionMarkdown({ type: 'calendar_event', id: BEN_EVENT, label: 'Dentist' })}`,
    ].join('\n')
    await syncDocumentLinks(db, WS, DOC, body, ANA, ANA_USER)
    expect(mentions()).toEqual([`attachment:${OPEN_FILE}`, `deal:${DEAL}`, `decision:${DECISION}`].sort())
  })

  it('an edit removes what the body no longer mentions (a chip deleted too), and keeps other kinds and relations', async () => {
    const db = memoryDb(tables)
    await syncDocumentLinks(db, WS, DOC, `See [[pricing]], GEN-42 and ${mentionMarkdown({ type: 'deal', id: DEAL, label: 'Renewal' })}.`, ANA, ANA_USER)
    expect(mentions()).toContain(`deal:${DEAL}`)
    await syncDocumentLinks(db, WS, DOC, 'Only GEN-42 now.', ANA)
    expect(mentions()).toEqual([`action:${ACTION}`, `decision:${DECISION}`].sort())
    expect(tables.entity_link.map((e) => e.id)).toContain('cites-edge')
  })
})
