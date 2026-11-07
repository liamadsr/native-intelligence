/**
 * Migration 357: agents, not bots (or birds). Seed text only (Liam,
 * 2026-10-17: the bot/bird persona is gone). Pins the file: it rewords the
 * work-agent anchor recipe and five lines of the flows and library playbooks,
 * matching both PROD's text (302 and 338, "bot") and DEV's (338 then the
 * unmerged 350, "bird"), so both end on the same text; it replaces whole
 * phrases only, so the rest of each playbook (tool names like `bot_character`
 * included) is untouched; every update is fenced on an old phrase, so it is
 * safe to run twice; and it holds no backslash.
 *
 * The replace pairs are read from the SQL itself and applied to 338's text,
 * so this checks what ships.
 */
import { describe, it, expect } from 'vitest'
import { promptRewrites, readMigration } from './playbook-seeds'

const FILE = '357_agent_not_bot.sql'
const SQL = readMigration(FILE)
// Comments out: the statements only.
const STMTS = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
const BODY = STMTS.replace(/\s+/g, ' ')

const FLOWS = { id: '1ef0c12f-5d78-41ef-ab12-714512fa03cd', slug: 'flows-playbook' } as const
const LIBRARY = { id: '800dc79b-a55f-4ef5-802d-8a6945e38460', slug: 'library-playbook' } as const

