/**
 * Migration 626 (Studio): the Studio skills learn what the Studio can do now
 * (ads from a brand kit, narration, generated shots and their costs, sound
 * design and listening, the measured checks, cut-outs, the director pass,
 * face-aware formats). Pinned: it rewrites sixteen of 621's rows whole, by
 * their ids and slugs, and adds five fixed-id skills, all in the studio
 * area; it touches only Studio rows and no CHECK, function or policy; every
 * backticked name is a real tool, a real editing command, a Studio skill or
 * a word that text lists on purpose (studio-skill-terms); every new tool is
 * taught somewhere; no text says a built capability is "not yet" any more;
 * the rules that matter most are in the texts (measure before describing
 * sound or motion and quote the numbers, one fix at a time, a quote and the
 * person's card before any spend and never a retry, a director dry run
 * first, brand rules from the kit and the canon documents, export only when
 * asked, say "when available" and carry on when a tool refuses); sizes;
 * idempotence, the guard, and no backslash.
 */
import { describe, expect, it } from 'vitest'
import { ATTENDED_ONLY_TOOL_NAMES, TOOL_CATEGORIES } from '@/lib/ai/tool-registry'
import { CORE_TOOL_NAMES } from '@/lib/ai/tool-ceiling-core'
import { FEATURES } from '@/lib/editions/manifest'
import { estimateTokens } from '../memory'
import { CORE_HELPER_LINE, allShippedSkills, readMigration, seededSkills } from './playbook-seeds'
import { STUDIO_ENGINE_OPS, STUDIO_TERMS_626 } from './studio-skill-terms'

const FILE = '626_studio_skills_refresh.sql'
const sql = readMigration(FILE)
const rows = seededSkills(FILE)
const before = seededSkills('621_studio_skills.sql')
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

/** 621's rows this file rewrites whole, by id. */
const REWRITTEN = [
  { id: '954c76ec-ab39-4066-af50-7bdfb4a15a82', slug: 'studio-playbook' },
  { id: '586ac29a-3ea9-44ed-a21c-03f1d5850570', slug: 'studio-editing-layers' },
  { id: '09a42a42-bcc7-4e1e-8aea-cde5f7410df6', slug: 'studio-picture-and-shots' },
  { id: '748fabfb-99c8-40f6-a43c-6bf74921fb75', slug: 'studio-motion-design' },
  { id: 'ddd132e7-05d6-490b-a1b8-6fda277f6287', slug: 'studio-type-and-graphics' },
  { id: '6890489d-e8a8-4712-9d5d-35e9633b323a', slug: 'studio-brand' },
  { id: 'edbcbdcc-5101-4c9a-b89f-7f9d51fea9d6', slug: 'studio-script-writing' },
  { id: 'dc4e61f5-a966-4120-9a63-e770725696c5', slug: 'studio-storyboard' },
  { id: '470a6a9c-ef31-4d9f-a43c-b64d30717e8e', slug: 'studio-style-packs' },
  { id: '9499a35b-bacb-462d-aad9-7168668fa405', slug: 'studio-style-pack-warm-loft' },
  { id: '73c5576d-701d-49d4-bdd8-4fb40df9a7c4', slug: 'studio-reference-to-style-pack' },
  { id: '399c0258-a53f-4ac5-b4b4-97ebbcaa5e4c', slug: 'studio-review' },
  { id: 'd7dd9d4f-f7af-4722-9e8c-e7daf930d159', slug: 'studio-match-a-reference' },
  { id: '630f44d7-164d-46bc-a5d4-723558173211', slug: 'studio-motion-ads' },
  { id: 'ecb5d367-acbe-4fcf-a863-30b3332eb2ca', slug: 'studio-generated-shots' },
  { id: 'cd6753b1-db8f-42cb-aab1-21620b411f24', slug: 'studio-sound' },
]
/** The skills this file adds. */
const ADDED = [
  { id: 'ff3c1bc7-de70-4e91-9201-37b79d1d0c03', slug: 'studio-static-ads' },
  { id: '808be34a-c35f-4976-abf7-8f19066e30d9', slug: 'studio-reels' },
  { id: 'd1c1868a-529c-420c-9e65-86ce43b64050', slug: 'studio-narration' },
  { id: 'eca4a2dd-7410-43c5-bddc-477d2f1d7da1', slug: 'studio-measured-checks' },
  { id: 'c1ae523f-83c4-4a7e-9dff-3286f38cd4d4', slug: 'studio-director-and-cut-outs' },
]
const ROWS = [...REWRITTEN, ...ADDED]
/** Every Studio system skill once both files are applied: 621's 24 and these five. */
const ALL_STUDIO = [...before.map((r) => ({ id: r.id, slug: r.slug })), ...ADDED]
const STUDIO_SLUGS: ReadonlySet<string> = new Set(ALL_STUDIO.map((r) => r.slug))
const STUDIO_IDS: ReadonlySet<string> = new Set(ALL_STUDIO.map((r) => r.id))

