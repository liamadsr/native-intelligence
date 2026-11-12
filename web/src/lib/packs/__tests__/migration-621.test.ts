/**
 * Migration 621 (Studio): the studio area in every area CHECK, and the Studio
 * playbook with its task skills. Pinned: the CHECKs allow exactly the
 * registry's areas; the rows, fixed ids, slugs, area and pack-only flags; the
 * core's shape and every text's size (the bounds playbook-accuracy holds the
 * other areas to); every backticked name is a real tool, a real editing
 * command of the Studio engine, a Studio skill, or a word that text lists on
 * purpose; the skills that need a capability this workspace lacks say so;
 * the rules the texts teach (one undoable step, the digest, stills are the
 * agent's eyes, locked beats are the person's, the hand-off, the money rules,
 * consent); nothing from a private tool, path or person; idempotence, the
 * guard, and no backslash.
 */
import { describe, expect, it } from 'vitest'
import { ATTENDED_ONLY_TOOL_NAMES, TOOL_CATEGORIES } from '@/lib/ai/tool-registry'
import { CORE_TOOL_NAMES } from '@/lib/ai/tool-ceiling-core'
import { AREA_KEYS } from '../registry'
import { estimateTokens } from '../memory'
import { CORE_HELPER_LINE, allShippedSkills, readMigration, seededSkills } from './playbook-seeds'
import { STUDIO_ENGINE_OPS, STUDIO_TERMS } from './studio-skill-terms'

const FILE = '621_studio_skills.sql'
const sql = readMigration(FILE)
const rows = seededSkills(FILE)
const by = (slug: string) => {
  const row = rows.find((r) => r.slug === slug)
  if (!row) throw new Error(`no row ${slug}`)
  return row
}
/** The statements, without comments or the quoted texts. */
const statements = sql
  .replace(/\$(pb|desc|name|slug|icon|color|cfg)\$[\s\S]*?\$\1\$/g, "''")
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')

const ROWS = [
  { id: '954c76ec-ab39-4066-af50-7bdfb4a15a82', slug: 'studio-playbook' },
  { id: '586ac29a-3ea9-44ed-a21c-03f1d5850570', slug: 'studio-editing-layers' },
  { id: '09a42a42-bcc7-4e1e-8aea-cde5f7410df6', slug: 'studio-picture-and-shots' },
  { id: '748fabfb-99c8-40f6-a43c-6bf74921fb75', slug: 'studio-motion-design' },
  { id: '99e78d7c-4e13-4cff-8fba-75aea2cd7060', slug: 'studio-motion-particles' },
  { id: 'f4b1b4cc-ab0b-4e91-b49b-d3111e0b02ff', slug: 'studio-motion-recipes' },
  { id: 'ddd132e7-05d6-490b-a1b8-6fda277f6287', slug: 'studio-type-and-graphics' },
  { id: '6890489d-e8a8-4712-9d5d-35e9633b323a', slug: 'studio-brand' },
  { id: 'edbcbdcc-5101-4c9a-b89f-7f9d51fea9d6', slug: 'studio-script-writing' },
  { id: 'dc4e61f5-a966-4120-9a63-e770725696c5', slug: 'studio-storyboard' },
  { id: '470a6a9c-ef31-4d9f-a43c-b64d30717e8e', slug: 'studio-style-packs' },
  { id: '651c4102-eaef-4a56-ae51-bbb4afb995d3', slug: 'studio-style-pack-editorial-archival' },
  { id: '8cf5a3ee-ab8b-4dcb-ac70-5ca6e9da1ad8', slug: 'studio-style-pack-paper-collage' },
  { id: '4390a45d-766e-4487-af0a-808223245a91', slug: 'studio-style-pack-orbital' },
  { id: '9499a35b-bacb-462d-aad9-7168668fa405', slug: 'studio-style-pack-warm-loft' },
  { id: '73c5576d-701d-49d4-bdd8-4fb40df9a7c4', slug: 'studio-reference-to-style-pack' },
  { id: '399c0258-a53f-4ac5-b4b4-97ebbcaa5e4c', slug: 'studio-review' },
  { id: 'd7dd9d4f-f7af-4722-9e8c-e7daf930d159', slug: 'studio-match-a-reference' },
  { id: '630f44d7-164d-46bc-a5d4-723558173211', slug: 'studio-motion-ads' },
  { id: 'ecb5d367-acbe-4fcf-a863-30b3332eb2ca', slug: 'studio-generated-shots' },
  { id: 'cd6753b1-db8f-42cb-aab1-21620b411f24', slug: 'studio-sound' },
  { id: 'b310d743-be33-49dd-85ef-1655cd5b7f14', slug: 'studio-scene-design' },
  { id: '6ed3b2eb-8d15-46b7-9717-23f36d698f85', slug: 'studio-product-ui' },
  { id: 'f78898eb-1f33-4cc2-974a-6f7986e5070e', slug: 'studio-product-onboarding' },
]
const SLUGS: ReadonlySet<string> = new Set(ROWS.map((r) => r.slug))

