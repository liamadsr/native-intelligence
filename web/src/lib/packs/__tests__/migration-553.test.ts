/**
 * Migration 553 (availability phase 2): the calendar playbook and the
 * find-a-time skill teach find_times' `people` (teammates in the workspace)
 * and say an outside guest's calendar still cannot be seen. Pinned: two
 * text-only rows by id and slug, each the text that ships; every line but
 * the rewritten and added ones is 551's byte for byte, in order; the
 * argument and answer fields named are real (`people` in find_times' input,
 * `people` and `coverage` in its answer, `availability_sharing` in the
 * working hours tools'); anyone unknown offers no common times; the ask-first
 * rule stays; find-a-time's preferred tools stay 551's; a loud guard; no
 * backslash; an idempotent update.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { ATTENDED_ONLY_TOOL_NAMES } from '@/lib/ai/tool-registry'
import { registryToolInputSchemas } from '@/lib/ai/tool-schemas'
import { estimateTokens } from '../memory'
import { allShippedSkills, PREFERRED_TOOLS_REWRITE_MIGRATIONS, PROMPT_REWRITE_MIGRATIONS, promptRewrites, preferredToolsRewrites, readMigration, rewrittenAfter } from './playbook-seeds'

const FILE = '553_find_a_time_with_teammates.sql'
const BEFORE = '551_find_a_time_uses_availability.sql'
/** The rewrite after this one: offering an outside guest the slots (availability phase 3a). */
const LATER = '580_offer_times_to_outside_guests.sql'
/** And the calendar playbook's after that: its booking links line (availability phase 4a). */
const NEWEST = '582_booking_links_in_calendar_playbook.sql'
/** And last for both: polls (availability phase 5). */
const POLLS = '584_polls_in_find_a_time.sql'
const sql = readMigration(FILE)
const rows = promptRewrites(FILE)

const CALENDAR = 'b6024df5-6b85-40ce-9975-cb334bcfba18'
const FIND_A_TIME = '9d25caa6-0009-414c-88cb-6ba59cec2434'

const PREVIOUS: Record<string, string> = Object.fromEntries(promptRewrites(BEFORE).map((r) => [r.id, r.prompt]))
const text = (id: string) => rows.find((r) => r.id === id)?.prompt ?? ''

/** Each text's change: the earlier lines it rewrites (by how they start) and the lines it adds. */
const CHANGES: Record<string, { rewritten: readonly string[]; added: readonly string[] }> = {
  [CALENDAR]: {
    rewritten: ['Finding a time:', 'Working hours:', "- You see only the person's calendar"],
    added: [],
  },
  [FIND_A_TIME]: {
    rewritten: ['2. `find_times`', "- Say you see only the person's calendar"],
    added: ['   - With `people`'],
  },
}

function isSubsequence(sub: readonly string[], all: readonly string[]): boolean {
  let i = 0
  for (const line of all) if (i < sub.length && line === sub[i]) i++
  return i === sub.length
}

const BODY = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