/** The tools added since 621 (src/lib/ai/tools/studio-ads.ts, -media, -sound, -checks, -vision): each is taught somewhere. */
const NEW_TOOLS = [
  'get_studio_brand_kit', 'set_studio_brand_kit', 'make_studio_static_ads', 'make_studio_motion_ad', 'make_studio_reel', 'list_studio_ads',
  'get_studio_voice', 'list_studio_voices', 'set_studio_voice', 'quote_studio_narration', 'generate_studio_narration',
  'quote_studio_shot', 'generate_studio_shot', 'get_studio_costs',
  'sound_pass_studio_video', 'add_studio_sounds', 'import_studio_sound', 'list_studio_sounds', 'listen_to_studio_video',
  'check_studio_motion', 'review_studio_video', 'look_at_studio_video',
  'cut_out_studio_subject', 'direct_studio_video', 'set_studio_delivery_format',
] as const
/** The tools that run only where the Studio worker has the capability: a text naming one says what to do when it refuses. */
const WORKER_TOOLS: ReadonlySet<string> = new Set([
  'make_studio_static_ads', 'make_studio_motion_ad', 'make_studio_reel', 'generate_studio_narration', 'list_studio_voices', 'quote_studio_shot',
  'generate_studio_shot', 'sound_pass_studio_video', 'add_studio_sounds', 'import_studio_sound', 'listen_to_studio_video', 'check_studio_motion',
  'review_studio_video', 'look_at_studio_video', 'cut_out_studio_subject',
])
const WHEN_UNAVAILABLE = /when available|NOT_AVAILABLE|when one isn't available|isn't available right now/i

/** The registry's tools, plus the core ones the chat always has. */
const TOOL_NAMES: ReadonlySet<string> = new Set([...TOOL_CATEGORIES.flatMap((c) => c.tools.map((t) => t.name)), ...CORE_TOOL_NAMES])
const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['helpers', 'update_plan'])

/** The chat-only tools each text names (playbook-accuracy pins the same). */
const CHAT_ONLY_NAMED: Record<string, readonly string[]> = { 'studio-reference-to-style-pack': ['create_skill'] }

const NOT_HERE = /(isn't|aren't|not) in this workspace yet|\bnot yet\b/i
/** What the Studio has now: no "not yet" sentence may name it. */
const BUILT =
  /\b(sound|sounds|listen\w*|generat\w*|narrat\w*|voices?|cut-outs?|director|measured|motion check|review|visual check|costs?|brand kit|static ads?|motion ads?|reels?|ad pipeline)\b/i

function backtickedIdentifiers(text: string): string[] {
  return [...text.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1])
}
function backtickedHyphenated(text: string): string[] {
  return [...text.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g)].map((m) => m[1])
}
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n/).filter((s) => s.trim())
}

