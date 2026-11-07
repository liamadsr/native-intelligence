/**
 * The teammates' starting faces have one rule and two copies of it: the
 * database hands them out (migration 294's `default_bot_character` and
 * `free_bot_character`, which the seeds, the insert default and the backfill
 * call), and the app names them (teammate-faces.ts). This reads the newest
 * migration defining each
 * function and holds the app's copy to it, so a face changed in one place and
 * not the other fails here instead of the app offering one bot while the seed
 * gives the teammate another.
 *
 * Read case-insensitively, and the newest definition across the whole
 * directory (src/test/migration-sql.ts explains why a pinned filename rots):
 * 294 writes its DDL in lower case, which `latestDefinition` doesn't match.
 */
import { describe, expect, it } from 'vitest'
import { BOT_CHARACTERS } from '@/lib/bots/bot-faces'
import { WORK_ROLES } from '@/lib/work/roles'
import { SYSTEM_TEAMMATE_KEYS } from '@/lib/work/system-teammates'
import { migrationsInOrder } from '@/test/migration-sql'
import {
  BOT_CHARACTER_ORDER,
  FREE_BOT_CHARACTER_ORDER,
  RESERVED_BOT_CHARACTERS,
  ROLE_TEAMMATE_FACES,
  SYSTEM_TEAMMATE_FACES,
  asBotCharacter,
  defaultBotCharacter,
  firstFreeBotCharacter,
  inCrewOrder,
  isBotCharacterType,
} from '../teammate-faces'

const MIGRATIONS = migrationsInOrder()

/** The newest definition of `public.<fn>`, from its CREATE to the end of its body, and where it is. */
function latest(fn: string): { file: string; body: string } {
  const needle = new RegExp(`create or replace function public\\.${fn}\\(`, 'gi')
  for (let i = MIGRATIONS.length - 1; i >= 0; i--) {
    const { file, sql } = MIGRATIONS[i]
    const hit = [...sql.matchAll(needle)].at(-1)
    if (!hit) continue
    const open = sql.indexOf('$$', hit.index)
    const close = sql.indexOf('$$', open + 2)
    return { file, body: sql.slice(hit.index, close + 2) }
  }
  return { file: '(none)', body: '' }
}

/** `case <on> when 'a' then 'b' … end` as { a: 'b' }. */
function caseMap(body: string, on: string): Record<string, string> {
  const block = body.match(new RegExp(`case ${on}([\\s\\S]*?)\\bend\\b`, 'i'))?.[1] ?? ''
  return Object.fromEntries([...block.matchAll(/when '([^']+)' then '([^']+)'/gi)].map((m) => [m[1], m[2]]))
}

