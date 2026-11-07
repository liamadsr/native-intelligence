/**
 * Migration 326: feature skills, A1c CRM & outreach (docs/plans/always-on-agent.md
 * §1b item 7). It rewrites the CRM, Prospecting, Sequences and Campaigns cores
 * on their 319/322 ids, rewrites `build-prospect-list` in place (still global,
 * same slug), and adds the pack-only `stale-relationships` and
 * `launch-a-sequence` recipes. This pins the file: the rows, ids, areas and
 * pack-only flags, the core shape, the rules prospecting keeps, the honesty
 * fixes (no launch tool; a sequences card exists; get_company_overview never
 * takes a name), the asks-first lines, the upsert and the gating.
 */
import { describe, it, expect } from 'vitest'
import { TOOL_CATEGORIES } from '@/lib/ai/tool-registry'
import { FEATURES } from '@/lib/editions/manifest'
import { PROSPECT_LIST_SKILL_SLUG } from '@/app/account/(dashboard)/prospecting/start-event'
import { estimateTokens } from '../memory'
import { PACKS, playbookSlug } from '../registry'
import { allSeededSkills, allShippedSkills, readMigration, seededSkills } from './playbook-seeds'

const FILE = '326_crm_outreach_skills.sql'
const sql = readMigration(FILE)
const rows = seededSkills(FILE)
const by = (slug: string) => rows.find((r) => r.slug === slug)!