describe('migration 626', () => {
  it('rewrites sixteen of 621’s rows by their own ids and slugs, and adds five fresh fixed-id skills, all in the studio area', () => {
    expect(rows.map((r) => ({ id: r.id, slug: r.slug }))).toEqual(ROWS)
    for (const r of rows) expect(r.area, r.slug).toBe('studio')
    for (const r of REWRITTEN) expect(before.some((b) => b.id === r.id && b.slug === r.slug), r.slug).toBe(true)
    const earlier = allShippedSkills().filter((s) => s.file < FILE)
    for (const r of ADDED) {
      expect(r.slug.startsWith('studio-'), r.slug).toBe(true)
      expect(earlier.some((s) => s.id === r.id || s.slug === r.slug), r.slug).toBe(false)
    }
    // A written row's id: once in its row, once in the guard. 621's others: only in the guard.
    for (const r of ROWS) expect(sql.split(r.id).length - 1, r.slug).toBe(2)
    for (const r of before.filter((b) => !ROWS.some((w) => w.id === b.id))) expect(sql.split(r.id).length - 1, r.slug).toBe(1)
    expect(new Set(ROWS.map((r) => r.id)).size).toBe(ROWS.length)
    expect(new Set(ALL_STUDIO.map((r) => r.slug)).size).toBe(29)
  })

  it('ships 626’s texts for the rows it writes, and every Studio skill id is in the Studio feature', () => {
    const shipped = allShippedSkills()
    for (const r of ROWS) expect(shipped.find((s) => s.id === r.id)?.file, r.slug).toBe(FILE)
    const ids = FEATURES.studio.systemRecipeIds ?? []
    expect([...ids].sort()).toEqual([...STUDIO_IDS].sort())
  })

  it('lists the playbook globally and every task skill inside the Studio pack only, on real categories and tools', () => {
    const categories = new Set(TOOL_CATEGORIES.map((c) => c.id))
    for (const r of rows) {
      expect(r.config.pack_only, r.slug).toBe(r.slug === 'studio-playbook' ? undefined : true)
      expect(r.config.enabled_tools, r.slug).toContain('studio')
      for (const c of r.config.enabled_tools ?? []) expect(categories.has(c), `${r.slug}: ${c}`).toBe(true)
      for (const t of r.config.preferred_tools ?? []) expect(TOOL_NAMES.has(t), `${r.slug}: ${t}`).toBe(true)
    }
  })

  it('keeps the core’s shape and every text within its size; descriptions one line of at most 200 characters', () => {
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
    expect(Object.keys(STUDIO_TERMS_626).sort()).toEqual(ROWS.map((r) => r.slug).sort())
    for (const r of rows) {
      const terms = STUDIO_TERMS_626[r.slug]
      const allowed = new Set([...terms.ops, ...terms.words])
      const unknown = backtickedIdentifiers(r.prompt).filter((w) => !TOOL_NAMES.has(w) && !AGENT_TOOL_NAMES.has(w) && !allowed.has(w))
      expect(unknown, `${r.slug}: not a tool, a command or a listed word`).toEqual([])
      const used = new Set(backtickedIdentifiers(r.prompt))
      for (const op of terms.ops) {
        expect(STUDIO_ENGINE_OPS.has(op), `${r.slug}: ${op} is not an editing command`).toBe(true)
        expect(used.has(op), `${r.slug}: ${op} is no longer used`).toBe(true)
      }
      for (const word of terms.words) {
        expect(TOOL_NAMES.has(word) || STUDIO_ENGINE_OPS.has(word), `${r.slug}: ${word} is a tool or a command`).toBe(false)
        expect(used.has(word), `${r.slug}: ${word} is no longer used`).toBe(true)
      }
      expect(backtickedHyphenated(r.prompt).filter((s) => !STUDIO_SLUGS.has(s)), r.slug).toEqual([])
      // The chat-only tools it names are pinned (saving a look as a skill is the person's step, in their chat).
      const chatOnly = [...new Set(backtickedIdentifiers(r.prompt).filter((w) => ATTENDED_ONLY_TOOL_NAMES.has(w)))].sort()
      expect(chatOnly, r.slug).toEqual([...(CHAT_ONLY_NAMED[r.slug] ?? [])].sort())
    }
  })

  it('every Studio tool a text names is in the studio category, and every tool added since 621 is taught', () => {
    const studio = TOOL_CATEGORIES.find((c) => c.id === 'studio')!
    const names = new Set(studio.tools.map((t) => t.name))
    for (const t of NEW_TOOLS) expect(names.has(t), t).toBe(true)
    const named = new Set(rows.flatMap((r) => backtickedIdentifiers(r.prompt)))
    for (const t of named) if (t.includes('studio')) expect(names.has(t), t).toBe(true)
    for (const t of NEW_TOOLS) expect(named.has(t), `${t} is taught by no Studio skill`).toBe(true)
  })

  it('the playbook loads every Studio skill by name', () => {
    const core = by('studio-playbook').prompt
    for (const slug of STUDIO_SLUGS) if (slug !== 'studio-playbook') expect(core, slug).toContain(`\`${slug}\``)
  })

  it('no Studio text that ships says a built capability is not here yet', () => {
    const shipped = allShippedSkills().filter((s) => s.area === 'studio')
    expect(shipped.map((s) => s.slug).sort()).toEqual([...STUDIO_SLUGS].sort())
    for (const s of shipped) {
      for (const text of [s.prompt, s.description]) {
        for (const sentence of sentences(text).filter((x) => NOT_HERE.test(x))) expect(sentence, s.slug).not.toMatch(BUILT)
        expect(text, s.slug).not.toMatch(/\b(isn't|aren't) here yet\b/i)
      }
    }
    for (const r of rows) {
      expect(r.prompt.startsWith('Needs a capability'), r.slug).toBe(false)
      expect(r.description.startsWith('Not in this workspace yet'), r.slug).toBe(false)
    }
    // What is still missing is still said, so it is never promised.
    expect(by('studio-playbook').prompt).toMatch(
      /Not in this workspace yet: the product's real UI from its code, reading a brand from a site, custom code scenes, reference blueprints, importing media from a link\./,
    )
  })

  it('says "when available" wherever it teaches a tool that needs the Studio worker, and what to do when one refuses', () => {
    for (const r of rows) {
      const worker = backtickedIdentifiers(r.prompt).filter((w) => WORKER_TOOLS.has(w))
      if (worker.length) expect(r.prompt, `${r.slug} names ${worker.join(', ')}`).toMatch(WHEN_UNAVAILABLE)
    }
    const core = by('studio-playbook').prompt
    expect(core).toMatch(/On the Studio worker, when available:/)
    expect(core).toMatch(/say so plainly and carry on with what works\. Never promise, start or report what a tool refused\./)
  })

  it('measures before describing sound or motion, quotes the numbers, and fixes one thing at a time', () => {
    const core = by('studio-playbook').prompt
    expect(core).toMatch(/never describe motion or sound without a measured report \(`studio-measured-checks`, `studio-sound`\), and quote its numbers\. Fix one thing at a time/)
    const sound = by('studio-sound').prompt
    expect(sound).toMatch(/You cannot hear: never say how a video sounds without the report of `listen_to_studio_video`, and quote its numbers/)
    expect(sound).toMatch(/one thing at a time, then listen again/)
    const checks = by('studio-measured-checks').prompt
    expect(checks).toMatch(/never present a guess as a measurement/)
    expect(checks).toMatch(/Fix the worst finding first, one thing at a time/)
    expect(checks).toMatch(/Measure again/)
    expect(checks).toMatch(/Report with the numbers/)
    for (const kept of ['cuts through an empty frame', 'Its reading flag samples a few frames per scene', 'Numbers aren\'t the goal']) expect(checks, kept).toContain(kept)
    expect(by('studio-motion-design').prompt).toMatch(/one thing at a time/)
    expect(by('studio-narration').prompt).toMatch(/never say how it sounds yourself/)
  })

  it('a quote before any spend, the person’s approval card decides, and a spend is never retried', () => {
    const core = by('studio-playbook').prompt
    expect(core).toMatch(/Quote first \(`quote_studio_narration`, `quote_studio_shot`\)/)
    expect(core).toMatch(/waits for their approval card\. A decline is an answer: never retry a spend/)
    const gen = by('studio-generated-shots').prompt
    for (const kept of [
      'Propose before generating',
      'Quote first: `quote_studio_shot`',
      'held for the person\'s approval card',
      'A decline is an answer: never retry it',
      'A failed generation is told, not retried',
      'Cheap drafts, good models only for finals',
      'Model names and prices change: take them from the provider',
      'Code first',
      'A person needs consent true',
    ]) expect(gen, kept).toContain(kept)
    expect([...gen.matchAll(/^(\d)\. /gm)].map((m) => Number(m[1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    const narration = by('studio-narration').prompt
    expect(narration).toMatch(/`quote_studio_narration`[\s\S]*`generate_studio_narration`/)
    expect(narration).toMatch(/held for the person's approval card/)
    expect(narration).toMatch(/A decline is an answer: never call it again/)
    // No price list: model names and prices change.
    for (const r of rows) expect(r.prompt, r.slug).not.toMatch(/\d+(\.\d+)? credits/)
  })

  it('shows a director dry run before cutting, and cuts only on the person’s yes', () => {
    const director = by('studio-director-and-cut-outs').prompt
    expect(director).toMatch(/Dry run first, always: dry_run true/)
    expect(director).toMatch(/Show the person the plan/)
    expect(director).toMatch(/Only on their yes, the same call with dry_run false/)
    expect(director).toMatch(/keep a shot between 2\.2 s and 8 s; never two cuts within 1 s/)
    expect(by('studio-storyboard').prompt).toMatch(/Always a dry run first, shown to the person, then the cut on their yes/)
  })

  it('brand rules come from the kit, the person and the canon documents, never invented; ads fix the brief, never the rules', () => {
    expect(by('studio-playbook').prompt).toMatch(/Brand rules come from these and the person, never from you/)
    for (const slug of ['studio-static-ads', 'studio-motion-ads', 'studio-reels', 'studio-brand']) {
      expect(by(slug).prompt, slug).toContain('`read_canon`')
      expect(by(slug).prompt, slug).toMatch(/`get_studio_brand_kit`/)
    }
    expect(by('studio-static-ads').prompt).toMatch(/never from you\. Never invent a colour, a rule, a banned word or a claim/)
    expect(by('studio-static-ads').prompt).toMatch(/Never loosen a rule to pass the check/)
    expect(by('studio-motion-ads').prompt).toMatch(/never by loosening the rules/)
  })

  it('exports only when asked, publishes nothing, and keeps locks and the digest', () => {
    const core = by('studio-playbook').prompt
    expect(core).toMatch(/Export only when they ask/)
    expect(core).toMatch(/never say a video was posted, published or sent/)
    expect(core).toMatch(/applied in order as ONE undoable step, all or nothing/)
    expect(core).toMatch(/Pass `expected_digest` from your last read/)
    expect(core).toMatch(/Locked beats are the person's\. Every command on one is refused/)
    expect(core).toMatch(/You can't watch video: the stills are your eyes/)
    expect(core).toMatch(/Copy a reference's craft, never its logo, product, people or words/)
  })

  it('carries no local path, no shell step, and no provider name where plain words do', () => {
    for (const word of ['project.ts', '.cache', 'editor-data', 'kits/', 'style-packs/', 'node --import', 'checkout', '.tsx', '/Users/', '~/']) {
      expect(sql.includes(word), word).toBe(false)
    }
    for (const r of rows) expect(r.prompt + r.description, r.slug).not.toMatch(/\b(higgsfield|elevenlabs|earshot|seedance|kling)\b/i)
  })

  it('touches only Studio rows, by id, and no CHECK, function, policy or other table', () => {
    const ids = [...statements.matchAll(/'([0-9a-f-]{36})'::uuid/g)].map((m) => m[1])
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(STUDIO_IDS.has(id), id).toBe(true)
    expect([...statements.matchAll(/INSERT INTO public\.(\w+)/g)].map((m) => m[1])).toEqual(['recipe'])
    expect([...statements.matchAll(/UPDATE public\.(\w+)/g)].map((m) => m[1])).toEqual(['recipe'])
    expect(statements).toMatch(/WHERE r\.id = p\.id\s+AND r\.is_system\s+AND r\.area = 'studio'/)
    expect(statements).not.toMatch(/\b(CONSTRAINT|POLICY|FUNCTION|TRIGGER|ALTER|DROP|CREATE|GRANT|REVOKE|DELETE|TRUNCATE|VALIDATE)\b/i)
    expect(statements).not.toMatch(/\bCHECK\s*\(/i)
    expect(statements).not.toMatch(/INSERT INTO public\.flow/i)
  })

  it('is one transaction, idempotent (insert when missing, update only what differs), guarded over all 29, and has no backslash', () => {
    expect(sql.includes(String.fromCharCode(92))).toBe(false)
    expect(statements).toMatch(/^begin;$/m)
    expect(statements).toMatch(/^SET LOCAL lock_timeout = '5s';$/m)
    expect(statements).toMatch(/ON CONFLICT \(id\) DO NOTHING/)
    expect(statements).toMatch(/r\.system_prompt IS DISTINCT FROM p\.system_prompt/)
    expect(statements).toMatch(/^notify pgrst, 'reload schema';$/m)
    expect(statements.trim().endsWith('commit;')).toBe(true)
    const guard = statements.slice(statements.indexOf('DO $guard$'))
    expect(guard).toContain('<> 29 THEN')
    expect([...guard.matchAll(/'([0-9a-f-]{36})'::uuid/g)].map((m) => m[1]).sort()).toEqual([...STUDIO_IDS].sort())
    expect(guard.match(/RAISE EXCEPTION/g)?.length).toBe(1)
    expect(statements.indexOf('DO $guard$')).toBeGreaterThan(statements.lastIndexOf('UPDATE public.recipe'))
  })
})
