/**
 * Migration 368: the documents playbook learns the documents phase 1 tools
 * (partial reads, part edits, safe writes, version history). Text only. This
 * pins the file: one row, the documents playbook, rewriting the text 338 left,
 * and that text is what ships; every phase 1 tool named, each argument it
 * names a real field of that tool; restore_document_revision only in a chat,
 * when the person asks; the sentences phase 1 made untrue gone; every other
 * line of 338's text kept, in order; the five sections and 338's helper line;
 * no backslash anywhere; and an idempotent text-only update.
 */
import { describe, it, expect } from 'vitest'
import { ATTENDED_ONLY_TOOL_NAMES, TOOL_CATEGORIES } from '@/lib/ai/tool-registry'
import { registryToolInputSchemas } from '@/lib/ai/tool-schemas'
import { estimateTokens } from '../memory'
import {
  allShippedSkills,
  CORE_HELPER_LINE,
  promptRewrites,
  PROMPT_REWRITE_MIGRATIONS,
  readMigration,
  rewrittenAfter,
  seededSkills,
} from './playbook-seeds'

const FILE = '368_documents_playbook_part_edits.sql'
const sql = readMigration(FILE)
const rows = promptRewrites(FILE)

const ID = 'e8d88dec-0326-41b0-971e-f974c21cdefb'
const SLUG = 'documents-playbook'

/** 338's documents playbook: the text on DEV and PROD before this one. */
const PREVIOUS = promptRewrites('338_skill_helper_lines.sql').find((r) => r.id === ID && r.slug === SLUG)?.prompt ?? ''
const TEXT = rows[0]?.prompt ?? ''

// Comments out: the statements only.
const BODY = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

const CORE_HEADINGS = ["What's here", 'How to find things', 'Doing it well', 'Pitfalls', 'When to hand to a helper']

/** The tools phase 1 added (tool-registry.ts), each named in the text. */
const PHASE_1_TOOLS = [
  'edit_document_lines',
  'replace_section',
  'append_to_section',
  'remove_section',
  'insert_section_after',
  'list_document_revisions',
  'get_document_revision',
  'restore_document_revision',
]

/** The arguments the text names, each with the tool whose input schema must hold it. */
const ARGS: Array<[tool: string, field: string]> = [
  ['get_document', 'section'],
  ['get_document', 'lines'],
  ['get_document', 'match'],
  ['get_document', 'outline'],
  ['edit_document_content', 'old_text'],
  ['edit_document_content', 'base_revision'],
  ['edit_document_lines', 'base_revision'],
  ['replace_section', 'base_revision'],
  ['update_document', 'base_revision'],
  ['update_document', 'change_summary'],
  ['update_document', 'project_id'],
  ['publish_draft', 'overwrite'],
  ['publish_draft', 'change_summary'],
  ['get_document_revision', 'compare_to'],
  ['list_documents', 'include_reports'],
  ['list_documents', 'include_preps'],
]

/**
 * The lines of 338's text this one rewrites, by how each began. Every other
 * line stays, word for word.
 */
const REWRITTEN = [
  '- A document is a markdown page in the workspace',
  '- Two ways to change one: straight to the live page',
  '1. "What do we have on pricing"',
  '2. `list_documents` lists them',
  '3. `get_document` returns the live content',
  '5. `show` with `entity_type: document`',
  "- To change someone's existing page, prefer a draft",
  '- `edit_document_content` replaces one exact passage on the live page',
  "- `publish_draft` publishes the person's pending draft",
  '- A live edit is overwritten if the person later publishes an older draft.',
  "- Don't duplicate: `find` (with `all_time: true`)",
]

/** True when `sub` appears in `all` in the same order. */
function isSubsequence(sub: readonly string[], all: readonly string[]): boolean {
  let i = 0
  for (const line of all) if (i < sub.length && line === sub[i]) i++
  return i === sub.length
}

