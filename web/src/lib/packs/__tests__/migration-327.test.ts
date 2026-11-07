/**
 * Migration 327: the Documents, Initiatives, Evals, Browser and Library
 * skills, A1c (docs/plans/always-on-agent.md §1b item 7). It rewrites five
 * cores on their 319 ids and adds two pack-only recipes, write-a-document and
 * initiative-review. This pins the file: the rows, ids, areas and pack-only
 * flags, the cores' shape, the facts each text must keep true against the
 * code, the upsert, and the gating.
 */
import { describe, it, expect } from 'vitest'
import { TOOL_CATEGORIES } from '@/lib/ai/tool-registry'
import { FEATURES } from '@/lib/editions/manifest'
import { estimateTokens } from '../memory'
import { PACKS, playbookSlug } from '../registry'
import {
  allSeededSkills,
  allShippedSkills,
  CORE_HELPER_LINE,
  OLD_CORE_HELPER_LINE,
  readMigration,
  rewrittenAfter,
  seededSkills,
} from './playbook-seeds'

const FILE = '327_docs_goals_tools_skills.sql'
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
  { id: 'e8d88dec-0326-41b0-971e-f974c21cdefb', slug: 'documents-playbook', area: 'documents' },
  { id: '1d277e63-8a44-4ca6-b743-322a812971a9', slug: 'initiatives-playbook', area: 'initiatives' },
  { id: '8e08678d-1944-4a10-95ec-b9e73a7feea4', slug: 'evals-playbook', area: 'evals' },
  { id: 'eec790ec-399f-416d-8189-c883859ba8c3', slug: 'browser-playbook', area: 'browser' },
  { id: '800dc79b-a55f-4ef5-802d-8a6945e38460', slug: 'library-playbook', area: 'library' },
]
const RECIPES = [
  { id: 'a4b9263b-eb4d-4c57-afcc-7f8cd40bf1bb', slug: 'write-a-document', area: 'documents' },
  { id: '5472e163-15c1-4f7d-a263-55268a3825c3', slug: 'initiative-review', area: 'initiatives' },
]

const CORE_HEADINGS = ["What's here", 'How to find things', 'Doing it well', 'Pitfalls', 'When to hand to a helper']

/** The feature each area's rows are gated with (the library is core: never gated). */
const FEATURE_OF: Record<string, keyof typeof FEATURES | null> = {
  documents: 'docs',
  initiatives: 'projects',
  evals: 'evals',
  browser: 'browser',
  library: null,
}

