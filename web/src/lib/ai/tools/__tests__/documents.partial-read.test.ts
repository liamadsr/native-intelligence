/**
 * get_document reads just the part you need (documents phase 1, item 3):
 * outline, a section by heading, a line range, or the passages around a
 * phrase. A short document comes back whole; a long one comes back as its
 * outline and how to read part of it, so the middle of a long document is
 * never past the chat agent's output cap. Every read names the revision; a
 * partial read reads no links; a generated page's text stays marked as
 * outside text whichever part is read.
 */
import { describe, expect, it } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createFakeSupabase, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import { createDocumentTools, LONG_DOCUMENT_CHARS } from '../documents'

const USER = 'user-1'
const WS = 'ws-1'
const DOC = '11111111-1111-4111-8111-111111111111'
const OPTS = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>
type Result = Record<string, unknown> & { success: boolean; error?: string; document?: Record<string, unknown> }

const SHORT = '# Plan\n\n## Goals\nShip it.\n\n## Risks\nNone yet.'
const filler = (n: number) => Array.from({ length: n }, (_, i) => `Filler sentence number ${i} about nothing in particular.`).join('\n')
const LONG = `# Big\n\n## Start\n${filler(150)}\n\n## Middle\nThe pricing decision: annual plans only.\n${filler(150)}\n\n## End\nDone.`

function tools(content: string, frontmatter: Record<string, unknown> = {}) {
  const fake = createFakeSupabase((q: FakeQuery): FakeResult => {
    if (q.table === 'member') return { data: { id: 'mem-1', workspace_id: WS }, error: null }
    if (q.table === 'document') {
      return { data: { id: DOC, workspace_id: WS, title: 'Plan', content, frontmatter, tags: [], revision: 7, project: null, author: null }, error: null }
    }
    if (q.table === 'entity_link') return { data: [], error: null }
    return { data: null, error: null }
  })
  return { ...fake, get: (args: Record<string, unknown>) => createDocumentTools(USER, fake.client, WS).get_document.execute!({ document_id: DOC, ...args } as never, OPTS) as Promise<Result> }
}

describe('get_document', () => {
  it('a short document comes back whole, with its revision and size', async () => {
    const r = await tools(SHORT).get({})
    expect(r.document).toMatchObject({ content: SHORT, revision: 7, chars: SHORT.length, line_count: 7 })
    expect(r).not.toHaveProperty('long_document')
  })

  it('a long one comes back as its outline and how to read part of it', async () => {
    expect(LONG.length).toBeGreaterThan(LONG_DOCUMENT_CHARS)
    const r = await tools(LONG).get({})
    expect(r.document).not.toHaveProperty('content')
    expect(r.long_document).toBe(true)
    expect(String(r.how_to_read)).toMatch(/section.*lines.*match/)
    expect((r.outline as Array<{ heading: string }>).map((e) => e.heading)).toEqual(['Big', 'Start', 'Middle', 'End'])
    // full: true still reads the whole body.
    expect((await tools(LONG).get({ full: true })).document).toMatchObject({ content: LONG })
  })

  it('outline: headings with level, line and size, no body', async () => {
    const r = await tools(SHORT).get({ outline: true })
    expect(r.document).not.toHaveProperty('content')
    expect(r.outline).toEqual([
      { heading: 'Plan', level: 1, line: 1, end_line: 7, chars: SHORT.length },
      { heading: 'Goals', level: 2, line: 3, end_line: 5, chars: '## Goals\nShip it.\n'.length },
      { heading: 'Risks', level: 2, line: 6, end_line: 7, chars: '## Risks\nNone yet.'.length },
    ])
  })

  it('section: that section only, with where it is; no links read', async () => {
    const t = tools(LONG)
    const r = await t.get({ section: 'middle' })
    expect(r.section).toMatchObject({ heading: 'Middle', path: 'Big > Middle', level: 2 })
    expect(String(r.text).startsWith('## Middle\nThe pricing decision: annual plans only.')).toBe(true)
    expect(String(r.text)).not.toContain('## End')
    expect(r.document).toMatchObject({ revision: 7 })
    expect(t.log.some((q) => q.table === 'entity_link')).toBe(false)
  })

  it('section: a missing or ambiguous heading is refused with the candidates', async () => {
    const missing = await tools(SHORT).get({ section: 'Roadmap' })
    expect(missing.success).toBe(false)
    expect(missing.error).toMatch(/No heading matches "Roadmap".*"Plan > Goals" \(line 3\)/)
    const twice = await tools(`${SHORT}\n\n## Goals\nAgain.`).get({ section: 'Goals' })
    expect(twice.error).toMatch(/More than one heading matches "Goals"/)
  })

  it('lines: numbered, clamped to the document', async () => {
    const r = await tools(SHORT).get({ lines: { from: 6, to: 99 } })
    expect(r).toMatchObject({ from_line: 6, to_line: 7, text: '6: ## Risks\n7: None yet.' })
    expect((await tools(SHORT).get({ lines: { from: 50, to: 60 } })).success).toBe(false)
  })

  it('match: the passage in the middle of a long document, with its line and section', async () => {
    const r = await tools(LONG).get({ match: 'pricing decision', context_lines: 1 })
    const passages = r.passages as Array<{ match_lines: number[]; section: string; text: string }>
    expect(r).toMatchObject({ match_mode: 'exact', total_matches: 1 })
    expect(passages).toHaveLength(1)
    expect(passages[0].section).toBe('Big > Middle')
    expect(passages[0].text).toContain(': The pricing decision: annual plans only.')
    expect(passages[0].text.split('\n')).toHaveLength(3)
  })

  it('a generated page stays marked as outside text in a partial read', async () => {
    const r = await tools(SHORT, { generated: true, source_attachment_id: 'att-1' }).get({ section: 'Risks' })
    expect(String(r.text)).not.toBe('## Risks\nNone yet.')
    expect(String(r.text)).toContain('## Risks\nNone yet.')
  })
})
