/**
 * Migration 338: helper lines in the playbooks and the promotion rule in the
 * Actions core (docs/plans/always-on-agent.md §4c items 3 and 8). Text only.
 * This pins the file: the rows and the earlier text each changes; additions
 * plus exactly one line swapped in each core (undoing the swap and removing
 * the passage gives back the earlier text byte for byte); the same helper
 * line in all sixteen cores, none still saying helpers come later; every
 * helper line conditional (loops, background runs and helpers themselves have
 * neither `helpers` nor `start_helper`); the promotion rule as the code
 * enforces it; mail lines that describe tools rather than storage; no
 * backslash anywhere; and an idempotent text-only update.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TOOL_FAMILIES } from '../tool-families'
import { describe, it, expect } from 'vitest'
import { CHAT_NATIVE_TOOL_NAMES, NON_CHAT_TOOL_NAMES } from '@/lib/ai/tool-registry'
import {
  allSeededSkills,
  allShippedSkills,
  CORE_HELPER_LINE,
  OLD_CORE_HELPER_LINE,
  promptRewrites,
  PROMPT_REWRITE_MIGRATIONS,
  readMigration,
  rewrittenAfter,
  seededSkills,
  SKILL_REWRITE_MIGRATIONS,
} from './playbook-seeds'

const FILE = '338_skill_helper_lines.sql'
const sql = readMigration(FILE)
const rows = promptRewrites(FILE)
const by = (slug: string) => rows.find((r) => r.slug === slug)!

/** The batch skills, each with the migration whose text it extends. */
const BATCH = [
  { id: '1b502445-3db0-4f04-bc4b-39505d2fe5ca', slug: 'prospecting-playbook', from: '326_crm_outreach_skills.sql' },
  { id: 'c4b81f6d-2a7e-4d39-b0c6-5e9a3f18d247', slug: 'build-prospect-list', from: '326_crm_outreach_skills.sql' },
  { id: 'a7337d9e-1ec0-4ed8-b6f0-0311edd54335', slug: 'stale-relationships', from: '326_crm_outreach_skills.sql' },
  { id: '1534bd72-4cd1-4a53-b14a-a8fe8c4a0fb4', slug: 'mail-playbook', from: '325_meetings_mail_skills.sql' },
  { id: '72cc7391-28bf-46ef-a0f2-6206bfb5de64', slug: 'clear-inbox', from: '325_meetings_mail_skills.sql' },
  { id: 'f67ca385-0771-4b55-8699-932b5de20117', slug: 'meeting-prep', from: '325_meetings_mail_skills.sql' },
  { id: '29b2a03c-a998-4133-b9c5-70b969f86a41', slug: 'everything-about', from: '323_feature_skills_v2.sql' },
  { id: '46d24d23-ef85-48b9-b16d-4c912899459d', slug: 'what-do-we-know', from: '323_feature_skills_v2.sql' },
  { id: '326b5c1f-552e-4e83-af87-8cbb960de47b', slug: 'find-anything', from: '323_feature_skills_v2.sql' },
  { id: 'ca443e96-3c3f-419a-b1f4-4f444bbe8c5c', slug: 'project-status-update', from: '323_feature_skills_v2.sql' },
  { id: '5472e163-15c1-4f7d-a263-55268a3825c3', slug: 'initiative-review', from: '327_docs_goals_tools_skills.sql' },
] as const

const ACTIONS = { id: 'ec62f1a3-cafe-4905-a6f1-2fb328906446', slug: 'actions-playbook', from: '323_feature_skills_v2.sql' } as const

/** The cores whose only change is the helper line, in file order after the rows above. */
const LINE_ONLY = [
  { id: 'b6024df5-6b85-40ce-9975-cb334bcfba18', slug: 'calendar-playbook', from: '325_meetings_mail_skills.sql' },
  { id: 'e1a419c7-8cc0-46b2-b24b-d866210d87c5', slug: 'projects-playbook', from: '323_feature_skills_v2.sql' },
  { id: 'e6ea5b11-b98c-4d56-a5e5-40b5e661d1dc', slug: 'knowledge-playbook', from: '323_feature_skills_v2.sql' },
  { id: '1ef0c12f-5d78-41ef-ab12-714512fa03cd', slug: 'flows-playbook', from: '324_workflows_skill.sql' },
  { id: 'f896062b-8182-4f94-8bca-40b53aee96ce', slug: 'captures-playbook', from: '325_meetings_mail_skills.sql' },
  { id: 'e05a0562-a4a2-4700-8c7b-19435fa7430b', slug: 'crm-playbook', from: '326_crm_outreach_skills.sql' },
  { id: '1438190a-646d-4709-ae89-22e24ddf340b', slug: 'sequences-playbook', from: '326_crm_outreach_skills.sql' },
  { id: '48b8e8bd-2299-43b2-9a65-f9928a232b90', slug: 'campaigns-playbook', from: '326_crm_outreach_skills.sql' },
  { id: 'e8d88dec-0326-41b0-971e-f974c21cdefb', slug: 'documents-playbook', from: '327_docs_goals_tools_skills.sql' },
  { id: '1d277e63-8a44-4ca6-b743-322a812971a9', slug: 'initiatives-playbook', from: '327_docs_goals_tools_skills.sql' },
  { id: '8e08678d-1944-4a10-95ec-b9e73a7feea4', slug: 'evals-playbook', from: '327_docs_goals_tools_skills.sql' },
  { id: 'eec790ec-399f-416d-8189-c883859ba8c3', slug: 'browser-playbook', from: '327_docs_goals_tools_skills.sql' },
  { id: '800dc79b-a55f-4ef5-802d-8a6945e38460', slug: 'library-playbook', from: '327_docs_goals_tools_skills.sql' },
] as const

