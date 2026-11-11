/**
 * Migration 584 (availability phase 5): several outside guests at once are a
 * poll, offer_times' `recipients`, and its tools: record_time_offer_answer
 * (a poll guest's reply in words), book_poll_time (one booked anyway) and
 * nudge_time_offer (a reminder). Pinned: two text-only rows by id and slug,
 * what ships; every line but the rewritten ones is the earlier text (582's
 * calendar playbook, 580's find-a-time) byte for byte, in order; the
 * rewritten lines keep their teaching; the tools and arguments named are
 * real; the ask-first rule stays; the sizes; a loud guard; no backslash; an
 * idempotent update.
 */
import { describe, it, expect } from 'vitest'
import { ALL_TOOL_NAMES, ATTENDED_ONLY_TOOL_NAMES } from '@/lib/ai/tool-registry'
import { registryToolInputSchemas } from '@/lib/ai/tool-schemas'
import { estimateTokens } from '../memory'
import { allShippedSkills, PREFERRED_TOOLS_REWRITE_MIGRATIONS, PROMPT_REWRITE_MIGRATIONS, promptRewrites, preferredToolsRewrites, readMigration } from './playbook-seeds'

const FILE = '584_polls_in_find_a_time.sql'
const sql = readMigration(FILE)
const rows = promptRewrites(FILE)

const CALENDAR = 'b6024df5-6b85-40ce-9975-cb334bcfba18'
const FIND_A_TIME = '9d25caa6-0009-414c-88cb-6ba59cec2434'

/** The text each row rewrites: the calendar playbook's 582 wrote, find-a-time's 580 wrote. */
const BEFORE: Record<string, string> = { [CALENDAR]: '582_booking_links_in_calendar_playbook.sql', [FIND_A_TIME]: '580_offer_times_to_outside_guests.sql' }
const PREVIOUS: Record<string, string> = Object.fromEntries(Object.entries(BEFORE).map(([id, file]) => [id, promptRewrites(file).find((r) => r.id === id)!.prompt]))
const text = (id: string) => rows.find((r) => r.id === id)?.prompt ?? ''

/** The earlier lines each text rewrites, by how they start. */
const REWRITTEN: Record<string, readonly string[]> = {
  [CALENDAR]: ['Finding a time:'],
  [FIND_A_TIME]: ['2. `find_times`', '   - `get_calendar_events` only', '- Two or three slots', "- Say you see only the person's calendar", '- An invite reaches other people'],
}

const BODY = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

