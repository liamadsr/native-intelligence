/**
 * Migration 322: the prospecting skill stops being a persona. The Scout skill
 * (253) becomes `build-prospect-list`, a recipe of steps with no identity of
 * its own, and the prospecting playbook points at it. This pins the file: the
 * two rows, the text that keeps the model from reading the skill as an agent
 * to hand off to, the 316/319 upsert shape, and the slug the app arms.
 */
import { describe, it, expect } from 'vitest'
import { TOOL_CATEGORIES, getToolNamesForCategories } from '@/lib/ai/tool-registry'
import { PROSPECT_LIST_SKILL_SLUG } from '@/app/account/(dashboard)/prospecting/start-event'
import { readMigration, seededSkills } from './playbook-seeds'

const FILE = '322_prospecting_skill_not_a_persona.sql'
const sql = readMigration(FILE)
const rows = seededSkills(FILE)
const skill = rows.find((r) => r.id === 'c4b81f6d-2a7e-4d39-b0c6-5e9a3f18d247')!
const playbook = rows.find((r) => r.id === '1b502445-3db0-4f04-bc4b-39505d2fe5ca')!
const playbook319 = seededSkills('319_area_playbooks.sql').find((r) => r.slug === 'prospecting-playbook')!

/** The statements, without comments or the quoted texts. */
const statements = sql
  .replace(/\$(pb|desc)\$[\s\S]*?\$\1\$/g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')

describe('migration 322', () => {
  it('rewrites exactly two rows: the Scout skill (253) and the prospecting playbook (319), both tagged prospecting', () => {
    expect(rows.map((r) => ({ id: r.id, slug: r.slug, area: r.area }))).toEqual([
      { id: 'c4b81f6d-2a7e-4d39-b0c6-5e9a3f18d247', slug: 'build-prospect-list', area: 'prospecting' },
      { id: '1b502445-3db0-4f04-bc4b-39505d2fe5ca', slug: 'prospecting-playbook', area: 'prospecting' },
    ])
    expect(sql).toContain('$name$Build a prospect list$name$')
    expect(skill.description).toMatch(/^Steps to build a prospect list end to end/)
  })

  it('gives the skill the slug the app arms it by', () => {
    expect(PROSPECT_LIST_SKILL_SLUG).toBe(skill.slug)
  })

  it('is a recipe, not a persona: no "You are", and Scout appears nowhere the model reads', () => {
    expect(skill.prompt).not.toMatch(/\byou are\b/i)
    for (const text of [skill.prompt, skill.description, playbook.prompt, playbook.description]) {
      expect(text).not.toMatch(/scout/i)
    }
    expect(sql.match(/\$name\$([^$]*)\$name\$/g)!.join(' ')).not.toMatch(/scout/i)
  })

  it('keeps the pipeline steps in order', () => {
    const headings = [...skill.prompt.matchAll(/^## (.+)$/gm)].map((m) => m[1])
    expect(headings).toEqual([
      '1. Their company',
      '2. Who they want',
      '3. The list',
      '4. Find and score companies',
      '5. People',
      '6. Save, publish, enroll',
      'Edge cases',
    ])
  })

  it('leaves the rules to the playbook and says where they are', () => {
    expect(skill.prompt).toContain('`prospecting-playbook`')
    // The playbook's own sentences are not repeated here.
    expect(skill.prompt).not.toMatch(/never (talk|mention)[a-z]* about money:/i)
    expect(skill.prompt).not.toMatch(/one yes covers one call/i)
    expect(skill.prompt).not.toMatch(/\$\d|\b(budget|spend|spent|price|prices|cost|costs|free|cheap|dollars?|quote|quoted|cap|caps)\b/i)
  })

  it('still handles the Prospecting page handoff and the cases the playbook lacks', () => {
    // buildProspectingSeedText's wording (start-event.ts).
    expect(skill.prompt).toContain('Learn about my company')
    expect(skill.prompt).toContain('Continue prospect list: <id>')
    for (const word of ['needs_go_ahead', 'needs_domain', 'joined_live_run', 'follow_up_run', 'sequenceable_contact_ids']) {
      expect(skill.prompt, word).toContain(word)
    }
    expect(skill.prompt).toMatch(/never navigate the app/i)
  })

  it('changes one line of the playbook: the pointer, now to build-prospect-list', () => {
    const before = playbook319.prompt.split('\n')
    const after = playbook.prompt.split('\n')
    expect(after).toHaveLength(before.length)
    const changed = after.filter((line, i) => line !== before[i])
    expect(changed).toEqual(['- To build a list end to end, follow the steps in the `build-prospect-list` skill.'])
    expect(playbook.description).toBe(playbook319.description)
    expect(playbook.config).toEqual(playbook319.config)
  })

  it('keeps the skill to prospecting, the sequence handoff and contacts, naming only real tools', () => {
    expect(skill.config.enabled_tools).toEqual(['prospecting', 'sequences', 'contacts'])
    const reachable = new Set(getToolNamesForCategories(skill.config.enabled_tools!))
    const prospecting = TOOL_CATEGORIES.find((c) => c.id === 'prospecting')!.tools.map((t) => t.name)
    for (const name of [...prospecting, 'enroll_contacts_in_sequence']) expect(reachable.has(name), name).toBe(true)
    for (const name of skill.config.preferred_tools ?? []) expect(reachable.has(name), name).toBe(true)
  })

  it('upserts the 316/319 way: fixed ids, insert when missing, update only where a column differs', () => {
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
