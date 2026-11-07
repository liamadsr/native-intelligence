/**
 * Migration 385 (P8, marketing M0): the marketing playbook and its six
 * skills. Pinned: the rows, ids, area and pack-only flags; the core's shape;
 * and what the texts teach about the product doc as the brand context
 * (decision 10): graded claims by evidence, open questions that move, the
 * admins own it and web-only edits wait on their card, customers' words stay
 * internal, a research budget, no broadcasts, nothing on by default.
 */
import { describe, expect, it } from 'vitest'
import { playbookSlug } from '../registry'
import { estimateTokens } from '../memory'
import { CORE_HELPER_LINE, allShippedSkills, readMigration, seededSkills } from './playbook-seeds'
import { GRADED_PRODUCT_SECTIONS } from '@/lib/marketing/grade'

const FILE = '385_marketing_skills.sql'
const sql = readMigration(FILE)
const rows = seededSkills(FILE)
const by = (slug: string) => rows.find((r) => r.slug === slug)!
const statements = sql
  .replace(/\$(pb|desc|name)\$[\s\S]*?\$\1\$/g, "''")
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')

const ROWS = [
  { id: '494f83d0-b2b2-4122-b51b-a0ff37a9ce7b', slug: 'marketing-playbook' },
  { id: '0758cf12-7a1a-48b6-aeae-ec53610acfbc', slug: 'brand-context' },
  { id: '50211238-e1c3-47b3-ad1b-757f075993b9', slug: 'marketing-positioning' },
  { id: 'a67ee2eb-3591-435a-89b7-98a38cf0b26d', slug: 'marketing-messaging' },
  { id: 'b1bb2826-d5e4-4b4f-b525-941d2dd9dcd6', slug: 'customer-language' },
  { id: 'e1da632c-55e2-4072-a258-f9eb097a7595', slug: 'battle-card' },
  { id: '9ec4667c-5269-4f15-b398-635e81cc81cd', slug: 'content-planning' },
]

