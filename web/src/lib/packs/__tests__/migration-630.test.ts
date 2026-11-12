/**
 * Migration 630 (Studio): the Studio skills teach the capabilities built
 * since 629 (a reference's blueprint as a command, judging and making sounds,
 * reading every value before a relative edit, voice search and re-voicing,
 * designed effects and music beds, lip-synced talking shots, code scenes, the
 * product's real UI filmed from its code on the person's Mac) and stop saying
 * they are missing. Pinned: it rewrites twenty-one Studio rows whole, by their
 * ids and slugs (the newest text of each, from 621, 626 or 629), and adds one
 * fixed-id skill, all in the studio area; it touches only Studio rows and no
 * CHECK, function or policy; every backticked name is a real tool, a real
 * editing command, a Studio skill or a word that text lists on purpose
 * (studio-skill-terms), and every such word that is a tool's argument is an
 * argument some Studio tool really takes; every tool built since 629 is
 * taught, and every Studio tool is taught somewhere; what is still not
 * available is said plainly, and no shipped Studio text says a built
 * capability is missing; the money rules stay exact for every paid tool; the
 * writing rules (no semicolons or dashes, no provider names, no local
 * pointers); sizes; idempotence, the guard over all 33, and no backslash.
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))

import { ATTENDED_ONLY_TOOL_NAMES, TOOL_CATEGORIES } from '@/lib/ai/tool-registry'
import { CORE_TOOL_NAMES } from '@/lib/ai/tool-ceiling-core'
import { createStudioTools } from '@/lib/ai/tools/studio'
import { createStudioAdsTools } from '@/lib/ai/tools/studio-ads'
import { createStudioAudioTools } from '@/lib/ai/tools/studio-audio'
import { createStudioBlueprintTools } from '@/lib/ai/tools/studio-blueprint'
import { createStudioCheckTools } from '@/lib/ai/tools/studio-checks'
import { createStudioLibraryTools } from '@/lib/ai/tools/studio-library'
import { createStudioMediaTools } from '@/lib/ai/tools/studio-media'
import { createStudioProductTools } from '@/lib/ai/tools/studio-product'
import { createStudioSceneTools } from '@/lib/ai/tools/studio-scenes'
import { createStudioSoundTools } from '@/lib/ai/tools/studio-sound'
import { createStudioVisionTools } from '@/lib/ai/tools/studio-vision'
import { FEATURES } from '@/lib/editions/manifest'
import { estimateTokens } from '../memory'
import { CORE_HELPER_LINE, allShippedSkills, readMigration, seededSkills } from './playbook-seeds'
import { STUDIO_ENGINE_OPS, STUDIO_TERMS_630 } from './studio-skill-terms'

const FILE = '630_studio_skills_capabilities.sql'
const sql = readMigration(FILE)
const rows = seededSkills(FILE)
/** Every Studio row before this file, each as the newest earlier file wrote it (621's 24, 626's five, 629's three). */
const before = new Map(
  ['621_studio_skills.sql', '626_studio_skills_refresh.sql', '629_studio_skills_parity.sql'].flatMap((f) => seededSkills(f)).map((r) => [r.id, r]),
)
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

