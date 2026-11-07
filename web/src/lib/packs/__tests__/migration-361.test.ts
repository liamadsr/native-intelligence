/**
 * Migration 361: the flows playbook stops saying `bot_character` "picks one by
 * its face" (persona removal took the faces away). Pins the file: it replaces
 * that one sentence whole, in each wording a row can hold (338's "a bot", DEV's
 * "a bird" from the unmerged 350, 357's "an agent"), so every database ends on
 * the same text; the new sentence still describes `bot_character` (a real
 * create_flow / update_flow field) without faces; nothing else in the playbook
 * changes; the update is fenced on an old sentence, so a second run changes
 * nothing; and the file holds no backslash.
 *
 * The replace pairs are read from the SQL itself and applied to 338's text, so
 * this checks what ships.
 */
import { describe, it, expect } from 'vitest'
import { promptRewrites, readMigration } from './playbook-seeds'

const SQL = readMigration('361_flows_playbook_wording.sql')
// Comments out: the statements only.
const STMTS = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
const BODY = STMTS.replace(/\s+/g, ' ')

const ID = '1ef0c12f-5d78-41ef-ab12-714512fa03cd'
const SLUG = 'flows-playbook'

/** The SQL string literals in a chunk, unquoted ('' → '). */
function literals(chunk: string): string[] {
  return [...chunk.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"))
}

const set = STMTS.slice(STMTS.indexOf('SET system_prompt ='), STMTS.indexOf('updated_at = now()'))
const lits = literals(set)
const PAIRS: Array<[string, string]> = []
for (let i = 0; i < lits.length; i += 2) PAIRS.push([lits[i], lits[i + 1]])
const GUARDS = [...STMTS.matchAll(/strpos\(system_prompt, '((?:[^']|'')*)'\) > 0/g)].map((m) => m[1].replace(/''/g, "'"))
const OLDS = PAIRS.map(([from]) => from)
const NEW = PAIRS[0]?.[1] ?? ''

const apply = (text: string, pairs: ReadonlyArray<readonly [string, string]>) =>
  pairs.reduce((t, [from, to]) => t.split(from).join(to), text)

/** 338's flows-playbook: PROD's text before 357. */
const PROD = promptRewrites('338_skill_helper_lines.sql').find((r) => r.id === ID && r.slug === SLUG)?.prompt ?? ''
const BOT_LEAD = 'Every loop has a bot, the teammate'
/** DEV before 357 (350 said bird) and any row after 357 (agent): the same sentence, other lead words. */
const DEV = PROD.replace(BOT_LEAD, 'Every loop has a bird, the teammate')
const AFTER_357 = PROD.replace(BOT_LEAD, 'Every loop has an agent, the teammate')

describe('migration 361', () => {
  it('holds no backslash anywhere (the MCP transport decodes escapes) and sets a lock timeout', () => {
    expect(SQL.includes(String.fromCharCode(92))).toBe(false)
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
  })

  it('says in its header that it is applied to DEV, then PROD', () => {
    expect(SQL).toMatch(/Applied by hand, from this file: to DEV, then to PROD/)
  })

  it('only updates the flows-playbook recipe row: one UPDATE, fenced by id, slug and is_system', () => {
    expect(BODY.match(/\bUPDATE public\.\w+/g)).toEqual(['UPDATE public.recipe'])
    expect(BODY).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|INSERT\s+INTO|DROP|ALTER)\b/i)
    expect(BODY).toContain(`WHERE id = '${ID}'::uuid AND slug = '${SLUG}' AND is_system AND (`)
  })

  it('replaces the sentence in its bot, bird and agent wording, all with one new sentence', () => {
    expect(PROD).toContain(BOT_LEAD)
    expect(OLDS).toHaveLength(3)
    expect(OLDS.map((o) => o.slice(0, o.indexOf(', the teammate')))).toEqual([
      'Every loop has a bot',
      'Every loop has a bird',
      'Every loop has an agent',
    ])
    for (const o of OLDS) expect(o).toContain('`bot_character` picks one by its face, or leave it out for the default.')
    expect(new Set(PAIRS.map(([, to]) => to)).size).toBe(1)
  })

  it('the new sentence describes bot_character without faces', () => {
    expect(NEW).not.toMatch(/\bfaces?\b/i)
    expect(NEW).toContain('`bot_character` picks one by its character id')
    expect(NEW).toContain('or leave it out for the default.')
    expect(NEW.startsWith('Every loop has an agent, the teammate who tells the person about its runs: ')).toBe(true)
  })

  it('ends PROD, DEV and post-357 rows on the same text, with no "by its face" left', () => {
    const fromProd = apply(PROD, PAIRS)
    expect(apply(DEV, PAIRS)).toBe(fromProd)
    expect(apply(AFTER_357, PAIRS)).toBe(fromProd)
    expect(fromProd).not.toContain('picks one by its face')
    expect(fromProd.split(NEW).length - 1).toBe(1)
  })

  it('drops nothing: only that sentence changes, and undoing it gives back the text byte for byte', () => {
    for (const [base, old] of [[PROD, OLDS[0]], [DEV, OLDS[1]], [AFTER_357, OLDS[2]]] as const) {
      expect(base.split(old).length - 1, old).toBe(1)
      const after = apply(base, PAIRS)
      expect(after.split(NEW).join(old)).toBe(base)
      // Every other line is still there, word for word.
      const otherLines = base.split('\n').filter((l) => !l.includes(old))
      for (const line of otherLines) expect(after.includes(line), line).toBe(true)
    }
    for (const name of ['bot_character', 'bot_name', 'ai_team_member_id', 'list_flows', 'create_flow', 'update_flow']) {
      expect(apply(PROD, PAIRS).split(name).length, name).toBe(PROD.split(name).length)
    }
  })

  it('is idempotent: guarded on exactly the old sentences, and a second run changes nothing', () => {
    expect([...GUARDS].sort()).toEqual([...OLDS].sort())
    for (const from of OLDS) expect(NEW.includes(from)).toBe(false)
    const once = apply(PROD, PAIRS)
    expect(OLDS.some((o) => once.includes(o))).toBe(false)
    expect(apply(once, PAIRS)).toBe(once)
  })
})