/** The statements, without comments or the quoted texts. */
const statements = sql
  .replace(/\$(pb|desc)\$[\s\S]*?\$\1\$/g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')

const CORES = [
  { id: 'e05a0562-a4a2-4700-8c7b-19435fa7430b', slug: 'crm-playbook', area: 'crm' },
  { id: '1b502445-3db0-4f04-bc4b-39505d2fe5ca', slug: 'prospecting-playbook', area: 'prospecting' },
  { id: '1438190a-646d-4709-ae89-22e24ddf340b', slug: 'sequences-playbook', area: 'sequences' },
  { id: '48b8e8bd-2299-43b2-9a65-f9928a232b90', slug: 'campaigns-playbook', area: 'campaigns' },
] as const
const BUILD_PROSPECT_LIST = { id: 'c4b81f6d-2a7e-4d39-b0c6-5e9a3f18d247', slug: 'build-prospect-list', area: 'prospecting' } as const
const RECIPES = [
  { id: 'a7337d9e-1ec0-4ed8-b6f0-0311edd54335', slug: 'stale-relationships', area: 'crm' },
  { id: '287cbaef-c539-42b2-84be-3cbfef7a88ec', slug: 'launch-a-sequence', area: 'sequences' },
] as const

const CORE_HEADINGS = ["What's here", 'How to find things', 'Doing it well', 'Pitfalls', 'When to hand to a helper']

/** 326's rows whose text a later migration changed, by slug: the file whose text ships (338: the cores' helper line, and helper passages; 461: the outreach launch). */
const LATER_TEXT: Readonly<Record<string, string>> = {
  'crm-playbook': '338_skill_helper_lines.sql',
  'sequences-playbook': '461_outreach_launch_playbooks.sql',
  'campaigns-playbook': '461_outreach_launch_playbooks.sql',
  'prospecting-playbook': '338_skill_helper_lines.sql',
  'build-prospect-list': '338_skill_helper_lines.sql',
}

/** The feature that gates each area here. */
const FEATURE_OF = { crm: 'crm', prospecting: 'prospecting', sequences: 'sequences', campaigns: 'campaigns' } as const

describe('migration 326', () => {
  it('writes the four cores, then build-prospect-list, then the two recipes, each with its id, slug and area', () => {
    expect(rows.map((r) => ({ id: r.id, slug: r.slug, area: r.area }))).toEqual([...CORES, BUILD_PROSPECT_LIST, ...RECIPES])
  })

  it('rewrites each core and build-prospect-list by the id it was seeded under, and its text is the one that ships', () => {
    const earlier = new Map(
      ['319_area_playbooks.sql', '322_prospecting_skill_not_a_persona.sql'].flatMap(seededSkills).map((r) => [r.id, r]),
    )
    for (const row of [...CORES, BUILD_PROSPECT_LIST]) {
      const before = earlier.get(row.id)
      expect(before, row.slug).toBeDefined()
      expect(before!.slug).toBe(row.slug)
      const shipped = allShippedSkills().find((s) => s.id === row.id)!
      expect(shipped.file, row.slug).toBe(LATER_TEXT[row.slug] ?? FILE)
      expect(shipped.prompt, row.slug).not.toBe(before!.prompt)
    }
    for (const core of CORES) expect(core.slug).toBe(playbookSlug(core.area))
    for (const core of CORES) expect(allSeededSkills().find((s) => s.id === core.id)!.file).toBe(LATER_TEXT[core.slug] ?? FILE)
  })

  it('gives the recipes new ids and slugs, none an earlier row, and no id twice', () => {
    const earlier = new Set(
      [
        '316_skill_area_and_playbooks.sql',
        '319_area_playbooks.sql',
        '322_prospecting_skill_not_a_persona.sql',
        '323_feature_skills_v2.sql',
        '324_workflows_skill.sql',
      ].flatMap((f) => seededSkills(f).flatMap((r) => [r.id, r.slug])),
    )
    for (const r of RECIPES) {
      expect(earlier.has(r.id), r.slug).toBe(false)
      expect(earlier.has(r.slug), r.slug).toBe(false)
    }
    const ids = allShippedSkills().map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('makes the two recipes pack-only, and keeps build-prospect-list global (the Prospecting page arms it by slug)', () => {
    for (const r of RECIPES) expect(by(r.slug).config.pack_only, r.slug).toBe(true)
    expect(by(BUILD_PROSPECT_LIST.slug).config.pack_only).toBeUndefined()
    expect(PROSPECT_LIST_SKILL_SLUG).toBe(BUILD_PROSPECT_LIST.slug)
    for (const c of CORES) expect(by(c.slug).config.pack_only, c.slug).toBeUndefined()
  })

  it('has no persona framing, and one-line descriptions of at most 200 characters', () => {
    for (const r of rows) {
      expect(r.prompt, r.slug).not.toMatch(/\byou are\b/i)
      expect(r.prompt, r.slug).not.toMatch(/scout/i)
      expect(r.description.length, r.slug).toBeLessThanOrEqual(200)
      expect(r.description, r.slug).not.toContain('\n')
    }
  })

  it('keeps the cores within 2,000 tokens, and build-prospect-list and the recipes within 150 to 800', () => {
    for (const c of CORES) expect(estimateTokens(by(c.slug).prompt), c.slug).toBeLessThanOrEqual(2000)
    for (const slug of [BUILD_PROSPECT_LIST.slug, ...RECIPES.map((r) => r.slug)]) {
      const tokens = estimateTokens(by(slug).prompt)
      expect(tokens, slug).toBeGreaterThanOrEqual(150)
      expect(tokens, slug).toBeLessThanOrEqual(800)
    }
  })

  it('gives every core the shared shape, with a one-line helper section', () => {
    for (const c of CORES) {
      const prompt = by(c.slug).prompt
      expect([...prompt.matchAll(/^## (.+)$/gm)].map((m) => m[1]), c.slug).toEqual(CORE_HEADINGS)
      expect(prompt.split('## When to hand to a helper\n')[1].trim().split('\n'), c.slug).toHaveLength(1)
      // The ladder says which tools need search_tools.
      expect(prompt.split('## How to find things\n')[1], c.slug).toMatch(/need[s]? `search_tools` first/)
    }
  })

  it('CRM: company lookups by id or domain, visibility, enrichment, voice matches, and check-ins as drafts', () => {
    const crm = by('crm-playbook').prompt
    expect(crm).toContain('`get_company_overview` takes a `company_id` or `domain`, not a name')
    expect(crm).toContain('`people_on_record` above `contact_count`')
    expect(crm).toMatch(/private to the person; only the Share button/)
    expect(crm).toContain('`enrichment_status`')
    expect(crm).toContain('`voice_match_confidence`')
    expect(crm).toMatch(/Nothing sends from the chat/)
    expect(crm).toContain('`stale-relationships`')
    expect(crm).toContain('is pushed there too: say so when you create one')
    // The old "Looking someone up" section is a ladder now, cheapest first.
    const ladder = crm.split('## How to find things\n')[1].split('## Doing it well')[0]
    const order = ['`list_contacts`', '`get_contact`', '`get_contact_details`', '`get_company_overview`', '`list_contact_captures`', '`show` with `entity_type: contact`']
    const at = order.map((s) => ladder.indexOf(s))
    for (const [i, pos] of at.entries()) expect(pos, order[i]).toBeGreaterThan(-1)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  it("Prospecting keeps 322's rules: the go-ahead per call, never money, the list is not the CRM until publish", () => {
    const p = by('prospecting-playbook').prompt
    expect(p).toContain('The search tools, publish and dismiss take `confirmed_with_user`')
    expect(p).toContain('One yes covers one call.')
    expect(p).toContain('A background run never passes it')
    expect(p).toContain('Never talk about money: no prices, budgets or what\'s left.')
    expect(p).toContain('The list is not the CRM')
    expect(p).toContain('nothing reaches the CRM until `publish_prospect_list`')
    expect(p).toContain('`build-prospect-list`')
    expect(p).toMatch(/Never say hot, warm or cold/)
  })

  it('build-prospect-list still handles the page handoff, leaves the rules to the playbook and never talks money', () => {
    const b = by(BUILD_PROSPECT_LIST.slug).prompt
    expect(b).toContain('Learn about my company')
    expect(b).toContain('Continue prospect list: <id>')
    expect(b).toContain('`prospecting-playbook`')
    for (const word of ['needs_go_ahead', 'needs_domain', 'joined_live_run', 'follow_up_run', 'sequenceable_contact_ids']) {
      expect(b, word).toContain(word)
    }
    expect(b).toMatch(/never navigate the app/i)
    expect(b).toContain('`launch-a-sequence`')
    expect(b).toContain('confirm the ICP when you ask to run discovery')
    expect(b).not.toMatch(/\$\d|\b(budget|spend|spent|price|prices|cost|costs|free|cheap|dollars?|quote|quoted|cap|caps)\b/i)
    expect([...b.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual([
      '1. Their company',
      '2. Who they want',
      '3. The list',
      '4. Find and score companies',
      '5. People',
      '6. Save, publish, enroll',
      'Edge cases',
    ])
  })

  it('Sequences: there is no launch tool, the person launches, a sequences card exists, resume asks first', () => {
    const s = by('sequences-playbook').prompt
    // 326's text, as it shipped. Roadmap D1 added launch_sequence since, and
    // 461_outreach_launch_playbooks.sql rewrites these lines for it.
    expect(s).toContain("There's no launch tool. The only call that restarts sending is `status` resume on a paused sequence.")
    // The launch route refuses with no_enrollments; a disconnected mailbox pauses the sequence.
    expect(s).toContain('at least one contact enrolled')
    expect(s).toContain('If it paused because the mailbox disconnected, they reconnect it first.')
    // Review & launch on a paused sequence restarts everyone in it: resume first, on a yes.
    expect(s).toContain('On a paused sequence, Review & launch also restarts everyone already in it. Ask to resume it first')
    expect(s).toContain('A draft never sends: save it with `create_sequence`, then show the steps and offer changes.')
    expect(s).not.toMatch(/no sequence card/i)
    expect(s).toContain('`show` with `kind: sequences`')
    expect(s).toMatch(/Resume and archive only on the person's yes in this conversation/)
    expect(s).toMatch(/run Review & launch again to schedule the newcomers/)
    expect(s).toContain('`launch-a-sequence`')
  })

  it('Campaigns: says what the tools really do, and the campaigns card', () => {
    const c = by('campaigns-playbook').prompt
    expect(c).toMatch(/What the tools really do/)
    expect(c).toMatch(/Never promise metrics Dial8 doesn't hold/)
    expect(c).toContain('`show` with `kind: campaigns`')
    expect(c).not.toMatch(/no campaign card/i)
  })

  it('stale-relationships: N days, ranked by what is at stake, a next step each, drafts only', () => {
    const r = by('stale-relationships').prompt
    expect(r).toContain('`search_tools` first')
    expect(r).toContain('`last_interaction_at`')
    expect(r).toMatch(/none given: 30 days, and say so/)
    expect(r).toMatch(/There are no deals in Dial8/)
    expect(r).toMatch(/one next step each/)
    expect(r).toMatch(/Drafts stay drafts/)
    expect(r).toContain('`send_email`')
    expect(r).toMatch(/nothing sends from the chat/)
    expect(r).toMatch(/## Steps[\s\S]*## The answer/)
    // list_contacts doesn't return next_followup_at; get_contact does.
    expect(r.split('3. Rank from the rows')[1].split('\n')[0]).not.toContain('next_followup_at')
    expect(r).toContain('`get_contact` (it has `next_followup_at`)')
  })

  it('launch-a-sequence: stage, review, state what sends and when, the person launches; resume only on a later yes', () => {
    const r = by('launch-a-sequence').prompt
    const order = ['`search_tools`', '`list_sequences`', '`enroll_contacts_in_sequence`', '`get_sequence`', 'Say exactly what will send and when', '`show` with `kind: sequences`']
    const at = order.map((s) => r.indexOf(s))
    for (const [i, pos] of at.entries()) expect(pos, order[i]).toBeGreaterThan(-1)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(r).toMatch(/there is no launch tool/)
    expect(r).toMatch(/Never say it's sending or launched/)
    expect(r).toMatch(/`status` resume only after their yes to that, in a later turn/)
    expect(r).toMatch(/"Set it up and launch it" is not that yes/)
    // Enrollment is sticky (227: unique (sequence_id, contact_id), one active sequence per contact).
    expect(r).toContain("wait for their yes before enrolling anyone they didn't name: a contact removed from a sequence can never rejoin it")
    expect(r).toContain('On an active or paused sequence, change it only on their yes')
    expect(r).toContain('Review & launch also restarts everyone already in it. Ask to resume it first')
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

  it("hides every row with its area's feature", () => {
    for (const row of rows) {
      const area = row.area as keyof typeof FEATURE_OF
      expect(PACKS[area].feature, row.slug).toBe(FEATURE_OF[area])
      expect(FEATURES[FEATURE_OF[area]].systemRecipeIds ?? [], row.slug).toContain(row.id)
    }
  })

  it('upserts the 316/319 way: fixed ids, insert when missing, update only where a column differs, seed only', () => {
    expect(sql).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(statements).toMatch(/SELECT id, NULL::uuid, name, slug, icon, color, description,\s*system_prompt, agent_config, area,\s*'skill'::public\.recipe_category, true,/)
    expect(statements).toContain('ON CONFLICT (id) DO NOTHING')
    const check = /WHERE r\.id = p\.id\s*AND \(([\s\S]*?)\);/.exec(statements)
    expect(check).not.toBeNull()
    for (const col of ['system_prompt', 'description', 'agent_config', 'area', 'slug', 'name', 'icon', 'color']) {
      expect(check![1], col).toContain(`r.${col} IS DISTINCT FROM p.${col}`)
    }
    expect(statements).not.toMatch(/\bALTER\s+TABLE\b|\bCREATE\s+TABLE\b|\bDROP\b|\bDELETE\b/i)
  })
})