/** The quoted values of the first `array[…]` in `body`. */
function arrayValues(body: string): string[] {
  const block = body.match(/array\[([\s\S]*?)\]/i)?.[1] ?? ''
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/** The CHECK's list, from the newest migration that (re-)adds it. */
function checkValues(): string[] {
  for (let i = MIGRATIONS.length - 1; i >= 0; i--) {
    const at = MIGRATIONS[i].sql.search(/add constraint ai_team_member_bot_character_check/i)
    if (at === -1) continue
    const list = MIGRATIONS[i].sql.slice(at).match(/bot_character in \(([\s\S]*?)\)/i)?.[1] ?? ''
    return [...list.matchAll(/'([^']+)'/g)].map((m) => m[1])
  }
  return []
}

const defaults = latest('default_bot_character')
const free = latest('free_bot_character')

describe('the faces the database hands out', () => {
  it('finds both functions', () => {
    expect(defaults.body).toContain('p_system_key')
    expect(free.body).toContain('with ordinality')
  })

  it('starts each system teammate on the face the app names for it', () => {
    expect(caseMap(defaults.body, 'p_system_key')).toEqual(SYSTEM_TEAMMATE_FACES)
    expect(Object.keys(SYSTEM_TEAMMATE_FACES).sort()).toEqual([...SYSTEM_TEAMMATE_KEYS].sort())
  })

  it('starts each role on the face the app names for it', () => {
    expect(caseMap(defaults.body, 'p_role')).toEqual(ROLE_TEAMMATE_FACES)
    expect(Object.keys(ROLE_TEAMMATE_FACES).sort()).toEqual([...WORK_ROLES].sort())
  })

  it('picks a free face in the crew’s order, past the reserved faces, as the app does', () => {
    expect(arrayValues(free.body)).toEqual([...FREE_BOT_CHARACTER_ORDER])
    expect(FREE_BOT_CHARACTER_ORDER).toEqual(BOT_CHARACTER_ORDER.filter((c) => !RESERVED_BOT_CHARACTERS.has(c)))
    expect(BOT_CHARACTER_ORDER).toEqual([
      'chat', 'research', 'reconciler', 'sprout', 'writer', 'triage', 'extraction', 'berry',
      'dev', 'nova', 'live', 'flows', 'notes', 'ember', 'scout', 'dew',
      'coach', 'mail', 'knowledge', 'calendar', 'acorn', 'browser', 'shroom', 'deals',
    ])
  })

  it('checks the column against exactly the characters, every one of which the crew has', () => {
    expect(checkValues().sort()).toEqual(BOT_CHARACTERS.map((c) => c.type).sort())
  })

  it('lets the column hold a built bot’s id too, by its shape, and the app reads only ones that name real parts', () => {
    const newest = [...MIGRATIONS].reverse().find((m) => /add constraint ai_team_member_bot_character_check/i.test(m.sql))!
    expect(newest.sql).toContain("or bot_character ~ '^x[a-z]{7}$'")
    expect(isBotCharacterType('xabafbba')).toBe(true)
    expect(asBotCharacter('xaaaaaaa')).toBe('xaaaaaaa')
    expect(isBotCharacterType('xzzzzzzz')).toBe(false)
    expect(inCrewOrder(['xabafbba', 'mail', 'xaaaaaaa', 'chat'])).toEqual(['chat', 'mail', 'xaaaaaaa', 'xabafbba'])
  })

  it('keeps `chat` for the Assistant and each area face its own (bots-v4 decision 7, migration 318): its default, and no free pick, hands it out', () => {
    expect([...RESERVED_BOT_CHARACTERS].sort()).toEqual(['chat', 'coach', 'deals', 'scout', 'triage'])
    expect(SYSTEM_TEAMMATE_FACES.assistant).toBe('chat')
    expect(caseMap(defaults.body, 'p_system_key').assistant).toBe('chat')
    for (const face of RESERVED_BOT_CHARACTERS) expect(arrayValues(free.body)).not.toContain(face)
    // Mail's envelope is the one email face, which a Correspondent wears too: not reserved.
    expect(arrayValues(free.body)).toContain('mail')
    expect(defaults.file).toBe('318_area_faces.sql')
    expect(free.file).toBe('318_area_faces.sql')
    // The column still takes it (anyone may put it on a teammate by hand), and the crew still stands in its order.
    expect(checkValues()).toContain('chat')
    expect(inCrewOrder(['mail', 'chat'])).toEqual(['chat', 'mail'])
  })

  it('moves every old shape onto a character, one for one, before the new check is added', () => {
    const sql = MIGRATIONS.find((m) => /set bot_character = m\.new_face/.test(m.sql))!.sql
    const moves = [...sql.matchAll(/\('([a-z]+)', '([a-z]+)'\)/g)].map((m) => [m[1], m[2]])
    expect(moves).toHaveLength(18)
    expect(new Set(moves.map(([, to]) => to)).size).toBe(18)
    for (const [, to] of moves) expect(BOT_CHARACTERS.map((c) => c.type)).toContain(to)
    // The first eighteen in the crew's order are the old eighteen's places, in order.
    expect(moves.map(([, to]) => to)).toEqual(BOT_CHARACTER_ORDER.slice(0, 18))
    expect(sql.indexOf('drop constraint if exists ai_team_member_bot_character_check')).toBeLessThan(sql.indexOf('set bot_character = m.new_face'))
    expect(sql.indexOf('set bot_character = m.new_face')).toBeLessThan(sql.indexOf('add constraint ai_team_member_bot_character_check'))
  })

  it('has every seed start its rows through default_bot_character, not a copy of the mapping', () => {
    const system = latest('seed_system_teammates')
    const role = latest('seed_role_teammates')
    expect(system.body).toMatch(/default_bot_character\(s\.system_key, null\)/)
    expect(role.body).toMatch(/default_bot_character\(null, s\.role\)/)
    // 286's behaviour rides along: the lock, and the launch can_delegate_to.
    expect(role.body).toContain('pg_advisory_xact_lock')
    expect(role.body).toContain('can_delegate_to')
  })

  it('starts Email as the one email face, moving it off Mail only while that row still wears it', () => {
    const system = latest('seed_system_teammates').body
    expect(system).toMatch(/s\.system_key = 'mail' and exists \([\s\S]*?a\.role = 'correspondent'[\s\S]*?\) then null/)
    const role = latest('seed_role_teammates').body
    expect(role).toMatch(/set bot_character = null[\s\S]*?system_key = 'mail'\s+and bot_character = v_face/)
  })

  it('gives every insert with no face its starting one, through the same two functions, and never overrides one', () => {
    const fill = latest('ai_team_member_default_bot_character')
    expect(fill.body).toMatch(/security definer/i)
    // An explicit face wins: the first thing it does is hand a faced row back.
    expect(fill.body).toMatch(/begin\s+if new\.bot_character is not null then\s+return new;/i)
    expect(fill.body).toMatch(/new\.bot_character := public\.default_bot_character\(new\.system_key, null\)/)
    expect(fill.body).toMatch(
      /new\.bot_character := coalesce\(\s*public\.default_bot_character\(null, new\.role\),\s*public\.free_bot_character\(new\.workspace_id\)\s*\)/,
    )
    // Mail starts on none where there's a Correspondent, as in the seed.
    expect(fill.body).toMatch(/new\.system_key = 'mail' and exists \([\s\S]*?c\.role = 'correspondent'[\s\S]*?\) then\s+return new;/)
    // The trigger itself is 294's; later migrations replace only its function.
    const sql = MIGRATIONS.find((m) => /create trigger ai_team_member_default_bot_character/i.test(m.sql))!.sql
    expect(sql).toMatch(
      /create trigger ai_team_member_default_bot_character\s+before insert on public\.ai_team_member\s+for each row execute function public\.ai_team_member_default_bot_character\(\)/i,
    )
    // Only on insert: a face someone changes stays changed.
    expect(sql).not.toMatch(/before (insert or )?update[^;]*ai_team_member_default_bot_character\(\)/i)
  })

  it('leaves a face free to change: no unique index on it, and the system-row guard as 283 has it', () => {
    for (const { file, sql } of MIGRATIONS) {
      expect(sql, file).not.toMatch(/unique index[^;]*bot_character/i)
    }
    const guard = latest('ai_team_member_protect_system')
    // 402 (merge workspaces) only adds the merge exemption to 283's guard.
    expect(guard.file).toBe('402_merge_workspaces.sql')
    expect(guard.body).toContain('not public._wsmerge_active()')
    expect(guard.body).not.toContain('bot_character')
  })
})

describe('the faces, as the app names them', () => {
  it('starts two defaults on Email, the email face, and no other face twice (the Assistant on its own `chat`)', () => {
    const starts = [...Object.values(SYSTEM_TEAMMATE_FACES), ...Object.values(ROLE_TEAMMATE_FACES)]
    expect(starts.filter((face) => face === 'mail')).toHaveLength(2)
    expect(new Set(starts).size).toBe(starts.length - 1)
  })

  it('lets the system key win, and names no starting face for any other teammate', () => {
    expect(defaultBotCharacter('mail', 'writer')).toBe('mail')
    expect(defaultBotCharacter('captures', null)).toBe('triage')
    expect(defaultBotCharacter(null, 'writer')).toBe('writer')
    expect(defaultBotCharacter('nope', 'developer')).toBe('dev')
    expect(defaultBotCharacter(null, null)).toBeNull()
    expect(defaultBotCharacter('toString', 'constructor')).toBeNull()
  })

  it('picks the first face in the crew’s order nobody wears, past the reserved ones, none once all are worn', () => {
    expect(firstFreeBotCharacter([])).toBe('research')
    expect(firstFreeBotCharacter(['triage', 'extraction', 'reconciler', 'mail', 'chat', null])).toBe('research')
    expect(firstFreeBotCharacter(['chat', 'research', 'reconciler'])).toBe('sprout')
    expect(firstFreeBotCharacter(FREE_BOT_CHARACTER_ORDER.slice(0, -1))).toBe('shroom')
    // A reserved face free is never picked: every other face worn reads as none.
    expect(firstFreeBotCharacter(FREE_BOT_CHARACTER_ORDER)).toBeNull()
    expect(firstFreeBotCharacter(BOT_CHARACTER_ORDER)).toBeNull()
  })

  it('draws only a stored value that names a character', () => {
    expect(isBotCharacterType('writer')).toBe(true)
    expect(isBotCharacterType('Writer')).toBe(false)
    expect(isBotCharacterType(null)).toBe(false)
    expect(asBotCharacter('robot')).toBeNull()
    expect(asBotCharacter('coach')).toBe('coach')
  })
})