/** The Studio rows this file rewrites whole, by id, in the guard's order. */
const REWRITTEN = [
  { id: '954c76ec-ab39-4066-af50-7bdfb4a15a82', slug: 'studio-playbook' },
  { id: '586ac29a-3ea9-44ed-a21c-03f1d5850570', slug: 'studio-editing-layers' },
  { id: '748fabfb-99c8-40f6-a43c-6bf74921fb75', slug: 'studio-motion-design' },
  { id: 'f4b1b4cc-ab0b-4e91-b49b-d3111e0b02ff', slug: 'studio-motion-recipes' },
  { id: 'dc4e61f5-a966-4120-9a63-e770725696c5', slug: 'studio-storyboard' },
  { id: '470a6a9c-ef31-4d9f-a43c-b64d30717e8e', slug: 'studio-style-packs' },
  { id: '4390a45d-766e-4487-af0a-808223245a91', slug: 'studio-style-pack-orbital' },
  { id: '9499a35b-bacb-462d-aad9-7168668fa405', slug: 'studio-style-pack-warm-loft' },
  { id: '73c5576d-701d-49d4-bdd8-4fb40df9a7c4', slug: 'studio-reference-to-style-pack' },
  { id: '399c0258-a53f-4ac5-b4b4-97ebbcaa5e4c', slug: 'studio-review' },
  { id: 'd7dd9d4f-f7af-4722-9e8c-e7daf930d159', slug: 'studio-match-a-reference' },
  { id: 'ecb5d367-acbe-4fcf-a863-30b3332eb2ca', slug: 'studio-generated-shots' },
  { id: 'cd6753b1-db8f-42cb-aab1-21620b411f24', slug: 'studio-sound' },
  { id: 'b310d743-be33-49dd-85ef-1655cd5b7f14', slug: 'studio-scene-design' },
  { id: '6ed3b2eb-8d15-46b7-9717-23f36d698f85', slug: 'studio-product-ui' },
  { id: 'f78898eb-1f33-4cc2-974a-6f7986e5070e', slug: 'studio-product-onboarding' },
  { id: '651c4102-eaef-4a56-ae51-bbb4afb995d3', slug: 'studio-style-pack-editorial-archival' },
  { id: '8cf5a3ee-ab8b-4dcb-ac70-5ca6e9da1ad8', slug: 'studio-style-pack-paper-collage' },
  { id: 'd1c1868a-529c-420c-9e65-86ce43b64050', slug: 'studio-narration' },
  { id: '87d5379b-f8f5-4ed6-85fe-4a3c355ca1d4', slug: 'studio-reference-blueprint' },
  { id: '49c3dda3-ff71-4aba-ab70-d14790a2c48f', slug: 'studio-story-film' },
]
/** The skill this file adds. */
const ADDED = [{ id: '7341b7e4-c5a7-45df-b18c-29c3136c599b', slug: 'studio-sound-making' }]
const ROWS = [...REWRITTEN, ...ADDED]
/** Every Studio system skill once 621, 626, 629 and this file are applied: 32 and this one. */
const ALL_STUDIO = [...[...before.values()].map((r) => ({ id: r.id, slug: r.slug })), ...ADDED]
const STUDIO_SLUGS: ReadonlySet<string> = new Set(ALL_STUDIO.map((r) => r.slug))
const STUDIO_IDS: ReadonlySet<string> = new Set(ALL_STUDIO.map((r) => r.id))

/** The tools built since 629: each is taught somewhere. */
const NEW_TOOLS = [
  'get_studio_blueprint', 'storyboard_from_studio_blueprint',
  'judge_studio_sound', 'make_studio_sound',
  'search_studio_voices', 'quote_studio_revoice', 'generate_studio_revoice', 'quote_studio_sound_effect', 'generate_studio_sound_effect',
  'quote_studio_music', 'generate_studio_music',
  'write_studio_scene', 'get_studio_scene', 'list_studio_scenes', 'add_studio_scene',
  'list_studio_products', 'onboard_studio_product', 'capture_studio_component', 'refresh_studio_components', 'place_studio_component',
] as const
/**
 * Studio tools no skill needs to teach: get_studio_job reads a job without
 * waiting, and every skill teaches wait_for_studio_job, which reads the same
 * job and waits for it.
 */
const NEED_NOT_TEACH: ReadonlySet<string> = new Set(['get_studio_job'])
/** The tools that run only where the Studio worker has the capability: a text naming one says what to do when it refuses. */
const WORKER_TOOLS: ReadonlySet<string> = new Set([
  'make_studio_static_ads', 'make_studio_motion_ad', 'make_studio_reel', 'generate_studio_narration', 'list_studio_voices', 'quote_studio_shot',
  'generate_studio_shot', 'sound_pass_studio_video', 'add_studio_sounds', 'import_studio_sound', 'listen_to_studio_video', 'check_studio_motion',
  'review_studio_video', 'look_at_studio_video', 'cut_out_studio_subject', 'transcribe_studio_asset', 'check_studio_continuity',
  'get_studio_blueprint', 'judge_studio_sound', 'make_studio_sound', 'search_studio_voices', 'quote_studio_revoice', 'generate_studio_revoice',
  'quote_studio_sound_effect', 'generate_studio_sound_effect', 'quote_studio_music', 'generate_studio_music',
])
const WHEN_UNAVAILABLE = /when available|NOT_AVAILABLE|when one isn't available|isn't available right now/i

