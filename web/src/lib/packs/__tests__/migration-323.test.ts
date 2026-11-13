/**
 * Migration 323: feature skills, A1 (docs/plans/always-on-agent.md §1b). It
 * rewrites four area cores on their 319 ids and adds seven recipes. This pins
 * the file: the rows, their slugs, areas and pack-only flags, the cores'
 * shared shape, the honesty fixes the rewrite exists for, the 316/319 upsert,
 * and that every gated area's new row is hidden with its feature.
 */
import { describe, it, expect } from 'vitest'
import { TOOL_CATEGORIES } from '@/lib/ai/tool-registry'
import { FEATURES, CORE_FEATURE } from '@/lib/editions/manifest'
import { PACKS, isAreaKey, playbookSlug } from '../registry'
import { allSeededSkills, allShippedSkills, readMigration, seededSkills } from './playbook-seeds'

const FILE = '323_feature_skills_v2.sql'
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
  { id: 'ec62f1a3-cafe-4905-a6f1-2fb328906446', slug: 'actions-playbook', area: 'actions' },
  { id: 'e1a419c7-8cc0-46b2-b24b-d866210d87c5', slug: 'projects-playbook', area: 'projects' },
  { id: 'e6ea5b11-b98c-4d56-a5e5-40b5e661d1dc', slug: 'knowledge-playbook', area: 'knowledge' },
  { id: '1ef0c12f-5d78-41ef-ab12-714512fa03cd', slug: 'flows-playbook', area: 'flows' },
]

const RECIPES = [
  { id: '4fb68c47-22fb-4073-9600-c037f8ed993b', slug: 'my-todo-list', area: 'actions', packOnly: false },
  { id: '2cb64212-9dd5-42df-bede-3dc46313cc4a', slug: 'overdue-work', area: 'actions', packOnly: true },
  { id: 'ca443e96-3c3f-419a-b1f4-4f444bbe8c5c', slug: 'project-status-update', area: 'projects', packOnly: true },
  { id: '46d24d23-ef85-48b9-b16d-4c912899459d', slug: 'what-do-we-know', area: 'knowledge', packOnly: false },
  { id: 'dc51017f-b90b-485e-a701-806f9c7b9d18', slug: 'whats-changed', area: 'knowledge', packOnly: true },
  { id: '29b2a03c-a998-4133-b9c5-70b969f86a41', slug: 'everything-about', area: 'knowledge', packOnly: false },
  // No area: the general front door, a plain global skill. Loading it
  // attaches no core, and no feature gates it (Notes has no Knowledge).
  { id: '326b5c1f-552e-4e83-af87-8cbb960de47b', slug: 'find-anything', area: null, packOnly: false },
]

/** 323's cores a later migration rewrote again, by slug: the file whose text ships. */
const LATER_REWRITES: Readonly<Record<string, string>> = {
  // 324 rewrote the Flows core; 338 then swapped every core's helper line and
  // added the promotion rule to Actions (migration-338.test.ts); 641 rewrote the
  // Flows core again for the new triggers and schedules (migration-641.test.ts).
  'flows-playbook': '641_flow_triggers_playbooks.sql',
  'actions-playbook': '338_skill_helper_lines.sql',
  'projects-playbook': '338_skill_helper_lines.sql',
  'knowledge-playbook': '338_skill_helper_lines.sql',
}

/** The headings every core has, in order. */
const CORE_HEADINGS = ["What's here", 'How to find things', 'Doing it well', 'Pitfalls', 'When to hand to a helper']

