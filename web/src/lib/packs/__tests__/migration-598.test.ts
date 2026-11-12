/**
 * Migration 598: the SEO skills, ten pack-only rows in the marketing area
 * (SEO's tool group belongs to the Marketing pack). Pinned: the rows, fixed
 * ids and slugs, area, system and pack-only flags; every tool a text or a
 * preferred_tools list names is a real tool, every enabled_tools id a real
 * category; the writing rules (no em dash, no exclamation mark, no other
 * product's name, the size bounds); what the texts teach (free first, the
 * cost before a yes, change_website one change at a time, a report built
 * from free data, a weekly loop and no monthly cadence); and a re-runnable
 * insert.
 */
import { describe, expect, it } from 'vitest'
import { ALL_CATEGORY_IDS, ALL_TOOL_NAMES } from '@/lib/ai/tool-registry'
import { CORE_TOOL_NAMES } from '@/lib/ai/tool-ceiling-core'
import { estimateTokens } from '../memory'
import { allShippedSkills, readMigration, seededSkills } from './playbook-seeds'

const FILE = '598_seo_skills.sql'
const sql = readMigration(FILE)
const rows = seededSkills(FILE)
const by = (slug: string) => rows.find((r) => r.slug === slug)!
/** The statements, without comments or the quoted texts. */
const statements = sql
  .replace(/\$(pb|desc|name)\$[\s\S]*?\$\1\$/g, "''")
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')

const ROWS = [
  { id: '72285100-16f5-43ac-abc8-599ad8e96e8a', slug: 'seo-guide' },
  { id: '7185990b-056e-42f8-be10-4fb998268646', slug: 'seo-site-audit' },
  { id: '48632b85-370a-41d2-90ec-134c70720de6', slug: 'seo-keywords' },
  { id: 'f39d4983-a50f-4b8c-9628-e36e61bc389e', slug: 'seo-competitors' },
  { id: '6972ef33-62e5-4f75-bc0d-ca12fe66059b', slug: 'seo-rank-tracking' },
  { id: '7effa973-4c67-4c25-8d1d-8458d15750a3', slug: 'seo-performance' },
  { id: '59791459-238d-40ad-8bc4-39d87497c76f', slug: 'seo-backlinks' },
  { id: '87aac0de-9c0c-40b7-a5c2-d8ed2099f38b', slug: 'seo-ai-visibility' },
  { id: '52d2241c-1a7d-482f-8645-d4e706472a9a', slug: 'seo-local' },
  { id: '0b2fb881-429c-485d-9119-1a6ad914680c', slug: 'seo-report' },
]

/** The registry's tools, plus the core ones the chat always has (`search_tools`, `ask_user`). */
const REGISTRY_TOOLS: ReadonlySet<string> = new Set([...ALL_TOOL_NAMES, ...CORE_TOOL_NAMES])

/** The chat-agent's own eve tools (agents/chat-agent/tools, and load_skill in workspace_tools.ts): not in the registry. */
const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['load_skill', 'web_search', 'web_fetch', 'helpers', 'update_plan', 'ask_user'])

/** Backticked words that are deliberately not tools: arguments the texts name. Never a tool name here. */
const NOT_TOOLS: ReadonlySet<string> = new Set(['confirmed_with_user', 'enabled'])

/** The skills a text may name besides these ten: the marketing ones it hands to (385). */
const OTHER_SKILLS: ReadonlySet<string> = new Set(seededSkills('385_marketing_skills.sql').map((s) => s.slug))

/** Every backticked token in a text. */
const backticked = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1])

/** Other products, and the project the know-how was adapted from: never named. */
const FORBIDDEN_NAMES = [/open\s*-?\s*seo/i, /dataforseo/i, /semrush/i, /ahrefs/i, /\bmoz\b/i, /local falcon/i, /brightlocal/i, /\bse ranking/i]