/** The SQL string literals in a chunk, unquoted ('' → '). */
function literals(chunk: string): string[] {
  return [...chunk.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"))
}

/** One playbook UPDATE: its replace pairs (in order) and its strpos guards. */
function playbookUpdate(slug: string) {
  const start = STMTS.indexOf(`AND slug = '${slug}'`)
  const head = STMTS.lastIndexOf('UPDATE public.recipe', start)
  const end = STMTS.indexOf(';', start)
  const stmt = STMTS.slice(head, end)
  const set = stmt.slice(stmt.indexOf('SET system_prompt ='), stmt.indexOf('updated_at = now()'))
  const lits = literals(set)
  const pairs: Array<[string, string]> = []
  for (let i = 0; i < lits.length; i += 2) pairs.push([lits[i], lits[i + 1]])
  const guards = [...stmt.matchAll(/strpos\(system_prompt, '((?:[^']|'')*)'\) > 0/g)].map((m) => m[1].replace(/''/g, "'"))
  return { stmt, pairs, guards }
}

const apply = (text: string, pairs: ReadonlyArray<readonly [string, string]>) =>
  pairs.reduce((t, [from, to]) => t.split(from).join(to), text)

/** 338's text for a playbook: PROD's baseline (no later migration on main rewrites these rows). */
function prodText(slug: string): string {
  const row = promptRewrites('338_skill_helper_lines.sql').find((r) => r.slug === slug)
  expect(row, slug).toBeDefined()
  return row!.prompt
}

/** Persona words a playbook may not say once 357 has run (identifiers like `bot_character` aside). */
const PERSONA_WORD = /(?<![a-z_`])(bots?|birds?)(?![a-z_`])/i

/** 350's phrase swaps (branch claude/birds-settings, applied on DEV only), bot → bird, as 350 wrote them. */
const BIRD_SWAPS: Record<string, Array<[string, string]>> = {
  [FLOWS.slug]: [
    ['Every loop has a bot, the teammate', 'Every loop has a bird, the teammate'],
    ['on/off state and bot (bearer', 'on/off state and bird (bearer'],
    ['a new name or a new bot: leave', 'a new name or a new bird: leave'],
  ],
  [LIBRARY.slug]: [
    ['Bots, custom chat agents', 'Birds, custom chat agents'],
    ["the bot's Customize (About on the bot's page)", "the bird's Customize (About on the bird's page)"],
  ],
}

describe('migration 357', () => {
  it('holds no backslash anywhere (the MCP transport decodes escapes) and sets a lock timeout', () => {
    expect(SQL.includes(String.fromCharCode(92))).toBe(false)
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
  })

  it('only updates recipes: three UPDATEs, nothing inserted, deleted or dropped', () => {
    expect(BODY.match(/\bUPDATE public\.\w+/g)).toEqual(['UPDATE public.recipe', 'UPDATE public.recipe', 'UPDATE public.recipe'])
    expect(BODY).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|INSERT\s+INTO|DROP|ALTER)\b/i)
  })

  describe.each([FLOWS, LIBRARY])('$slug', ({ id, slug }) => {
    const { stmt, pairs, guards } = playbookUpdate(slug)
    const prod = prodText(slug)
    const dev = apply(prod, BIRD_SWAPS[slug])
    const olds = pairs.map(([from]) => from)
    const news = [...new Set(pairs.map(([, to]) => to))]

    it('is fenced by id, slug and is_system', () => {
      expect(stmt.replace(/\s+/g, ' ')).toContain(`WHERE id = '${id}'::uuid AND slug = '${slug}' AND is_system AND (`)
    })

    it('matches each phrase in both its bot (PROD) and bird (DEV) wording, and the new one says agent', () => {
      expect(pairs.length).toBe(BIRD_SWAPS[slug].length * 2)
      for (let i = 0; i < pairs.length; i += 2) {
        const [bot, toA] = pairs[i]
        const [bird, toB] = pairs[i + 1]
        expect(toA).toBe(toB)
        expect(bot).toMatch(/\b(bot|Bots|bot's)\b/)
        expect(bird).toMatch(/\b(bird|Birds|bird's)\b/)
        expect(PERSONA_WORD.test(toA.replace(/`bot_character`/g, ''))).toBe(false)
        expect(toA).toMatch(/\bagent('s)?\b|AI teammates/)
      }
      for (const [bot] of pairs.filter((_, i) => i % 2 === 0)) expect(prod.split(bot).length - 1, bot).toBe(1)
      for (const [bird] of pairs.filter((_, i) => i % 2 === 1)) expect(dev.split(bird).length - 1, bird).toBe(1)
    })

    it('ends PROD and DEV on the same text, with no persona word left and nothing else changed', () => {
      const fromProd = apply(prod, pairs)
      const fromDev = apply(dev, pairs)
      expect(fromDev).toBe(fromProd)
      expect(PERSONA_WORD.test(fromProd.replace(/`bot_character`/g, ''))).toBe(false)
      // Undoing the bot pairs gives back 338's text byte for byte.
      const botPairs = pairs.filter((_, i) => i % 2 === 0)
      expect(apply(fromProd, botPairs.map(([from, to]) => [to, from] as [string, string]))).toBe(prod)
    })

    it('never touches a tool name or field', () => {
      const ids = (t: string) => (t.match(/`[^`]+`|\b[a-z]+_[a-z_]+\b/g) ?? []).sort()
      for (const [from, to] of pairs) expect(ids(to)).toEqual(ids(from))
      const after = apply(prod, pairs)
      for (const name of ['bot_character', 'list_bot_work', 'get_bot_item', 'bot_id', 'bot_name']) {
        expect(after.split(name).length, name).toBe(prod.split(name).length)
      }
    })

    it('is idempotent: guarded on exactly the old phrases, and a second run changes nothing', () => {
      expect([...guards].sort()).toEqual([...olds].sort())
      for (const to of news) for (const from of olds) expect(to.includes(from), `${to} ⊃ ${from}`).toBe(false)
      const once = apply(prod, pairs)
      expect(olds.some((o) => once.includes(o))).toBe(false)
      expect(apply(once, pairs)).toBe(once)
    })
  })

  describe('the work-agent anchor (302)', () => {
    const start = STMTS.indexOf("WHERE slug = 'loop-work-bot'")
    const stmt = STMTS.slice(STMTS.lastIndexOf('UPDATE public.recipe', start), STMTS.indexOf(';', start)).replace(/\s+/g, ' ')
    const s302 = readMigration('302_every_loop_has_a_bot.sql')
    const insert = s302.slice(s302.indexOf("('Work bot', 'loop-work-bot'"))
    const [name302, , icon302, , desc302, prompt302] = literals(insert.slice(0, insert.indexOf("'agent', false")))

    it('is matched by its slug and the NULL workspace, and keeps the slug', () => {
      expect(stmt).toContain("WHERE slug = 'loop-work-bot' AND workspace_id IS NULL AND (")
      expect(stmt.slice(0, stmt.indexOf('WHERE slug'))).not.toMatch(/\bslug\s*=/)
    })

    it("matches 302's text (PROD) and 350's bird text (DEV), and the new text says agent", () => {
      const lits = literals(stmt)
      expect(name302).toBe('Work bot')
      expect(icon302).toBe('🤖')
      for (const old of [name302, desc302, prompt302]) {
        expect(lits, old).toContain(old)
        expect(lits, old).toContain(old.replace(/\bbots\b/, 'birds').replace(/\bbot\b/g, 'bird').replace('birds (birds v3)', 'birds (bots v3)'))
      }
      expect(stmt).toContain("THEN 'Work agent'")
      expect(stmt).toContain("THEN 'An agent made for a loop: it tells you about the loop''s runs and talks them through with you. It takes no assignments.'")
      expect(stmt).toContain("THEN 'Identity anchor for work agents. No run executes this prompt: a work agent speaks from the loops it fronts.'")
      // 350 made the icon a bird; 302's robot comes back.
      expect(stmt).toContain("icon = CASE WHEN icon = '🐦' THEN '🤖' ELSE icon END")
    })

    it('changes each column only where it holds a known old value, so a second run changes nothing', () => {
      for (const col of ['name', 'icon', 'description', 'system_prompt']) {
        expect(stmt).toMatch(new RegExp(`${col} = CASE WHEN ${col} (IN|=) [^;]*?ELSE ${col} END`))
      }
      const news = ['Work agent', '🤖', 'An agent made for a loop', 'Identity anchor for work agents']
      const guard = stmt.slice(stmt.indexOf('WHERE slug'))
      for (const n of news) expect(guard.includes(n), n).toBe(false)
    })
  })
})