describe('migration 323', () => {
  it('writes the four cores, then the seven recipes, each with its id, slug and area', () => {
    expect(rows.map((r) => ({ id: r.id, slug: r.slug, area: r.area }))).toEqual([
      ...CORES,
      ...RECIPES.map(({ id, slug, area }) => ({ id, slug, area })),
    ])
  })

  it('rewrites each core by the id 319 seeded it under, keeping its slug and area', () => {
    const s319 = seededSkills('319_area_playbooks.sql')
    for (const core of CORES) {
      const before = s319.find((r) => r.id === core.id)!
      expect(before, core.slug).toBeDefined()
      expect(before.slug).toBe(core.slug)
      expect(core.slug).toBe(playbookSlug(core.area as never))
      // The shipped text is 323's, not 319's (or a later rewrite's: 324 rewrote the Flows core).
      const shipped = allSeededSkills().find((r) => r.id === core.id)!
      expect(LATER_REWRITES[core.slug] ?? FILE).toBe(shipped.file)
      expect(shipped.prompt).not.toBe(before.prompt)
    }
  })

  it('gives the recipes new ids, none a 316/319/322 row', () => {
    const earlier = new Set(
      ['316_skill_area_and_playbooks.sql', '319_area_playbooks.sql', '322_prospecting_skill_not_a_persona.sql'].flatMap((f) =>
        seededSkills(f).flatMap((r) => [r.id, r.slug]),
      ),
    )
    for (const r of RECIPES) {
      expect(earlier.has(r.id), r.slug).toBe(false)
      expect(earlier.has(r.slug), r.slug).toBe(false)
    }
    const ids = allShippedSkills().map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('marks exactly the pack-only recipes with agent_config.pack_only, and never a core', () => {
    for (const r of RECIPES) {
      const config = by(r.slug).config
      if (r.packOnly) expect(config.pack_only, r.slug).toBe(true)
      else expect(config.pack_only, r.slug).toBeUndefined()
    }
    for (const c of CORES) expect(by(c.slug).config.pack_only, c.slug).toBeUndefined()
  })

  it('has no persona framing, and one-line descriptions of at most 200 characters', () => {
    for (const r of rows) {
      expect(r.prompt, r.slug).not.toMatch(/\byou are\b/i)
      expect(r.description.length, r.slug).toBeLessThanOrEqual(200)
      expect(r.description, r.slug).not.toContain('\n')
    }
  })

  it('gives every core the same shape', () => {
    for (const c of CORES) {
      const headings = [...by(c.slug).prompt.matchAll(/^## (.+)$/gm)].map((m) => m[1])
      expect(headings, c.slug).toEqual(CORE_HEADINGS)
      // The helper line stays one line in 323's text (338 swaps it for the line that ships).
      const helper = by(c.slug).prompt.split('## When to hand to a helper\n')[1]
      expect(helper.trim().split('\n'), c.slug).toHaveLength(1)
    }
  })

  it('says what the audit found: list_actions is workspace-wide and urgent first, get_project_context lists open work with a total, find has a window, flows are HTTP only', () => {
    const actions = by('actions-playbook').prompt
    expect(actions).not.toMatch(/lists actions the person created/i)
    expect(actions).toContain("`assignee`: 'me'")
    // It filters by project and team in the database: no paging the workspace to filter rows by hand.
    expect(actions).not.toMatch(/No project or team filter/)
    expect(actions).toMatch(/`project_id` narrows it to one project/)
    expect(actions).toMatch(/`team_id` to one team's board/)
    // read_card reads a card that was on screen, never one drawn this turn.
    expect(actions).not.toMatch(/`read_card` reads up to 50\.$/m)
    expect(actions).toMatch(/can't read a card you draw this turn/)
    for (const r of rows) expect(r.prompt, r.slug).not.toMatch(/keep(ing)? (the )?rows whose `project_id` matches/)
    // A show date filter takes an ISO date ("before today" is refused by the card's check).
    for (const r of rows) expect(r.prompt, r.slug).not.toMatch(/`due_at` before today/)
    // The priority sort was fixed (urgent first): nothing tells the model to re-rank.
    expect(actions).toMatch(/Rows come urgent first, then by the earliest due date, undated last/)
    expect(actions).not.toMatch(/none first|re-?rank|rank them yourself/i)
    expect(actions).toMatch(/`confirmation`: dismissed rows are left out/)
    const projects = by('projects-playbook').prompt
    expect(projects).not.toMatch(/projects the person created/i)
    expect(projects).toMatch(/its 20 most urgent open actions/)
    expect(projects).toContain('`open_actions_total`')
    expect(projects).not.toMatch(/under-report/)
    const knowledge = by('knowledge-playbook').prompt
    expect(knowledge).toMatch(/past 4 weeks/)
    expect(knowledge).toContain('`all_time`')
    expect(knowledge).toMatch(/A claim with no source is a rumor/)
    const flows = by('flows-playbook').prompt
    expect(flows).toMatch(/What chat can build today: one kind/)
    expect(flows).toMatch(/Flows editor/)
  })

  it('tells every recipe that reaches past the core tools to use search_tools first', () => {
    const core = new Set(['find', 'list_actions', 'get_dashboard_summary', 'show', 'suggest_changes', 'list_captures', 'get_calendar_events', 'create_action', 'update_action', 'complete_action'])
    for (const r of RECIPES) {
      const prompt = by(r.slug).prompt
      const named = [...prompt.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1])
      const tools = new Set(TOOL_CATEGORIES.flatMap((c) => c.tools.map((t) => t.name)))
      const nonCore = named.filter((w) => tools.has(w) && !core.has(w) && w !== 'read_card' && w !== 'run_browser_task')
      if (nonCore.length > 0) expect(prompt, r.slug).toContain('`search_tools`')
    }
  })

  it('my-todo-list reads the list in ONE call and splits it overdue, this week, the rest, confirmed work only, in the order rows arrive', () => {
    const p = by('my-todo-list').prompt
    const call = p.indexOf("One call: `list_actions` with `assignee` 'me', `confirmation` 'confirmed' and `limit` 200, no `filter`")
    expect(call).toBeGreaterThan(-1)
    const overdue = p.indexOf('overdue: `is_overdue` is true')
    const week = p.indexOf('due this week:')
    const rest = p.indexOf('the rest, undated included')
    expect(overdue).toBeGreaterThan(call)
    expect(week).toBeGreaterThan(overdue)
    expect(rest).toBeGreaterThan(week)
    // Not three overlapping calls: one filter only when one slice is asked for.
    expect(p.match(/`filter` overdue/g) ?? []).toHaveLength(1)
    expect(p).toMatch(/Asked for one slice only/)
    expect(p).toMatch(/server's day/)
    expect(p).toMatch(/Rows arrive urgent first, then earliest due: keep that order/)
    for (const slug of ['my-todo-list', 'overdue-work']) expect(by(slug).prompt, slug).not.toMatch(/none first|re-?rank/i)
    expect(by('my-todo-list').description).toMatch(/my to-dos.*what's on my plate.*what should I work on/i)
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

  it('hides every gated area’s rows with its feature, and leaves core areas ungated', () => {
    const gated = new Set(Object.values(FEATURES).flatMap((f) => f.systemRecipeIds ?? []))
    for (const row of allShippedSkills()) {
      if (!isAreaKey(row.area)) continue
      const feature = PACKS[row.area].feature
      const ids = FEATURES[feature].systemRecipeIds ?? []
      if (feature === CORE_FEATURE) expect(ids, row.slug).not.toContain(row.id)
      else expect(ids, `${row.slug} must be in FEATURES.${feature}.systemRecipeIds`).toContain(row.id)
    }
  })

  it('leaves find-anything with no area: global, ungated, never pack-only, attaching no core', () => {
    const row = by('find-anything')
    expect(row.area).toBeNull()
    expect(row.config.pack_only).toBeUndefined()
    const gated = new Set(Object.values(FEATURES).flatMap((f) => f.systemRecipeIds ?? []))
    expect(gated.has(row.id)).toBe(false)
    // The SQL writes a typed NULL, so the VALUES column stays text.
    expect(sql).toMatch(/\$cfg\$::jsonb,\s*NULL::text\s*\)\s*\),\s*inserted AS/)
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
