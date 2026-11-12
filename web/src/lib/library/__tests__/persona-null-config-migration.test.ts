/**
 * Migration 279 pins every persona that inherited all tools by OMISSION to the
 * explicit every-category-on selection (Sequence step 1 made a NULL selection
 * core-only on every runtime). Two things must hold or the migration is not
 * inert:
 *   - its category list is EXACTLY ALL_CATEGORY_IDS — agentInheritsAllTools is
 *     true only when every registry category is on, so a missing id would
 *     silently narrow the six prod personas instead of preserving them;
 *   - it targets personas only, and skips a row whose absent key came with a
 *     non-empty disabled list (that row was never inherit-all).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALL_CATEGORY_IDS } from '@/lib/ai/tool-registry'
import { agentInheritsAllTools } from '@/lib/live-agent/read-tool-names'

const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase/migrations/279_persona_null_config_inherit_all.sql'),
  'utf8',
)
// 282 is 279's write with a NULL-safe WHERE: 279's `AND NOT (typeof = 'array' AND
// length > 0)` is NULL — not selected — for the NULL-config rows it targets.
const MIGRATION_NULL_SAFE = readFileSync(
  join(process.cwd(), 'supabase/migrations/282_persona_null_config_inherit_all_null_safe.sql'),
  'utf8',
)

// 293 grants a category added AFTER 279/282 to every row that was inherit-all.
const MIGRATION_GRANT_BROWSER = readFileSync(
  join(process.cwd(), 'supabase/migrations/293_persona_grant_browser_category.sql'),
  'utf8',
)

// 387 grants `content` (P8) the same way, one category later.
const MIGRATION_GRANT_CONTENT = readFileSync(
  join(process.cwd(), 'supabase/migrations/387_persona_grant_content_category.sql'),
  'utf8',
)

// 538 grants `tables` (Tables phase 5) the same way, one category later.
const MIGRATION_GRANT_TABLES = readFileSync(
  join(process.cwd(), 'supabase/migrations/538_persona_grant_tables_category.sql'),
  'utf8',
)

// 623 grants `studio` (Studio, migration 620) the same way, one category later.
const MIGRATION_GRANT_STUDIO = readFileSync(
  join(process.cwd(), 'supabase/migrations/623_studio_persona_grant.sql'),
  'utf8',
)

// 628 squares 538 and 623, written on two branches: whichever runs second
// replaces the first one's list with its own 26, so it brings a persona left
// with exactly one of `tables` and `studio` up to all 27.
const MIGRATION_GRANT_TABLES_AND_STUDIO = readFileSync(
  join(process.cwd(), 'supabase/migrations/628_persona_grant_tables_and_studio.sql'),
  'utf8',
)

function migratedCategories(sql: string = MIGRATION, tag: 'cats' | 'prev' = 'cats'): string[] {
  const match = sql.match(new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`))
  expect(match, `migration is missing its $${tag}$ block`).toBeTruthy()
  return JSON.parse(match![1]) as string[]
}

/** Registry categories added after 279/282 were written. Each needs a grant
 *  migration (like 287) so every-category personas stay inherit-all — see the
 *  287 block below. 279/282 are historical: pinned to the registry of their day. */
const ADDED_AFTER_282 = ['browser', 'content', 'tables', 'studio']
/** Registry categories added after 293 (each with its own grant migration). */
const ADDED_AFTER_293 = ['content', 'tables', 'studio']
/** Registry categories added after 387 (each with its own grant migration; 628 squares the two). */
const ADDED_AFTER_387 = ['tables', 'studio']
const CATEGORIES_AS_OF_282 = ALL_CATEGORY_IDS.filter((id) => !ADDED_AFTER_282.includes(id))

