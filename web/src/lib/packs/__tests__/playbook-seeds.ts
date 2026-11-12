/**
 * Reads the system skills migrations 316 and 319 seed, straight from the SQL:
 * both write one VALUES list whose rows are
 *   (id, $name$…$name$, $slug$…$slug$, icon, color, $desc$…$desc$, $pb$…$pb$, $cfg$…$cfg$::jsonb, 'area').
 * The area may be NULL::text: a global system skill of no area (323's find-anything).
 * A later migration that rewrites one (322, 323, 324) writes the same row shape,
 * and its row replaces the earlier one by id. The drift, accuracy and size tests
 * all read the seeds through this, so they check the text that ships, not a
 * copy of it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SeededSkill {
  file: string
  id: string
  slug: string
  /** The area key, or null for a system skill of no area. */
  area: string | null
  description: string
  prompt: string
  /** agent_config as seeded. `pack_only`: listed only in its area's pack (323's and 324's recipes). */
  config: { enabled_tools?: string[]; preferred_tools?: string[]; pack_only?: boolean }
}

export const PLAYBOOK_MIGRATIONS = ['316_skill_area_and_playbooks.sql', '319_area_playbooks.sql'] as const

/** Later migrations that rewrite seeded skills by id, oldest first. */
export const SKILL_REWRITE_MIGRATIONS = [
  '322_prospecting_skill_not_a_persona.sql',
  '323_feature_skills_v2.sql',
  '324_workflows_skill.sql',
  '325_meetings_mail_skills.sql',
  '326_crm_outreach_skills.sql',
  '327_docs_goals_tools_skills.sql',
  // P8: the content and marketing areas' skills (new rows, their own areas).
  '384_content_area_skills.sql',
  '385_marketing_skills.sql',
  // The SEO area: ten skills in the marketing area (new rows).
  '598_seo_skills.sql',
] as const

/**
 * Later migrations that change only the text of seeded skills, oldest first,
 * after every row rewrite. Their rows are `('id'::uuid, $slug$…$slug$, $pb$…$pb$)`:
 * the text replaces the prompt of the row with that id and slug, and every
 * other column stays as the row rewrites left it.
 */
export const PROMPT_REWRITE_MIGRATIONS = [
  '338_skill_helper_lines.sql',
  '368_documents_playbook_part_edits.sql',
  '370_write_a_document_part_edits.sql',
  '391_playbooks_teach_recipes.sql',
  // C5 (cloud browser): the Browser core no longer says the desktop app.
  '425_browser_playbook_cloud.sql',
  // GEN-1166: the mail playbooks can tidy the inbox (update_email_thread, unsubscribe_thread).
  '444_mail_playbooks_tidy.sql',
  // Roadmap D1/D2: the outreach playbooks teach the launch (launch_sequence, launch_campaign).
  '461_outreach_launch_playbooks.sql',
  // Availability phase 1: the calendar playbook and find-a-time call find_times (and the working hours tools).
  '551_find_a_time_uses_availability.sql',
  // Availability phase 2: find_times takes teammates (`people`); an outside guest's calendar still can't be seen.
  '553_find_a_time_with_teammates.sql',
  // Availability phase 3a: an outside guest is offered the slots with offer_times (held, picked on a link).
  '580_offer_times_to_outside_guests.sql',
  // Availability phase 4a: the calendar playbook hands out a booking link when someone asks for the person's calendar.
  '582_booking_links_in_calendar_playbook.sql',
  // Availability phase 5: several outside guests at once are a poll (offer_times' `recipients`), and its three tools.
  '584_polls_in_find_a_time.sql',
] as const

/**
 * Later migrations that change only a seeded skill's `preferred_tools`, oldest
 * first, after every row and text rewrite. Their rows are
 * `('id'::uuid, $slug$…$slug$, $tools$[…]$tools$::jsonb)`: the list replaces
 * that one key of the row with that id and slug, and every other key stays.
 */
export const PREFERRED_TOOLS_REWRITE_MIGRATIONS = ['551_find_a_time_uses_availability.sql', '580_offer_times_to_outside_guests.sql'] as const

/** The helper line every core carried until 338, and the one 338 puts in its place, word for word in all sixteen. */
export const OLD_CORE_HELPER_LINE = 'Not yet: helpers come later, so do the work here.'
export const CORE_HELPER_LINE =
  "If you have `helpers` (main chat only), split work across them where this playbook or the skill you're running says to; without them (a loop, or any run without that tool), do the work here."

/** Each migration read and parsed once per test file: allShippedSkills replays every rewrite for every skill, many times a test. */
const fileCache = new Map<string, string>()
const seededCache = new Map<string, SeededSkill[]>()
const rewriteCache = new Map<string, PromptRewrite[]>()

export function readMigration(file: string): string {
  let sql = fileCache.get(file)
  if (sql === undefined) {
    sql = readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8')
    fileCache.set(file, sql)
  }
  return sql
}

