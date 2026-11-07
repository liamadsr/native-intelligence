/**
 * Migration 347: the Morning Brief stops prepping each meeting (prep comes
 * about 30 minutes before each meeting, src/lib/agent-events/meeting-prep.ts).
 * Pins: no backslash; every statement touches only the system `brief` skill
 * and only text that is still the old text (safe to run twice); every piece
 * of old text it replaces is really in the brief as migration 142 wrote it
 * (a replace that matches nothing would silently leave the prep in); the
 * overview line replaces the per-meeting rules.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
const SQL = read('347_brief_meetings_overview.sql')
/** Migration 142's brief, SQL quoting undone (the text the brief holds). */
const BRIEF_142 = read('142_morning_brief_skill.sql').replace(/''/g, "'")
const statements = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter(Boolean)
/** The old text each `replace(system_prompt, '<old>', ...)` looks for, quoting undone. */
const replaced = [...SQL.matchAll(/replace\(system_prompt,\s*'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"))

describe('migration 347', () => {
  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('every statement updates the system brief skill only, guarded on the old text (idempotent)', () => {
    expect(statements.length).toBe(9)
    for (const s of statements) {
      expect(s.startsWith('UPDATE public.recipe')).toBe(true)
      expect(s).toContain("WHERE is_system = true AND category = 'skill' AND slug = 'brief'")
      expect(s).toMatch(/AND (position\(|COALESCE\(agent_config::text|description LIKE)/)
      expect(s).not.toMatch(/\b(delete|drop|insert|truncate)\b/i)
    }
  })

  it('every replaced sentence and both section markers are in the brief as written (the replaces hit)', () => {
    expect(replaced).toHaveLength(6)
    for (const old of replaced) expect(BRIEF_142).toContain(old)
    expect(BRIEF_142).toContain('### 2. Work out what each real meeting is about')
    expect(BRIEF_142).toContain('### 3. Pull what')
    expect(BRIEF_142.indexOf('### 2. Work out what each real meeting is about')).toBeLessThan(BRIEF_142.indexOf('### 3. Pull what'))
    for (const rule of ['to find what a meeting is about', 'Derive each meeting', 'Triage the calendar']) expect(BRIEF_142).toContain(rule)
  })

  it('the brief keeps one overview line and says the prep comes about 30 minutes before each meeting', () => {
    expect(SQL).toContain('### 2. Meetings get one line here; their prep comes later')
    expect(SQL).toContain('no section per meeting, no search per meeting')
    expect(SQL).toContain("- **Today''s meetings** — the one overview line from step 2")
    expect(SQL).toContain('No per-meeting prep in the brief: each meeting gets its own prep about 30 minutes before it starts.')
    // The step 3 text that points back at step 2's search still has a search to point at.
    expect(SQL).toContain('Then run ONE broad `deep_search`')
  })
})
