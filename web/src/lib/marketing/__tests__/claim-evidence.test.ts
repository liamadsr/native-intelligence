/**
 * evidenceFromSources: what an edit's cited rows show, for gradeClaim.
 * Pinned (P8 review B1, S2):
 *   - only this workspace's rows count, never an eval capture;
 *   - one company is counted once: folded the way the screen folds a company
 *     ("Acme Inc" = "Acme" = acme.com mail), members, the recorder and our
 *     own company never;
 *   - a document counts only when a person wrote it: an agent-created doc,
 *     an outside-derived doc, a private one, a report or a canon doc never
 *     lifts a grade, and the edited doc is never its own proof;
 *   - a failed read counts nothing.
 */
import { describe, expect, it } from 'vitest'
import { filterDb } from '@/test/filter-db'
import { emailCompanyKey, evidenceFromSources } from '../claim-evidence'
import { gradeClaim } from '../grade'

const WS = 'ws-1'
const NONE = { companies: 0, documents: 0, metrics: 0 }

let n = 0
/** A participant; each a different person unless the row says otherwise (external_name is required by the table). */
const part = (capture: string, p: Record<string, unknown>) => ({ capture_id: capture, member_id: null, is_self: false, company: null, contact_id: null, external_email: null, external_name: `Guest ${++n}`, ...p })

describe('companies', () => {
  const tables = {
    captures: [
      { id: 'c1', workspace_id: WS, is_eval: false },
      { id: 'c2', workspace_id: WS, is_eval: false },
      { id: 'c3', workspace_id: WS, is_eval: true },
      { id: 'c9', workspace_id: 'other', is_eval: false },
    ],
    capture_participant: [
      // Acme three ways: its CRM company, the company it gave, its mail domain.
      part('c1', { contact_id: 'k1', company: 'ACME' }),
      part('c2', { company: 'The Acme Inc.' }),
      part('c2', { external_email: 'sam@acme.com' }),
      // Members, the recorder and our own company are never a company.
      part('c1', { member_id: 'm1', company: 'Globex' }),
      part('c1', { is_self: true, company: 'Globex' }),
      part('c2', { company: 'Dial8' }),
      part('c2', { external_email: 'me@gmail.com' }),
      // Initech, on an eval capture and a call in another workspace: not counted.
      part('c3', { company: 'Initech' }),
      part('c9', { company: 'Initech' }),
    ],
    contact: [{ id: 'k1', workspace_id: WS, company_id: 'co-acme' }],
    company: [
      { id: 'co-acme', workspace_id: WS, name: 'Acme', is_workspace_company: false, domain: 'acme.com' },
      { id: 'co-us', workspace_id: WS, name: 'Dial8 Inc', is_workspace_company: true, domain: 'dial8.ai' },
    ],
  }

  it('counts one company once, whichever way it was named, and never a member or ourselves', async () => {
    const e = await evidenceFromSources(filterDb(tables), WS, [{ kind: 'capture', id: 'c1' }, { kind: 'capture', id: 'c2' }])
    expect(e).toEqual({ companies: 1, people: 3, documents: 0, metrics: 0 })
    expect(gradeClaim(e)).toBe('assumption')
  })

  it('two real companies make it proven; an eval call or another workspace’s never counts', async () => {
    const two = { ...tables, capture_participant: [...tables.capture_participant, part('c2', { company: 'Globex Corporation' })] }
    expect(await evidenceFromSources(filterDb(two), WS, [{ kind: 'capture', id: 'c1' }, { kind: 'capture', id: 'c2' }])).toMatchObject({ companies: 2 })
    expect(await evidenceFromSources(filterDb(tables), WS, [{ kind: 'capture', id: 'c3' }, { kind: 'capture', id: 'c9' }])).toMatchObject(NONE)
  })

  it('one company per PERSON (P9 review S8): one person twice, or spelled two ways, is one company; proven needs two people', async () => {
    const t = {
      captures: [
        { id: 'c1', workspace_id: WS, is_eval: false },
        { id: 'c2', workspace_id: WS, is_eval: false },
      ],
      capture_participant: [
        // The same contact on two calls, giving two companies: one person, one company.
        part('c1', { contact_id: 'k1', company: 'Acme' }),
        part('c2', { contact_id: 'k1', company: 'Globex' }),
        // The same name twice without a contact, two spellings: still one person.
        part('c1', { external_name: 'Dana Whit', company: 'Initech' }),
        part('c2', { external_name: 'dana whit', company: 'Initech Holdings' }),
      ],
      contact: [{ id: 'k1', workspace_id: WS, company_id: null }],
      company: [],
    }
    const e = await evidenceFromSources(filterDb(t), WS, [{ kind: 'capture', id: 'c1' }, { kind: 'capture', id: 'c2' }])
    expect(e).toMatchObject({ companies: 2, people: 2 })
    expect(gradeClaim(e)).toBe('proven')
    // Two companies from ONE person are not proof.
    expect(gradeClaim({ companies: 2, people: 1, documents: 0, metrics: 0 })).toBe('assumption')
    // The same person on two calls, giving two spellings of one company, is one company.
    const one = { ...t, capture_participant: [part('c1', { contact_id: 'k1', company: 'Acme' }), part('c2', { contact_id: 'k1', company: 'Acme Inc' })] }
    expect(await evidenceFromSources(filterDb(one), WS, [{ kind: 'capture', id: 'c1' }, { kind: 'capture', id: 'c2' }])).toMatchObject({ companies: 1, people: 1 })
  })

  it('reads a mail domain as its company, and free mail as nobody', () => {
    expect(emailCompanyKey('sam@acme.com')).toBe('acme')
    expect(emailCompanyKey('sam@mail.acme.co.uk')).toBe('acme')
    expect(emailCompanyKey('sam@gmail.com')).toBe('')
    expect(emailCompanyKey(null)).toBe('')
  })
})

