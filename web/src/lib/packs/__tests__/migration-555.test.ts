/**
 * Migration 555 (availability phase 3a): the calendar playbook and the
 * find-a-time skill offer an outside guest the slots with offer_times (a
 * link by default; email or text on the person's card) instead of only
 * drafting an email, and teach the other offer tools. Pinned: two text-only
 * rows by id and slug and one preferred-tools row, each what ships; every
 * line but the rewritten and added ones is 553's byte for byte, in order;
 * the tools and arguments named are real; email and text are the person's
 * card; accept_time_offer books only the offer's own time for its own
 * recipient; the ask-first rule stays; a loud guard; no backslash; an
 * idempotent update.
 */
import { describe, it, expect } from 'vitest'
import { ALL_TOOL_NAMES, ATTENDED_ONLY_TOOL_NAMES } from '@/lib/ai/tool-registry'
import { registryToolInputSchemas } from '@/lib/ai/tool-schemas'
import { estimateTokens } from '../memory'
import { allShippedSkills, PREFERRED_TOOLS_REWRITE_MIGRATIONS, PROMPT_REWRITE_MIGRATIONS, promptRewrites, preferredToolsRewrites, readMigration, rewrittenAfter } from './playbook-seeds'

const FILE = '555_offer_times_to_outside_guests.sql'
const BEFORE = '553_find_a_time_with_teammates.sql'
const sql = readMigration(FILE)
const rows = promptRewrites(FILE)

const CALENDAR = 'b6024df5-6b85-40ce-9975-cb334bcfba18'
const FIND_A_TIME = '9d25caa6-0009-414c-88cb-6ba59cec2434'

const PREVIOUS: Record<string, string> = Object.fromEntries(promptRewrites(BEFORE).map((r) => [r.id, r.prompt]))
const text = (id: string) => rows.find((r) => r.id === id)?.prompt ?? ''