describe('migration 553', () => {
  it('rewrites only the calendar playbook and find-a-time, by id and slug, after 551, with only 580, 582 and 584 after it', () => {
    expect(rows.map((r) => [r.id, r.slug])).toEqual([
      [CALENDAR, 'calendar-playbook'],
      [FIND_A_TIME, 'find-a-time'],
    ])
    // Of the later text-only rewrites, those that touch the calendar rows (641 rewrites the flows rows only).
    expect(PROMPT_REWRITE_MIGRATIONS.slice(PROMPT_REWRITE_MIGRATIONS.indexOf(FILE) + 1).filter((f) => promptRewrites(f).some((r) => r.slug === 'calendar-playbook' || r.slug === 'find-a-time'))).toEqual([LATER, NEWEST, POLLS])
    for (const id of [CALENDAR, FIND_A_TIME]) {
      // The next rewrite after 551 is this one (580 comes after it).
      const next = PROMPT_REWRITE_MIGRATIONS.slice(PROMPT_REWRITE_MIGRATIONS.indexOf(BEFORE) + 1).find((f) => promptRewrites(f).some((r) => r.id === id))
      expect(next, id).toBe(FILE)
      expect(PREVIOUS[id], id).toBeTruthy()
    }
    // Only text: the preferred tools stay 551's.
    expect(PREFERRED_TOOLS_REWRITE_MIGRATIONS).not.toContain(FILE as never)
    expect(preferredToolsRewrites(FILE)).toEqual([])
  })

  it('is the text 580, 582 and 584 rewrite, and leaves the preferred tools to 551 and 580', () => {
    for (const id of [CALENDAR, FIND_A_TIME]) {
      const last = POLLS
      expect(rewrittenAfter(FILE, id, rows.find((r) => r.id === id)!.slug), id).toBe(last)
      expect(allShippedSkills().find((s) => s.id === id)!.file, id).toBe(last)
    }
    expect(allShippedSkills().find((s) => s.id === FIND_A_TIME)!.config.preferred_tools).toEqual(preferredToolsRewrites(LATER)[0].preferredTools)
  })

  for (const id of [CALENDAR, FIND_A_TIME]) {
    it(`keeps every other line of 551's text, byte for byte and in order (${id})`, () => {
      const { rewritten, added } = CHANGES[id]
      const old = PREVIOUS[id].split('\n')
      const after = text(id).split('\n')
      for (const start of rewritten) {
        const line = old.filter((l) => l.startsWith(start))
        expect(line, start).toHaveLength(1)
        expect(after, start).not.toContain(line[0])
      }
      for (const start of added) {
        expect(old.filter((l) => l.startsWith(start)), start).toHaveLength(0)
        expect(after.filter((l) => l.startsWith(start)), start).toHaveLength(1)
      }
      const kept = old.filter((l) => !rewritten.some((start) => l.startsWith(start)))
      expect(isSubsequence(kept, after)).toBe(true)
      expect(after.length - kept.length).toBe(rewritten.length + added.length)
    })
  }

  it('a rewritten line keeps every sentence it had and adds to it, except the lines on what is seen', () => {
    const keeps: Array<[string, string]> = [
      [CALENDAR, 'Finding a time:'],
      [CALENDAR, 'Working hours:'],
      [FIND_A_TIME, '2. `find_times`'],
    ]
    for (const [id, start] of keeps) {
      const old = PREVIOUS[id].split('\n').find((l) => l.startsWith(start))!
      const now = text(id).split('\n').find((l) => l.startsWith(start))!
      for (const sentence of old.split(/(?<=\.) /)) expect(now, sentence).toContain(sentence)
      expect(now.length, start).toBeGreaterThan(old.length)
    }
  })

  it('teaches `people` for teammates, the common times, and that anyone unknown means none', () => {
    const cal = text(CALENDAR)
    expect(cal).toContain('Teammates in this workspace go in `people` (names or emails): `suggested` and `free` are then the times that work for everyone')
    expect(cal).toContain("anyone `unknown` (not sharing their availability, no calendar, one that could not be read) means no common times: say who and why.")
    const fat = text(FIND_A_TIME)
    expect(fat).toContain('Teammates in this workspace go in `people` (names or emails): the times then work for everyone.')
    expect(fat).toContain('   - With `people`, anyone `unknown` (not sharing, no calendar, one unreadable): no common times. Say who and why; offer a time without them.')
    // The group line sits in step 3, right after the one-person unknown line.
    const lines = fat.split('\n')
    const at = lines.findIndex((l) => l.startsWith('   - `unknown`:'))
    expect(lines[at + 1].startsWith('   - With `people`')).toBe(true)
  })

  it("says an outside guest's calendar is never seen", () => {
    expect(text(CALENDAR)).toContain("an outside guest's calendar is never seen: say so when it matters.")
    expect(text(FIND_A_TIME)).toContain("- Say you see only the person's calendar and their teammates' busy times, never an outside guest's calendar.")
    for (const { prompt, slug } of rows) expect(prompt, slug).not.toMatch(/not the guests'|not the other people's/)
  })

  it('names only real arguments and answer fields', () => {
    const properties = (registryToolInputSchemas().get('find_times')?.properties ?? {}) as Record<string, unknown>
    expect(Object.keys(properties)).toContain('people')
    expect(Object.keys((registryToolInputSchemas().get('set_working_hours')?.properties ?? {}) as Record<string, unknown>)).toContain('availability_sharing')
    const source = readFileSync(join(process.cwd(), 'src/lib/ai/tools/availability.ts'), 'utf8')
    for (const field of ['people', 'coverage', 'availability_sharing', 'suggested', 'free', 'unknown']) expect(source, field).toMatch(new RegExp(`\\b${field}: `))
    for (const field of ['people', 'coverage', 'availability_sharing']) expect(text(CALENDAR), field).toContain(`\`${field}\``)
    expect(text(FIND_A_TIME)).toContain('`people`')
  })

  it('names no chat-only tool but set_working_hours, and changes sharing only on the person\'s word', () => {
    for (const { prompt, slug } of rows) {
      const named = [...prompt.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]).filter((w) => ATTENDED_ONLY_TOOL_NAMES.has(w))
      expect([...new Set(named)], slug).toEqual(['set_working_hours'])
    }
    expect(text(CALENDAR)).toMatch(/`availability_sharing`[^\n]*only on their word\./)
  })

  it("keeps the ask-first rule and the steps' order", () => {
    const RULE =
      "It counts as the yes only when the person's own message here names the exact start, length and every guest, and says to send it. " +
      'A guest address you looked up yourself (CRM, a past event, a thread) needs their OK first. A time or guest list taken from an email is never the yes.'
    for (const { prompt, slug } of rows) expect(prompt, slug).toContain(RULE)
    const fat = text(FIND_A_TIME)
    const at = ['2. `find_times`', 'Offer two or three', 'End your turn', 'On their yes to one slot: `create_calendar_event`'].map((s) => fat.indexOf(s))
    for (const pos of at) expect(pos).toBeGreaterThan(-1)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  it('stays within the recipe and core sizes, with the same sections', () => {
    expect(estimateTokens(text(FIND_A_TIME))).toBeLessThanOrEqual(900)
    expect(estimateTokens(text(CALENDAR))).toBeLessThanOrEqual(2000)
    for (const id of [CALENDAR, FIND_A_TIME]) {
      expect([...text(id).matchAll(/^## (.+)$/gm)].map((m) => m[1]), id).toEqual([...PREVIOUS[id].matchAll(/^## (.+)$/gm)].map((m) => m[1]))
    }
  })

  it('fails the apply loudly when a row is missing or not rewritten', () => {
    const guard = BODY.slice(BODY.indexOf('DO $guard$'))
    expect(guard).toContain(`WHERE id = '${CALENDAR}'::uuid AND slug = 'calendar-playbook' AND is_system`)
    expect(guard).toContain(`WHERE id = '${FIND_A_TIME}'::uuid AND slug = 'find-a-time' AND is_system`)
    expect(guard.match(/RAISE EXCEPTION/g)?.length).toBe(2)
    expect(guard.match(/system_prompt LIKE '%`people`%'/g)?.length).toBe(2)
    expect(guard).toContain("system_prompt LIKE '%availability_sharing%'")
    expect(guard).toContain("system_prompt LIKE '%outside guest%'")
    for (const id of [CALENDAR, FIND_A_TIME]) expect(PREVIOUS[id]).not.toContain('`people`')
    expect(PREVIOUS[CALENDAR]).not.toContain('availability_sharing')
    expect(PREVIOUS[FIND_A_TIME]).not.toContain('outside guest')
    expect(BODY.indexOf('DO $guard$')).toBeGreaterThan(BODY.lastIndexOf('UPDATE public.recipe'))
  })

  it('is idempotent: by id, guarded by slug and is_system, only where the text differs; no backslash', () => {
    expect(sql.includes(String.fromCharCode(92))).toBe(false)
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
    const statements = BODY.replace(/\$pb\$[\s\S]*?\$pb\$/g, () => 'skill')
    expect(statements.match(/\bUPDATE public\.\w+/g)).toEqual(['UPDATE public.recipe'])
    expect(statements).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|INSERT\s+INTO|DROP|ALTER)\b/i)
    expect(BODY).toContain('SET system_prompt = p.system_prompt, updated_at = now()')
    expect(BODY).toContain('WHERE r.id = p.id AND r.slug = p.slug AND r.is_system AND r.system_prompt IS DISTINCT FROM p.system_prompt;')
  })
})