/** The rows with a passage (the Actions core and the batch skills). */
const WITH_PASSAGE = [ACTIONS, ...BATCH]
const ALL = [...WITH_PASSAGE, ...LINE_ONLY]
const isCore = (slug: string) => slug.endsWith('-playbook')

/** The batch skills whose passage also offers `start_helper` (long work that outlives the reply). */
const OFFERS_START_HELPER = [
  'prospecting-playbook', 'build-prospect-list', 'mail-playbook', 'clear-inbox', 'meeting-prep', 'everything-about',
  'project-status-update', 'initiative-review',
]

const CORE_HEADINGS = ["What's here", 'How to find things', 'Doing it well', 'Pitfalls', 'When to hand to a helper']

/** Each row's text before 338: the latest row rewrite of that id. */
const before = new Map(SKILL_REWRITE_MIGRATIONS.flatMap(seededSkills).map((s) => [s.id, s]))

/**
 * The block of whole lines 338 inserted: the new text minus its longest
 * common line prefix and suffix with the old one. Null unless removing it
 * gives back the old text exactly.
 */
function insertedBlock(previous: string, next: string): string | null {
  const a = previous.split('\n')
  const b = next.split('\n')
  if (b.length <= a.length) return null
  let head = 0
  while (head < a.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  if (head + tail !== a.length) return null
  const rebuilt = [...b.slice(0, head), ...b.slice(b.length - tail)].join('\n')
  if (rebuilt !== previous) return null
  return b.slice(head, b.length - tail).join('\n')
}

/** A row's earlier text, with the core helper line already swapped: what the passage is inserted into. */
function swapped(row: { id: string; slug: string }): string {
  const prev = before.get(row.id)!.prompt
  if (!isCore(row.slug)) return prev
  expect(prev.split(OLD_CORE_HELPER_LINE), `${row.slug}: the old helper line exactly once`).toHaveLength(2)
  return prev.replace(OLD_CORE_HELPER_LINE, () => CORE_HELPER_LINE)
}

const passage = (slug: string) => {
  const row = WITH_PASSAGE.find((r) => r.slug === slug)!
  return insertedBlock(swapped(row), by(slug).prompt)!
}

describe('migration 338', () => {
  it('has no backslash anywhere (the MCP transport decodes unicode escapes)', () => {
    expect(sql.includes(String.fromCharCode(92))).toBe(false)
  })

  it('updates the Actions core, the eleven batch skills and the other thirteen cores, each by id and slug, in that order', () => {
    expect(rows.map((r) => ({ id: r.id, slug: r.slug }))).toEqual(ALL.map(({ id, slug }) => ({ id, slug })))
    expect(PROMPT_REWRITE_MIGRATIONS).toContain(FILE)
  })

  it('changes each row the latest earlier migration wrote, and its text is the one that ships (or a later rewrite\'s)', () => {
    for (const row of ALL) {
      const prev = before.get(row.id)
      expect(prev?.file, row.slug).toBe(row.from)
      expect(prev?.slug, row.slug).toBe(row.slug)
      const shipped = allShippedSkills().find((s) => s.id === row.id)!
      // A later text-only rewrite (368's documents playbook) pins its own text.
      const later = rewrittenAfter(FILE, row.id, row.slug)
      expect(shipped.file, row.slug).toBe(later ?? FILE)
      if (!later) expect(shipped.prompt, row.slug).toBe(by(row.slug).prompt)
      // Every other column is the earlier row's: description, config and area ride through.
      expect(shipped.description, row.slug).toBe(prev!.description)
      expect(shipped.config, row.slug).toEqual(prev!.config)
      expect(shipped.area, row.slug).toBe(prev!.area)
    }
  })

  it('only adds, besides the one helper line in each core: undoing that and removing one block of whole lines gives back the earlier text byte for byte', () => {
    for (const row of LINE_ONLY) {
      expect(by(row.slug).prompt, row.slug).toBe(swapped(row))
      expect(by(row.slug).prompt.replace(CORE_HELPER_LINE, () => OLD_CORE_HELPER_LINE), row.slug).toBe(before.get(row.id)!.prompt)
    }
    for (const row of WITH_PASSAGE) {
      const block = insertedBlock(swapped(row), by(row.slug).prompt)
      expect(block, `${row.slug}: not a pure insertion of whole lines`).not.toBeNull()
      const lines = block!.split('\n')
      expect(lines.length, row.slug).toBeGreaterThanOrEqual(1)
      expect(lines.length, row.slug).toBeLessThanOrEqual(3)
      for (const line of lines) expect(line.trim().length, row.slug).toBeGreaterThan(0)
      expect(block!.length, row.slug).toBeLessThanOrEqual(800)
    }
  })

  it('keeps each core in its five sections', () => {
    for (const { slug } of ALL.filter((r) => isCore(r.slug))) {
      expect([...by(slug).prompt.matchAll(/^## (.+)$/gm)].map((m) => m[1]), slug).toEqual(CORE_HEADINGS)
    }
  })

  it('gives all sixteen cores the same conditional helper line, and no shipped core still says helpers come later', () => {
    const cores = allSeededSkills().filter((s) => isCore(s.slug))
    expect(cores).toHaveLength(16)
    expect(ALL.filter((r) => isCore(r.slug)).map((r) => r.id).sort()).toEqual(cores.map((c) => c.id).sort())
    for (const core of cores) {
      expect(core.file, core.slug).toBe(rewrittenAfter(FILE, core.id, core.slug) ?? FILE)
      expect(core.prompt, core.slug).not.toContain('helpers come later')
      // The section opens with the shared line; a core's own passage may follow it.
      expect(core.prompt.split('## When to hand to a helper\n')[1].split('\n')[0], core.slug).toBe(CORE_HELPER_LINE)
    }
    for (const s of allShippedSkills()) expect(s.prompt, s.slug).not.toContain('helpers come later')
    // Main chat only, conditional, and without them the work happens right there.
    expect(CORE_HELPER_LINE).toMatch(/^If you have `helpers` \(main chat only\), /)
    expect(CORE_HELPER_LINE).toMatch(/where this playbook or the skill you're running says to/)
    expect(CORE_HELPER_LINE).toMatch(/without them \(a loop, or any run without that tool\), do the work here\.$/)
    expect(CORE_HELPER_LINE).not.toContain('\n')
    // The passages after it no longer bridge from the old line.
    for (const slug of ['prospecting-playbook', 'mail-playbook']) expect(by(slug).prompt, slug).not.toContain('here now')
  })

  it('makes every helper line conditional: no loop, background run or helper is told to call a tool it lacks', () => {
    for (const p of [CORE_HELPER_LINE]) {
      for (const m of p.matchAll(/`helpers`/g)) expect(p.slice(Math.max(0, m.index! - 9), m.index)).toBe('you have ')
    }
    for (const { slug } of BATCH) {
      const p = passage(slug)
      const helpers = [...p.matchAll(/`helpers`/g)]
      expect(helpers.length, slug).toBeGreaterThan(0)
      for (const m of helpers) expect(p.slice(Math.max(0, m.index! - 9), m.index), slug).toBe('you have ')
      for (const m of p.matchAll(/`start_helper`/g)) {
        const around = p.slice(Math.max(0, m.index! - 9), m.index! + 30)
        expect(/you have `start_helper`|`start_helper` if you have it/.test(around), `${slug}: ${around}`).toBe(true)
      }
    }
    // Why: both tools live in the main chat alone.
    expect(CHAT_NATIVE_TOOL_NAMES.has('start_helper')).toBe(true)
    expect(NON_CHAT_TOOL_NAMES).not.toContain('start_helper')
    expect(existsSync(join(process.cwd(), 'agents/chat-agent/tools/helpers.ts'))).toBe(true)
    expect(existsSync(join(process.cwd(), 'agents/skill-runner/tools/helpers.ts'))).toBe(false)
    expect(existsSync(join(process.cwd(), 'agents/work-agent/tools/helpers.ts'))).toBe(false)
  })

  it('says when to stay inline, and offers start_helper for long work whose report comes back by itself', () => {
    for (const { slug } of BATCH) {
      expect(passage(slug), slug).toMatch(/\bhere\b/)
    }
    for (const slug of OFFERS_START_HELPER) {
      const p = passage(slug)
      expect(p, slug).toContain('`start_helper`')
      expect(p, slug).toMatch(/report comes back (to this conversation|here) by itself/)
    }
    for (const { slug } of BATCH) {
      if (!OFFERS_START_HELPER.includes(slug)) expect(passage(slug), slug).not.toContain('`start_helper`')
    }
  })

  it('names what splits in each skill', () => {
    const UNIT: Record<string, RegExp> = {
      'prospecting-playbook': /companies per task/,
      'build-prospect-list': /companies per task/,
      'stale-relationships': /people or accounts per task/,
      'mail-playbook': /thread ids per task/,
      'clear-inbox': /thread ids per task/,
      'meeting-prep': /one task per person or company/,
      'everything-about': /one task per entity/,
      'what-do-we-know': /one task per entity/,
      'find-anything': /one task per thing or kind/,
      'project-status-update': /one task per project/,
      'initiative-review': /projects per task/,
    }
    for (const { slug } of BATCH) expect(passage(slug), slug).toMatch(UNIT[slug])
  })

  it('keeps helpers to reading and drafting: sends, searches that need a go-ahead and publishing stay with the main agent', () => {
    for (const slug of ['mail-playbook', 'clear-inbox']) expect(passage(slug), slug).toMatch(/helpers draft, never send/i)
    expect(passage('prospecting-playbook')).toMatch(/Helpers read and draft only: searches, saves, dismissals and publishing stay with you, each with its go-ahead/)
    expect(passage('build-prospect-list')).toMatch(/Searches, saves and publishes stay yours, each with its go-ahead/)
  })

  it('describes mail by what the tools do, never by how mail is stored', () => {
    for (const slug of ['mail-playbook', 'clear-inbox']) {
      expect(passage(slug), slug).not.toMatch(/sync|stored|storage|cache|index|database/i)
    }
    expect(passage('mail-playbook')).toContain('searching the mailbox')
  })

  it('teaches the promotion rule as the chat-agent instructions and the code have it', () => {
    const p = passage('actions-playbook')
    expect(p).toContain('`update_plan`')
    expect(p).toMatch(/stay checklists/)
    expect(p).toMatch(/becomes an action only when the person asked for it or agreed to it/)
    expect(p).toMatch(/needs a person to decide or do something/)
    expect(p).toMatch(/a commitment someone made for later/)
    expect(p).toMatch(/spans days or another owner picks it up/)
    expect(p).toMatch(/stays in the plan, or goes to the person as a suggestion \(`suggest_changes`\)/)
    expect(p).toMatch(/Work nobody is watching \(a loop, a background helper\) files every action it creates as a suggestion for the person to confirm, whatever you pass, and can't confirm one/)
    expect(p).not.toContain('`helpers`')
    // The same rule rides the helpers' pack once the main chat touches start_helper
    // (src/lib/packs/tool-families.ts), and the standing instructions keep its first
    // half for the agent's own plan.
    const guide = TOOL_FAMILIES.find((f) => f.key === 'helpers')?.guide ?? ''
    expect(guide).toMatch(/becomes an action on the board only when it needs a person to decide or do something/)
    expect(guide).toContain('Work nobody is watching files such a step as a suggested action for the person to confirm, never as a confirmed one.')
    const instructions = readFileSync(join(process.cwd(), 'agents/chat-agent/instructions.md'), 'utf8').replace(/\s+/g, ' ')
    expect(instructions).toContain('A step only becomes an action when the person asks for one or it is a real commitment for later.')
    // And what the code enforces: unattended skill runs and work runs file actions as suggested.
    for (const route of ['src/app/api/internal/skill-run/tool/route.ts', 'src/app/api/internal/work-run/tool/route.ts']) {
      expect(readFileSync(join(process.cwd(), route), 'utf8'), route).toContain('fileActionsAsSuggested: true')
    }
  })

  it('is idempotent and text only: by id, guarded by slug, only where the text differs, nothing else touched', () => {
    const statements = sql
      .replace(/\$pb\$[\s\S]*?\$pb\$/g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
    expect(statements).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(statements).toMatch(/UPDATE public\.recipe AS r\s+SET system_prompt = p\.system_prompt,\s+updated_at\s+= now\(\)\s+FROM \(VALUES/)
    expect(statements).toMatch(/\) AS p \(id, slug, system_prompt\)\s+WHERE r\.id = p\.id\s+AND r\.slug = p\.slug\s+AND r\.is_system\s+AND r\.system_prompt IS DISTINCT FROM p\.system_prompt;/)
    expect(statements).not.toMatch(/\bINSERT\b|\bDELETE\b|\bALTER\b|\bCREATE\b|\bDROP\b/i)
    expect(statements.match(/\bUPDATE\b/g)).toHaveLength(1)
  })
})
