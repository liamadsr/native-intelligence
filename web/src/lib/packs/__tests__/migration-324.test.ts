/**
 * Migration 324: the Workflows skill, A1b (docs/plans/always-on-agent.md §1b
 * item 6). It rewrites the Flows core on its 319 id for the chat workflow
 * tools and adds the pack-only `build-a-workflow` recipe. This pins the file:
 * the rows, ids, area and pack-only flag, the core's shape, the honesty fix
 * (chat no longer builds only HTTP flows), the asks-first steps, the upsert,
 * and the gating.
 */
import { describe, it, expect } from 'vitest'
import { TOOL_CATEGORIES } from '@/lib/ai/tool-registry'
import { FEATURES } from '@/lib/editions/manifest'
import { estimateTokens } from '../memory'
import { PACKS, playbookSlug } from '../registry'
import { allSeededSkills, allShippedSkills, CORE_HELPER_LINE, OLD_CORE_HELPER_LINE, promptRewrites, readMigration, seededSkills } from './playbook-seeds'

const FILE = '324_workflows_skill.sql'
const sql = readMigration(FILE)
const rows = seededSkills(FILE)
const by = (slug: string) => rows.find((r) => r.slug === slug)!

/** The statements, without comments or the quoted texts. */
const statements = sql
  .replace(/\$(pb|desc)\$[\s\S]*?\$\1\$/g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')

const CORE = { id: '1ef0c12f-5d78-41ef-ab12-714512fa03cd', slug: 'flows-playbook', area: 'flows' }
const RECIPE = { id: 'a1c4ac7d-4b00-4af4-a97e-1c79abaed9b3', slug: 'build-a-workflow', area: 'flows' }

const CORE_HEADINGS = ["What's here", 'How to find things', 'Doing it well', 'Pitfalls', 'When to hand to a helper']

describe('migration 324', () => {
  it('writes the Flows core, then build-a-workflow, each with its id, slug and area', () => {
    expect(rows.map((r) => ({ id: r.id, slug: r.slug, area: r.area }))).toEqual([CORE, RECIPE])
  })

  it('rewrites the Flows core by its 319 id, and its text is the one later rewrites start from', () => {
    const before = seededSkills('319_area_playbooks.sql').find((r) => r.id === CORE.id)!
    expect(before.slug).toBe(CORE.slug)
    expect(CORE.slug).toBe(playbookSlug('flows'))
    // 338 swapped its helper line for the one every core now ships; the rest is 324's.
    const s338 = promptRewrites('338_skill_helper_lines.sql').find((r) => r.id === CORE.id)!
    expect(s338.prompt).toBe(by(CORE.slug).prompt.replace(OLD_CORE_HELPER_LINE, CORE_HELPER_LINE))
    // 641 (the new triggers and schedules) rewrote it again: its text ships, and pins itself.
    const shipped = allSeededSkills().find((r) => r.id === CORE.id)!
    expect(shipped.file).toBe('641_flow_triggers_playbooks.sql')
    const s323 = seededSkills('323_feature_skills_v2.sql').find((r) => r.id === CORE.id)!
    expect(shipped.prompt).not.toBe(s323.prompt)
  })

  it('gives build-a-workflow a new id and slug, none an earlier row', () => {
    const earlier = new Set(
      ['316_skill_area_and_playbooks.sql', '319_area_playbooks.sql', '322_prospecting_skill_not_a_persona.sql', '323_feature_skills_v2.sql'].flatMap(
        (f) => seededSkills(f).flatMap((r) => [r.id, r.slug]),
      ),
    )
    expect(earlier.has(RECIPE.id)).toBe(false)
    expect(earlier.has(RECIPE.slug)).toBe(false)
    const ids = allShippedSkills().map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('makes build-a-workflow pack-only, never the core', () => {
    expect(by(RECIPE.slug).config.pack_only).toBe(true)
    expect(by(CORE.slug).config.pack_only).toBeUndefined()
  })

  it('has no persona framing, and one-line descriptions of at most 200 characters', () => {
    for (const r of rows) {
      expect(r.prompt, r.slug).not.toMatch(/\byou are\b/i)
      expect(r.description.length, r.slug).toBeLessThanOrEqual(200)
      expect(r.description, r.slug).not.toContain('\n')
    }
  })

  it('keeps the core within 2,000 tokens and the recipe within 150 to 800', () => {
    expect(estimateTokens(by(CORE.slug).prompt)).toBeLessThanOrEqual(2000)
    const recipe = estimateTokens(by(RECIPE.slug).prompt)
    expect(recipe).toBeGreaterThanOrEqual(150)
    expect(recipe).toBeLessThanOrEqual(800)
  })

  it('gives the core the shared shape, with a one-line helper section', () => {
    const prompt = by(CORE.slug).prompt
    expect([...prompt.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(CORE_HEADINGS)
    expect(prompt.split('## When to hand to a helper\n')[1].trim().split('\n')).toHaveLength(1)
  })

  it('no longer says chat builds only HTTP status flows, and teaches every trigger and action the tools take', () => {
    const core = by(CORE.slug).prompt
    expect(core).not.toMatch(/What chat can build today: one kind/)
    expect(core).not.toMatch(/only HTTP|built in the Flows editor|Don't promise a schedule/i)
    for (const trigger of ['entity_status_change', 'schedule', 'capture_processed', 'calendar_event']) expect(core, trigger).toContain(trigger)
    for (const action of ['http_post', 'run_skill', 'archive_capture', 'run_agent']) expect(core, action).toContain(action)
    expect(core).toMatch(/hourly, daily, weekdays or weekly/)
    expect(core).toMatch(/No cron/)
    // The still-true debugging notes.
    expect(core).toContain('`list_flow_runs`')
    expect(core).toContain('`action_results`')
    expect(core).toContain('`fire_on_agent_changes`')
    expect(core).toMatch(/chains of automations stop after two steps/)
    expect(core).toMatch(/times out after 5 seconds/)
  })

  it('asks first: create saved off, a one-line summary, then update_flow with confirmed_with_user on the yes', () => {
    const recipe = by(RECIPE.slug).prompt
    const order = ['`search_tools`', '`list_flows`', '`create_flow`', '`summary`', '`update_flow` with `flow_id`, `enabled` true and `confirmed_with_user` true']
    const at = order.map((s) => recipe.indexOf(s))
    for (const [i, pos] of at.entries()) expect(pos, order[i]).toBeGreaterThan(-1)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(recipe).toMatch(/Leave `enabled` out/)
    expect(recipe).toMatch(/Never set `confirmed_with_user` without that yes/)
    // Report vs act, and when the editor is better.
    expect(recipe).toMatch(/`mode` report unless/)
    expect(recipe).toMatch(/## When the editor is better/)
    for (const slug of [CORE.slug, RECIPE.slug]) expect(by(slug).prompt, slug).toContain('confirmed_with_user')
  })

  it("teaches update_flow's by-id merge: re-send every action with its id, and no stale reset-to-defaults pitfall", () => {
    const core = by(CORE.slug).prompt
    expect(core).toContain('re-send every action you keep, each with its `id`')
    expect(core).toMatch(/A matched action keeps what you leave out \(its skill, mode, auto-apply trust, document title/)
    // update_flow now carries a run_skill's unexposed fields by id (src/lib/ai/tools/flows.ts).
    expect(core).not.toMatch(/go back to their defaults|keeps only what these tools set/)
  })

  it('every loop starts off (no exemption), the yes waits for the next turn, and switching off never asks', () => {
    const core = by(CORE.slug).prompt
    const recipe = by(RECIPE.slug).prompt
    expect(core).not.toMatch(/starts on|a loop that runs on its own/i)
    expect(recipe).not.toMatch(/a loop that runs on its own/i)
    expect(core).toContain('Every loop `create_flow` makes is saved off')
    expect(recipe).toContain('every loop is saved off')
    expect(core).toContain('Switching off never needs it')
    for (const text of [core, recipe]) expect(text).toContain('a loop they can see in `list_flows` or the Flows page')
    expect(recipe).toMatch(/ask in your reply whether to switch it on, and end your turn/)
  })

  it("update_flow keeps a matched action's node fields: omitted keeps, null clears", () => {
    const core = by(CORE.slug).prompt
    expect(core).toContain('`enabled`, `condition` and `parent_id`')
    expect(core).toContain('omitted keeps, null clears a `condition` or `parent_id`')
  })

  it('states what a condition can filter as the evaluator does (src/lib/flows/condition.ts)', () => {
    const core = by(CORE.slug).prompt
    expect(core).toContain("an action's label, priority, assignee or team, the project of an action or a milestone, or from-status")
    expect(core).toContain('on a project or initiative loop only from-status filters, on a milestone loop from-status and project')
    expect(core).not.toMatch(/sees only an action status trigger's action/)
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

  it('hides both rows with the Flows feature', () => {
    expect(PACKS.flows.feature).toBe('flows')
    for (const row of rows) expect(FEATURES.flows.systemRecipeIds ?? [], row.slug).toContain(row.id)
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