describe('migration 327', () => {
  it('writes the five cores, then the two recipes, each with its id, slug and area', () => {
    expect(rows.map((r) => ({ id: r.id, slug: r.slug, area: r.area }))).toEqual([...CORES, ...RECIPES])
  })

  it('rewrites each core by its 319 id, and its text is the one that ships', () => {
    const s319 = seededSkills('319_area_playbooks.sql')
    const shipped = allSeededSkills()
    for (const core of CORES) {
      const before = s319.find((r) => r.id === core.id)
      expect(before?.slug, core.slug).toBe(core.slug)
      expect(core.slug).toBe(playbookSlug(core.area as Parameters<typeof playbookSlug>[0]))
      const now = shipped.find((r) => r.id === core.id)!
      // 338 swapped the helper line (only that): the rest of the shipped text is
      // 327's, unless a later rewrite (368's documents playbook) replaced it.
      const later = rewrittenAfter('338_skill_helper_lines.sql', core.id, core.slug)
      expect(now.file, core.slug).toBe(later ?? '338_skill_helper_lines.sql')
      if (!later) expect(now.prompt, core.slug).toBe(by(core.slug).prompt.replace(OLD_CORE_HELPER_LINE, CORE_HELPER_LINE))
      expect(now.prompt, core.slug).not.toBe(before!.prompt)
    }
  })

  it('gives the recipes new ids and slugs, none an earlier row', () => {
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

  it('makes both recipes pack-only, never a core', () => {
    for (const r of RECIPES) expect(by(r.slug).config.pack_only, r.slug).toBe(true)
    for (const c of CORES) expect(by(c.slug).config.pack_only, c.slug).toBeUndefined()
  })

  it('has no persona framing, and one-line descriptions of at most 200 characters', () => {
    for (const r of rows) {
      expect(r.prompt, r.slug).not.toMatch(/\byou are\b/i)
      expect(r.description.length, r.slug).toBeLessThanOrEqual(200)
      expect(r.description, r.slug).not.toContain('\n')
    }
  })

  it('keeps each core within 2,000 tokens and each recipe within 150 to 800', () => {
    for (const c of CORES) expect(estimateTokens(by(c.slug).prompt), c.slug).toBeLessThanOrEqual(2000)
    for (const r of RECIPES) {
      const n = estimateTokens(by(r.slug).prompt)
      expect(n, r.slug).toBeGreaterThanOrEqual(150)
      expect(n, r.slug).toBeLessThanOrEqual(800)
    }
  })

  it('gives every core the shared shape, with a one-line helper section', () => {
    for (const c of CORES) {
      const prompt = by(c.slug).prompt
      expect([...prompt.matchAll(/^## (.+)$/gm)].map((m) => m[1]), c.slug).toEqual(CORE_HEADINGS)
      expect(prompt.split('## When to hand to a helper\n')[1].trim(), c.slug).toBe(OLD_CORE_HELPER_LINE)
      // What ships is 338's line in its place.
      const shipped = allSeededSkills().find((r) => r.id === c.id)!.prompt
      expect(shipped.split('## When to hand to a helper\n')[1].trim(), c.slug).toBe(CORE_HELPER_LINE)
    }
  })

  it('tells the model to search_tools first where the tools are not core', () => {
    for (const slug of ['documents-playbook', 'initiatives-playbook', 'evals-playbook', 'library-playbook', 'write-a-document', 'initiative-review']) {
      expect(by(slug).prompt, slug).toContain('`search_tools`')
    }
    // Desktop turns get the browser tools without a search (BROWSER_TOOL_NAMES).
    expect(by('browser-playbook').prompt).toContain('seeded only in a turn from the desktop app; elsewhere they need `search_tools`')
  })

  it('documents: drafts versus live edits, the draft is the person\'s own, and linking', () => {
    const core = by('documents-playbook').prompt
    expect(core).toContain('`propose_document_edit` with the whole new `content`')
    expect(core).toContain("It doesn't show a pending draft")
    expect(core).toContain('`propose_document_edit` replaces any unpublished draft of theirs on that page')
    expect(core).toContain('Unless they just asked for this change, ask first')
    // Main chat's find covers recent weeks only unless all_time (search.ts).
    expect(core).toContain('`find` with the topic and `all_time: true`')
    // link_document_to_action takes the action UUID, not ENG-42.
    expect(core).toContain('with `get_action` first')
    expect(core).toMatch(/Neither keeps a revision/)
    expect(core).toContain('`publish_draft`')
    expect(core).toContain('`link_document_to_action`')
    expect(core).toContain('`update_document` with `project_id`')
    expect(core).toContain('[[slug]]')
  })

  it('initiatives: computed health as the tools compute it, and projects by initiative_id', () => {
    const core = by('initiatives-playbook').prompt
    expect(core).toMatch(/Health is computed, never set/)
    expect(core).toContain('behind once its target date passes; at risk when it\'s under a quarter done with at least one active project')
    expect(core).toContain('`list_projects` with its `initiative_id`')
    expect(core).toContain('archived ones still need `include_archived`')
    // No this_quarter preset (_shared.ts resolveSince): ISO dates.
    expect(core).toContain('ISO dates for the quarter')
    expect(core).not.toContain('this_quarter')
    expect(core).toContain('sub-actions and suggestions included')
    expect(core).toContain('`initiative-review`')
  })

  it('evals: what a run is and what it costs, as src/lib/evals does', () => {
    const core = by('evals-playbook').prompt
    expect(core).toMatch(/not chat answers/)
    expect(core).toContain('about 13 cents in either mode, 12 of it the judges')
    expect(core).toContain('$100 a month')
    expect(core).toContain('three times its estimate')
    expect(core).toContain('`create-eval`')
    expect(core).toContain('`local_1`')
    expect(core).toMatch(/get a yes before `start_eval_run`/)
    expect(core).toContain("a teammate's personal agent or skill can't be tested")
  })

  it('browser: desktop only, the last rung, never for Dial8 data, bounded goals, hand back on hard stops', () => {
    const core = by('browser-playbook').prompt
    expect(core).toMatch(/seeded only in a turn from the desktop app/)
    expect(core).toMatch(/work only while the desktop app is open/)
    expect(core).toMatch(/last rung of the tool ladder/)
    expect(core).toMatch(/Never for Dial8's own data/)
    expect(core).toMatch(/Never to work around a broken connector/)
    expect(core).toMatch(/A bounded goal with its completion condition/)
    expect(core).toContain('`max_wait_seconds` up to 240')
    expect(core).toMatch(/never reach it another way/)
  })

  it('library: visibility as the tools scope it (src/lib/library/visibility.ts), Discover for owners and admins only, on a yes', () => {
    const core = by('library-playbook').prompt
    expect(core).toMatch(/personal: its creator only\. Another member's personal skill isn't listed/)
    expect(core).toMatch(/workspace: every member/)
    expect(core).toMatch(/public: published to Discover for every Dial8 user\. Only workspace owners and admins may publish\./)
    // True before and after chat's create/update_skill gate public by role.
    expect(core).toContain('says yes to that exact skill')
    expect(core).toContain('or the tool refuses, offer workspace instead')
    expect(core).toMatch(/editable by its creator or a workspace owner or admin/)
    expect(core).toContain('`create-skill`')
    expect(core).not.toMatch(/anyone in the workspace can (see|edit)/i)
  })

  it('write-a-document: find first, file on the project, link, and propose edits instead of overwriting', () => {
    // 327's own text. What ships is 370's rewrite, pinned in migration-370.test.ts.
    const recipe = by('write-a-document').prompt
    const order = ['`search_tools`', '`find`', '`create_document`', '`link_document_to_action`', '`propose_document_edit`']
    const at = order.map((s) => recipe.indexOf(s))
    for (const [i, pos] of at.entries()) expect(pos, order[i]).toBeGreaterThan(-1)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(recipe).toMatch(/Never replace someone's page with a new one/)
    expect(recipe).toContain('`all_time: true`')
    expect(recipe).toContain('Unless they just asked for this change, ask first')
    expect(recipe).toMatch(/## The answer/)
  })

  it('initiative-review: rolled up from projects in one list_projects call, deeper only where off track', () => {
    const recipe = by('initiative-review').prompt
    const order = ['`search_tools`', '`get_initiative`', '`list_projects` with its `initiative_id`', '`list_actions`', '`get_project_context`']
    const at = order.map((s) => recipe.indexOf(s))
    for (const [i, pos] of at.entries()) expect(pos, order[i]).toBeGreaterThan(-1)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(recipe).toMatch(/Skip the healthy ones/)
    // list_projects' progress_pct: completed over total minus canceled (projects.ts).
    expect(recipe).toContain('`progress_pct` (top-level actions: completed over all but canceled)')
    expect(recipe).not.toContain('open work only')
    expect(recipe).toContain('`suggest_changes`')
    expect(recipe).toMatch(/\*\*Decisions needed:\*\*/)
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

  it('gates every row with its area\'s feature; the library core is core', () => {
    for (const row of rows) {
      const feature = FEATURE_OF[row.area!]
      expect(PACKS[row.area as keyof typeof PACKS].feature, row.slug).toBe(feature ?? 'core')
      if (feature) expect(FEATURES[feature].systemRecipeIds ?? [], row.slug).toContain(row.id)
      else for (const f of Object.values(FEATURES)) expect(f.systemRecipeIds ?? [], row.slug).not.toContain(row.id)
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