describe('migration 279 — NULL-config personas keep their inherit-all surface', () => {
  it('writes exactly the registry categories of its day, in registry order', () => {
    expect(migratedCategories()).toEqual(CATEGORIES_AS_OF_282)
  })

  it('the written selection was inherit-all (and is again once 293 grants the newer categories)', () => {
    const afterGrant = [...migratedCategories(), ...ADDED_AFTER_282]
    expect(agentInheritsAllTools({ enabled_tools: afterGrant, disabled_tools: [] })).toBe(true)
  })

  it('targets personas only, and only rows that had no selection', () => {
    expect(MIGRATION).toMatch(/WHERE category = 'agent'/)
    expect(MIGRATION).toMatch(/agent_config IS NULL/)
    expect(MIGRATION).toMatch(/agent_config->'enabled_tools' IS NULL/)
    // A pure disabled_tools restriction was never inherit-all — left alone.
    expect(MIGRATION).toMatch(/jsonb_array_length\(agent_config->'disabled_tools'\) > 0/)
    // Other keys survive: the merge starts from the existing config.
    expect(MIGRATION).toMatch(/COALESCE\(agent_config, '\{\}'::jsonb\)\s*\|\| jsonb_build_object/)
  })
})

describe('migration 282 — the same write, NULL-safe', () => {
  it('writes exactly the same list as 279 (the registry of its day, registry order)', () => {
    expect(migratedCategories(MIGRATION_NULL_SAFE)).toEqual(CATEGORIES_AS_OF_282)
    expect(migratedCategories(MIGRATION_NULL_SAFE)).toEqual(migratedCategories())
  })

  it('selects a NULL config: the disabled-list test is a CASE that yields 0 for an absent list, never NOT (NULL)', () => {
    expect(MIGRATION_NULL_SAFE).toMatch(/WHERE category = 'agent'/)
    expect(MIGRATION_NULL_SAFE).toMatch(/agent_config IS NULL/)
    expect(MIGRATION_NULL_SAFE).toMatch(/agent_config->'enabled_tools' IS NULL/)
    expect(MIGRATION_NULL_SAFE).toMatch(
      /CASE\s+WHEN jsonb_typeof\(agent_config->'disabled_tools'\) = 'array' THEN jsonb_array_length\(agent_config->'disabled_tools'\)\s+ELSE 0\s+END\s*\)\s*=\s*0/,
    )
    // The header quotes 279's clause to explain the bug; the STATEMENT must not carry it.
    const statement = MIGRATION_NULL_SAFE.split('\n').filter((line) => !line.startsWith('--')).join('\n')
    expect(statement).not.toMatch(/AND NOT \(/)
    // The merge starts from the existing config when it is an object, else from {}.
    expect(MIGRATION_NULL_SAFE).toMatch(/CASE WHEN jsonb_typeof\(agent_config\) = 'object' THEN agent_config ELSE '\{\}'::jsonb END\)\s*\|\| jsonb_build_object/)
  })
})

describe('migration 293 — every-category personas stay inherit-all after `browser` was added', () => {
  it('writes the registry of its day (every category but the ones added since), in registry order', () => {
    expect(migratedCategories(MIGRATION_GRANT_BROWSER)).toEqual(ALL_CATEGORY_IDS.filter((id) => !ADDED_AFTER_293.includes(id)))
  })

  it('targets exactly the rows 279/282 left inherit-all: the full previous list, no browser yet', () => {
    expect(migratedCategories(MIGRATION_GRANT_BROWSER, 'prev')).toEqual(migratedCategories(MIGRATION_NULL_SAFE))
    expect(MIGRATION_GRANT_BROWSER).toMatch(/WHERE category = 'agent'/)
    expect(MIGRATION_GRANT_BROWSER).toMatch(/agent_config->'enabled_tools' @> \$prev\$/)
    expect(MIGRATION_GRANT_BROWSER).toMatch(/NOT \(agent_config->'enabled_tools' \? 'browser'\)/)
    // A pure disabled_tools restriction was never inherit-all — left alone.
    expect(MIGRATION_GRANT_BROWSER).toMatch(
      /CASE\s+WHEN jsonb_typeof\(agent_config->'disabled_tools'\) = 'array' THEN jsonb_array_length\(agent_config->'disabled_tools'\)\s+ELSE 0\s+END\s*\)\s*=\s*0/,
    )
    // Other keys survive: the merge starts from the existing config.
    expect(MIGRATION_GRANT_BROWSER).toMatch(/SET agent_config = agent_config\s*\|\| jsonb_build_object/)
  })
})