describe('migration 385', () => {
  it('seeds the playbook and the six skills the plan names, with fresh ids, in the marketing area', () => {
    // Generic names carry the area (review nit): never a bare /positioning or /messaging.
    for (const r of rows.filter((x) => x.slug !== 'marketing-playbook')) expect(['brand-context', 'customer-language', 'battle-card', 'content-planning'].includes(r.slug) || r.slug.startsWith('marketing-'), r.slug).toBe(true)
    expect(rows.map((r) => ({ id: r.id, slug: r.slug }))).toEqual(ROWS)
    for (const r of rows) expect(r.area, r.slug).toBe('marketing')
    expect(by('marketing-playbook').slug).toBe(playbookSlug('marketing'))
    // A later text-only rewrite (391) keeps the row's id and slug: it is this row, not an earlier one.
    const earlier = allShippedSkills().filter((s) => s.file !== FILE && s.file !== '391_playbooks_teach_recipes.sql')
    for (const r of ROWS) expect(earlier.some((s) => s.id === r.id || s.slug === r.slug), r.slug).toBe(false)
  })

  it('makes every skill but the playbook pack-only', () => {
    expect(by('marketing-playbook').config.pack_only).toBeUndefined()
    for (const r of rows.filter((x) => x.slug !== 'marketing-playbook')) expect(r.config.pack_only, r.slug).toBe(true)
  })

  it('keeps the core’s shape and size, one-line descriptions, no persona', () => {
    const core = by('marketing-playbook').prompt
    for (const h of ["## What's here", '## How to find things', '## Doing it well', '## Pitfalls', '## When to hand to a helper']) expect(core, h).toContain(h)
    expect(core.split('## When to hand to a helper\n')[1]).toBe(CORE_HELPER_LINE)
    expect(estimateTokens(core)).toBeLessThanOrEqual(2000)
    for (const r of rows) {
      expect(r.description.length, r.slug).toBeLessThanOrEqual(200)
      expect(r.description, r.slug).not.toContain('\n')
      expect(r.prompt, r.slug).not.toMatch(/\byou are\b/i)
    }
  })

  it('teaches the grades the code holds edits to, from evidence (gradeClaim)', () => {
    const core = by('marketing-playbook').prompt
    for (const section of GRADED_PRODUCT_SECTIONS) expect(core, section).toContain(section)
    expect(core).toMatch(/\[proven\] \(calls with two or more companies, or a document a person wrote\)/)
    expect(core).toMatch(/\[plausible\] \(it follows from how the product works\)/)
    expect(core).toMatch(/\[assumption\] \(nothing backs it yet\)/)
    expect(core).toMatch(/One call is one company: an assumption/)
    for (const slug of ['brand-context', 'marketing-positioning', 'marketing-messaging', 'customer-language']) expect(by(slug).prompt, slug).toMatch(/\[proven\]/)
  })

  it('teaches that open questions move, never get deleted (P13)', () => {
    expect(by('marketing-playbook').prompt).toMatch(/move them, never delete them/)
    expect(by('brand-context').prompt).toMatch(/the question leaves the list; never delete one/)
  })

  it('the admins own the product doc; every edit applies with undo, web-backed ones labelled, nobody else may edit, and no card is taught', () => {
    expect(by('marketing-playbook').prompt).toMatch(/one that rests on web pages applies too, labelled so in the history and the digest. Anyone else's is refused/)
    const bc = by('brand-context').prompt
    expect(bc).toMatch(/## Who decides/)
    expect(bc).toMatch(/there is no card to accept/)
    expect(bc).toMatch(/A section that rests on web pages applies too, labelled so in the history and the digest/)
    expect(bc).toMatch(/For anyone else every edit is refused/)
    expect(bc).toMatch(/which rest on web pages/)
    for (const slug of ['marketing-playbook', 'brand-context', 'marketing-positioning']) expect(by(slug).prompt, slug).not.toMatch(/wait(s)? on (a|the|that) card|on the admins' card/)
  })

  it('infers, never interviews: at most three questions, the rest under Open questions', () => {
    const bc = by('brand-context').prompt
    expect(bc).toMatch(/by inference from the workspace: the person never fills in a questionnaire/)
    expect(bc).toMatch(/at most three questions/)
    expect(bc).toContain('`research_my_company` with no arguments')
    expect(bc).toContain('`create_canon_document` with key product')
  })

  it("customers' words stay internal: our words in the doc, testimonials only with the customer's yes", () => {
    expect(by('marketing-playbook').prompt).toMatch(/Our words in the doc, never a customer's quote/)
    expect(by('marketing-playbook').prompt).toMatch(/stays internal until the customer says yes/)
    expect(by('customer-language').prompt).toMatch(/Quotes stay in this summary and on the calls, never in the product doc/)
    expect(by('battle-card').prompt).toMatch(/Internal only/)
  })

  it('the evidence boundary and a research budget for web pages (P10, P11)', () => {
    for (const slug of ['marketing-playbook', 'marketing-positioning', 'battle-card', 'brand-context']) expect(by(slug).prompt, slug).toMatch(/at most 8 sources/)
    expect(by('marketing-positioning').prompt).toMatch(/Say only what a page shows/)
  })

  it('no broadcasts, and nothing seeded: a recipe they ask for is on', () => {
    const core = by('marketing-playbook').prompt
    expect(core).toMatch(/Dial8 sends no newsletters or broadcasts/)
    expect(core).toMatch(/## Recipes \(only when they ask; nothing is seeded for anyone\)/)
    expect(core).toMatch(/`enabled` true \(they asked, so it is on\)/)
    expect(core).toMatch(/`marketing-lens`/)
    expect(statements).not.toMatch(/INSERT INTO public\.flow/i)
  })

  it('is idempotent and has no backslash', () => {
    expect(statements).toMatch(/ON CONFLICT \(id\) DO NOTHING/)
    expect(sql).not.toContain('\\')
    expect(sql).toMatch(/^SET LOCAL lock_timeout = '5s';$/m)
  })
})
