/**
 * Migration 263 seeds the Find-email skill, and it can drift from the code in
 * ways the compiler cannot see — the same three failure modes
 * `scout-skill-seed.test.ts` guards for 253, plus one specific to this skill:
 *
 *   1. `agent_config.enabled_tools` is a list of TOOL-REGISTRY CATEGORY ids
 *      (expanded by `getToolNamesForCategories`). A typo is silent: the
 *      category expands to nothing and the skill loses its tool surface.
 *   2. `preferred_tools` are TOOL names. A renamed tool leaves a dangling hint
 *      pointing the model at something that does not exist. The exception is
 *      `web_search`, which is an ALWAYS-ON capability living outside the
 *      registry on purpose (src/lib/ai/tools/web-search.ts) — so it is legal in
 *      preferred_tools and must NOT appear in enabled_tools, where it would
 *      expand to a dangling name.
 *   3. The prompt is the only thing standing between a button click and a
 *      fabricated email address. "Never combine a first name and a domain
 *      without a cited source" is not enforced by any tool — the tool will
 *      happily write whatever it is handed — so a prompt edit that softens it
 *      fails no compiler and no other test.
 *
 * And the fourth, particular to a skill that writes off one click: the seed
 * text the button sends says "The user clicked Find email", and the prompt
 * treats that as the authorization to save. Both halves are pinned, here and in
 * the start-event test, so neither can be reworded alone.
 *
 * Reads the migration text and pins it against the code. No database.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ALL_CATEGORY_IDS, getToolNamesForCategories } from '../../tool-registry'
import { createTools } from '../index'
import { FIND_EMAIL_SKILL_SLUG } from '@/app/account/(dashboard)/prospecting/start-event'

const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase/migrations/263_find_email_skill.sql'),
  'utf8',
)

/** The agent_config json out of both dollar-quoted literals. The INSERT
 *  (`$cfg$`) and the UPDATE (`$ucfg$`) must agree — a re-run applies the
 *  UPDATE, so a divergent one silently rewrites the seed. */
function configs(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const tag of ['cfg', 'ucfg']) {
    const match = MIGRATION.match(new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`))
    expect(match, `migration is missing its $${tag}$ block`).toBeTruthy()
    out.push(JSON.parse(match![1]) as Record<string, unknown>)
  }
  return out
}

/** Both copies of the system prompt, for the same reason. */
function prompts(): string[] {
  return ['prompt', 'uprompt'].map((tag) => {
    const match = MIGRATION.match(new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`))
    expect(match, `migration is missing its $${tag}$ block`).toBeTruthy()
    return match![1]
  })
}

const stub = {} as unknown as SupabaseClient
const allRealToolNames = new Set(Object.keys(createTools('u', stub, 'w')))

/** Tools that exist but live outside the registry by design. */
const ALWAYS_ON_TOOLS = new Set(['web_search'])

describe('migration 263 — the Find-email skill seed', () => {
  it('seeds slug "find-email", name "Find email", and is a system skill', () => {
    expect(MIGRATION).toContain('$slug$find-email$slug$')
    expect(MIGRATION).toContain('$name$Find email$name$')
    expect(MIGRATION).toMatch(/is_system\s+=\s+true/)
    expect(MIGRATION).toContain("'skill'")
  })

  it('the slug is the one the button arms', () => {
    expect(FIND_EMAIL_SKILL_SLUG).toBe('find-email')
    expect(MIGRATION).toContain(`$slug$${FIND_EMAIL_SKILL_SLUG}$slug$`)
  })

  it('is a WORKSPACE-less system row offered everywhere', () => {
    // workspace_id NULL + views_context NULL: every workspace has it, and it is
    // not pinned to one view.
    expect(MIGRATION).toMatch(/views_context\s+=\s+NULL/)
    expect(MIGRATION).toContain('$vis$workspace$vis$')
  })

  it('is idempotent the way 253 is — fixed uuid, ON CONFLICT (id) DO NOTHING, then UPDATE by id', () => {
    const uuid = MIGRATION.match(/'([0-9a-f-]{36})'/)?.[1]
    expect(uuid).toBeTruthy()
    expect(MIGRATION).toContain('ON CONFLICT (id) DO NOTHING')
    expect(MIGRATION).toContain(`WHERE id = '${uuid}'`)
    // Not keyed on the slug: `recipe` carries two overlapping partial slug
    // indexes and inferring one needs an exact predicate match.
    const sql = MIGRATION.split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
    expect(sql).not.toContain('ON CONFLICT (slug)')
  })

  it('does not collide with the Scout skill id', () => {
    const scout = readFileSync(
      join(process.cwd(), 'supabase/migrations/253_scout_prospector_skill.sql'),
      'utf8',
    ).match(/'([0-9a-f-]{36})'/)?.[1]
    const mine = MIGRATION.match(/'([0-9a-f-]{36})'/)?.[1]
    expect(mine).not.toBe(scout)
  })

  it('the INSERT and the UPDATE seed the SAME config and prompt', () => {
    const [insert, update] = configs()
    expect(update).toEqual(insert)
    const [p1, p2] = prompts()
    expect(p2).toBe(p1)
  })
})