/** The Studio tools the texts are written against (src/lib/ai/tools/studio.ts and job-tools.ts). */
const STUDIO_TOOLS = [
  'list_studio_projects', 'get_studio_video', 'get_studio_catalog', 'edit_studio_video', 'get_studio_storyboard',
  'get_studio_script', 'write_studio_script', 'list_studio_assets', 'create_studio_project', 'update_studio_project',
  'create_studio_video', 'update_studio_video', 'duplicate_studio_video', 'make_studio_format', 'list_studio_versions',
  'restore_studio_version', 'check_studio_video', 'render_studio_stills', 'export_studio_video', 'get_studio_job',
  'wait_for_studio_job', 'archive_studio_video',
] as const

/** The registry's tools, plus the core ones the chat always has (`search_tools`). */
const TOOL_NAMES: ReadonlySet<string> = new Set([...TOOL_CATEGORIES.flatMap((c) => c.tools.map((t) => t.name)), ...CORE_TOOL_NAMES])
/** The chat-agent's own tools a text may name (playbook-accuracy's AGENT_TOOL_NAMES). */
const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['helpers', 'update_plan'])
/** The editing commands `edit_studio_video` takes (studio-skill-terms reads them from the engine's source). */
const ENGINE_OPS = STUDIO_ENGINE_OPS
/** Per text, its commands and its fields (studio-skill-terms; playbook-accuracy takes both as that text's NOT_TOOLS). */
const TERMS = STUDIO_TERMS

/** The chat-only tools each text names: saving a pack as a skill is the person's step, in their chat. */
const CHAT_ONLY_NAMED: Record<string, readonly string[]> = {
  'studio-reference-to-style-pack': ['create_skill'],
}

/** Skills that need a capability this workspace lacks for all of their craft. */
const NOT_YET = ['studio-generated-shots', 'studio-scene-design', 'studio-product-ui', 'studio-product-onboarding']
/** Skills usable today, with a part that needs a capability this workspace lacks. */
const PARTLY = [
  'studio-sound', 'studio-motion-ads', 'studio-reference-to-style-pack', 'studio-match-a-reference', 'studio-review',
  'studio-style-pack-warm-loft', 'studio-style-pack-paper-collage', 'studio-style-pack-orbital', 'studio-storyboard',
]
const NOT_HERE = /(isn't|aren't|not) in this workspace yet/i

function backtickedIdentifiers(text: string): string[] {
  return [...text.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1])
}
function backtickedHyphenated(text: string): string[] {
  return [...text.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g)].map((m) => m[1])
}