/** Each text's change: the earlier lines it rewrites (by how they start) and the lines it adds. */
const CHANGES: Record<string, { rewritten: readonly string[]; added: readonly string[] }> = {
  [CALENDAR]: {
    rewritten: ['Finding a time:'],
    added: ['- Offered times:'],
  },
  [FIND_A_TIME]: {
    rewritten: ['Find a time on the person', "- Say you see only the person's calendar"],
    added: [],
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

describe('migration 555', () => {
  it('rewrites only the calendar playbook and find-a-time, by id and slug, after 553 and registered last', () => {
    expect(rows.map((r) => [r.id, r.slug])).toEqual([
      [CALENDAR, 'calendar-playbook'],
      [FIND_A_TIME, 'find-a-time'],
    ])
    expect(PROMPT_REWRITE_MIGRATIONS.at(-1)).toBe(FILE)
    expect(PREFERRED_TOOLS_REWRITE_MIGRATIONS.at(-1)).toBe(FILE)
    for (const id of [CALENDAR, FIND_A_TIME]) {
      expect(rewrittenAfter(BEFORE, id, rows.find((r) => r.id === id)!.slug), id).toBe(FILE)
      expect(PREVIOUS[id], id).toBeTruthy()
    }
  })

  it('is the text and the preferred tools that ship', () => {
    for (const id of [CALENDAR, FIND_A_TIME]) {
      const shipped = allShippedSkills().find((s) => s.id === id)!
      expect(shipped.file, id).toBe(FILE)
      expect(shipped.prompt, id).toBe(text(id))
    }
    const tools = preferredToolsRewrites(FILE)
    expect(tools.map((t) => [t.id, t.slug])).toEqual([[FIND_A_TIME, 'find-a-time']])
    expect(allShippedSkills().find((s) => s.id === FIND_A_TIME)!.config.preferred_tools).toEqual(tools[0].preferredTools)
  })

  it("puts offer_times right after find_times in find-a-time's preferred tools and keeps 551's others in order", () => {
    const preferred = preferredToolsRewrites(FILE)[0].preferredTools
    expect(preferred.slice(0, 2)).toEqual(['find_times', 'offer_times'])
    expect(preferred.filter((n) => n !== 'offer_times')).toEqual(preferredToolsRewrites('551_find_a_time_uses_availability.sql')[0].preferredTools)
    for (const name of preferred) expect((ALL_TOOL_NAMES as readonly string[]).includes(name), name).toBe(true)
    // offer_times is a calendar tool, so the skill's enabled categories already hold it.
    expect(allShippedSkills().find((s) => s.id === FIND_A_TIME)!.config.enabled_tools).toContain('calendar')
  })

  for (const id of [CALENDAR, FIND_A_TIME]) {
    it(`keeps every other line of 553's text, byte for byte and in order (${id})`, () => {
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

  it('a rewritten line keeps every sentence it had and adds to it, except the outside guests\' line', () => {
    const keeps: Array<[string, string]> = [[CALENDAR, 'Finding a time:']]
    for (const [id, start] of keeps) {
      const old = PREVIOUS[id].split('\n').find((l) => l.startsWith(start))!
      const now = text(id).split('\n').find((l) => l.startsWith(start))!
      for (const sentence of old.split(/(?<=\.) /)) expect(now, sentence).toContain(sentence)
      expect(now.length, start).toBeGreaterThan(old.length)
    }
    // The opening line only adds offer_times to the tools it reveals.
    const open = text(FIND_A_TIME).split('\n')[0]
    expect(open).toBe(PREVIOUS[FIND_A_TIME].split('\n')[0].replace('`set_working_hours` or `create_calendar_event`', '`set_working_hours`, `create_calendar_event` or `offer_times`'))
  })

  it('offers an outside guest the slots with offer_times, a link by default, email or text on the person\'s card, in place of a drafted email', () => {
    const cal = text(CALENDAR)
    expect(cal).toContain('An outside guest: offer the slots with `offer_times`, held until they pick one and then booked;')
    expect(cal).toContain("`send_by` `link` (default) returns a link and text to send, `email` or `text` is the person's card.")
    const fat = text(FIND_A_TIME)
    expect(fat).toContain("Guests outside the company: offer the slots with `offer_times` (held until they pick; by link unless the person says email or text, which is their card)")
    // The drafted email is gone from the outside guests' line: offer_times takes its place.
    expect(fat).not.toContain('Offer to draft an email proposing the slots instead')
    expect(PREVIOUS[FIND_A_TIME]).toContain('Offer to draft an email proposing the slots instead')
  })

  it("teaches accept_time_offer only for that offer's own time and recipient, and the other offer tools", () => {
    const cal = text(CALENDAR)
    expect(cal).toContain("`accept_time_offer` books the time a guest named in a reply (that offer's own time and recipient only)")
    for (const tool of ['list_time_offers', 'withdraw_time_offer', 'accept_time_offer', 'cancel_offered_meeting']) expect(cal, tool).toContain(`\`${tool}\``)
    expect(text(FIND_A_TIME)).toContain('a reply in words is `accept_time_offer`.')
  })

  it('names only real tools and arguments', () => {
    const properties = (registryToolInputSchemas().get('offer_times')?.properties ?? {}) as Record<string, unknown>
    expect(Object.keys(properties)).toContain('send_by')
    const accept = (registryToolInputSchemas().get('accept_time_offer')?.properties ?? {}) as Record<string, unknown>
    expect(Object.keys(accept).sort()).toEqual(['offer_id', 'start'])
    for (const { prompt, slug } of rows) {
      for (const m of prompt.matchAll(/`([a-z]+_[a-z_]+)`/g)) {
        const name = m[1]
        if (['send_by', 'working_hours_are_default', 'availability_sharing', 'buffer_minutes', 'duration_minutes', 'time_zone', 'local_exchange', 'max_results', 'start_date', 'end_date', 'event_id', 'participant_email', 'account_email', 'hours_ahead', 'capture_status'].includes(name)) continue
        expect((ALL_TOOL_NAMES as readonly string[]).includes(name) || name === 'search_tools', `${slug}: ${name}`).toBe(true)
      }
    }
  })

  it('names no chat-only tool but set_working_hours, and keeps the ask-first rule', () => {
    for (const { prompt, slug } of rows) {
      const named = [...prompt.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]).filter((w) => ATTENDED_ONLY_TOOL_NAMES.has(w))
      expect([...new Set(named)], slug).toEqual(['set_working_hours'])
    }
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
    expect(guard.match(/system_prompt LIKE '%`offer_times`%'/g)?.length).toBe(2)
    expect(guard).toContain("system_prompt LIKE '%`accept_time_offer`%'")
    expect(guard).toContain(`agent_config -> 'preferred_tools' @> '["offer_times"]'::jsonb`)
    for (const id of [CALENDAR, FIND_A_TIME]) expect(PREVIOUS[id]).not.toContain('offer_times')
    expect(BODY.indexOf('DO $guard$')).toBeGreaterThan(BODY.lastIndexOf('UPDATE public.recipe'))
  })

  it('is idempotent: by id, guarded by slug and is_system, only where the text or tools differ; no backslash', () => {
    expect(sql.includes(String.fromCharCode(92))).toBe(false)
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
    const statements = BODY.replace(/\$pb\$[\s\S]*?\$pb\$/g, () => 'skill')
    expect(statements.match(/\bUPDATE public\.\w+/g)).toEqual(['UPDATE public.recipe', 'UPDATE public.recipe'])
    expect(statements).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|INSERT\s+INTO|DROP|ALTER)\b/i)
    expect(BODY).toContain('SET system_prompt = p.system_prompt, updated_at = now()')
    expect(BODY).toContain('WHERE r.id = p.id AND r.slug = p.slug AND r.is_system AND r.system_prompt IS DISTINCT FROM p.system_prompt;')
    expect(BODY).toContain("SET agent_config = jsonb_set(COALESCE(r.agent_config, '{}'::jsonb), '{preferred_tools}', p.preferred_tools), updated_at = now()")
    expect(BODY).toContain("WHERE r.id = p.id AND r.slug = p.slug AND r.is_system AND r.agent_config -> 'preferred_tools' IS DISTINCT FROM p.preferred_tools;")
  })
})