describe('migration 263 — agent_config against the real registry', () => {
  it('every enabled_tools entry is a real CATEGORY id', () => {
    for (const cfg of configs()) {
      const ids = cfg.enabled_tools as string[]
      expect(ids.length).toBeGreaterThan(0)
      for (const id of ids) expect(ALL_CATEGORY_IDS).toContain(id)
    }
  })

  it('the ceiling is exactly contacts + emails — read the profile, read the inbox, write the address', () => {
    for (const cfg of configs()) {
      expect(cfg.enabled_tools).toEqual(['contacts', 'emails'])
    }
  })

  it('the expanded ceiling actually contains the three tools the flow needs', () => {
    const names = getToolNamesForCategories(configs()[0].enabled_tools as string[])
    for (const needed of ['get_contact', 'get_contact_details', 'update_contact']) {
      expect(names).toContain(needed)
    }
    // The inbox-first step.
    expect(names).toContain('list_emails')
    expect(names).toContain('read_email')
  })

  it('does NOT list web_search as a category — it is always-on and outside the registry', () => {
    for (const cfg of configs()) {
      expect(cfg.enabled_tools).not.toContain('web_search')
    }
  })

  it('every preferred_tool is a real tool (web_search excepted, by design)', () => {
    for (const cfg of configs()) {
      for (const name of cfg.preferred_tools as string[]) {
        if (ALWAYS_ON_TOOLS.has(name)) continue
        expect(allRealToolNames, `preferred tool "${name}" does not exist`).toContain(name)
      }
    }
  })

  it('prefers web_search and update_contact — the search and the save', () => {
    for (const cfg of configs()) {
      expect(cfg.preferred_tools).toContain('web_search')
      expect(cfg.preferred_tools).toContain('update_contact')
      expect(cfg.preferred_tools).toContain('get_contact')
    }
  })
})

describe('migration 263 — the prompt is the anti-fabrication guard', () => {
  it('names both confidence tiers and no third one', () => {
    for (const p of prompts()) {
      expect(p).toContain('**listed**')
      expect(p).toContain('**inferred**')
      expect(p).toMatch(/not found/i)
    }
  })

  it('forbids assembling an address from a first name and a domain', () => {
    for (const p of prompts()) {
      expect(p).toMatch(/never combine a first name and a domain/i)
      expect(p).toMatch(/fabricat/i)
    }
  })

  it('refuses to save a personal-domain address for a work contact', () => {
    for (const p of prompts()) {
      expect(p).toMatch(/gmail/i)
      expect(p).toMatch(/never save a personal-domain address/i)
    }
  })

  it('treats the button click as the authorization to save — the seed text says so', () => {
    for (const p of prompts()) {
      expect(p).toContain('"Find email" click IS that request')
      expect(p).toMatch(/without asking again/i)
    }
  })

  it('saves with contact_id + email only — the tool takes no provenance arguments', () => {
    // `update_contact` was briefly given `email_source`/`email_source_url`
    // (Liam, 2026-09-10: cut). A prompt naming arguments the tool does not
    // accept is a silent dead end — the model would send them and the schema
    // would drop them — so pin their ABSENCE, not just the save call.
    for (const p of prompts()) {
      expect(p).toContain('update_contact')
      expect(p).toContain('`contact_id` and `email`')
      expect(p).not.toContain('email_source')
      expect(p).not.toContain('email_source_url')
    }
  })

  it('puts the provenance in the ANSWER instead — the one line carries all three', () => {
    // Nothing persists how the address was found, so the chat line is the only
    // place the user learns it. If it stops naming the tier or the link, the
    // provenance is gone entirely and no other test notices.
    for (const p of prompts()) {
      expect(p).toMatch(/report in ONE line/)
      expect(p).toMatch(/listed or inferred/i)
      expect(p).toMatch(/source link/i)
    }
  })

  it('orders get_contact first and names the wrong-turn tools the model actually reached for', () => {
    // A live DEV run (DeepSeek V4 Flash) burned its first SEVEN tool calls on
    // get_dashboard_summary / get_calendar_events before get_contact. Those are
    // CORE_TOOL_NAMES, seeded unconditionally by computeToolCeiling /
    // computeInitialActiveTools (src/lib/ai/tool-discovery.ts) — no agent_config
    // key can remove them from a turn's map — so the PROMPT is the only lever.
    // If this line is softened, nothing else fails.
    for (const p of prompts()) {
      expect(p).toMatch(/Start with `get_contact`\. Nothing else comes first/)
      expect(p).toMatch(/no dashboard, calendar, or activity tools/i)
      // It leads "The steps", before the numbered list.
      const steps = p.indexOf('## The steps')
      const lead = p.indexOf('Start with `get_contact`')
      const first = p.indexOf('1. **Check the profile first.**')
      expect(steps).toBeGreaterThan(-1)
      expect(lead).toBeGreaterThan(steps)
      expect(first).toBeGreaterThan(lead)
    }
  })

  it('puts the inbox before the web', () => {
    for (const p of prompts()) {
      const inbox = p.indexOf('mailbox')
      const web = p.indexOf('`web_search` for')
      expect(inbox).toBeGreaterThan(-1)
      expect(web).toBeGreaterThan(inbox)
    }
  })
})
