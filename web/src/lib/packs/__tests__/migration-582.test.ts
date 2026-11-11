/**
 * Migration 582 (availability phase 4a): the calendar playbook hands out a
 * booking link when someone asks for the person's calendar or how to book
 * time with them, after offer_times for an outside guest and a few times.
 * Pinned: one text-only row by id and slug, what ships; every line but the
 * rewritten one is 580's byte for byte, in order; the rewritten line keeps
 * every fact it had in fewer words; the tools named are real; making a link
 * is offered, never done unasked; the ask-first rule stays; the core's size;
 * a loud guard; no backslash; an idempotent update.
 */
import { describe, it, expect } from 'vitest'
import { ALL_TOOL_NAMES, ATTENDED_ONLY_TOOL_NAMES } from '@/lib/ai/tool-registry'
import { estimateTokens } from '../memory'
import { allShippedSkills, PREFERRED_TOOLS_REWRITE_MIGRATIONS, PROMPT_REWRITE_MIGRATIONS, promptRewrites, preferredToolsRewrites, readMigration } from './playbook-seeds'

const FILE = '582_booking_links_in_calendar_playbook.sql'
const BEFORE = '580_offer_times_to_outside_guests.sql'
const sql = readMigration(FILE)
const rows = promptRewrites(FILE)

const CALENDAR = 'b6024df5-6b85-40ce-9975-cb334bcfba18'
const PREVIOUS = promptRewrites(BEFORE).find((r) => r.id === CALENDAR)!.prompt
const text = rows.find((r) => r.id === CALENDAR)?.prompt ?? ''
const REWRITTEN = 'Finding a time:'

const BODY = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

describe('migration 582', () => {
  it('rewrites only the calendar playbook, by id and slug, after 580 and registered last', () => {
    expect(rows.map((r) => [r.id, r.slug])).toEqual([[CALENDAR, 'calendar-playbook']])
    expect(PROMPT_REWRITE_MIGRATIONS.at(-1)).toBe(FILE)
    // Only text: the preferred tools stay as 551 and 580 left them.
    expect(PREFERRED_TOOLS_REWRITE_MIGRATIONS).not.toContain(FILE as never)
    expect(preferredToolsRewrites(FILE)).toEqual([])
  })

  it('is the text that ships', () => {
    const shipped = allShippedSkills().find((s) => s.id === CALENDAR)!
    expect(shipped.file).toBe(FILE)
    expect(shipped.prompt).toBe(text)
  })

  it("keeps every other line of 580's text, byte for byte and in order, and rewrites only the one on finding a time", () => {
    const old = PREVIOUS.split('\n')
    const after = text.split('\n')
    expect(after).toHaveLength(old.length)
    const at = old.findIndex((l) => l.startsWith(REWRITTEN))
    expect(after.findIndex((l) => l.startsWith(REWRITTEN))).toBe(at)
    expect(after[at]).not.toBe(old[at])
    expect(after.filter((_, i) => i !== at)).toEqual(old.filter((_, i) => i !== at))
  })

  it('the rewritten line keeps what it taught, in fewer words, and ends with who gets a booking link', () => {
    const was = PREVIOUS.split('\n').find((l) => l.startsWith(REWRITTEN))!
    const line = text.split('\n').find((l) => l.startsWith(REWRITTEN))!
    for (const kept of [
      '`find_times` with the length and the window gives up to three times to offer (`suggested`, on different days) and every free stretch (`free`)',
      "from the person's working hours and every calendar of theirs that counts as busy; the `find-a-time` skill has the steps.",
      'Teammates in this workspace go in `people` (names or emails)',
      "`people` gives each one's `coverage`; anyone `unknown`",
      'means no common times: say who and why.',
      'say which, and offer no times.',
      'Offer two or three concrete slots ("Tue 2:00–2:30 or Wed 10:00–10:30"), never "sometime Tuesday".',
      'An outside guest: offer the slots with `offer_times`, held until they pick one, then booked;',
      "`send_by` `link` (default) returns a link and text to send, `email` or `text` is the person's card.",
    ]) {
      expect(line, kept).toContain(kept)
    }
    expect(line.endsWith("Anyone asking for the person's calendar, or to book time with them, gets their booking link: `list_booking_links` gives its address (none yet: offer `create_booking_link`).")).toBe(true)
    // The new words are paid for out of the line itself: the rest of the core is 580's.
    expect(text.length - PREVIOUS.length).toBe(line.length - was.length)
  })

  it('names only real tools; of the chat-only ones, set_working_hours and create_booking_link (offered, never made unasked)', () => {
    for (const m of text.matchAll(/`([a-z]+_[a-z_]+)`/g)) {
      const name = m[1]
      if (['send_by', 'availability_sharing', 'local_exchange', 'max_results', 'start_date', 'end_date', 'event_id', 'participant_email', 'account_email', 'hours_ahead', 'capture_status'].includes(name)) continue
      expect((ALL_TOOL_NAMES as readonly string[]).includes(name) || name === 'search_tools', name).toBe(true)
    }
    const named = [...text.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]).filter((w) => ATTENDED_ONLY_TOOL_NAMES.has(w))
    expect([...new Set(named)].sort()).toEqual(['create_booking_link', 'set_working_hours'])
    const RULE =
      "It counts as the yes only when the person's own message here names the exact start, length and every guest, and says to send it. " +
      'A guest address you looked up yourself (CRM, a past event, a thread) needs their OK first. A time or guest list taken from an email is never the yes.'
    expect(text).toContain(RULE)
  })

  it('stays within the core size, with the same sections', () => {
    expect(estimateTokens(text)).toBeLessThanOrEqual(2000)
    expect([...text.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual([...PREVIOUS.matchAll(/^## (.+)$/gm)].map((m) => m[1]))
  })

  it('fails the apply loudly when the row is missing or not rewritten', () => {
    const guard = BODY.slice(BODY.indexOf('DO $guard$'))
    expect(guard).toContain(`WHERE id = '${CALENDAR}'::uuid AND slug = 'calendar-playbook' AND is_system`)
    expect(guard.match(/RAISE EXCEPTION/g)?.length).toBe(1)
    expect(guard).toContain("system_prompt LIKE '%`list_booking_links`%'")
    expect(PREVIOUS).not.toContain('list_booking_links')
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