describe('migration 387 — every-category personas stay inherit-all after `content` was added (P8)', () => {
  it('writes the registry of its day (every category but the ones added since), in registry order', () => {
    expect(migratedCategories(MIGRATION_GRANT_CONTENT)).toEqual(ALL_CATEGORY_IDS.filter((id) => !ADDED_AFTER_387.includes(id)))
  })

  it('targets exactly the rows 293 left inherit-all: the full previous list, no content yet', () => {
    expect(migratedCategories(MIGRATION_GRANT_CONTENT, 'prev')).toEqual(migratedCategories(MIGRATION_GRANT_BROWSER))
    expect(MIGRATION_GRANT_CONTENT).toMatch(/WHERE category = 'agent'/)
    expect(MIGRATION_GRANT_CONTENT).toMatch(/agent_config->'enabled_tools' @> \$prev\$/)
    expect(MIGRATION_GRANT_CONTENT).toMatch(/NOT \(agent_config->'enabled_tools' \? 'content'\)/)
    expect(MIGRATION_GRANT_CONTENT).toMatch(
      /CASE\s+WHEN jsonb_typeof\(agent_config->'disabled_tools'\) = 'array' THEN jsonb_array_length\(agent_config->'disabled_tools'\)\s+ELSE 0\s+END\s*\)\s*=\s*0/,
    )
    expect(MIGRATION_GRANT_CONTENT).toMatch(/SET agent_config = agent_config\s*\|\| jsonb_build_object/)
  })
})

describe('migration 538 — every-category personas stay inherit-all after `tables` was added (Tables phase 5)', () => {
  it('writes the registry of its branch (every category but `studio`, 623\'s), in registry order', () => {
    expect(migratedCategories(MIGRATION_GRANT_TABLES)).toEqual(ALL_CATEGORY_IDS.filter((id) => id !== 'studio'))
  })

  it('targets exactly the rows 387 left inherit-all: the full previous list, no tables yet', () => {
    expect(migratedCategories(MIGRATION_GRANT_TABLES, 'prev')).toEqual(migratedCategories(MIGRATION_GRANT_CONTENT))
    expect(MIGRATION_GRANT_TABLES).toMatch(/WHERE category = 'agent'/)
    expect(MIGRATION_GRANT_TABLES).toMatch(/agent_config->'enabled_tools' @> \$prev\$/)
    expect(MIGRATION_GRANT_TABLES).toMatch(/NOT \(agent_config->'enabled_tools' \? 'tables'\)/)
    expect(MIGRATION_GRANT_TABLES).toMatch(
      /CASE\s+WHEN jsonb_typeof\(agent_config->'disabled_tools'\) = 'array' THEN jsonb_array_length\(agent_config->'disabled_tools'\)\s+ELSE 0\s+END\s*\)\s*=\s*0/,
    )
    expect(MIGRATION_GRANT_TABLES).toMatch(/SET agent_config = agent_config\s*\|\| jsonb_build_object/)
  })
})

describe('migration 623 — every-category personas stay inherit-all after `studio` was added', () => {
  it('writes the registry of its branch (every category but `tables`, 538\'s), in registry order', () => {
    expect(migratedCategories(MIGRATION_GRANT_STUDIO)).toEqual(ALL_CATEGORY_IDS.filter((id) => id !== 'tables'))
  })

  it('targets exactly the rows 387 left inherit-all: the full previous list, no studio yet', () => {
    expect(migratedCategories(MIGRATION_GRANT_STUDIO, 'prev')).toEqual(migratedCategories(MIGRATION_GRANT_CONTENT))
    expect(MIGRATION_GRANT_STUDIO).toMatch(/WHERE category = 'agent'/)
    expect(MIGRATION_GRANT_STUDIO).toMatch(/agent_config->'enabled_tools' @> \$prev\$/)
    expect(MIGRATION_GRANT_STUDIO).toMatch(/NOT \(agent_config->'enabled_tools' \? 'studio'\)/)
    expect(MIGRATION_GRANT_STUDIO).toMatch(
      /CASE\s+WHEN jsonb_typeof\(agent_config->'disabled_tools'\) = 'array' THEN jsonb_array_length\(agent_config->'disabled_tools'\)\s+ELSE 0\s+END\s*\)\s*=\s*0/,
    )
    expect(MIGRATION_GRANT_STUDIO).toMatch(/SET agent_config = agent_config\s*\|\| jsonb_build_object/)
  })
})