describe('migration 598', () => {
  it('seeds the ten SEO skills with fixed, distinct, valid ids and distinct slugs, none seeded before', () => {
    expect(rows.map((r) => ({ id: r.id, slug: r.slug }))).toEqual(ROWS)
    expect(new Set(rows.map((r) => r.id)).size).toBe(10)
    expect(new Set(rows.map((r) => r.slug)).size).toBe(10)
    for (const r of rows) {
      expect(r.id, r.slug).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(sql.split(r.id).length - 1, r.slug).toBe(1)
      expect(r.slug, r.slug).toMatch(/^seo-[a-z-]+$/)
    }
    const earlier = allShippedSkills().filter((s) => s.file !== FILE)
    for (const r of ROWS) expect(earlier.some((s) => s.id === r.id || s.slug === r.slug), r.slug).toBe(false)
  })

  it('puts every one in the marketing area as a pack-only system skill', () => {
    for (const r of rows) {
      expect(r.area, r.slug).toBe('marketing')
      expect(r.config.pack_only, r.slug).toBe(true)
    }
    expect(statements).toMatch(/'skill'::public\.recipe_category, true, false, 0, 'workspace'::public\.recipe_visibility/)
    expect(statements).toMatch(/SELECT id, NULL::uuid, name, slug/)
  })

  it('names only real tools: every backticked tool in every text, and every preferred tool', () => {
    const missing = new Set<string>()
    for (const r of rows) {
      for (const token of backticked(r.prompt)) {
        if (!/^[a-z][a-z0-9_]*$/.test(token)) continue
        if (REGISTRY_TOOLS.has(token) || AGENT_TOOL_NAMES.has(token) || NOT_TOOLS.has(token)) continue
        missing.add(token)
      }
      for (const tool of r.config.preferred_tools ?? []) if (!REGISTRY_TOOLS.has(tool)) missing.add(tool)
      expect(r.config.preferred_tools?.length ?? 0, r.slug).toBeGreaterThanOrEqual(3)
    }
    expect([...missing].sort()).toEqual([])
  })

  it('lists each not-a-tool word because a text uses it', () => {
    const used = new Set(rows.flatMap((r) => backticked(r.prompt)))
    for (const word of NOT_TOOLS) expect(used.has(word), word).toBe(true)
  })

  it('names only real skills', () => {
    const own = new Set(ROWS.map((r) => r.slug))
    for (const r of rows) {
      for (const token of backticked(r.prompt).filter((t) => /^[a-z]+(-[a-z]+)+$/.test(t))) {
        expect(own.has(token) || OTHER_SKILLS.has(token), `${r.slug}: ${token}`).toBe(true)
      }
    }
  })

  it('enables only real tool categories, always seo', () => {
    for (const r of rows) {
      expect(r.config.enabled_tools, r.slug).toContain('seo')
      for (const id of r.config.enabled_tools ?? []) expect(ALL_CATEGORY_IDS, `${r.slug}: ${id}`).toContain(id)
    }
  })

  it('keeps to the writing rules: no em dash, no exclamation mark, no other product, no persona, the size bounds', () => {
    for (const r of rows) {
      const text = `${r.description}\n${r.prompt}`
      expect(text, r.slug).not.toMatch(/[—–]/)
      expect(text, r.slug).not.toContain('!')
      for (const name of FORBIDDEN_NAMES) expect(text, `${r.slug}: ${name}`).not.toMatch(name)
      expect(r.prompt, r.slug).not.toMatch(/\byou are\b/i)
      expect(r.description.length, r.slug).toBeLessThanOrEqual(200)
      expect(r.description, r.slug).not.toContain('\n')
      expect(r.prompt.length, r.slug).toBeGreaterThanOrEqual(1500)
      expect(r.prompt.length, r.slug).toBeLessThanOrEqual(r.slug === 'seo-guide' ? 4800 : 4500)
      // Within the packs' size for an area skill (playbook-accuracy.test.ts).
      expect(estimateTokens(r.prompt), r.slug).toBeLessThanOrEqual(1200)
      expect(r.prompt, r.slug).toMatch(/^## /m)
    }
    // Headings and the overview stay out of the source's names entirely, the file too.
    for (const name of FORBIDDEN_NAMES) expect(sql).not.toMatch(name)
  })

  it('the overview points to every other SEO skill and holds the standing rules', () => {
    const guide = by('seo-guide').prompt
    for (const r of ROWS.filter((x) => x.slug !== 'seo-guide')) expect(guide, r.slug).toContain(`\`${r.slug}\``)
    expect(guide).toMatch(/Paid search data only when the person asked/)
    expect(guide).toMatch(/A stored lookup answers again for free/)
    expect(guide).toMatch(/never mention price, spend or budget/)
    expect(guide).toMatch(/No site named means the workspace's own/)
    expect(guide).toMatch(/never state a ranking, a search volume, a traffic figure or a count that a tool did not return/)
    expect(guide).toMatch(/provider's estimates: say so/)
    expect(guide).toMatch(/`change_website`, one change at a time, after the person says yes/)
    expect(guide).toContain('`create_document`')
  })

  it('the cost is said before a yes wherever a tool spends on its own', () => {
    for (const slug of ['seo-rank-tracking', 'seo-ai-visibility', 'seo-local']) {
      expect(by(slug).prompt, slug).toMatch(/`confirmed_with_user` true (only )?after their yes/)
      expect(by(slug).prompt, slug).toMatch(/cost/)
    }
    expect(by('seo-rank-tracking').prompt).toContain('`get_rank_tracker_cost_estimate`')
    expect(by('seo-ai-visibility').prompt).toContain('`get_ai_visibility_cost_estimate`')
    expect(by('seo-local').prompt).toContain('`get_local_rank_grid_cost_estimate`')
  })

  it('fixes go through change_website on the person’s yes', () => {
    for (const slug of ['seo-guide', 'seo-site-audit', 'seo-performance', 'seo-local', 'seo-ai-visibility']) {
      expect(by(slug).prompt, slug).toMatch(/`change_website`[^.]*after (the person says yes|their yes)/)
    }
  })

  it('the report reads only stored or free data, and schedules weekly on request with no monthly cadence', () => {
    const report = by('seo-report').prompt
    expect(report).toMatch(/never a paid lookup/)
    expect(report).toMatch(/Anything paid is left out/)
    expect(report).toMatch(/## Recipes \(only when they ask; nothing is seeded for anyone\)/)
    expect(report).toMatch(/Build it with `enabled` true \(they asked, so it is on\)/)
    expect(report).toMatch(/The cadences are hourly, daily, weekdays and weekly: there is no monthly one/)
    expect(report).toContain('`create_flow`')
    expect(report).toContain('`update_flow`')
    expect(by('seo-report').config.enabled_tools).toEqual(expect.arrayContaining(['seo', 'documents', 'flows']))
    expect(statements).not.toMatch(/INSERT INTO public\.flow/i)
  })

  it('outreach and reviews stay the person’s to send', () => {
    expect(by('seo-backlinks').prompt).toMatch(/The person decides whom to contact and sends it: never send it/)
    expect(by('seo-local').prompt).toMatch(/Draft replies to unanswered reviews for the person to post/)
  })

  it('is re-runnable: insert when missing, update only what differs, no backslash', () => {
    expect(sql).toMatch(/^SET LOCAL lock_timeout = '5s';$/m)
    expect(statements).toMatch(/ON CONFLICT \(id\) DO NOTHING/)
    for (const col of ['system_prompt', 'description', 'agent_config', 'area', 'slug', 'name', 'icon', 'color']) {
      expect(statements, col).toContain(`r.${col} IS DISTINCT FROM p.${col}`)
    }
    expect(sql).not.toContain('\\')
  })
})