describe('documents', () => {
  const doc = (id: string, p: Record<string, unknown> = {}) => ({ id, workspace_id: WS, visibility: 'workspace', kind: 'doc', canon_key: null, outside_derived: false, ...p })
  const human = (document_id: string) => ({ document_id, workspace_id: WS, author_kind: 'human' })
  const agent = (document_id: string) => ({ document_id, workspace_id: WS, author_kind: 'agent' })
  const tables = {
    document: [
      doc('d-human'),
      doc('d-agent'),
      doc('d-outside', { outside_derived: true }),
      doc('d-private', { visibility: 'private' }),
      doc('d-report', { kind: 'report' }),
      doc('d-canon', { canon_key: 'product' }),
    ],
    document_revision: [human('d-human'), agent('d-agent'), human('d-outside'), human('d-private'), human('d-report'), human('d-canon')],
  }
  const cite = (id: string) => [{ kind: 'document' as const, id }]

  it('a document a person wrote is proof', async () => {
    const e = await evidenceFromSources(filterDb(tables), WS, cite('d-human'))
    expect(e.documents).toBe(1)
    expect(gradeClaim(e)).toBe('proven')
  })

  it('an agent-created document never lifts a grade (review B1)', async () => {
    expect((await evidenceFromSources(filterDb(tables), WS, cite('d-agent'))).documents).toBe(0)
    // Created by a tool and never edited: no revision at all.
    expect((await evidenceFromSources(filterDb({ ...tables, document: [doc('d-new')] }), WS, cite('d-new'))).documents).toBe(0)
  })

  it('only the CURRENT text counts: an agent’s edit on top of a person’s never rides their old revision (verification B1)', async () => {
    const rev = (n: number, author_kind: string) => ({ document_id: 'd-wiki', workspace_id: WS, revision_number: n, author_kind })
    const wiki = (revisions: Record<string, unknown>[]) => filterDb({ document: [doc('d-wiki')], document_revision: revisions })
    // A person wrote it, then an agent appended "customers confirm…": not proof.
    expect((await evidenceFromSources(wiki([rev(1, 'human'), rev(2, 'agent')]), WS, cite('d-wiki'))).documents).toBe(0)
    expect((await evidenceFromSources(wiki([rev(2, 'agent'), rev(3, 'system'), rev(1, 'human')]), WS, cite('d-wiki'))).documents).toBe(0)
    // A person's edit on top of an agent's: their text now, so it counts.
    expect((await evidenceFromSources(wiki([rev(1, 'agent'), rev(2, 'human')]), WS, cite('d-wiki'))).documents).toBe(1)
  })

  it('an outside-derived document never lifts a grade, even with a person’s edit', async () => {
    expect((await evidenceFromSources(filterDb(tables), WS, cite('d-outside'))).documents).toBe(0)
  })

  it('nor a private document, a report, a canon doc, or the edited doc itself', async () => {
    for (const id of ['d-private', 'd-report', 'd-canon']) expect((await evidenceFromSources(filterDb(tables), WS, cite(id))).documents, id).toBe(0)
    expect((await evidenceFromSources(filterDb(tables), WS, cite('d-human'), 'd-human')).documents).toBe(0)
  })

  it('a cited claim counts through its own sources, in this workspace only', async () => {
    const withClaims = {
      ...tables,
      claim: [{ id: 'cl1', workspace_id: WS }, { id: 'cl2', workspace_id: 'other' }],
      claim_source: [
        { claim_id: 'cl1', source_type: 'document', source_id: 'd-human' },
        { claim_id: 'cl2', source_type: 'document', source_id: 'd-human' },
      ],
    }
    expect((await evidenceFromSources(filterDb(withClaims), WS, [{ kind: 'claim', id: 'cl1' }])).documents).toBe(1)
    expect((await evidenceFromSources(filterDb(withClaims), WS, [{ kind: 'claim', id: 'cl2' }])).documents).toBe(0)
  })
})

describe('what proves nothing', () => {
  it('a web page or the chat; a failed read counts nothing', async () => {
    expect(await evidenceFromSources(filterDb({}), WS, [{ kind: 'web', url: 'https://acme.com' }, { kind: 'chat' }])).toMatchObject(NONE)
    expect(await evidenceFromSources(filterDb({}, ['captures']), WS, [{ kind: 'capture', id: 'c1' }])).toEqual(NONE)
  })
})
