/**
 * Migration 370: the write-a-document skill learns the documents phase 1
 * tools, as 368 taught the documents playbook. Text only. This pins the file:
 * one row, the write-a-document skill, rewriting the text 327 seeded, and that
 * text is what ships; the part tools named, each argument it names a real
 * field of that tool; propose_document_edit with the base_revision it now
 * requires; 368's draft-versus-live rule; the sentences phase 1 made untrue
 * gone; every other line of 327's text kept, in order; no backslash anywhere;
 * and an idempotent text-only update.
 */
import { describe, it, expect } from 'vitest'
import { ATTENDED_ONLY_TOOL_NAMES, TOOL_CATEGORIES } from '@/lib/ai/tool-registry'
import { registryToolInputSchemas } from '@/lib/ai/tool-schemas'
import { estimateTokens } from '../memory'
import {
  allShippedSkills,
  promptRewrites,
  PROMPT_REWRITE_MIGRATIONS,
  readMigration,
  seededSkills,
} from './playbook-seeds'

const FILE = '370_write_a_document_part_edits.sql'
const sql = readMigration(FILE)
const rows = promptRewrites(FILE)

const ID = 'a4b9263b-eb4d-4c57-afcc-7f8cd40bf1bb'
const SLUG = 'write-a-document'

/** 327's write-a-document: the text on DEV and PROD before this one. */
const SEEDED = seededSkills('327_docs_goals_tools_skills.sql').find((s) => s.id === ID && s.slug === SLUG)
const PREVIOUS = SEEDED?.prompt ?? ''
const TEXT = rows[0]?.prompt ?? ''

// Comments out: the statements only.
const BODY = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

const HEADINGS = ['Steps', 'Changing an existing page', 'The answer']

/** The part tools phase 1 added (tool-registry.ts), each named in the text. */
const PART_TOOLS = ['edit_document_lines', 'replace_section', 'append_to_section', 'remove_section', 'insert_section_after']

/** The arguments the text names, each with the tool whose input schema must hold it. */
const ARGS: Array<[tool: string, field: string]> = [
  ['get_document', 'full'],
  ['propose_document_edit', 'content'],
  ['propose_document_edit', 'base_revision'],
  ['edit_document_content', 'base_revision'],
  ['edit_document_lines', 'base_revision'],
  ['replace_section', 'base_revision'],
  ['append_to_section', 'base_revision'],
  ['remove_section', 'base_revision'],
  ['insert_section_after', 'base_revision'],
]

/**
 * The lines of 327's text this one rewrites, by how each began. Every other
 * line stays, word for word.
 */
const REWRITTEN = ["1. Check it doesn't exist:", "Never replace someone's page with a new one."]

/** True when `sub` appears in `all` in the same order. */
function isSubsequence(sub: readonly string[], all: readonly string[]): boolean {
  let i = 0
  for (const line of all) if (i < sub.length && line === sub[i]) i++
  return i === sub.length
}

