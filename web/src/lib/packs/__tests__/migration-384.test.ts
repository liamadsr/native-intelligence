/**
 * Migration 384 (P8, content C0): the content and marketing areas in every
 * area CHECK, and the three content skills. Pinned: the CHECKs allow exactly
 * the registry's areas; the rows, ids, areas and pack-only flags; the core's
 * shape; the rules the texts teach (Dial8 never posts, the checks, cite and
 * hedge, public-safe sources, slow weeks bring ideas, nothing on by default);
 * idempotence; and no backslash.
 */
import { describe, expect, it } from 'vitest'
import { AREA_KEYS, playbookSlug } from '../registry'
import { estimateTokens } from '../memory'
import { CORE_HELPER_LINE, allShippedSkills, readMigration, seededSkills } from './playbook-seeds'

const FILE = '384_content_area_skills.sql'
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
  { id: '240170e8-53d5-4f79-accd-19725eecee21', slug: 'content-playbook', area: 'content' },
  { id: '75313979-5de2-4f21-9660-f321f84d1c61', slug: 'x-post', area: 'content' },
  { id: 'cb4dd812-f165-4355-a006-91c7d0f4a5ac', slug: 'linkedin-post', area: 'content' },
]

describe('migration 384', () => {
  it('widens all five area CHECKs to exactly the registry’s areas, dropping each first (idempotent)', () => {
    const checks: Array<[string, string]> = [
      ['recipe', 'recipe_area_check'],
      ['area_memory', 'area_memory_area_check'],
      ['area_memory_learning_run', 'area_memory_learning_run_area_check'],
      ['tracked_job', 'tracked_job_area_check'],
      ['chat_conversations', 'chat_conversations_focus_area_check'],
    ]
    for (const [table, name] of checks) {
      expect(statements, name).toContain(`ALTER TABLE public.${table} DROP CONSTRAINT IF EXISTS ${name};`)
      const add = new RegExp(`ALTER TABLE public\\.${table} ADD CONSTRAINT ${name} CHECK \\(([\\s\\S]*?)\\) NOT VALID;`).exec(statements)
      expect(add, name).not.toBeNull()
      const listed = [...add![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
      expect(listed, name).toEqual([...AREA_KEYS])
      // Added without a scan, then validated under a lock that lets writes go on (review nit).
      expect(statements, name).toContain(`ALTER TABLE public.${table} VALIDATE CONSTRAINT ${name};`)
    }
    // The focus area keeps its other two conditions (318).
    expect(statements).toMatch(/AND ai_team_member_id IS NULL\s+AND agent_teammate_id IS NULL/)
  })

  it('seeds the content playbook and the two surface skills, with fresh ids, in the content area', () => {
    expect(rows.map((r) => ({ id: r.id, slug: r.slug, area: r.area }))).toEqual(ROWS)
    expect(by('content-playbook').slug).toBe(playbookSlug('content'))
    // A later text-only rewrite (391) keeps the row's id and slug: it is this row, not an earlier one.
    const earlier = allShippedSkills().filter((s) => s.file !== FILE && s.file !== '391_playbooks_teach_recipes.sql')
    for (const r of ROWS) {
      expect(earlier.some((s) => s.id === r.id || s.slug === r.slug), r.slug).toBe(false)
      expect(sql.split(r.id).length - 1, r.slug).toBe(1)
    }
  })

  it('makes the surface skills pack-only and keeps the playbook in the global list', () => {
    expect(by('content-playbook').config.pack_only).toBeUndefined()
    expect(by('x-post').config.pack_only).toBe(true)
    expect(by('linkedin-post').config.pack_only).toBe(true)
    for (const r of rows) expect(r.config.enabled_tools, r.slug).toContain('content')
  })

  it('keeps the core’s shape and size, and every description to one line of at most 200 characters', () => {
    const core = by('content-playbook').prompt
    for (const h of ["## What's here", '## How to find things', '## Doing it well', '## Pitfalls', '## When to hand to a helper']) expect(core, h).toContain(h)
    expect(core.split('## When to hand to a helper\n')[1]).toBe(CORE_HELPER_LINE)
    expect(estimateTokens(core)).toBeLessThanOrEqual(2000)
    for (const r of rows) {
      expect(r.description.length, r.slug).toBeLessThanOrEqual(200)
      expect(r.description, r.slug).not.toContain('\n')
      expect(r.prompt, r.slug).not.toMatch(/\byou are\b/i)
    }
  })

  it('teaches that Dial8 never posts: the person posts every one from the link (decision 2)', () => {
    const core = by('content-playbook').prompt
    expect(core).toMatch(/Dial8 drafts; the person posts\. Nothing is ever published for them, now or later/)
    expect(core).toMatch(/Never call a post published, scheduled or sent/)
    for (const slug of ['x-post', 'linkedin-post']) expect(by(slug).prompt, slug).toMatch(/\[Post on (X|LinkedIn)\]\(link\)/)
    expect(by('linkedin-post').prompt).toMatch(/Nothing posts until they post it there/)
  })

  it('teaches the checks: lint_post on every version, review_post once, both revealed first', () => {
    for (const r of rows) {
      expect(r.prompt, r.slug).toContain('`lint_post`')
      expect(r.prompt, r.slug).toContain('`review_post`')
      expect(r.prompt, r.slug).toContain('`search_tools`')
    }
    expect(by('content-playbook').prompt).toMatch(/`review_post` once/)
  })

  it('teaches the evidence boundary and the grades: cite every fact, hedge plausible, never post an assumption as fact', () => {
    const core = by('content-playbook').prompt
    expect(core).toMatch(/every fact in the post comes from one of them/)
    expect(core).toMatch(/A fact you can't find is a gap: ask in one line, never guess it/)
    for (const r of rows) {
      expect(r.prompt, r.slug).toMatch(/plausible/)
      expect(r.prompt, r.slug).toMatch(/assumption is never posted as fact|never post an assumption as fact/)
    }
  })

  it('keeps posts public-safe: never mail, CRM, sequences, prospecting or a private call, nor a name from them', () => {
    const core = by('content-playbook').prompt
    expect(core).toMatch(/Never mail, the CRM, sequences, prospecting or a private call/)
    expect(core).toMatch(/a customer, a company, a person, a price or a deal never goes in a post/)
  })

  it('never an empty week (decision 3): a slow week brings ideas, marked as ideas', () => {
    const core = by('content-playbook').prompt
    expect(core).toMatch(/A slow week is never an empty week/)
    expect(core).toMatch(/Pass `idea` true to the checks and say it's an idea/)
  })

  it('nothing is seeded: the recipes are built only when asked, and then they are on (§5b; P12)', () => {
    const core = by('content-playbook').prompt
    expect(core).toMatch(/## Recipes \(only when they ask; nothing is seeded for anyone\)/)
    expect(core).toMatch(/Build it with `enabled` true \(they asked, so it is on\)/)
    expect(core).toMatch(/`content-lens`/)
    expect(core).toMatch(/Dial8 never sends a newsletter/)
    // No flow, no default, nothing switched on in the SQL itself.
    expect(statements).not.toMatch(/INSERT INTO public\.flow/i)
  })

  it('says the deploy order in its header (review S5)', () => {
    expect(sql).toMatch(/DEPLOY ORDER \(P8 review S5\): 382, then 384, 385, 386 and 387, all on PROD\n-- BEFORE the P8 code deploys/)
  })

  it('is idempotent (insert when missing, update only what differs) and has no backslash', () => {
    expect(statements).toMatch(/ON CONFLICT \(id\) DO NOTHING/)
    expect(statements).toMatch(/r\.system_prompt IS DISTINCT FROM p\.system_prompt/)
    expect(sql).not.toContain('\\')
    expect(sql).toMatch(/^SET LOCAL lock_timeout = '5s';$/m)
  })
})
