/**
 * Migration 453 (docs/plans/getting-started-skill.md): the getting-started
 * system skill, seeded under the id the code reads it by, and the Onboarding
 * Guide persona's row deleted. Pinned from the file, as the other seed
 * migrations are.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GETTING_STARTED_SKILL_ID, GETTING_STARTED_SKILL_SLUG, FINISH_GETTING_STARTED_TOOL } from '../getting-started'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/453_getting_started_skill.sql'), 'utf8')
const GUIDE_ID = '0e5b1c9a-6d2f-4a7b-9c31-8f0a2b4c6d7e'

describe('migration 453', () => {
  it('seeds the skill under the id and slug the code reads, as a system skill of no workspace', () => {
    expect(SQL).toContain(`'${GETTING_STARTED_SKILL_ID}'::uuid`)
    expect(SQL).toContain(`$slug$${GETTING_STARTED_SKILL_SLUG}$slug$`)
    expect(SQL).toMatch(/'skill'::public\.recipe_category, true, false/)
    expect(SQL).toContain('ON CONFLICT (id) DO NOTHING')
  })

  it("its steps name the tools it uses, the finishing one included, and never a persona", () => {
    const body = SQL.slice(SQL.indexOf('$pb$') + 4, SQL.lastIndexOf('$pb$'))
    for (const tool of [FINISH_GETTING_STARTED_TOOL, 'get_capture_extractions', 'connect', 'update_project', 'list_connections']) {
      expect(body, tool).toContain(tool)
    }
    expect(body).not.toMatch(/You are (the|an?) /)
  })

  it('deletes only the guide persona, a system agent, and never one a bot is built on', () => {
    const del = SQL.slice(SQL.indexOf('DELETE FROM public.recipe'))
    expect(del).toContain(`'${GUIDE_ID}'::uuid`)
    expect(del).toContain('AND r.is_system')
    expect(del).toContain("r.category = 'agent'::public.recipe_category")
    expect(del).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM public\.ai_team_member AS t WHERE t\.agent_recipe_id = r\.id\s*\)/)
  })

  it('has no backslash, and a lock timeout', () => {
    expect(SQL).not.toContain('\\')
    expect(SQL).toContain("SET LOCAL lock_timeout = '5s';")
  })
})