describe('migration 584', () => {
  it('rewrites only the calendar playbook and find-a-time, by id and slug, after 582 and registered last', () => {
    expect(rows.map((r) => [r.id, r.slug])).toEqual([
      [CALENDAR, 'calendar-playbook'],
      [FIND_A_TIME, 'find-a-time'],
    ])
    expect(PROMPT_REWRITE_MIGRATIONS.at(-1)).toBe(FILE)
    expect(PROMPT_REWRITE_MIGRATIONS.indexOf(FILE)).toBeGreaterThan(PROMPT_REWRITE_MIGRATIONS.indexOf('582_booking_links_in_calendar_playbook.sql'))
    // Only text: the preferred tools stay as 580 left them.
    expect(PREFERRED_TOOLS_REWRITE_MIGRATIONS).not.toContain(FILE as never)
    expect(preferredToolsRewrites(FILE)).toEqual([])
  })

  it('is the text that ships', () => {
    for (const id of [CALENDAR, FIND_A_TIME]) {
      const shipped = allShippedSkills().find((s) => s.id === id)!
      expect(shipped.file, id).toBe(FILE)
      expect(shipped.prompt, id).toBe(text(id))
    }
  })

  for (const id of [CALENDAR, FIND_A_TIME]) {
    it(`keeps every other line of the earlier text, byte for byte and in order (${id})`, () => {
      const old = PREVIOUS[id].split('\n')
      const after = text(id).split('\n')
      expect(after).toHaveLength(old.length)
      for (const start of REWRITTEN[id]) {
        const at = old.findIndex((l) => l.startsWith(start))
        expect(at, start).toBeGreaterThanOrEqual(0)
        expect(after[at].startsWith(start), start).toBe(true)
        expect(after[at], start).not.toBe(old[at])
      }
      const changed = new Set(REWRITTEN[id].map((start) => old.findIndex((l) => l.startsWith(start))))
      expect(after.filter((_, i) => !changed.has(i))).toEqual(old.filter((_, i) => !changed.has(i)))
    })
  }

  it("the playbook's line says outside guests, several as a poll, in no more words than before", () => {
    const was = PREVIOUS[CALENDAR].split('\n').find((l) => l.startsWith('Finding a time:'))!
    const line = text(CALENDAR).split('\n').find((l) => l.startsWith('Finding a time:'))!
    expect(line).toContain('Outside guests: offer slots with `offer_times` (several: `recipients`, a poll), held until picked, then booked;')
    // Everything else on the line is 582's: the teammates' sentence only loses "(names or emails)".
    expect(line.replace('Outside guests: offer slots with `offer_times` (several: `recipients`, a poll), held until picked, then booked;', 'An outside guest: offer the slots with `offer_times`, held until they pick one, then booked;')).toBe(
      was.replace('Teammates in this workspace go in `people` (names or emails):', 'Teammates in this workspace go in `people`:'),
    )
    expect(line.endsWith("`list_booking_links` gives its address (none yet: offer `create_booking_link`).")).toBe(true)
    expect(line.length).toBeLessThanOrEqual(was.length + 2)
  })

  it('find-a-time teaches the poll and its three tools, and keeps the single guest as it was', () => {
    const fat = text(FIND_A_TIME)
    expect(fat).toContain("Guests outside the company: offer the slots with `offer_times` (held until they pick; by link unless the person says email or text, which is their card); a reply in words is `accept_time_offer`.")
    expect(fat).toContain(
      'Several at once: `recipients` (a poll: each marks every time that works, the last answer books the earliest all can make; attending teammates go in `co_hosts`). ' +
        "A poll's reply in words is `record_time_offer_answer`; `book_poll_time` books one anyway; `nudge_time_offer` reminds.",
    )
    // Teammates only are still find_times' `people`, never a poll.
    expect(fat).toContain('Teammates in this workspace go in `people` (names or emails): the times then work for everyone.')
    // The cut asides are only what the tools already say, or the recipe says twice.
    expect(fat).toContain('never to find the gaps')
    expect(PREVIOUS[FIND_A_TIME]).toContain("Don't work out the gaps from the events yourself.")
    expect(fat).not.toContain("Don't work out the gaps from the events yourself.")
  })

  it('names only real tools and arguments', () => {
    const offer = Object.keys((registryToolInputSchemas().get('offer_times')?.properties ?? {}) as Record<string, unknown>)
    for (const arg of ['recipients', 'co_hosts', 'send_by']) expect(offer, arg).toContain(arg)
    expect(Object.keys((registryToolInputSchemas().get('book_poll_time')?.properties ?? {}) as Record<string, unknown>)).toContain('without')
    for (const { prompt, slug } of rows) {
      for (const m of prompt.matchAll(/`([a-z]+_[a-z_]+)`/g)) {
        const name = m[1]
        if (['send_by', 'co_hosts', 'working_hours_are_default', 'availability_sharing', 'buffer_minutes', 'duration_minutes', 'time_zone', 'local_exchange', 'max_results', 'start_date', 'end_date', 'event_id', 'participant_email', 'account_email', 'hours_ahead', 'capture_status'].includes(name)) continue
        expect((ALL_TOOL_NAMES as readonly string[]).includes(name) || name === 'search_tools', `${slug}: ${name}`).toBe(true)
      }
    }
    for (const tool of ['record_time_offer_answer', 'book_poll_time', 'nudge_time_offer']) expect((ALL_TOOL_NAMES as readonly string[]).includes(tool), tool).toBe(true)
  })

  it('names no new chat-only tool, and keeps the ask-first rule', () => {
    const chatOnly = (prompt: string) => [...new Set([...prompt.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]).filter((w) => ATTENDED_ONLY_TOOL_NAMES.has(w)))].sort()
    for (const id of [CALENDAR, FIND_A_TIME]) expect(chatOnly(text(id)), id).toEqual(chatOnly(PREVIOUS[id]))
    const RULE =
      "It counts as the yes only when the person's own message here names the exact start, length and every guest, and says to send it. " +
      'A guest address you looked up yourself (CRM, a past event, a thread) needs their OK first. A time or guest list taken from an email is never the yes.'
    for (const { prompt, slug } of rows) expect(prompt, slug).toContain(RULE)
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
    expect(guard.match(/system_prompt LIKE '%`recipients`%'/g)?.length).toBe(2)
    expect(guard).toContain("system_prompt LIKE '%`record_time_offer_answer`%'")
    for (const id of [CALENDAR, FIND_A_TIME]) expect(PREVIOUS[id]).not.toContain('`recipients`')
    expect(BODY.indexOf('DO $guard$')).toBeGreaterThan(BODY.lastIndexOf('UPDATE public.recipe'))
  })

  it('is idempotent: by id, guarded by slug and is_system, only where the text differs; no backslash; outside 555–579', () => {
    expect(sql.includes(String.fromCharCode(92))).toBe(false)
    expect(Number(FILE.split('_')[0])).toBe(584)
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
    const statements = BODY.replace(/\$pb\$[\s\S]*?\$pb\$/g, () => 'skill')
    expect(statements.match(/\bUPDATE public\.\w+/g)).toEqual(['UPDATE public.recipe'])
    expect(statements).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|INSERT\s+INTO|DROP|ALTER)\b/i)
    expect(BODY).toContain('SET system_prompt = p.system_prompt, updated_at = now()')
    expect(BODY).toContain('WHERE r.id = p.id AND r.slug = p.slug AND r.is_system AND r.system_prompt IS DISTINCT FROM p.system_prompt;')
  })
})