describe('migration 368', () => {
  it('holds no backslash anywhere (the MCP transport decodes escapes) and sets a lock timeout', () => {
    expect(sql.includes(String.fromCharCode(92))).toBe(false)
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
  })

  it('says in its header that it is applied to DEV, then PROD, after 364 to 367', () => {
    expect(sql).toMatch(/Applied by hand, from this file: to DEV, then to PROD/)
    expect(sql).toContain('after 364 to 367')
  })

  it('rewrites one row, the documents playbook, by id and slug, and is registered as a text-only rewrite after 338', () => {
    expect(rows.map((r) => ({ id: r.id, slug: r.slug }))).toEqual([{ id: ID, slug: SLUG }])
    expect(PROMPT_REWRITE_MIGRATIONS.indexOf(FILE)).toBeGreaterThan(PROMPT_REWRITE_MIGRATIONS.indexOf('338_skill_helper_lines.sql'))
    expect(rewrittenAfter('338_skill_helper_lines.sql', ID, SLUG)).toBe(FILE)
    expect(PREVIOUS).not.toBe('')
    expect(TEXT).not.toBe(PREVIOUS)
  })

  it('is the text that ships, with every other column as 327 left it', () => {
    const shipped = allShippedSkills().find((s) => s.id === ID)!
    expect(shipped.file).toBe(FILE)
    expect(shipped.prompt).toBe(TEXT)
    const seeded = seededSkills('327_docs_goals_tools_skills.sql').find((s) => s.id === ID)!
    expect(shipped.description).toBe(seeded.description)
    expect(shipped.config).toEqual(seeded.config)
    expect(shipped.area).toBe('documents')
  })

  it("keeps the five sections, 338's helper line, and the core's size", () => {
    expect([...TEXT.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(CORE_HEADINGS)
    expect(TEXT.split('## When to hand to a helper\n')[1]).toBe(CORE_HELPER_LINE)
    expect(estimateTokens(TEXT)).toBeLessThanOrEqual(2000)
  })

  it("keeps every line of 338's text it doesn't rewrite, word for word and in order", () => {
    const previous = PREVIOUS.split('\n')
    for (const start of REWRITTEN) {
      expect(previous.filter((l) => l.startsWith(start)), start).toHaveLength(1)
    }
    const kept = previous.filter((l) => !REWRITTEN.some((start) => l.startsWith(start)))
    expect(isSubsequence(kept, TEXT.split('\n'))).toBe(true)
  })

  it('names every phase 1 tool, each a documents tool in the registry', () => {
    const documents = TOOL_CATEGORIES.find((c) => c.tools.some((t) => t.name === 'get_document'))!
    for (const name of PHASE_1_TOOLS) {
      expect(TEXT, name).toContain(`\`${name}\``)
      expect(documents.tools.some((t) => t.name === name), name).toBe(true)
    }
  })

  it('names only arguments the tools take', () => {
    const schemas = registryToolInputSchemas()
    for (const [tool, field] of ARGS) {
      const properties = (schemas.get(tool)?.properties ?? {}) as Record<string, unknown>
      expect(Object.keys(properties), `${tool}.${field}`).toContain(field)
      expect(TEXT, `${tool}.${field}`).toMatch(new RegExp('`' + field + '[`:]'))
    }
  })

  it('teaches reading part of a page, changing part of it, safe writes and the whole-body rule', () => {
    expect(TEXT).toContain('read just the part you need with `section` (a heading), `lines` (from and to) or `match`')
    expect(TEXT).toContain('Change the part, not the page.')
    expect(TEXT).toContain('`edit_document_lines` replaces, inserts or deletes lines by number. It needs `base_revision`')
    expect(TEXT).toContain('`update_document` replaces the whole body and needs `base_revision`')
    expect(TEXT).toContain('Every write is safe against someone else\'s edit')
    expect(TEXT).toContain('Each write returns the new `revision`')
    expect(TEXT).toContain('read it again and redo the change on the new text')
  })

  it('keeps restore for the person: only in a chat, when they ask, and the text names no other chat-only tool', () => {
    expect(ATTENDED_ONLY_TOOL_NAMES.has('restore_document_revision')).toBe(true)
    const named = [...new Set([...TEXT.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]))].filter((w) => ATTENDED_ONLY_TOOL_NAMES.has(w))
    expect(named).toEqual(['restore_document_revision'])
    const line = TEXT.split('\n').find((l) => l.includes('`restore_document_revision`'))!
    expect(line).toContain('Only in a chat, when the person asks for it.')
  })

  it('drops what phase 1 made untrue', () => {
    expect(PREVIOUS).toContain('a live edit keeps none')
    for (const stale of [
      'a live edit keeps none',
      'Neither keeps a revision',
      'A live edit is overwritten if the person later publishes an older draft',
      'otherwise it searches only recent weeks',
    ]) {
      expect(TEXT, stale).not.toContain(stale)
    }
  })

  it('fails the apply loudly when the row is missing or not rewritten, never a silent no-op', () => {
    const guard = BODY.slice(BODY.indexOf('DO $guard$'))
    expect(guard).toContain(`WHERE id = '${ID}'::uuid AND slug = '${SLUG}' AND is_system`)
    expect(guard.match(/RAISE EXCEPTION/g)?.length).toBe(2)
    // The second check looks for words only the new text holds.
    for (const word of ['edit_document_lines', 'restore_document_revision']) {
      expect(guard).toContain(`system_prompt LIKE '%${word}%'`)
      expect(TEXT).toContain(word)
      expect(PREVIOUS).not.toContain(word)
    }
    expect(BODY.indexOf('DO $guard$')).toBeGreaterThan(BODY.indexOf('UPDATE public.recipe'))
  })

  it('teaches the base_revision propose_document_edit now requires', () => {
    expect(TEXT).toContain('`propose_document_edit` with the whole new `content` and the `revision` you read as `base_revision`')
  })

  it('is idempotent and text only: by id, guarded by slug and is_system, only where the text differs', () => {
    // The statements without the playbook text, whose words ("drop") aren't SQL.
    const statements = BODY.replace(/\$pb\$[\s\S]*?\$pb\$/g, () => 'playbook')
    expect(statements.match(/\bUPDATE public\.\w+/g)).toEqual(['UPDATE public.recipe'])
    expect(statements).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|INSERT\s+INTO|DROP|ALTER)\b/i)
    expect(BODY).toContain('SET system_prompt = p.system_prompt, updated_at = now()')
    expect(BODY).toContain(
      'WHERE r.id = p.id AND r.slug = p.slug AND r.is_system AND r.system_prompt IS DISTINCT FROM p.system_prompt;',
    )
  })
})