const ROW_RE =
  /\(\s*'([0-9a-f-]{36})'::uuid,\s*\$name\$[\s\S]*?\$name\$,\s*\$slug\$([a-z-]+)\$slug\$,[\s\S]*?\$desc\$([\s\S]*?)\$desc\$,\s*\$pb\$([\s\S]*?)\$pb\$,\s*\$cfg\$([\s\S]*?)\$cfg\$::jsonb,\s*(?:'([a-z_]+)'|NULL::text)\s*\)/g

/** Every seeded skill row in one migration, in file order. */
export function seededSkills(file: string): SeededSkill[] {
  let rows = seededCache.get(file)
  if (!rows) {
    rows = [...readMigration(file).matchAll(ROW_RE)].map((m) => ({
      file,
      id: m[1],
      slug: m[2],
      description: m[3],
      prompt: m[4],
      config: JSON.parse(m[5]) as SeededSkill['config'],
      area: m[6] ?? null,
    }))
    seededCache.set(file, rows)
  }
  return rows.map((row) => ({ ...row, config: structuredClone(row.config) }))
}

export interface PromptRewrite {
  file: string
  id: string
  slug: string
  prompt: string
}

const PROMPT_ROW_RE = /\(\s*'([0-9a-f-]{36})'::uuid,\s*\$slug\$([a-z-]+)\$slug\$,\s*\$pb\$([\s\S]*?)\$pb\$\s*\)/g

/** Every text-only row in one migration, in file order. */
export function promptRewrites(file: string): PromptRewrite[] {
  let rows = rewriteCache.get(file)
  if (!rows) {
    rows = [...readMigration(file).matchAll(PROMPT_ROW_RE)].map((m) => ({ file, id: m[1], slug: m[2], prompt: m[3] }))
    rewriteCache.set(file, rows)
  }
  return rows.map((row) => ({ ...row }))
}

/**
 * The newest text-only rewrite after `file` that replaces the row with this
 * id and slug, or null. An earlier rewrite's test checks what ships against
 * that one when there is one.
 */
export function rewrittenAfter(file: (typeof PROMPT_REWRITE_MIGRATIONS)[number], id: string, slug: string): string | null {
  const later = PROMPT_REWRITE_MIGRATIONS.slice(PROMPT_REWRITE_MIGRATIONS.indexOf(file) + 1)
  return later.filter((f) => promptRewrites(f).some((r) => r.id === id && r.slug === slug)).at(-1) ?? null
}

export interface PreferredToolsRewrite {
  file: string
  id: string
  slug: string
  preferredTools: string[]
}

const TOOLS_ROW_RE = /\(\s*'([0-9a-f-]{36})'::uuid,\s*\$slug\$([a-z-]+)\$slug\$,\s*\$tools\$([\s\S]*?)\$tools\$::jsonb\s*\)/g

/** Every preferred-tools row in one migration, in file order. */
export function preferredToolsRewrites(file: string): PreferredToolsRewrite[] {
  return [...readMigration(file).matchAll(TOOLS_ROW_RE)].map((m) => ({
    file,
    id: m[1],
    slug: m[2],
    preferredTools: JSON.parse(m[3]) as string[],
  }))
}

/**
 * A skill with the latest text-only rewrite of its row applied, then the
 * latest preferred-tools rewrite (each by id, and only when the slug agrees).
 * `file` stays the file whose text ships.
 */
function withLatestPrompt(skill: SeededSkill): SeededSkill {
  let out = skill
  for (const file of PROMPT_REWRITE_MIGRATIONS) {
    const hit = promptRewrites(file).find((r) => r.id === out.id && r.slug === out.slug)
    if (hit) out = { ...out, file: hit.file, prompt: hit.prompt }
  }
  for (const file of PREFERRED_TOOLS_REWRITE_MIGRATIONS) {
    const hit = preferredToolsRewrites(file).find((r) => r.id === out.id && r.slug === out.slug)
    if (hit) out = { ...out, config: { ...out.config, preferred_tools: [...hit.preferredTools] } }
  }
  return out
}

/** The rows of both migrations, each as the latest rewrite left it (a later migration's row wins). */
export function allSeededSkills(): SeededSkill[] {
  const rewrites = new Map(SKILL_REWRITE_MIGRATIONS.flatMap(seededSkills).map((s) => [s.id, s]))
  return PLAYBOOK_MIGRATIONS.flatMap(seededSkills).map((s) => withLatestPrompt(rewrites.get(s.id) ?? s))
}

/**
 * Every area skill text that ships: allSeededSkills, plus the rows a rewrite
 * writes that 316 and 319 never seeded (322's `build-prospect-list`, the old
 * Scout row, 323's recipes and 324's `build-a-workflow`).
 */
export function allShippedSkills(): SeededSkill[] {
  const seeded = allSeededSkills()
  const ids = new Set(seeded.map((s) => s.id))
  const added = new Map(
    SKILL_REWRITE_MIGRATIONS.flatMap(seededSkills)
      .filter((s) => !ids.has(s.id))
      .map((s) => [s.id, withLatestPrompt(s)]),
  )
  return [...seeded, ...added.values()]
}
