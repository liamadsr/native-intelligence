/**
 * Migration 641: the flows playbook, build-a-workflow and seo-report learn the
 * loop triggers and schedules 640 added (mail, team chat and new documents;
 * monthly, cron and once). Pinned: three text-only rows by id and slug, what
 * ships; each rewrites its NEWEST restatement (the flows core is 338's text
 * with 357, 361 and 400's sentence edits applied, build-a-workflow 324's with
 * 400's, seo-report 598's), and every line but the rewritten and added ones is
 * that text byte for byte, in order; the fields, cadences, tokens and tools it
 * names are the tools' own; no line still says these are impossible; the
 * "first Monday" caveat matches cron's either-day rule; the sizes; a loud
 * guard; no backslash; an idempotent update.
 */
import { describe, it, expect } from 'vitest'
import { ALL_TOOL_NAMES } from '@/lib/ai/tool-registry'
import { registryToolInputSchemas } from '@/lib/ai/tool-schemas'
import { CRON_MIN_INTERVAL_MINUTES, parseCron } from '@/lib/flows/cron'
import { EVENT_FIRE_CAP_PER_DAY } from '@/lib/flows/event-triggers'
import { TEMPLATE_TOKENS } from '@/lib/flows/template'
import { OWNER_EVENT_TRIGGER_TYPES } from '@/lib/flows/types'
import { FLOW_TOOL_TRIGGER_TYPES } from '@/lib/ai/tools/flows'
import { estimateTokens } from '../memory'
import { allShippedSkills, PREFERRED_TOOLS_REWRITE_MIGRATIONS, PROMPT_REWRITE_MIGRATIONS, promptRewrites, readMigration, seededSkills } from './playbook-seeds'

const FILE = '641_flow_triggers_playbooks.sql'
const sql = readMigration(FILE)
const rows = promptRewrites(FILE)

const FLOWS = { id: '1ef0c12f-5d78-41ef-ab12-714512fa03cd', slug: 'flows-playbook' } as const
const RECIPE = { id: 'a1c4ac7d-4b00-4af4-a97e-1c79abaed9b3', slug: 'build-a-workflow' } as const
const SEO = { id: '0b2fb881-429c-485d-9119-1a6ad914680c', slug: 'seo-report' } as const
const text = (id: string) => rows.find((r) => r.id === id)?.prompt ?? ''