describe('migration 621', () => {
  it('widens all five area CHECKs to exactly the registry’s areas: 384’s list plus studio, dropping each first', () => {
    expect(AREA_KEYS.at(-1)).toBe('studio')
    const checks: Array<[string, string]> = [
      ['recipe', 'recipe_area_check'],
      ['area_memory', 'area_memory_area_check'],
      ['area_memory_learning_run', 'area_memory_learning_run_area_check'],
      ['tracked_job', 'tracked_job_area_check'],
      ['chat_conversations', 'chat_conversations_focus_area_check'],
    ]
    const before = readMigration('384_content_area_skills.sql')
    for (const [table, name] of checks) {
      expect(statements, name).toContain(`ALTER TABLE public.${table} DROP CONSTRAINT IF EXISTS ${name};`)
      const add = new RegExp(`ALTER TABLE public\\.${table} ADD CONSTRAINT ${name} CHECK \\(([\\s\\S]*?)\\) NOT VALID;`).exec(statements)
      expect(add, name).not.toBeNull()
      const listed = [...add![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
      expect(listed, name).toEqual([...AREA_KEYS])
      const old = new RegExp(`ALTER TABLE public\\.${table} ADD CONSTRAINT ${name} CHECK \\(([\\s\\S]*?)\\) NOT VALID;`).exec(before)
      expect(listed, name).toEqual([...[...old![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), 'studio'])
      expect(statements, name).toContain(`ALTER TABLE public.${table} VALIDATE CONSTRAINT ${name};`)
    }
    // The focus area keeps its other two conditions (318).
    expect(statements).toMatch(/AND ai_team_member_id IS NULL\s+AND agent_teammate_id IS NULL/)
  })

  it('seeds the playbook and 23 task skills, with fresh fixed ids and studio- slugs, in the studio area', () => {
    expect(rows.map((r) => ({ id: r.id, slug: r.slug }))).toEqual(ROWS)
    for (const r of rows) expect(r.area, r.slug).toBe('studio')
    expect(by('studio-playbook').slug).toBe(`${'studio'}-playbook`)
    // The migrations before this one (626 rewrites these rows by id, so its texts are later, not earlier).
    const earlier = allShippedSkills().filter((s) => s.file < FILE)
    for (const r of ROWS) {
      expect(r.slug.startsWith('studio-'), r.slug).toBe(true)
      expect(earlier.some((s) => s.id === r.id || s.slug === r.slug), r.slug).toBe(false)
      // Once in its row, once in the guard.
      expect(sql.split(r.id).length - 1, r.slug).toBe(2)
    }
    expect(new Set(ROWS.map((r) => r.id)).size).toBe(ROWS.length)
  })

  it('lists the playbook globally and every task skill inside the Studio pack only, on the studio tools', () => {
    const categories = new Set(TOOL_CATEGORIES.map((c) => c.id))
    for (const r of rows) {
      expect(r.config.pack_only, r.slug).toBe(r.slug === 'studio-playbook' ? undefined : true)
      expect(r.config.enabled_tools, r.slug).toContain('studio')
      for (const c of r.config.enabled_tools ?? []) expect(categories.has(c), `${r.slug}: ${c}`).toBe(true)
      for (const t of r.config.preferred_tools ?? []) expect(TOOL_NAMES.has(t), `${r.slug}: ${t}`).toBe(true)
    }
  })

  it('keeps the core’s shape and size, every skill within its bounds, and every description to one line of at most 200 characters', () => {
    const core = by('studio-playbook').prompt
    for (const h of ["## What's here", '## How to find things', '## Doing it well', '## Skills', '## Pitfalls', '## When to hand to a helper']) expect(core, h).toContain(h)
    expect(core.split('## When to hand to a helper\n')[1]).toBe(CORE_HELPER_LINE)
    expect(estimateTokens(core)).toBeLessThanOrEqual(2000)
    for (const r of rows) {
      if (r.slug !== 'studio-playbook') {
        expect(estimateTokens(r.prompt), r.slug).toBeLessThanOrEqual(1200)
        expect(estimateTokens(r.prompt), r.slug).toBeGreaterThan(400)
      }
      expect(r.description.length, r.slug).toBeLessThanOrEqual(200)
      expect(r.description, r.slug).not.toContain('\n')
      expect(r.prompt, r.slug).not.toMatch(/\byou are\b/i)
    }
  })

  it('names only real tools, real editing commands, Studio skills, and the words each text lists on purpose', () => {
    expect(Object.keys(TERMS).sort()).toEqual([...SLUGS].sort())
    for (const r of rows) {
      const terms = TERMS[r.slug]
      const allowed = new Set([...terms.ops, ...terms.words])
      const unknown = backtickedIdentifiers(r.prompt).filter((w) => !TOOL_NAMES.has(w) && !AGENT_TOOL_NAMES.has(w) && !allowed.has(w))
      expect(unknown, `${r.slug}: not a tool, a command or a listed word`).toEqual([])
      const used = new Set(backtickedIdentifiers(r.prompt))
      for (const op of terms.ops) {
        expect(ENGINE_OPS.has(op), `${r.slug}: ${op} is not an editing command`).toBe(true)
        expect(used.has(op), `${r.slug}: ${op} is no longer used`).toBe(true)
      }
      for (const word of terms.words) {
        expect(TOOL_NAMES.has(word) || ENGINE_OPS.has(word), `${r.slug}: ${word} is a tool or a command`).toBe(false)
        expect(used.has(word), `${r.slug}: ${word} is no longer used`).toBe(true)
      }
      // A hyphenated name in backticks is a skill: one of these.
      expect(backtickedHyphenated(r.prompt).filter((s) => !SLUGS.has(s)), r.slug).toEqual([])
    }
    // The commands the brief names exist in the engine, and no editing command shadows a tool.
    for (const op of ENGINE_OPS) expect(TOOL_NAMES.has(op), op).toBe(false)
    expect(ENGINE_OPS.size).toBeGreaterThanOrEqual(40)
  })

  it('every Studio tool the texts are written against is registered in the studio category', () => {
    const studio = TOOL_CATEGORIES.find((c) => c.id === 'studio')
    expect(studio, 'the studio tool category').toBeDefined()
    const names = new Set(studio!.tools.map((t) => t.name))
    for (const t of STUDIO_TOOLS) expect(names.has(t), t).toBe(true)
    const named = new Set(rows.flatMap((r) => backtickedIdentifiers(r.prompt)).filter((w) => w.includes('studio')))
    for (const t of named) expect(names.has(t), t).toBe(true)
  })

  it('names exactly the chat-only tools it is expected to', () => {
    for (const r of rows) {
      const named = [...new Set(backtickedIdentifiers(r.prompt).filter((w) => ATTENDED_ONLY_TOOL_NAMES.has(w)))].sort()
      expect(named, r.slug).toEqual([...(CHAT_ONLY_NAMED[r.slug] ?? [])].sort())
    }
  })

  it('the playbook loads every task skill by name', () => {
    const core = by('studio-playbook').prompt
    for (const slug of SLUGS) if (slug !== 'studio-playbook') expect(core, slug).toContain(`\`${slug}\``)
  })

  it('says plainly what is not in this workspace yet, so the agent never promises it', () => {
    const core = by('studio-playbook').prompt
    expect(core).toMatch(
      /Not in this workspace yet: the sound pass, sound effects and listening; the measured motion, review and visual checks; cut-outs; the product's real UI from its code; reading a brand from a site; custom code scenes; generated shots and their costs; the director pass; reference blueprints; importing media from a link\./,
    )
    expect(core).toMatch(/Never promise, start or report any of it/)
    for (const slug of NOT_YET) {
      const r = by(slug)
      expect(r.prompt.startsWith("Needs a capability that isn't in this workspace yet"), slug).toBe(true)
      expect(r.prompt, slug).toMatch(/Never (promise|generate)/)
      expect(r.description.startsWith('Not in this workspace yet'), slug).toBe(true)
    }
    for (const slug of PARTLY) expect(by(slug).prompt, slug).toMatch(NOT_HERE)
  })

  it('teaches the editing loop: one undoable step, the digest, the catalog, stills as eyes, no raw edit, no invented ids', () => {
    const core = by('studio-playbook').prompt
    expect(core).toMatch(/The loop is read, catalog, edit, look/)
    expect(core).toMatch(/applied in order as ONE undoable step, all or nothing/)
    expect(core).toMatch(/Pass `expected_digest` from your last read\. A refusal means the edit changed/)
    expect(core).toMatch(/never overwrite/)
    expect(core).toMatch(/`get_studio_catalog` before your first edit in a conversation/)
    expect(core).toMatch(/You can't watch video: the stills are your eyes/)
    expect(core).toMatch(/there is no raw edit/)
    expect(core).toMatch(/Never invent an asset, layer, beat or cast id/)
    expect(core).toMatch(/Say "Studio project": "project" or "campaign" alone mean other things here/)
    expect(core).toMatch(/`read_canon` with key product/)
  })

  it('locked beats are the person’s; recording, approving and exporting are theirs', () => {
    expect(by('studio-playbook').prompt).toMatch(/Locked beats are the person's\. Every command on one is refused: propose the change in chat\. Only they unlock\./)
    expect(by('studio-storyboard').prompt).toMatch(/Locked beats are the person's: every command on them is refused/)
    expect(by('studio-storyboard').prompt).toMatch(/You never record/)
    expect(by('studio-script-writing').prompt).toMatch(/Locked beats are refused: suggest changes to them in chat/)
    const core = by('studio-playbook').prompt
    expect(core).toMatch(/before anything goes back, `check_studio_video`/)
    expect(core).toMatch(/record a take into a placeholder, approve the video, decide to export\. Export only when they ask/)
    expect(core).toMatch(/never say a video was generated, posted, published or sent/)
  })

  it('keeps the craft’s numbers', () => {
    const design = by('studio-motion-design').prompt
    for (const kept of [
      'Aim for 6 to 8 beats in 15 to 25 s',
      'Reading time = 0.6 s plus words divided by 3.5 (a 6-word line needs 2.3 s up)',
      'Headline 0.06 to 0.09; secondary lines 0.028 to 0.036; anything meant to be read 0.033 or more',
      'The longest still hold is about 1.8 s, except the end card (2 to 3 s)',
      'start the next move 0.1 to 0.3 s before the last one settles',
    ]) expect(design, kept).toContain(kept)
    const particles = by('studio-motion-particles').prompt
    for (const kept of ['count 40 to 48', 'jitter 0.012', 'icon size s = min(h·1080, w·1920/n·0.7) px', 'about 2.6·z frame heights', 'camX drifts ±0.006']) {
      expect(particles, kept).toContain(kept)
    }
    const recipes = by('studio-motion-recipes').prompt
    for (const letter of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) expect(recipes, letter).toMatch(new RegExp(`^${letter}\\. `, 'm'))
    const review = by('studio-review').prompt
    for (const kept of ['under 4.5 to 1 (3 to 1 at size 0.05 and up)', 'more than 8% of the main face', 'a scene over 2.5 s (4 s if it is the last)', 'silence over 1.2 s']) {
      expect(review, kept).toContain(kept)
    }
    expect(by('studio-sound').prompt).toMatch(/-14 by default: web; -16 for podcasts and voice-led films/)
    expect(by('studio-storyboard').prompt).toMatch(/keep a shot between 2\.2 s and 8 s \(then change angle\); never two cuts within 1 s/)
  })

  it('carries every style pack, each applied by name with set_style_pack', () => {
    const chooser = by('studio-style-packs').prompt
    for (const pack of ['clean-product', 'editorial-archival', 'paper-collage', 'orbital', 'warm-loft']) expect(chooser, pack).toContain(pack)
    for (const [slug, pack] of [
      ['studio-style-pack-editorial-archival', 'editorial-archival'],
      ['studio-style-pack-paper-collage', 'paper-collage'],
      ['studio-style-pack-orbital', 'orbital'],
      ['studio-style-pack-warm-loft', 'warm-loft'],
    ]) {
      expect(by(slug).prompt, slug).toContain(`\`set_style_pack\` ${pack}`)
      for (const h of ['Avoid', 'Checklist']) expect(by(slug).prompt, `${slug}: ${h}`).toMatch(new RegExp(`(## |- )${h}`))
    }
    expect(chooser).toMatch(/The brand still owns colour and type/)
  })

  it('keeps the money rules and consent for generated shots, without hard-coding models or prices as fact', () => {
    const gen = by('studio-generated-shots').prompt
    for (const kept of [
      'Every call that can spend asks the person first',
      'A decline is an answer',
      'Propose before generating',
      'Cheap drafts, good models only for finals',
      'Model names and prices change: take them from the provider',
      'Stills before video',
      'Code first',
      'A person needs consent true',
    ]) expect(gen, kept).toContain(kept)
    // The shot prompt structure, all eight parts in order.
    const steps = [...gen.matchAll(/^(\d)\. /gm)].map((m) => Number(m[1]))
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    // No price list: model names and prices change.
    expect(gen).not.toMatch(/\d+(\.\d+)? credits/)
  })

  it('copies the craft, never the brand, and invents no proof', () => {
    expect(by('studio-playbook').prompt).toMatch(/Copy a reference's craft, never its logo, product, people or words/)
    expect(by('studio-match-a-reference').prompt).toMatch(/Copy the craft, not the brand/)
    expect(by('studio-script-writing').prompt).toMatch(/No invented proof/)
  })

  it('carries no local path, no shell step and no file a person would have on their own machine', () => {
    for (const word of ['project.ts', '.cache', 'editor-data', 'kits/', 'style-packs/', 'node --import', 'checkout', '.tsx', '/Users/', '~/']) {
      expect(sql.includes(word), word).toBe(false)
    }
  })

  it('is one transaction, idempotent (insert when missing, update only what differs), guarded, and has no backslash', () => {
    expect(sql.includes(String.fromCharCode(92))).toBe(false)
    expect(statements).toMatch(/^begin;$/m)
    expect(statements).toMatch(/^SET LOCAL lock_timeout = '5s';$/m)
    expect(statements).toMatch(/ON CONFLICT \(id\) DO NOTHING/)
    expect(statements).toMatch(/r\.system_prompt IS DISTINCT FROM p\.system_prompt/)
    expect(statements).toMatch(/^notify pgrst, 'reload schema';$/m)
    expect(statements.trim().endsWith('commit;')).toBe(true)
    expect(statements).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|DROP\s+TABLE)\b/i)
    expect(statements).not.toMatch(/INSERT INTO public\.flow/i)
    const guard = statements.slice(statements.indexOf('DO $guard$'))
    expect(guard).toContain('<> 24 THEN')
    expect(guard.match(/RAISE EXCEPTION/g)?.length).toBe(1)
    expect(statements.indexOf('DO $guard$')).toBeGreaterThan(statements.lastIndexOf('UPDATE public.recipe'))
  })
})
