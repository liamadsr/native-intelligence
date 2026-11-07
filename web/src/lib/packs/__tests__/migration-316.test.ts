/**
 * Migration 316 and the registry must agree: the CHECK on recipe.area is the
 * registry's area list, every system tag is a real area, and each playbook is
 * seeded under its area's playbook slug, tagged with that area. A new area
 * added on one side only fails here.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AREA_KEYS, playbookSlug, isAreaKey } from '../registry'

/** The 16 page areas 316 knew; 384 widens the CHECK with content and marketing (migration-384.test.ts). */
const PAGE_AREAS = AREA_KEYS.filter((a) => a !== 'content' && a !== 'marketing')

const sql = readFileSync(join(process.cwd(), 'supabase/migrations/316_skill_area_and_playbooks.sql'), 'utf8')

describe('migration 316', () => {
  it('CHECKs recipe.area against exactly the registry’s areas, NULL allowed', () => {
    const check = /CHECK \(\s*area IS NULL OR area IN \(([^)]*)\)/.exec(sql)
    expect(check).not.toBeNull()
    const listed = [...check![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect(listed).toHaveLength(16)
    expect(new Set(listed).size).toBe(16)
    expect(listed).toEqual([...PAGE_AREAS])
    // Every page area the registry has is allowed, and nothing else.
    for (const key of PAGE_AREAS) expect(listed, key).toContain(key)
  })

  it('seeds exactly the Mail and Calendar playbooks, each under its area’s slug and tagged with that area, as system skills', () => {
    const seed = /WITH playbook \(([^)]*)\) AS \(\s*VALUES([\s\S]*?)\n\),\ninserted AS/.exec(sql)
    expect(seed).not.toBeNull()
    expect(seed![1].split(',').map((c) => c.trim())).toEqual(['id', 'name', 'slug', 'icon', 'color', 'description', 'system_prompt', 'agent_config', 'area'])
    const rows = [...seed![2].matchAll(/\$slug\$([a-z-]+)\$slug\$[\s\S]*?\$cfg\$::jsonb,\s*'([a-z_]+)'\s*\)/g)].map((m) => ({ slug: m[1], area: m[2] }))
    expect(rows).toEqual([
      { slug: 'mail-playbook', area: 'mail' },
      { slug: 'calendar-playbook', area: 'calendar' },
    ])
    for (const { slug, area } of rows) {
      expect(isAreaKey(area), area).toBe(true)
      if (isAreaKey(area)) expect(slug).toBe(playbookSlug(area))
    }
    // Inserted as system skills, with no workspace.
    expect(sql).toMatch(/SELECT id, NULL::uuid, name, slug, icon, color, description,\s*system_prompt, agent_config, area,\s*'skill'::public\.recipe_category, true,/)
  })

  it('adds the column and the constraint only when missing, under a lock timeout', () => {
    expect(sql).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS area text;/)
    expect(sql).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint\s*WHERE conname = 'recipe_area_check'/)
  })

  it('tags system skills only with real areas, each skill once', () => {
    const tags = [...sql.matchAll(/UPDATE public\.recipe SET area = '([a-z_]+)'\nWHERE is_system = true AND workspace_id IS NULL AND category = 'skill'\n  AND slug IN \(([^)]*)\)/g)]
    expect(tags.length).toBeGreaterThan(0)
    const seen = new Set<string>()
    for (const [, area, slugs] of tags) {
      expect(isAreaKey(area), area).toBe(true)
      for (const [, slug] of slugs.matchAll(/'([a-z-]+)'/g)) {
        expect(seen.has(slug), `${slug} tagged twice`).toBe(false)
        seen.add(slug)
      }
    }
    // The ones the plan names.
    for (const slug of ['meeting-prep', 'occasion', 'triage', 'reconcile', 'session-insights', 'knowledge-weaver', 'canon-sync', 'scout', 'find-email', 'email-bridge', 'groom', 'standup-sync', 'weekend-sprint', 'create-eval', 'create-skill']) {
      expect(seen.has(slug), slug).toBe(true)
    }
  })

  it('seeds the Mail and Calendar playbooks under their playbook slugs, tagged with their area', () => {
    for (const area of ['mail', 'calendar'] as const) {
      const row = new RegExp(
        `\\$slug\\$${playbookSlug(area)}\\$slug\\$,[\\s\\S]*?\\$pb\\$([\\s\\S]*?)\\$pb\\$,\\s*\\$cfg\\$[\\s\\S]*?\\$cfg\\$::jsonb,\\s*'${area}'\\s*\\)`,
      ).exec(sql)
      expect(row, area).not.toBeNull()
      const words = row![1].split(/\s+/).length
      // About 1,000 tokens: a playbook, not a novel.
      expect(words, `${area} playbook words`).toBeGreaterThan(450)
      expect(words, `${area} playbook words`).toBeLessThan(900)
    }
  })

  it('grounds each playbook in the area’s real tools', () => {
    const mail = /\$slug\$mail-playbook\$slug\$[\s\S]*?\$pb\$([\s\S]*?)\$pb\$/.exec(sql)![1]
    for (const tool of ['list_emails', 'read_email', 'create_email_draft', 'revise_email_draft', 'get_email_summary', 'generate_email_drafts']) {
      expect(mail, tool).toContain(`\`${tool}\``)
    }
    const calendar = /\$slug\$calendar-playbook\$slug\$[\s\S]*?\$pb\$([\s\S]*?)\$pb\$/.exec(sql)![1]
    for (const tool of ['get_calendar_events', 'create_calendar_event', 'update_calendar_event', 'delete_calendar_event', 'get_meeting_prep', 'get_upcoming_meetings']) {
      expect(calendar, tool).toContain(`\`${tool}\``)
    }
    // What the tools really do: five drafts by default, and every capture status.
    expect(mail).toContain('pass `max_drafts: 10` for up to ten')
    // "Handle my email" goes through Clear an inbox, which drafts in the remembered tone.
    expect(mail).toMatch(/"Handle my email"[^\n]*load the `clear-inbox` skill/)
    for (const status of ['pending', 'ready', 'recording', 'completed']) expect(calendar, status).toContain(status)
    expect(calendar).toContain('`capture_status: null`')
    expect(calendar).toContain('`sync_calendar`')
  })
})
