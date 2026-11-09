/**
 * No canon path raises a card (decision 16 as Liam settled it on 2026-10-20:
 * "The agent should just go ahead and do it… Just give me the option to undo
 * it"). An agent's edit to a canon document applies, with its history and one
 * digest line, and is undone from the history; nothing waits on a person.
 *
 * Pinned two ways:
 *   - by source: no module on a canon write path (the section edit, its
 *     sources and label, freshness, the canon tools, the doc_proposals
 *     connector, the marketing lens and its regrade) names attention_item,
 *     and none keeps the old hold or card helpers;
 *   - by behaviour: an outside-sourced section edit and the nightly
 *     freshness pass, run against a recording fake, never touch
 *     attention_item.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'

vi.mock('@/lib/ai/embeddings', () => ({ indexDocument: vi.fn(async () => {}) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => {}) } }))
const logs = vi.hoisted(() => ({ lines: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/log/agent-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/log/agent-log')>()),
  appendLogLine: vi.fn(async (input: Record<string, unknown>) => {
    logs.lines.push(input)
    return true
  }),
}))
vi.mock('../access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../access')>()),
  loadDocumentAccess: vi.fn(async () => ({
    access: { role: 'admin', memberId: 'm1', isProductDoc: true, row: { id: 'd1', workspace_id: 'w', created_by: 'm1', type: 'note', slug: null, published_status: 'published', frontmatter: {}, project_id: null, canon_key: 'product', visibility: 'workspace' } },
    error: null,
  })),
}))

import { applyCanonSectionEdit } from '../canon-edit'
import { runCanonFreshness } from '../canon-freshness'

const CANON_WRITE_PATHS = [
  'src/lib/documents/canon-edit.ts',
  'src/lib/documents/canon-sources.ts',
  'src/lib/documents/canon-freshness.ts',
  'src/lib/ai/tools/canon.ts',
  'src/lib/flows/deliver-connector.ts',
  'src/lib/flows/lens-deliver.ts',
  'src/lib/marketing/regrade.ts',
]
const GONE = ['holdCanonEdit', 'heldEditFromPayload', 'heldEditCopy', 'decideCanonEditHold', 'accessCardKey', 'heldCardKey', 'raiseStillTrueCard', 'stillTrueFromPayload', 'canonCardCopy', 'canon_edit:', 'canon_access:', 'canon_check:']

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('no canon path raises a card: by source', () => {
  it.each(CANON_WRITE_PATHS)('%s names no attention_item and keeps no hold or card helper', (path) => {
    const text = source(path)
    // The doc_proposals connector shares its file with the post cards (insert_post_draft_card): only its section is checked.
    const body = path.endsWith('deliver-connector.ts') ? text.slice(text.indexOf('// ── doc_proposals'), text.indexOf('// ── email_drafts')) : text
    expect(body).not.toMatch(/attention_item/)
    for (const name of GONE) expect(body, name).not.toContain(name)
  })

  it('the canon card copy and its settle path are gone', () => {
    expect(() => source('src/lib/documents/canon-card-copy.ts')).toThrow()
    const settle = source('src/lib/attention/settle-card.ts')
    for (const name of ['heldEditFromPayload', 'stillTrueFromPayload', 'acceptCanonEditCard', 'CANON_CARD_PERSON_ONLY']) expect(settle, name).not.toContain(name)
  })
})

/** A fake that records every table the code touches. */
function recording() {
  const db = makeFakeSupabase()
  const touched = new Set<string>()
  const from = db.from.bind(db)
  ;(db as unknown as { from: (t: string) => unknown }).from = (table: string) => {
    touched.add(table)
    return from(table)
  }
  return { db, touched }
}

beforeEach(() => {
  logs.lines = []
})

describe('no canon path raises a card: by behaviour', () => {
  it('an outside-sourced section edit applies, with its labelled digest line, and touches no card', async () => {
    const { db, touched } = recording()
    db.seed('document', [{ id: 'd1', workspace_id: 'w', title: 'Product', content: '## Positioning\nVs spreadsheets.\n', revision: 2, project_id: null, canon_key: 'product' }])
    const r = await applyCanonSectionEdit(db as never, {
      workspaceId: 'w',
      userId: 'u',
      documentId: 'd1',
      key: 'product',
      section: 'Positioning',
      op: 'append',
      text: 'Cheaper than Gong.',
      sources: [{ kind: 'web', url: 'https://gong.example/pricing' }],
      outside: 'a web page on gong.example',
    })
    expect(r.ok).toBe(true)
    expect(String(db.rows('document')[0].content)).toContain('Cheaper than Gong.')
    expect(logs.lines.some((l) => l.line === 'Native Intelligence updated Positioning in Product (from a web page on gong.example)')).toBe(true)
    expect(touched.has('attention_item')).toBe(false)
  })

  it('the nightly freshness pass over a stale document touches no card', async () => {
    const { db, touched } = recording()
    db.seed('document', [{ id: 'd1', workspace_id: 'w', title: 'Product', content: '## Positioning\nVs spreadsheets.\n', canon_key: 'product', created_by: 'm1', last_edited_by: 'm1', updated_at: '2026-01-01T00:00:00Z', status: 'active' }])
    await runCanonFreshness(db as never, 'w')
    expect(touched.has('attention_item')).toBe(false)
  })
})