/** The SQL string literals in a chunk, unquoted ('' → '). */
const literals = (chunk: string) => [...chunk.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"))
const uncommented = (s: string) =>
  s
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
const applyPairs = (t: string, pairs: ReadonlyArray<readonly [string, string]>) => pairs.reduce((acc, [from, to]) => acc.split(from).join(to), t)
const pairsOf = (lits: string[]): Array<[string, string]> => {
  const out: Array<[string, string]> = []
  for (let i = 0; i < lits.length; i += 2) out.push([lits[i], lits[i + 1]])
  return out
}

/** 357's flows-playbook replace pairs (its second UPDATE), 361's, and 400's ($o$ / $n$). */
function editsAfter338(): { s357: Array<[string, string]>; s361: Array<[string, string]>; s400: Array<[string, string]> } {
  const m357 = uncommented(readMigration('357_agent_not_bot.sql'))
  const at = m357.indexOf("AND slug = 'flows-playbook'")
  const head = m357.lastIndexOf('UPDATE public.recipe', at)
  const stmt = m357.slice(head, at)
  const s357 = pairsOf(literals(stmt.slice(stmt.indexOf('SET system_prompt ='), stmt.indexOf('updated_at = now()'))))
  const m361 = uncommented(readMigration('361_flows_playbook_wording.sql'))
  const s361 = pairsOf(literals(m361.slice(m361.indexOf('SET system_prompt ='), m361.indexOf('updated_at = now()'))))
  const s400 = [...readMigration('400_flows_asked_for_loops_on.sql').matchAll(/\$o\$([^$]*)\$o\$,\s*\$n\$([^$]*)\$n\$/g)].map((m) => [m[1], m[2]] as [string, string])
  return { s357, s361, s400 }
}

/** Each row's newest restatement before this file, as the database holds it. */
const EDITS = editsAfter338()
const BEFORE: Record<string, string> = {
  [FLOWS.id]: applyPairs(applyPairs(applyPairs(promptRewrites('338_skill_helper_lines.sql').find((r) => r.id === FLOWS.id)!.prompt, EDITS.s357), EDITS.s361), EDITS.s400),
  [RECIPE.id]: applyPairs(seededSkills('324_workflows_skill.sql').find((r) => r.id === RECIPE.id)!.prompt, EDITS.s400),
  [SEO.id]: seededSkills('598_seo_skills.sql').find((r) => r.id === SEO.id)!.prompt,
}

/** Per row: the earlier lines it rewrites, and the lines it adds, each by how it starts. */
const REWRITTEN: Record<string, readonly string[]> = {
  [FLOWS.id]: [
    '  - schedule:',
    '- A schedule skips its fires',
    '- A condition reads only the status change',
    "- Don't promise what the tools refuse",
  ],
  [RECIPE.id]: ['   - On a clock:'],
  [SEO.id]: ['- The cadences are hourly'],
}
const ADDED: Record<string, readonly string[]> = {
  [FLOWS.id]: ['  - email_received:', '  - chat_message:', '  - document_created:', '- Map a schedule said in words:', '- Mail, chat and document loops pass ids'],
  [RECIPE.id]: ['   - New mail: email_received', '   - Mail, chat and document loops pass only ids'],
  [SEO.id]: [],
}

describe('migration 641', () => {
  it('rewrites the flows playbook, build-a-workflow and seo-report, by id and slug, registered after 584', () => {
    expect(rows.map((r) => [r.id, r.slug])).toEqual([
      [FLOWS.id, FLOWS.slug],
      [RECIPE.id, RECIPE.slug],
      [SEO.id, SEO.slug],
    ])
    expect(PROMPT_REWRITE_MIGRATIONS).toContain(FILE)
    expect(PROMPT_REWRITE_MIGRATIONS.indexOf(FILE)).toBeGreaterThan(PROMPT_REWRITE_MIGRATIONS.indexOf('584_polls_in_find_a_time.sql'))
    // Text only: the preferred tools stay as the rows' own migrations left them.
    expect(PREFERRED_TOOLS_REWRITE_MIGRATIONS).not.toContain(FILE as never)
  })

  it('is the text that ships, and nothing earlier rewrites these rows by id', () => {
    for (const { id } of [FLOWS, RECIPE, SEO]) {
      const shipped = allShippedSkills().find((s) => s.id === id)!
      expect(shipped.file, id).toBe(FILE)
      expect(shipped.prompt, id).toBe(text(id))
    }
    const earlier = PROMPT_REWRITE_MIGRATIONS.slice(0, PROMPT_REWRITE_MIGRATIONS.indexOf(FILE))
    const writers = (id: string) => earlier.filter((f) => promptRewrites(f).some((r) => r.id === id))
    expect(writers(FLOWS.id)).toEqual(['338_skill_helper_lines.sql'])
    expect(writers(RECIPE.id)).toEqual([])
    expect(writers(SEO.id)).toEqual([])
  })

  it("starts from each row's newest restatement: 357, 361 and 400's edits all landed in the text it rewrites", () => {
    expect(EDITS.s357.length).toBeGreaterThan(0)
    expect(EDITS.s361.length).toBeGreaterThan(0)
    expect(EDITS.s400).toHaveLength(6)
    const flows = BEFORE[FLOWS.id]
    expect(flows).toContain('Every loop has an agent, the teammate who tells the person about its runs: `bot_character` picks one by its character id')
    expect(flows).toContain('on/off state and agent (bearer tokens')
    expect(flows).toContain('A loop the person asks for (or says yes to when you offer it) is created on')
    expect(BEFORE[RECIPE.id]).toContain('The person asked for it, so it is on as soon as it is built.')
    // And the new text keeps them.
    expect(text(FLOWS.id)).toContain('`bot_character` picks one by its character id')
    expect(text(FLOWS.id)).toContain('A loop the person asks for (or says yes to when you offer it) is created on')
    expect(text(RECIPE.id)).toContain('The person asked for it, so it is on as soon as it is built.')
  })

  for (const { id, slug } of [FLOWS, RECIPE, SEO]) {
    it(`keeps every other line of the earlier text, byte for byte and in order (${slug})`, () => {
      const old = BEFORE[id].split('\n')
      const added = (l: string) => ADDED[id].some((start) => l.startsWith(start))
      const after = text(id).split('\n')
      expect(after.filter(added)).toHaveLength(ADDED[id].length)
      const kept = after.filter((l) => !added(l))
      expect(kept).toHaveLength(old.length)
      const changed = new Set<number>()
      for (const start of REWRITTEN[id]) {
        const at = old.findIndex((l) => l.startsWith(start))
        expect(at, start).toBeGreaterThanOrEqual(0)
        expect(kept[at], start).not.toBe(old[at])
        changed.add(at)
      }
      expect(kept.filter((_, i) => !changed.has(i))).toEqual(old.filter((_, i) => !changed.has(i)))
      // The same headings, in order.
      const headings = (t: string) => [...t.matchAll(/^## (.+)$/gm)].map((m) => m[1])
      expect(headings(text(id))).toEqual(headings(BEFORE[id]))
    })
  }

  it('drops every line that called the new triggers and schedules impossible', () => {
    for (const { id, slug } of [FLOWS, RECIPE, SEO]) {
      const t = text(id)
      expect(t, slug).not.toMatch(/No cron|There's no cron|no cron:|a cron expression|trigger on email|no monthly|monthly one|hourly, daily, weekdays (and|or) weekly/i)
    }
    for (const { id } of [FLOWS, RECIPE, SEO]) expect(BEFORE[id]).toMatch(/No cron|There's no cron|no monthly one/)
  })

  it('teaches every trigger and cadence the tools take, with their own field names', () => {
    const core = text(FLOWS.id)
    const recipe = text(RECIPE.id)
    for (const type of OWNER_EVENT_TRIGGER_TYPES) {
      expect((FLOW_TOOL_TRIGGER_TYPES as readonly string[]).includes(type), type).toBe(true)
      for (const t of [core, recipe]) expect(t, type).toContain(type)
    }
    for (const cadence of ['hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'cron', 'once']) {
      expect(core, cadence).toMatch(new RegExp(`\\b${cadence}\\b`))
      expect(recipe, cadence).toMatch(new RegExp(`\\b${cadence}\\b`))
    }
    // The trigger fields named are create_flow's own (the tool takes `email_from`; the stored config says `from`).
    const trigger = (registryToolInputSchemas().get('create_flow')?.properties as Record<string, { properties?: Record<string, unknown> }> | undefined)?.trigger
    const fields = Object.keys(trigger?.properties ?? {})
    for (const field of ['cadence', 'time', 'weekday', 'day_of_month', 'cron', 'run_at', 'timezone', 'email_from', 'channel_id', 'mentions_only']) {
      expect(fields, field).toContain(field)
      expect(core, field).toContain(`\`${field}\``)
    }
    for (const field of ['day_of_month', 'cron', 'run_at', 'email_from', 'channel_id', 'mentions_only']) expect(recipe, field).toContain(`\`${field}\``)
    expect(text(SEO.id)).toContain('cadence monthly, with `day_of_month` (1 to 28)')
    // The limits the code holds them to.
    expect(CRON_MIN_INTERVAL_MINUTES).toBe(15)
    for (const t of [core, recipe]) expect(t).toContain(`at most every ${CRON_MIN_INTERVAL_MINUTES} minutes`)
    expect(core).toContain(`at most ${EVENT_FIRE_CAP_PER_DAY} times a day`)
    for (const t of [core, recipe]) expect(t).toContain('`day_of_month` 1 to 28')
  })

  it('puts ids in templates, never words, and names the tool that reads each', () => {
    for (const t of [text(FLOWS.id), text(RECIPE.id)]) {
      for (const [token, tool] of [
        ['{{trigger.email_thread_id}}', 'read_email'],
        ['{{trigger.chat_message_id}}', 'read_team_chat_message'],
        ['{{trigger.document_id}}', 'get_document'],
      ] as const) {
        expect((TEMPLATE_TOKENS as readonly string[]).includes(token), token).toBe(true)
        expect((ALL_TOOL_NAMES as readonly string[]).includes(tool), tool).toBe(true)
        expect(t).toContain(`\`${token}\` with \`${tool}\``)
      }
      expect(t).toMatch(/pass (only )?ids/)
    }
  })

  it("is careful about cron's either-day rule: the first Monday is not promised", () => {
    // Classic cron: day-of-month 1-7 OR Monday, so "1-7" with Monday runs on every Monday too.
    const s = parseCron('0 9 1-7 * 1')
    expect(s).not.toBeInstanceOf(Error)
    if (!(s instanceof Error)) expect(s.domRestricted && s.dowRestricted).toBe(true)
    const core = text(FLOWS.id)
    expect(core).toContain('Cron can\'t say "the first Monday"')
    expect(core).toContain('"1-7" with Monday is every Monday too')
    expect(text(RECIPE.id)).toContain('"The first Monday" or "every other week" can\'t be exact (cron matches either day field)')
    // Plain-English examples map onto the configs.
    for (const phrase of ['"every weekday at 9am"', '"every two hours"', '"tomorrow at 3pm"']) expect(core, phrase).toContain(phrase)
  })

  it('stays within each kind of text\'s size: the core 2,000 tokens, the recipe 900, the area skill 1,200', () => {
    expect(estimateTokens(text(FLOWS.id))).toBeLessThanOrEqual(2000)
    expect(estimateTokens(text(RECIPE.id))).toBeLessThanOrEqual(900)
    expect(estimateTokens(text(SEO.id))).toBeLessThanOrEqual(1200)
  })

  it('updates only recipes by id, slug and is_system where the text differs, fails loudly, and has no backslash', () => {
    const body = uncommented(sql).replace(/\$pb\$[\s\S]*?\$pb\$/g, "''").replace(/\s+/g, ' ')
    expect(sql.includes(String.fromCharCode(92))).toBe(false)
    expect(body).toContain("SET LOCAL lock_timeout = '5s';")
    expect(body.match(/\bUPDATE public\.\w+/g)).toEqual(['UPDATE public.recipe'])
    expect(body).toContain('WHERE r.id = p.id AND r.slug = p.slug AND r.is_system AND r.system_prompt IS DISTINCT FROM p.system_prompt;')
    expect(body).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|INSERT\s+INTO|DROP|ALTER)\b/i)
    for (const { id, slug } of [FLOWS, RECIPE, SEO]) {
      expect(body).toContain(`WHERE id = '${id}'::uuid AND slug = '${slug}' AND is_system`)
      expect(body).toMatch(new RegExp(`RAISE EXCEPTION '641: the system ${slug}`))
    }
    expect(sql).toMatch(/Applied by hand, from this file: to DEV, then to PROD/)
  })
})