/** The registry's tools, plus the core ones the chat always has. */
const TOOL_NAMES: ReadonlySet<string> = new Set([...TOOL_CATEGORIES.flatMap((c) => c.tools.map((t) => t.name)), ...CORE_TOOL_NAMES])
const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['helpers', 'update_plan'])

/** The chat-only tools each text names (playbook-accuracy pins the same). */
const CHAT_ONLY_NAMED: Record<string, readonly string[]> = { 'studio-reference-to-style-pack': ['create_skill'] }

/** Every argument name any Studio tool takes, at any depth, read from the tools' own schemas. */
function studioArgumentNames(): Set<string> {
  const tools = {
    ...createStudioTools('u', 'w'), ...createStudioAdsTools('u', 'w'), ...createStudioAudioTools('u', 'w'), ...createStudioBlueprintTools('u', 'w'),
    ...createStudioCheckTools('u', 'w'), ...createStudioLibraryTools('u', 'w'), ...createStudioMediaTools('u', 'w'), ...createStudioProductTools('u', 'w'),
    ...createStudioSceneTools('u', 'w'), ...createStudioSoundTools('u', 'w'), ...createStudioVisionTools('u', 'w'),
  } as Record<string, { inputSchema: z.ZodType }>
  const names = new Set<string>()
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (n.properties && typeof n.properties === 'object') {
      for (const [key, value] of Object.entries(n.properties as Record<string, unknown>)) {
        names.add(key)
        walk(value)
      }
    }
    for (const key of ['items', 'additionalProperties']) walk(n[key])
    for (const key of ['anyOf', 'allOf', 'oneOf']) for (const v of (n[key] as unknown[] | undefined) ?? []) walk(v)
  }
  for (const t of Object.values(tools)) walk(z.toJSONSchema(t.inputSchema, { unrepresentable: 'any' }))
  return names
}
/**
 * The listed words that are not a Studio tool's argument, each on purpose:
 * get_studio_catalog's answer fields, the person-facing `show` card's
 * argument, and a model parameter written into a beat's generation plan.
 */
const NOT_ARGUMENTS: ReadonlySet<string> = new Set(['defaults', 'text_looks', 'target', 'generate_audio'])

const NOT_HERE = /(isn't|aren't|is not|are not) available here|not in this workspace|\bnot yet\b/i
/** What was built since 629: no "not available" sentence in a shipped Studio text may name it. */
const BUILT =
  /\b(code scenes?|custom scenes?|scene templates?|templates?|components?|real UI|blueprints?|voice search|re-?voic\w*|designed|music|forging|judg\w*|recording from the web app)\b/i

function backtickedIdentifiers(text: string): string[] {
  return [...text.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1])
}
function backtickedHyphenated(text: string): string[] {
  return [...text.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g)].map((m) => m[1])
}
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n/).filter((s) => s.trim())
}
/** A text without the core's fixed helper line, which every playbook carries word for word. */
function ownWords(text: string): string {
  return text.replace(CORE_HELPER_LINE, '')
}