describe('migration 370', () => {
  it('holds no backslash anywhere (the MCP transport decodes escapes) and sets a lock timeout', () => {
    expect(sql.includes(String.fromCharCode(92))).toBe(false)
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
  })

  it('says in its header that it is applied to DEV, then PROD, after 364 to 367', () => {
    expect(sql).toMatch(/Applied by hand, from this file: to DEV, then to PROD/)
    expect(sql).toContain('after 364 to 367')
  })

  it('rewrites one row, write-a-document, by id and slug, and is registered after 368 as the only text-only rewrite of it', () => {
    expect(rows.map((r) => ({ id: r.id, slug: r.slug }))).toEqual([{ id: ID, slug: SLUG }])
    expect(PROMPT_REWRITE_MIGRATIONS).toContain(FILE)
    expect(PROMPT_REWRITE_MIGRATIONS.indexOf(FILE)).toBeGreaterThan(PROMPT_REWRITE_MIGRATIONS.indexOf('368_documents_playbook_part_edits.sql'))
    // No other text-only rewrite touches this row: 327's text is what it
    // replaces, and its text is what ships (a later one, e.g. 391, rewrites other rows).
    for (const file of PROMPT_REWRITE_MIGRATIONS.filter((f) => f !== FILE)) {
      expect(promptRewrites(file).some((r) => r.id === ID), file).toBe(false)
    }
    expect(PREVIOUS).not.toBe('')
    expect(TEXT).not.toBe(PREVIOUS)
  })

  it('is the text that ships, with every other column as 327 left it', () => {
    const shipped = allShippedSkills().find((s) => s.id === ID)!
    expect(shipped.file).toBe(FILE)
    expect(shipped.prompt).toBe(TEXT)
    expect(shipped.description).toBe(SEEDED!.description)
    expect(shipped.config).toEqual(SEEDED!.config)
    expect(shipped.config.pack_only).toBe(true)
    expect(shipped.area).toBe('documents')
  })

  it("keeps 327's sections and stays within the recipe size", () => {
    expect([...TEXT.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(HEADINGS)
    expect([...PREVIOUS.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(HEADINGS)
    // playbook-accuracy.test.ts's RECIPE_MAX_TOKENS.
    expect(estimateTokens(TEXT)).toBeLessThanOrEqual(900)
  })

  it("keeps every line of 327's text it doesn't rewrite, word for word and in order", () => {
    const previous = PREVIOUS.split('\n')
    for (const start of REWRITTEN) {
      expect(previous.filter((l) => l.startsWith(start)), start).toHaveLength(1)
    }
    const kept = previous.filter((l) => !REWRITTEN.some((start) => l.startsWith(start)))
    expect(isSubsequence(kept, TEXT.split('\n'))).toBe(true)
  })

  it('names every part tool, each a documents tool in the registry, and no chat-only tool', () => {
    const documents = TOOL_CATEGORIES.find((c) => c.tools.some((t) => t.name === 'get_document'))!
    for (const name of PART_TOOLS) {
      expect(TEXT, name).toContain(`\`${name}\``)
      expect(documents.tools.some((t) => t.name === name), name).toBe(true)
    }
    const named = [...TEXT.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]).filter((w) => ATTENDED_ONLY_TOOL_NAMES.has(w))
    expect(named).toEqual([])
  })

  it('names only arguments the tools take', () => {
    const schemas = registryToolInputSchemas()
    for (const [tool, field] of ARGS) {
      const properties = (schemas.get(tool)?.properties ?? {}) as Record<string, unknown>
      expect(Object.keys(properties), `${tool}.${field}`).toContain(field)
      expect(TEXT, `${tool}.${field}`).toMatch(new RegExp('`' + field + '[`:]'))
    }
  })

  it('teaches the base_revision propose_document_edit now requires', () => {
    const required = (registryToolInputSchemas().get('propose_document_edit')?.required ?? []) as string[]
    expect(required).toContain('base_revision')
    expect(TEXT).toContain('`get_document`: it returns the `revision` you pass as `base_revision` when you write')
    expect(TEXT).toContain('`propose_document_edit` with the whole new `content` and the `revision` you read as `base_revision`')
  })

  it("keeps 368's draft-versus-live rule: your own wording is a draft, a change the person spelled out goes live as a part edit", () => {
    const playbook = allShippedSkills().find((s) => s.slug === 'documents-playbook')!.prompt
    for (const phrase of [
      'Your own wording on ',
      '(a rewrite, a section you write) goes in as a draft',
      'A change ',
      ' spelled out (fix this typo, add this line, drop that section), or any change to a page you just created, goes ',
      'read it again and redo the change',
    ]) {
      expect(TEXT, phrase).toContain(phrase)
      expect(playbook, phrase).toContain(phrase)
    }
    const draft = TEXT.split('\n').find((l) => l.startsWith('- Your own wording'))!
    expect(draft).toContain('`propose_document_edit`')
    expect(draft).toContain('Unless they just asked for this change, ask first')
    const live = TEXT.split('\n').find((l) => l.startsWith('- A change they spelled out'))!
    expect(live).toContain('goes live with a part tool')
    for (const name of ['edit_document_content', ...PART_TOOLS]) expect(live, name).toContain(`\`${name}\``)
    expect(live).not.toContain('`propose_document_edit`')
  })

  it('drops what phase 1 made untrue', () => {
    for (const stale of ['otherwise it searches only recent weeks', '`all_time: true`', 'only for a small fix they asked for outright']) {
      expect(PREVIOUS, stale).toContain(stale)
      expect(TEXT, stale).not.toContain(stale)
    }
    expect(TEXT).toContain('`find` with the topic (documents are searched in full)')
  })

  it('fails the apply loudly when the row is missing or not rewritten, never a silent no-op', () => {
    const guard = BODY.slice(BODY.indexOf('DO $guard$'))
    expect(guard).toContain(`WHERE id = '${ID}'::uuid AND slug = '${SLUG}' AND is_system`)
    expect(guard.match(/RAISE EXCEPTION/g)?.length).toBe(2)
    // The second check looks for words only the new text holds.
    for (const word of ['edit_document_lines', 'base_revision']) {
      expect(guard).toContain(`system_prompt LIKE '%${word}%'`)
      expect(TEXT).toContain(word)
      expect(PREVIOUS).not.toContain(word)
    }
    expect(BODY.indexOf('DO $guard$')).toBeGreaterThan(BODY.indexOf('UPDATE public.recipe'))
  })

  it('is idempotent and text only: by id, guarded by slug and is_system, only where the text differs', () => {
    // The statements without the skill text, whose words ("drop") aren't SQL.
    const statements = BODY.replace(/\$pb\$[\s\S]*?\$pb\$/g, () => 'skill')
    expect(statements.match(/\bUPDATE public\.\w+/g)).toEqual(['UPDATE public.recipe'])
    expect(statements).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|INSERT\s+INTO|DROP|ALTER)\b/i)
    expect(BODY).toContain('SET system_prompt = p.system_prompt, updated_at = now()')
    expect(BODY).toContain(
      'WHERE r.id = p.id AND r.slug = p.slug AND r.is_system AND r.system_prompt IS DISTINCT FROM p.system_prompt;',
    )
  })
})
