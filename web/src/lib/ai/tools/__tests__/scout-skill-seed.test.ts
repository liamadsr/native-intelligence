/**
 * Migration 253 seeds the Scout skill, and it can drift from the code in three
 * ways the compiler cannot see:
 *
 *   1. `agent_config.enabled_tools` is a list of TOOL-REGISTRY CATEGORY ids
 *      (expanded by `getToolNamesForCategories`), and a typo there is silent —
 *      the category simply expands to nothing and Scout loses its whole tool
 *      surface with no error anywhere.
 *   2. `preferred_tools` are TOOL names, and a renamed tool leaves a dangling
 *      hint that quietly points the model at something that does not exist.
 *   3. The prompt is the only thing keeping money out of the chat. The tools
 *      carry no prices any more, so a dollar figure, a budget, a cap or a
 *      "free" can only reach the user through the seeded text — and a prompt
 *      edit that lets one back in fails no compiler and no other test.
 *
 * The same reasoning as `schema-lockstep.test.ts`: read the migration text and
 * pin it against the code. No database.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ALL_CATEGORY_IDS, getToolNamesForCategories } from '../../tool-registry'
import { createProspectingTools } from '../prospecting'
import { createTools } from '../index'

const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase/migrations/253_scout_prospector_skill.sql'),
  'utf8',
)

/** The agent_config json, parsed out of the dollar-quoted literal. Both the
 *  INSERT (`$cfg$…$cfg$`) and the UPDATE (`$ucfg$…$ucfg$`) carry one, and they
 *  must agree — a re-run of the migration applies the UPDATE, so a divergent
 *  UPDATE silently rewrites the seed. */
