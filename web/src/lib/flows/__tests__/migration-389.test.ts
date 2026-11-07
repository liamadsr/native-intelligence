/**
 * Migration 389 (P9, marketing M2): the shipped-note and launch-kit skills.
 * Pinned: two system skills, gated with Flows, each asking the server for its
 * material; what they teach (one email per person who asked, never sent; the
 * launch kit from shipped work only, never a customer); no mail reads; no
 * backslash. Applied nowhere yet.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { FEATURES } from '@/lib/editions/manifest'
import { recipeFlow } from '../recipes'

const raw = readFileSync(resolve(__dirname, '../../../../supabase/migrations/389_shipped_note_skills.sql'), 'utf8')
const rows = [...raw.matchAll(/'([0-9a-f-]{36})'::uuid,\s*\$name\$[\s\S]*?\$slug\$([a-z-]+)\$slug\$[\s\S]*?\$desc\$([\s\S]*?)\$desc\$,\s*\$pb\$([\s\S]*?)\$pb\$,\s*\$cfg\$([\s\S]*?)\$cfg\$::jsonb,\s*(NULL::text|'[a-z]+')/g)].map((m) => ({
  id: m[1],
  slug: m[2],
  desc: m[3],
  prompt: m[4],
  cfg: JSON.parse(m[5]),
  area: m[6],
}))
const by = (slug: string) => rows.find((r) => r.slug === slug)!

describe('migration 389: the you-asked-we-shipped skills', () => {
  it('seeds shipped-note and launch-kit as loop skills, gated with Flows, that the recipe names', () => {
    expect(rows.map((r) => [r.slug, r.cfg.material, r.area])).toEqual([
      ['shipped-note', 'asked_by', 'NULL::text'],
      ['launch-kit', 'shipped', 'NULL::text'],
    ])
    for (const r of rows) {
      expect(FEATURES.flows.systemRecipeIds).toContain(r.id)
      expect(r.desc.length).toBeLessThanOrEqual(200)
      expect(r.prompt).not.toMatch(/\byou are\b/i)
    }
    const recipe = recipeFlow('you_asked_we_shipped', { launch_kit: true })
    if (recipe instanceof Error) throw recipe
    expect(recipe.actions.map((a) => (a.type === 'run_skill' ? a.skill : null))).toEqual([by('shipped-note').id, by('launch-kit').id])
  })

  it('the notes: one email per person who asked, nobody else, never sent; no mail read', () => {
    const p = by('shipped-note').prompt
    expect(p).toMatch(/one email, to that one address and nobody else/)
    expect(p).toMatch(/Nothing is ever sent/)
    expect(p).toMatch(/If nobody is listed, return no drafts/)
    expect(by('shipped-note').cfg.enabled_tools).not.toContain('emails')
  })

  it('the launch kit: from the shipped work only, public-safe, posted by the person', () => {
    const p = by('launch-kit').prompt
    expect(p).toMatch(/from the shipped work in the message and nothing else/)
    expect(p).toMatch(/never a customer, a company, a person's name, a price or a deal/)
    expect(p).toMatch(/Nothing is posted or published/)
  })

  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(raw).not.toContain('\\')
  })
})
