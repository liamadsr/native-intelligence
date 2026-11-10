/**
 * A document's body mentions documents (wikilinks, `[[slug]]`) and actions
 * (identifiers, `GEN-42`, drawn as chips): syncDocumentLinks keeps its
 * `mentions` edges to those two kinds matched to the body, as a diff, through
 * the shared mention helper, each target fenced for the editor. Other kinds'
 * `mentions` edges (an agent's link_entities) and other relations survive.
 * Fixtures are made up.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { parseActionIdentifiers, syncDocumentLinks } from '../wikilinks'

const WS = '11111111-1111-4111-8111-111111111111'
const ANA_USER = '22222222-2222-4222-8222-aaaaaaaaaaaa'
const ANA = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const BEN = '33333333-3333-4333-8333-bbbbbbbbbbbb'
const DOC = 'd0000000-0000-4000-8000-000000000001'
const PRICING = 'd0000000-0000-4000-8000-000000000002'
const BEN_PRIVATE = 'd0000000-0000-4000-8000-000000000003'
const ACTION = 'a0000000-0000-4000-8000-000000000042'
const CONTACT = 'c0000000-0000-4000-8000-000000000001'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>

beforeEach(() => {
  tables = {
    member: [
      { id: ANA, user_id: ANA_USER, workspace_id: WS },
      { id: BEN, user_id: 'someone-else', workspace_id: WS },
    ],
    document: [
      { id: DOC, workspace_id: WS, slug: 'launch-plan', visibility: 'workspace', created_by: ANA },
      { id: PRICING, workspace_id: WS, slug: 'pricing', visibility: 'workspace', created_by: ANA },
      { id: BEN_PRIVATE, workspace_id: WS, slug: 'ben-notes', visibility: 'private', created_by: BEN },
    ],
    actions: [{ id: ACTION, workspace_id: WS, identifier: 'GEN-42' }],
    entity_link: [
      // An agent's link to a contact, same relation: not the body's to remove.
      { id: 'agent-edge', workspace_id: WS, source_type: 'document', source_id: DOC, target_type: 'contact', target_id: CONTACT, relation: 'mentions' },
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

  it('links the wikilinked doc and the named action, never another member’s private doc', async () => {
    const db = memoryDb(tables)
    const res = await syncDocumentLinks(db, WS, DOC, 'See [[pricing]], [[ben-notes]], [[nowhere]] and GEN-42 (ISO-8601).', ANA, ANA_USER)
    expect(res.unresolved).toContain('nowhere')
    expect(mentions()).toEqual([`action:${ACTION}`, `contact:${CONTACT}`, `document:${PRICING}`].sort())
    expect(tables.entity_link.find((e) => e.target_id === BEN_PRIVATE)).toBeUndefined()
  })

  it('an edit removes what the body no longer mentions, and keeps other kinds and relations', async () => {
    const db = memoryDb(tables)
    await syncDocumentLinks(db, WS, DOC, 'See [[pricing]] and GEN-42.', ANA, ANA_USER)
    await syncDocumentLinks(db, WS, DOC, 'Only GEN-42 now.', ANA)
    expect(mentions()).toEqual([`action:${ACTION}`, `contact:${CONTACT}`].sort())
    expect(tables.entity_link.map((e) => e.id)).toContain('cites-edge')
  })
})