function configs(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const tag of ['cfg', 'ucfg']) {
    const re = new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`)
    const match = MIGRATION.match(re)
    expect(match, `migration is missing its $${tag}$ block`).toBeTruthy()
    out.push(JSON.parse(match![1]) as Record<string, unknown>)
  }
  return out
}

const stub = {} as unknown as SupabaseClient
const prospectingToolNames = Object.keys(createProspectingTools('u', stub, 'w'))
const allRealToolNames = new Set(Object.keys(createTools('u', stub, 'w')))

describe('migration 253 — the Scout skill seed', () => {
  it('seeds slug "scout", name "Scout", and is a system skill', () => {
    expect(MIGRATION).toContain('$slug$scout$slug$')
    expect(MIGRATION).toContain('$name$Scout$name$')
    expect(MIGRATION).toMatch(/is_system\s+=\s+true/)
    expect(MIGRATION).toContain("'skill'")
  })

  it('is idempotent the way 225 is — fixed uuid, ON CONFLICT (id) DO NOTHING, then UPDATE by id', () => {
    const uuid = MIGRATION.match(/'([0-9a-f-]{36})'/)?.[1]
    expect(uuid).toBeTruthy()
    expect(MIGRATION).toContain('ON CONFLICT (id) DO NOTHING')
    expect(MIGRATION).toContain(`WHERE id = '${uuid}'`)
    // Keying on the PRIMARY KEY, not on the slug: `recipe` carries two
    // overlapping partial slug indexes and inferring one requires an exact
    // predicate match. Checked against the SQL only — the file's own header
    // comment explains this choice and names the shape it rejects.
    const sql = MIGRATION.split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
    expect(sql).not.toContain('ON CONFLICT (slug)')
  })

  it('the INSERT and the UPDATE carry the SAME agent_config', () => {
    const [insert, update] = configs()
    expect(update).toEqual(insert)
  })

  it('every enabled_tools entry is a real registry CATEGORY that expands to tools', () => {
    for (const config of configs()) {
      const categories = config.enabled_tools as string[]
      expect(Array.isArray(categories)).toBe(true)
      for (const id of categories) {
        expect(ALL_CATEGORY_IDS, `unknown tool category "${id}"`).toContain(id)
      }
      // A ceiling that expands to nothing would leave Scout mute.
      expect(getToolNamesForCategories(categories).length).toBeGreaterThan(0)
    }
  })

  it('the ceiling covers the whole prospecting family plus the sequence handoff', () => {
    const [config] = configs()
    const reachable = new Set(getToolNamesForCategories(config.enabled_tools as string[]))
    for (const name of prospectingToolNames) {
      expect(reachable, `Scout cannot reach ${name}`).toContain(name)
    }
    // The handoff at the end of the pipeline.
    expect(reachable).toContain('enroll_contacts_in_sequence')
  })

  it('the ceiling stays TIGHT — no captures, actions, email, or knowledge graph', () => {
    const [config] = configs()
    const reachable = new Set(getToolNamesForCategories(config.enabled_tools as string[]))
    for (const forbidden of [
      'get_capture_transcript',
      'create_action',
      'list_emails',
      'create_claim',
      'create_skill',
    ]) {
      expect(reachable, `Scout should not reach ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('every preferred_tool is a tool that actually exists', () => {
    for (const config of configs()) {
      for (const name of config.preferred_tools as string[]) {
        expect(allRealToolNames, `preferred_tools names a nonexistent tool "${name}"`).toContain(
          name,
        )
      }
    }
  })

  it("preferred_tools does not name ask_user — it is core, not a listed category", () => {
    for (const config of configs()) {
      // ask_user is always available and is deliberately NOT a registry
      // category (NOT_IN_REGISTRY_BY_DESIGN), so listing it in a ceiling would
      // be a no-op that reads like a grant.
      expect(config.enabled_tools as string[]).not.toContain('ask_user')
    }
  })

  it('the prompt never mentions money — no amounts, budgets, caps, prices, or "free"', () => {
    // Liam's rule: the $20 month ceiling and the per-run caps exist in the
    // backend and the user never hears about them. The tools carry no prices
    // any more, so the seeded prompt is the only place a figure could come
    // from. Both copies, because a re-run applies the UPDATE.
    for (const tag of ['prompt', 'uprompt']) {
      const re = new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`)
      const body = MIGRATION.match(re)?.[1]
      expect(body, `migration is missing its $${tag}$ block`).toBeTruthy()
      expect(body).not.toMatch(/\$\d/)
      expect(body).not.toMatch(
        /\b(budget|budgets|spend|spent|price|prices|cost|costs|free|cheap|cents?|dollars?|headroom|quote|quoted|quotes|cap|caps|capped)\b/i,
      )
    }
  })

  it('the prompt names the go-ahead flag and the refusal it answers', () => {
    // `goAheadRefusal` in prospecting.ts returns `needs_go_ahead`; the prompt
    // has to tell the model what to do with it, or the first call of every
    // conversation is a refused turn.
    expect(MIGRATION).toContain('needs_go_ahead')
    expect(MIGRATION).toMatch(/Never mention money/)
    expect(MIGRATION.match(/Never mention money/g)).toHaveLength(2)
  })

  it('the prompt names every run tool, so the model knows which ones need the go-ahead', () => {
    for (const name of [
      'run_prospect_discovery',
      'research_prospect_companies',
      'find_prospect_people',
      'research_my_company',
    ]) {
      expect(MIGRATION, `the prompt never mentions ${name}`).toContain(name)
    }
  })

  it('the prompt carries the dismissal rule and the workspace-wide warning', () => {
    expect(MIGRATION).toMatch(/Never dismiss, save, or enroll without being asked/i)
    expect(MIGRATION).toMatch(/EVERY list in this workspace/i)
    expect(MIGRATION).toContain('confirmed_with_user')
  })

  it('step 5 forbids stating a LOW-confidence tier and points at the signals instead', () => {
    // The page hides the letter on a low-confidence row (FitChip renders the
    // grey NONE glyph), so a chat that announces "Vanta is an A" beside it is
    // telling the user two different things about the same row. `fit_display`
    // is the tool field that is already null there; the prompt is what stops
    // the model reaching past it to the raw `fit_tier`.
    expect(MIGRATION).toContain('whose confidence is not low')
    expect(MIGRATION).toMatch(/for low-confidence entries do not state a tier/i)
    expect(MIGRATION).toContain('signals_met')
    expect(MIGRATION).toContain('fit_display')
    // Both copies — a re-run applies the UPDATE, so a divergent UPDATE would
    // silently rewrite the seed back.
    expect(MIGRATION.match(/whose confidence is not low/g)).toHaveLength(2)
  })

  it('step 7 tells the model to READ the per-list save counts rather than tally them', () => {
    // `by_list` counts companies, people and needs_review per list on the
    // server. A model tallying a forty-object `saved` array gets it wrong often
    // enough to matter, and this is the sentence the user actually hears.
    expect(MIGRATION).toContain('by_list')
    expect(MIGRATION).toMatch(/PER LIST/)
    expect(MIGRATION).toMatch(/do not count the .saved. array yourself/i)
    expect(MIGRATION.match(/by_list/g)).toHaveLength(2)
  })

  it('the prompt forbids a second concurrent run', () => {
    expect(MIGRATION).toMatch(/Never start a second run/i)
  })
})

// ---------------------------------------------------------------------------
// Migration 257 — the prompt rewritten for the score-once pipeline
// ---------------------------------------------------------------------------

const MIGRATION_257 = readFileSync(
  join(process.cwd(), 'supabase/migrations/257_scout_skill_score_once.sql'),
  'utf8',
)

describe('migration 257 — Scout learns the score-once pipeline', () => {
  const body = MIGRATION_257.match(/\$uprompt\$([\s\S]*?)\$uprompt\$/)?.[1] ?? ''

  it('is an UPDATE of the same fixed id 253 inserted, by system_prompt only', () => {
    expect(MIGRATION_257).toMatch(/UPDATE public\.recipe/)
    expect(MIGRATION_257).toContain("WHERE id = 'c4b81f6d-2a7e-4d39-b0c6-5e9a3f18d247'")
    expect(MIGRATION_257).not.toMatch(/INSERT INTO/)
    expect(MIGRATION_257).not.toMatch(/agent_config\s*=/)
    expect(body.length).toBeGreaterThan(1000)
  })

  it('still never mentions money', () => {
    expect(body).not.toMatch(/\$\d/)
    expect(body).not.toMatch(
      /\b(budget|budgets|spend|spent|price|prices|cost|costs|free|cheap|cents?|dollars?|headroom|quote|quoted|quotes|cap|caps|capped)\b/i,
    )
    // `budget_exhausted` is a status name and is allowed; the regex above
    // needs the word boundary, which the underscore does not provide.
    expect(body).toContain('budget_exhausted')
    expect(body).toMatch(/Never mention money/)
  })

  it('says there is NO score at discovery and forbids inventing one', () => {
    expect(body).toMatch(/THERE IS NO SCORE YET/)
    expect(body).toMatch(/Never invent a number, a tier or a "strong fit"/)
    expect(body).toMatch(/not profiled yet/)
  })

  it('names the score fields the tool now returns, and the bands', () => {
    expect(body).toContain('fit_score')
    expect(body).toContain('fit_label')
    expect(body).toContain('fit_rationale')
    expect(body).toMatch(/hot \(80\+\), warm \(60–79\), moderate \(40–59\), cold \(below 40\)/)
    expect(body).toMatch(/sorted hottest first/)
  })

  it('forgets the tier vocabulary migration 256 removed', () => {
    for (const gone of ['fit_display', 'signals_met', 'A-tier', 'A and B tiers', 'fit tier']) {
      expect(body, gone).not.toContain(gone)
    }
  })

  it('describes prune-then-enrich rather than a gate', () => {
    expect(body).toMatch(/Prune, then enrich/)
    expect(body).toMatch(/dismiss what they do not care about/)
    expect(body).toContain('find_prospects')
  })

  it('keeps every rule the 253 suite pins that is not about tiers', () => {
    expect(body).toContain('needs_go_ahead')
    expect(body).toContain('confirmed_with_user')
    expect(body).toMatch(/Never dismiss, save, or enroll without being asked/i)
    expect(body).toMatch(/EVERY list in this workspace/i)
    expect(body).toContain('by_list')
    expect(body).toMatch(/do not count the .saved. array yourself/i)
    for (const name of [
      'run_prospect_discovery',
      'research_prospect_companies',
      'find_prospect_people',
      'research_my_company',
    ]) {
      expect(body, `the prompt never mentions ${name}`).toContain(name)
    }
  })
})

// ---------------------------------------------------------------------------
// Migration 258 — discovery scores by itself; the per-company step is people
// ---------------------------------------------------------------------------

const MIGRATION_258 = readFileSync(
  join(process.cwd(), 'supabase/migrations/258_scout_skill_auto_profile.sql'),
  'utf8',
)

describe('migration 258 — Scout learns the automatic profile run', () => {
  const body = MIGRATION_258.match(/\$uprompt\$([\s\S]*?)\$uprompt\$/)?.[1] ?? ''

  it('is an UPDATE of the same fixed id, by system_prompt only', () => {
    expect(MIGRATION_258).toMatch(/UPDATE public\.recipe/)
    expect(MIGRATION_258).toContain("WHERE id = 'c4b81f6d-2a7e-4d39-b0c6-5e9a3f18d247'")
    expect(MIGRATION_258).not.toMatch(/INSERT INTO/)
    expect(MIGRATION_258).not.toMatch(/agent_config\s*=/)
    expect(body.length).toBeGreaterThan(1000)
  })

  it('still never mentions money', () => {
    expect(body).not.toMatch(/\$\d/)
    expect(body).not.toMatch(
      /\b(budget|budgets|spend|spent|price|prices|cost|costs|free|cheap|cents?|dollars?|headroom|quote|quoted|quotes|cap|caps|capped)\b/i,
    )
    expect(body).toMatch(/Never mention money/)
  })

  it('says discovery scores by itself and that one go-ahead covers both halves', () => {
    expect(body).toMatch(/Discover — which also scores/)
    expect(body).toMatch(/hands off, by itself, to a profile run/)
    expect(body).toMatch(/ONE go-ahead covers both/)
    expect(body).toContain('follow_up_run')
    expect(body).toMatch(/re-sorts hottest first/)
  })

  it('makes Find people the per-company step and drops the manual enrich step', () => {
    expect(body).toMatch(/\*\*6\. Find people\.\*\*/)
    expect(body).toContain('find_prospect_people')
    expect(body).not.toMatch(/Prune, then enrich/)
    expect(body).not.toMatch(/THERE IS NO SCORE YET/)
  })

  it('still forbids inventing a score and keeps the score vocabulary', () => {
    expect(body).toMatch(/never invent a number, a tier or a "strong fit"/)
    expect(body).toMatch(/not scored yet/)
    expect(body).toContain('fit_score')
    expect(body).toContain('fit_label')
    expect(body).toMatch(/hot \(80\+\), warm \(60–79\), moderate \(40–59\), cold \(below 40\)/)
  })

  it('keeps every rule the earlier seeds pin that is not about the pipeline shape', () => {
    expect(body).toContain('needs_go_ahead')
    expect(body).toContain('confirmed_with_user')
    expect(body).toMatch(/Never dismiss, save, or enroll without being asked/i)
    expect(body).toMatch(/EVERY list in this workspace/i)
    expect(body).toContain('by_list')
    expect(body).toMatch(/do not count the .saved. array yourself/i)
    for (const name of [
      'run_prospect_discovery',
      'research_prospect_companies',
      'find_prospect_people',
      'research_my_company',
    ]) {
      expect(body, `the prompt never mentions ${name}`).toContain(name)
    }
  })
})

// ---------------------------------------------------------------------------
// 261 — the match-score vocabulary (no more hot / warm / cold)
// ---------------------------------------------------------------------------

const MIGRATION_261 = readFileSync(
  join(process.cwd(), 'supabase/migrations/261_scout_skill_match_score.sql'),
  'utf8',
)

describe('migration 261 — Scout calls it a match score', () => {
  const body = MIGRATION_261.slice(
    MIGRATION_261.indexOf('$uprompt$') + '$uprompt$'.length,
    MIGRATION_261.lastIndexOf('$uprompt$'),
  )

  it('is an UPDATE of the same row, quoted the same way, never mentioning money', () => {
    expect(MIGRATION_261).toMatch(/^UPDATE public\.recipe/m)
    expect(MIGRATION_261).toContain("WHERE id = 'c4b81f6d-2a7e-4d39-b0c6-5e9a3f18d247'")
    expect(MIGRATION_261).not.toMatch(/INSERT INTO/)
    expect(body.length).toBeGreaterThan(1000)
    expect(body).not.toMatch(/\$\d/)
    expect(body).toMatch(/Never mention money/)
  })

  it('renames the bands and drops the temperature words — the CRM owns those', () => {
    expect(body).toMatch(/a MATCH SCORE, 0–100/)
    expect(body).toMatch(/strong \(80\+\), good \(60–79\), partial \(40–59\), weak \(below 40\)/)
    expect(body).toMatch(/never hot\/warm\/cold/)
    expect(body).toMatch(/"Vanta, match score 88, strong"/)
    expect(body).not.toMatch(/hot \(80\+\)/)
    expect(body).not.toMatch(/hottest/)
    expect(body).toMatch(/sorted best match first/)
    expect(body).toMatch(/re-sorts best match first/)
  })

  it('keeps everything 260 taught — publish, the go-ahead list, the join', () => {
    expect(body).toMatch(/Six of your tools do something real/)
    expect(body).toMatch(/\*\*8\. Publish — the list becomes a group in the CRM\.\*\*/)
    expect(body).toContain('publish_prospect_list')
    expect(body).toMatch(/joined_live_run/)
  })
})