describe('migration 630', () => {
  it('rewrites twenty-one Studio rows by their own ids and slugs, and adds one fresh fixed-id skill, all in the studio area', () => {
    expect(rows.map((r) => ({ id: r.id, slug: r.slug }))).toEqual(ROWS)
    for (const r of rows) expect(r.area, r.slug).toBe('studio')
    for (const r of REWRITTEN) expect(before.get(r.id)?.slug, r.slug).toBe(r.slug)
    const earlier = allShippedSkills().filter((s) => s.file < FILE)
    for (const r of ADDED) {
      expect(r.slug.startsWith('studio-'), r.slug).toBe(true)
      expect(earlier.some((s) => s.id === r.id || s.slug === r.slug), r.slug).toBe(false)
    }
    // A written row's id: once in its row, once in the guard. The other Studio rows: only in the guard.
    for (const r of ROWS) expect(sql.split(r.id).length - 1, r.slug).toBe(2)
    for (const r of [...before.values()].filter((b) => !ROWS.some((w) => w.id === b.id))) expect(sql.split(r.id).length - 1, r.slug).toBe(1)
    expect(new Set(ROWS.map((r) => r.id)).size).toBe(ROWS.length)
    expect(before.size).toBe(32)
    expect(new Set(ALL_STUDIO.map((r) => r.slug)).size).toBe(33)
  })

  it('keeps each rewritten row’s name, icon and colour, and ships 630’s texts; every Studio skill id is in the Studio feature', () => {
    const fields = (text: string, id: string) => {
      const at = text.indexOf(`'${id}'::uuid`)
      const row = text.slice(at, text.indexOf('$cfg$::jsonb', at))
      return [/\$name\$([\s\S]*?)\$name\$/, /\$icon\$([\s\S]*?)\$icon\$/, /\$color\$([\s\S]*?)\$color\$/].map((re) => re.exec(row)?.[1])
    }
    for (const r of REWRITTEN) expect(fields(sql, r.id), r.slug).toEqual(fields(readMigration(before.get(r.id)!.file), r.id))
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
    expect(Object.keys(STUDIO_TERMS_630).sort()).toEqual(ROWS.map((r) => r.slug).sort())
    for (const r of rows) {
      const terms = STUDIO_TERMS_630[r.slug]
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
      const chatOnly = [...new Set(backtickedIdentifiers(r.prompt).filter((w) => ATTENDED_ONLY_TOOL_NAMES.has(w)))].sort()
      expect(chatOnly, r.slug).toEqual([...(CHAT_ONLY_NAMED[r.slug] ?? [])].sort())
    }
  })

  it('every argument a text names is one a Studio tool really takes', () => {
    const args = studioArgumentNames()
    expect(args.has('voice_id')).toBe(true)
    expect(args.has('ids')).toBe(true)
    for (const r of rows) {
      for (const word of STUDIO_TERMS_630[r.slug].words) {
        if (NOT_ARGUMENTS.has(word)) continue
        expect(args.has(word), `${r.slug}: \`${word}\` is no Studio tool's argument`).toBe(true)
      }
    }
    for (const word of NOT_ARGUMENTS) expect(args.has(word), `${word} is an argument now: take it out of NOT_ARGUMENTS`).toBe(false)
  })

  it('every Studio tool a text names is in the studio category, every tool built since 629 is taught, and every Studio tool is taught somewhere', () => {
    const studio = TOOL_CATEGORIES.find((c) => c.id === 'studio')!
    const names = new Set(studio.tools.map((t) => t.name))
    for (const t of NEW_TOOLS) expect(names.has(t), t).toBe(true)
    const named = new Set(rows.flatMap((r) => backtickedIdentifiers(r.prompt)))
    for (const t of named) if (t.includes('studio')) expect(names.has(t), t).toBe(true)
    for (const t of NEW_TOOLS) expect(named.has(t), `${t} is taught by no Studio skill`).toBe(true)
    // The Mac job starts in the main chat.
    expect(named.has('start_local_agent')).toBe(true)
    expect(named.has('local_agents')).toBe(true)
    const shippedNamed = new Set(allShippedSkills().filter((s) => s.area === 'studio').flatMap((s) => backtickedIdentifiers(s.prompt)))
    for (const t of names) if (!NEED_NOT_TEACH.has(t)) expect(shippedNamed.has(t), `${t} is taught by no shipped Studio skill`).toBe(true)
    for (const t of NEED_NOT_TEACH) expect(names.has(t), `${t} is no Studio tool now: take it out of NEED_NOT_TEACH`).toBe(true)
  })

  it('the playbook loads every Studio skill by name', () => {
    const core = by('studio-playbook').prompt
    for (const slug of STUDIO_SLUGS) if (slug !== 'studio-playbook') expect(core, slug).toContain(`\`${slug}\``)
  })

  it('says plainly what is still not available, and no shipped Studio text says a built capability is missing', () => {
    const core = by('studio-playbook').prompt
    expect(core).toMatch(
      /Not available here: a ready-made library of scenes, video inside a code scene, batch generation under one approval, sample data from a component's types\. The skills say what to do instead\./,
    )
    expect(core).not.toMatch(/recording from the web app/)
    expect(by('studio-scene-design').prompt).toMatch(/There is no ready-made library of scenes: you write each one\./)
    expect(by('studio-scene-design').prompt).toMatch(/Video does not play inside a scene: put the clip on its own layer\./)
    expect(by('studio-product-ui').prompt).toMatch(/Nothing makes sample data from a component's types: pass the props yourself\./)
    expect(by('studio-generated-shots').prompt).toMatch(/Each shot has its own card: there is no batch under one approval/)
    const shipped = allShippedSkills().filter((s) => s.area === 'studio')
    expect(shipped.map((s) => s.slug).sort()).toEqual([...STUDIO_SLUGS].sort())
    for (const s of shipped) {
      for (const text of [s.prompt, s.description]) {
        for (const sentence of sentences(text).filter((x) => NOT_HERE.test(x))) expect(sentence, s.slug).not.toMatch(BUILT)
        expect(text, s.slug).not.toMatch(/\bnot yet\b|in this workspace yet|Instead of code/i)
      }
    }
  })

  it('says "when available" wherever it teaches a tool that needs the Studio worker, and what to do when the Mac is away', () => {
    for (const r of rows) {
      const worker = backtickedIdentifiers(r.prompt).filter((w) => WORKER_TOOLS.has(w))
      if (worker.length) expect(r.prompt, `${r.slug} names ${worker.join(', ')}`).toMatch(WHEN_UNAVAILABLE)
    }
    const core = by('studio-playbook').prompt
    expect(core).toMatch(/On the Studio worker, when available:/)
    expect(core).toMatch(/say so plainly and carry on with what works\. Never promise, start or report what a tool refused\./)
    expect(by('studio-product-ui').prompt).toMatch(/If the Mac is not connected, the tool says what to open: tell the person, and meanwhile use their screenshots or recordings/)
    expect(by('studio-product-onboarding').prompt).toMatch(/If the Mac is not connected/)
  })

  it('keeps the loop, the measuring and every money rule, for every paid tool', () => {
    const core = by('studio-playbook').prompt
    expect(core).toMatch(/applied in order as ONE undoable step, all or nothing/)
    expect(core).toMatch(/Pass `expected_digest` from your last read/)
    expect(core).toMatch(/Locked beats are the person's\. Every command on one is refused/)
    expect(core).toMatch(/You can't watch video: the stills are your eyes/)
    expect(core).toMatch(/never describe motion or sound without a measured report \(`studio-measured-checks`, `studio-sound`\), and quote its numbers\. Fix one thing at a time/)
    expect(core).toMatch(/Copy a reference's craft, never its logo, product, people or words/)
    expect(core).toMatch(/Brand rules come from these and the person, never from you/)
    expect(core).toMatch(/Quote first \(`quote_studio_narration`, `quote_studio_shot`, `quote_studio_revoice`, `quote_studio_sound_effect`, `quote_studio_music`\) and show them/)
    expect(core).toMatch(/waits for their approval card, one per spend\. A decline is an answer: never retry a spend or find another way round it\. One that ends not delivered may have been charged: the person checks the costs\./)
    expect(core).toMatch(/Export only when they ask/)
    expect(core).toMatch(/never say a video was posted, published or sent/)
    // Reading before a relative edit.
    expect(core).toMatch(/Before a relative change \("bigger", "louder"\), read the thing with `ids`: every property, defaults included\./)
    expect(core).toMatch(/`defaults` and `text_looks`/)
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
      '`check_studio_continuity` (when available)',
      '`assign_studio_costs`',
    ]) expect(gen, kept).toContain(kept)
    expect([...gen.matchAll(/^(\d)\. /gm)].map((m) => Number(m[1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    const narration = by('studio-narration').prompt
    expect(narration).toMatch(/`quote_studio_narration`[\s\S]*`generate_studio_narration`/)
    expect(narration).toMatch(/held for the person's approval card/)
    expect(narration).toMatch(/A decline is an answer: never call it again/)
    expect(narration).toMatch(/One that ends not delivered may have been charged: the person checks the costs before asking again\. Never retry a spend\./)
    expect(narration).toMatch(/`quote_studio_revoice`, then `generate_studio_revoice` with `speaker` generated[\s\S]*the same money rules, one card/)
    expect(narration).toMatch(/only with that person's say-so/)
    const making = by('studio-sound-making').prompt
    expect(making).toMatch(/`quote_studio_sound_effect`[\s\S]*`generate_studio_sound_effect`[\s\S]*on one approval card/)
    expect(making).toMatch(/`quote_studio_music`, then `generate_studio_music` on one card/)
    expect(making).toMatch(/Money rules: quote first and show the person, one card per spend\. A decline is an answer: never ask again or find another way round it\. Never retry a spend\. One that ends not delivered may have been charged: the person checks the costs/)
    const story = by('studio-story-film').prompt
    expect(story).toMatch(/get a yes before anything is quoted/)
    expect(story).toMatch(/there is no batch under one approval/)
    // No price list: model names and prices change.
    for (const r of rows) expect(r.prompt, r.slug).not.toMatch(/\d+(\.\d+)? credits/)
  })

  it('teaches each new capability where it belongs, with the rules that keep it safe', () => {
    const blueprint = by('studio-reference-blueprint').prompt
    expect(blueprint).toMatch(/`get_studio_blueprint`[\s\S]*`wait_for_studio_job`, then call `get_studio_blueprint` again/)
    expect(blueprint).toMatch(/`storyboard_from_studio_blueprint` with the `video_id`, the reference's `asset_id`, `seconds`[\s\S]*`lines`/)
    expect(blueprint).toMatch(/comes fenced as data/)
    expect(blueprint).toMatch(/never the reference's words, brand or footage/)
    expect(blueprint).toMatch(/fontSize about its text height \(a share of the frame height\) times the output height times 0\.85, maxWords about its words on screen held between 2 and 8, reveal word/)
    expect(by('studio-storyboard').prompt).toMatch(/`storyboard_from_studio_blueprint`/)
    expect(by('studio-match-a-reference').prompt).toMatch(/`get_studio_blueprint`[\s\S]*`storyboard_from_studio_blueprint`/)
    const making = by('studio-sound-making').prompt
    expect(making).toMatch(/You cannot hear\. Never describe a sound, call one good or choose one without a measurement from `judge_studio_sound`, and quote its numbers/)
    expect(making).toMatch(/z 3 or more is strong, under 2 is no match/)
    expect(making).toMatch(/`make_studio_sound`[\s\S]*one to four candidates/)
    expect(making).toMatch(/30 s at most/)
    expect(making).toMatch(/The critic's own score is not proof/)
    expect(by('studio-sound').prompt).toMatch(/You cannot hear: never say how a video sounds without the report of `listen_to_studio_video`/)
    expect(by('studio-sound').prompt).toMatch(/`judge_studio_sound`/)
    const narration = by('studio-narration').prompt
    expect(narration).toMatch(/`search_studio_voices`/)
    expect(narration).toMatch(/only its id is kept, the account is unchanged/)
    expect(narration).toMatch(/Pasting a voice on afterwards does not lip-sync/)
    expect(narration).toMatch(/`generate_audio` true and the exact line in quotes in the prompt/)
    expect(narration).toMatch(/The re-voiced audio is placed nowhere/)
    const scene = by('studio-scene-design').prompt
    expect(scene).toMatch(/`write_studio_scene`[\s\S]*`add_studio_scene`[\s\S]*`render_studio_stills`/)
    expect(scene).toMatch(/A compile error comes back with its line and column/)
    expect(scene).toMatch(/no Math\.random or Date\.now/)
    expect(scene).toMatch(/Use its colours, never ones you pick/)
    for (const slug of ['studio-motion-design', 'studio-style-packs', 'studio-style-pack-orbital', 'studio-style-pack-warm-loft', 'studio-style-pack-paper-collage', 'studio-style-pack-editorial-archival', 'studio-editing-layers', 'studio-reference-to-style-pack']) {
      expect(by(slug).prompt, slug).toContain('`studio-scene-design`')
    }
    const ui = by('studio-product-ui').prompt
    expect(ui).toMatch(/Never redraw it with layers and never generate UI/)
    expect(ui).toMatch(/`capture_studio_component`/)
    expect(ui).toMatch(/start the job in the main chat with `start_local_agent`, passing exactly what the answer gave\. It runs on the person's Mac, read-only/)
    expect(ui).toMatch(/never a real customer's data/)
    expect(ui).toMatch(/needs the person's explicit consent first/)
    const onboard = by('studio-product-onboarding').prompt
    expect(onboard).toMatch(/`onboard_studio_product` with its `folder_id`/)
    expect(onboard).toMatch(/Nothing is ever written to the product/)
    expect(onboard).toMatch(/Their corrections always win/)
    expect(onboard).toMatch(/Never use customer data without the person's consent/)
  })

  it('follows the writing rules: plain sentences, made-up examples, no provider names, no local pointers', () => {
    for (const r of rows) {
      for (const text of [ownWords(r.prompt), r.description]) {
        expect(text, r.slug).not.toContain(';')
        expect(text, r.slug).not.toMatch(/[–—−]/)
        for (const line of text.split('\n')) expect(line, r.slug).not.toMatch(/\S - /)
        expect(text, r.slug).not.toMatch(/\b(higgsfield|elevenlabs|earshot|seedance|kling|remotion|remocn|freesound|mixkit|pixabay)\b/i)
        expect(text, r.slug).not.toMatch(/assistant panel|chat panel|command line|\bCLI\b|terminal|from disk/i)
      }
    }
    for (const word of ['project.ts', '.cache', 'editor-data', 'kits/', 'style-packs/', 'node --import', 'checkout', '.tsx', '/Users/', '~/', 'scripts/']) {
      expect(sql.includes(word), word).toBe(false)
    }
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

  it('is one transaction, idempotent (insert when missing, update only what differs), guarded over all 33, and has no backslash', () => {
    expect(sql.includes(String.fromCharCode(92))).toBe(false)
    expect(statements).toMatch(/^begin;$/m)
    expect(statements).toMatch(/^SET LOCAL lock_timeout = '5s';$/m)
    expect(statements).toMatch(/ON CONFLICT \(id\) DO NOTHING/)
    expect(statements).toMatch(/r\.system_prompt IS DISTINCT FROM p\.system_prompt/)
    expect(statements).toMatch(/^notify pgrst, 'reload schema';$/m)
    expect(statements.trim().endsWith('commit;')).toBe(true)
    const guard = statements.slice(statements.indexOf('DO $guard$'))
    expect(guard).toContain('<> 33 THEN')
    expect([...guard.matchAll(/'([0-9a-f-]{36})'::uuid/g)].map((m) => m[1]).sort()).toEqual([...STUDIO_IDS].sort())
    expect(guard.match(/RAISE EXCEPTION/g)?.length).toBe(1)
    expect(statements.indexOf('DO $guard$')).toBeGreaterThan(statements.lastIndexOf('UPDATE public.recipe'))
    // No dollar-quote tag inside a text.
    for (const r of rows) expect(r.prompt + r.description, r.slug).not.toMatch(/\$(pb|desc|name|slug|icon|color|cfg|guard)\$/)
  })
})
