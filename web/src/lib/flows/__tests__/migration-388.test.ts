/**
 * Migration 388 (P9, content C1): the weekly-posts skill. Pinned: one system
 * skill, gated with Flows, asking the server for the week's material; what
 * its text teaches (the material, never a name, ideas on a slow week, never
 * posted for them); idempotence; no backslash. Applied nowhere yet.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { FEATURES } from '@/lib/editions/manifest'
import { recipeFlow } from '../recipes'

const raw = readFileSync(resolve(__dirname, '../../../../supabase/migrations/388_weekly_posts_skill.sql'), 'utf8')
const rows = [...raw.matchAll(/'([0-9a-f-]{36})'::uuid,\s*\$name\$[\s\S]*?\$slug\$([a-z-]+)\$slug\$[\s\S]*?\$desc\$([\s\S]*?)\$desc\$,\s*\$pb\$([\s\S]*?)\$pb\$,\s*\$cfg\$([\s\S]*?)\$cfg\$::jsonb,\s*(NULL::text|'[a-z]+')/g)].map((m) => ({
  id: m[1],
  slug: m[2],
  desc: m[3],
  prompt: m[4],
  cfg: JSON.parse(m[5]),
  area: m[6],
}))
const statements = raw
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

describe('migration 388: the weekly-posts skill', () => {
  it('seeds one system skill, no area, gated with Flows, that the weekly_posts recipe names', () => {
    expect(rows.map((r) => [r.id, r.slug, r.area])).toEqual([['80d160c4-1b4a-481d-8b76-aa7fc1609326', 'weekly-posts', 'NULL::text']])
    expect(FEATURES.flows.systemRecipeIds).toContain(rows[0].id)
    const recipe = recipeFlow('weekly_posts')
    expect(recipe instanceof Error ? null : (recipe.actions[0] as { skill?: string }).skill).toBe(rows[0].id)
    expect(statements).toContain("'skill'::public.recipe_category, true, false, 0, 'workspace'::public.recipe_visibility")
    expect(statements).toContain('ON CONFLICT (id) DO NOTHING')
    expect(statements).toContain('r.system_prompt IS DISTINCT FROM p.system_prompt')
  })

  it('asks the server for the week’s material and reads with the content tools (the playbook rides the run)', () => {
    const cfg = rows[0].cfg
    expect(cfg.material).toBe('post_week')
    expect(cfg.output_contract).toBe('prose')
    expect(cfg.enabled_tools).toEqual(['content', 'documents', 'actions', 'projects'])
    expect(cfg.preferred_tools).toContain('lint_post')
  })

  it('teaches the rules: never published for them, never a name, the brief wins, ideas on a slow week', () => {
    const p = rows[0].prompt
    expect(p).toMatch(/Nothing is ever published for them/)
    expect(p).toMatch(/never a name, a company, a customer, a price or a deal/)
    expect(p).toMatch(/Never mail, the CRM or a private call/)
    expect(p).toMatch(/never post an assumption as fact/)
    expect(p).toMatch(/A slow week is never an empty week/)
    expect(p).toMatch(/mark it `idea: true`/)
    expect(p).toMatch(/names in `uses` the moment keys/)
    // The run has no web tool: it is never told to search the web (P9 review nit).
    expect(p).not.toMatch(/web search/i)
    expect(rows[0].desc.length).toBeLessThanOrEqual(200)
    expect(p).not.toMatch(/\byou are\b/i)
  })

  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(raw).not.toContain('\\')
  })
})