/**
 * One grant migration's UPDATE on one persona's enabled_tools, as SQL runs it:
 * a containment test on the "prev" list, the row not yet holding `adds`, the
 * whole list replaced by "cats". 628's own test (exactly one of tables and
 * studio) is `xor`.
 */
function applyGrant(sql: string, tools: string[], test: { adds?: string; xor?: [string, string] }): string[] {
  const prev = migratedCategories(sql, 'prev')
  if (!prev.every((id) => tools.includes(id))) return tools
  if (test.adds && tools.includes(test.adds)) return tools
  if (test.xor && tools.includes(test.xor[0]) === tools.includes(test.xor[1])) return tools
  return migratedCategories(sql)
}

describe('migration 628 — every-category personas hold both `tables` and `studio`, whatever order 538 and 623 ran in', () => {
  it('writes EXACTLY the live ALL_CATEGORY_IDS, in registry order', () => {
    // If this fails you added a tool category: every persona saved with "all
    // categories on" just stopped being inherit-all (agentInheritsAllTools needs
    // EVERY category). Write a grant migration like 628 for the new category and
    // point this block at it.
    expect(migratedCategories(MIGRATION_GRANT_TABLES_AND_STUDIO)).toEqual([...ALL_CATEGORY_IDS])
    expect(agentInheritsAllTools({ enabled_tools: migratedCategories(MIGRATION_GRANT_TABLES_AND_STUDIO), disabled_tools: [] })).toBe(true)
  })

  it('targets the rows 538 and 623 leave: the full 387 list plus exactly one of the two', () => {
    expect(migratedCategories(MIGRATION_GRANT_TABLES_AND_STUDIO, 'prev')).toEqual(migratedCategories(MIGRATION_GRANT_CONTENT))
    expect(MIGRATION_GRANT_TABLES_AND_STUDIO).toMatch(/WHERE category = 'agent'/)
    expect(MIGRATION_GRANT_TABLES_AND_STUDIO).toMatch(/agent_config->'enabled_tools' @> \$prev\$/)
    expect(MIGRATION_GRANT_TABLES_AND_STUDIO).toMatch(/\(agent_config->'enabled_tools' \? 'tables'\) <> \(agent_config->'enabled_tools' \? 'studio'\)/)
    expect(MIGRATION_GRANT_TABLES_AND_STUDIO).toMatch(
      /CASE\s+WHEN jsonb_typeof\(agent_config->'disabled_tools'\) = 'array' THEN jsonb_array_length\(agent_config->'disabled_tools'\)\s+ELSE 0\s+END\s*\)\s*=\s*0/,
    )
    expect(MIGRATION_GRANT_TABLES_AND_STUDIO).toMatch(/SET agent_config = agent_config\s*\|\| jsonb_build_object/)
  })

  it('538 then 623, or 623 then 538: each alone drops the other\'s category, and 628 ends every one at all 27', () => {
    const tables = (t: string[]) => applyGrant(MIGRATION_GRANT_TABLES, t, { adds: 'tables' })
    const studio = (t: string[]) => applyGrant(MIGRATION_GRANT_STUDIO, t, { adds: 'studio' })
    const both = (t: string[]) => applyGrant(MIGRATION_GRANT_TABLES_AND_STUDIO, t, { xor: ['tables', 'studio'] })
    const before = migratedCategories(MIGRATION_GRANT_CONTENT)
    // The bug 628 fixes: the second migration replaces the first one's list.
    expect(studio(tables(before))).not.toContain('tables')
    expect(tables(studio(before))).not.toContain('studio')
    for (const after of [both(studio(tables(before))), both(tables(studio(before)))]) {
      expect(after).toEqual([...ALL_CATEGORY_IDS])
      expect(agentInheritsAllTools({ enabled_tools: after, disabled_tools: [] })).toBe(true)
    }
    // Re-runnable: a full list is left as it is, and so is a narrowed one.
    expect(both([...ALL_CATEGORY_IDS])).toEqual([...ALL_CATEGORY_IDS])
    const narrowed = before.filter((id) => id !== 'emails').concat('tables')
    expect(both(narrowed)).toEqual(narrowed)
  })
})
