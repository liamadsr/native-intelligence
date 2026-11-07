/**
 * Migration 319 seeds the other fourteen playbooks and Mail's two new skills.
 * It must hold exactly those, each under its area's playbook slug and tagged
 * with that area, as system skills, and every one in a gated area must be
 * hidden with its feature (manifest systemRecipeIds), the way mail-playbook
 * is. A playbook added or renamed on one side only fails here.
 */
import { describe, it, expect } from 'vitest'
import { AREA_KEYS, PACKS, isAreaKey, playbookSlug, type AreaKey } from '../registry'
import { FEATURES, CORE_FEATURE } from '@/lib/editions/manifest'
import { TOOL_CATEGORIES } from '@/lib/ai/tool-registry'
import { allSeededSkills, allShippedSkills, readMigration, seededSkills } from './playbook-seeds'

const FILE = '319_area_playbooks.sql'
const sql = readMigration(FILE)
const rows = seededSkills(FILE)

/** The areas 316 already seeded. */
const S1_AREAS: readonly AreaKey[] = ['mail', 'calendar']
/** The areas 384 added (content and marketing): their playbooks are 384's. */
const P8_AREAS: readonly AreaKey[] = ['content', 'marketing']
const S4_AREAS = AREA_KEYS.filter((a) => !S1_AREAS.includes(a) && !P8_AREAS.includes(a))
const MAIL_SKILLS = ['write-in-your-tone', 'clear-inbox']

describe('migration 319', () => {
  it('seeds exactly the fourteen other playbooks, in area order, then the two Mail skills', () => {
    expect(S4_AREAS).toHaveLength(14)
    expect(rows.map((r) => ({ slug: r.slug, area: r.area }))).toEqual([
      ...S4_AREAS.map((area) => ({ slug: playbookSlug(area), area })),
      ...MAIL_SKILLS.map((slug) => ({ slug, area: 'mail' })),
    ])
  })

  it('tags every row with a real area, and names each playbook playbookSlug(area)', () => {
    for (const row of rows) {
      expect(isAreaKey(row.area), row.slug).toBe(true)
      if (row.slug.endsWith('-playbook') && isAreaKey(row.area)) expect(row.slug).toBe(playbookSlug(row.area))
    }
  })

  it('inserts them as system skills with no workspace, under a lock timeout, and never touches 316’s rows', () => {
    expect(sql).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(sql).toMatch(/SELECT id, NULL::uuid, name, slug, icon, color, description,\s*system_prompt, agent_config, area,\s*'skill'::public\.recipe_category, true,/)
    expect(sql).toMatch(/ON CONFLICT \(id\) DO NOTHING/)
    const s1 = seededSkills('316_skill_area_and_playbooks.sql')
    for (const row of rows) {
      expect(s1.some((r) => r.id === row.id || r.slug === row.slug), row.slug).toBe(false)
    }
    // No DDL: 319 is seed only. (The prompts are prose and may say "drop".)
    const statements = sql.replace(/\$(pb|desc)\$[\s\S]*?\$\1\$/g, '')
    expect(statements).not.toMatch(/\bALTER\s+TABLE\b|\bCREATE\s+TABLE\b|\bDROP\s+(TABLE|COLUMN|INDEX|POLICY|FUNCTION|TRIGGER|CONSTRAINT)\b/i)
  })

  it('updates an existing row when any seeded column differs, icon and color included', () => {
    const check = /WHERE r\.id = p\.id\s*AND \(([\s\S]*?)\);/.exec(sql)
    expect(check).not.toBeNull()
    for (const col of ['system_prompt', 'description', 'agent_config', 'area', 'slug', 'name', 'icon', 'color']) {
      expect(check![1], col).toContain(`r.${col} IS DISTINCT FROM p.${col}`)
    }
  })

  it('declares only real tool groups and tools in agent_config', () => {
    const groups = new Set(TOOL_CATEGORIES.map((c) => c.id))
    const tools = new Set(TOOL_CATEGORIES.flatMap((c) => c.tools.map((t) => t.name)))
    for (const row of rows) {
      expect(row.config.enabled_tools?.length, row.slug).toBeGreaterThan(0)
      for (const g of row.config.enabled_tools ?? []) expect(groups.has(g), `${row.slug}: group ${g}`).toBe(true)
      for (const t of row.config.preferred_tools ?? []) expect(tools.has(t), `${row.slug}: tool ${t}`).toBe(true)
    }
  })

  it('gives every seeded skill its own id', () => {
    const ids = allSeededSkills().map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('hides every gated area’s skills with its feature, as mail-playbook is', () => {
    for (const row of allSeededSkills()) {
      if (!isAreaKey(row.area)) continue
      const feature = PACKS[row.area].feature
      const ids = FEATURES[feature].systemRecipeIds ?? []
      if (feature === CORE_FEATURE) {
        // A core area is never off, so nothing hides it.
        expect(ids, row.slug).not.toContain(row.id)
      } else {
        expect(ids, `${row.slug} must be in FEATURES.${feature}.systemRecipeIds`).toContain(row.id)
      }
    }
  })

  it('has one playbook for every area across 316 and 319, and 384 for content and marketing', () => {
    const playbooks = allSeededSkills().filter((r) => r.slug.endsWith('-playbook'))
    expect(playbooks.map((r) => r.area).sort()).toEqual(AREA_KEYS.filter((a) => !P8_AREAS.includes(a)).sort())
    const all = allShippedSkills().filter((r) => r.slug.endsWith('-playbook'))
    expect(all.map((r) => r.area).sort()).toEqual([...AREA_KEYS].sort())
  })
})
