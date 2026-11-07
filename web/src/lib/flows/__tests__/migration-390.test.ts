/**
 * Migration 390 (P9, decision 9): the newsletter skill, and the recipe that
 * runs it. Pinned: a loop skill gated with Flows, told the week by the
 * server; its text (a document they copy out, public-safe, never sent); and
 * the deterministic half of "the newsletter recipe never calls a send tool":
 * no sending tool is in its ceiling in any mode, and its recipe's only step
 * writes a document. Applied nowhere yet.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { FEATURES } from '@/lib/editions/manifest'
import { recipeFlow } from '../recipes'
import { computeSkillCeiling } from '../run-skill'
import { renderNewsletterBlock } from '@/lib/content/post-week'

const raw = readFileSync(resolve(__dirname, '../../../../supabase/migrations/390_newsletter_skill.sql'), 'utf8')
const m = /'([0-9a-f-]{36})'::uuid,\s*\$name\$[\s\S]*?\$slug\$([a-z-]+)\$slug\$[\s\S]*?\$desc\$([\s\S]*?)\$desc\$,\s*\$pb\$([\s\S]*?)\$pb\$,\s*\$cfg\$([\s\S]*?)\$cfg\$::jsonb,\s*(NULL::text|'[a-z]+')/.exec(raw)!
const row = { id: m[1], slug: m[2], desc: m[3], prompt: m[4], cfg: JSON.parse(m[5]), area: m[6] }

/** Every tool that sends, posts or reaches a list (none may be reachable). */
const SENDING = ['send_email', 'create_email_draft', 'draft_followup_email', 'generate_email_drafts', 'revise_email_draft', 'create_campaign', 'update_campaign', 'create_sequence', 'enroll_contacts_in_sequence', 'publish_post', 'schedule_post', 'mcp_confirm_call', 'create_calendar_event']

describe('migration 390: the newsletter skill', () => {
  it('seeds one loop skill, gated with Flows, told the week by the server', () => {
    expect([row.id, row.slug, row.area, row.cfg.material]).toEqual(['d53ec7d9-10c9-476f-ba39-06b9f261bff1', 'content-newsletter', 'NULL::text', 'week_of_work'])
    expect(FEATURES.flows.systemRecipeIds).toContain(row.id)
    expect(row.desc.length).toBeLessThanOrEqual(200)
  })

  it('teaches a document they copy out, public-safe, and never sending anything', () => {
    expect(row.prompt).toMatch(/Dial8 never sends it/)
    expect(row.prompt).toMatch(/Never send anything, never draft an email, never create a campaign/)
    expect(row.prompt).toMatch(/never a customer, a company, a person's name, a price or a deal/)
    expect(row.prompt).not.toMatch(/\byou are\b/i)
  })

  it('never calls a send tool: none is in its ceiling, in report or act mode', () => {
    for (const mode of ['report', 'act'] as const) {
      const ceiling = computeSkillCeiling(row.cfg, mode, false)
      expect(ceiling, mode).not.toBeNull()
      for (const tool of SENDING) expect(ceiling!.has(tool), `${mode}: ${tool}`).toBe(false)
    }
  })

  it('the recipe: Friday afternoon, one step, a document, nothing sent', () => {
    const r = recipeFlow('weekly_newsletter')
    if (r instanceof Error) throw r
    expect(r.trigger).toMatchObject({ type: 'schedule', cadence: 'weekly', weekday: 5, time: '15:00' })
    expect(r.actions).toEqual([{ id: 'newsletter', type: 'run_skill', skill: 'd53ec7d9-10c9-476f-ba39-06b9f261bff1', deliver_to: 'document', document_title: 'Newsletter — {date}' }])
  })

  it('the week’s block: a slow week is a short issue, never invented news', () => {
    expect(renderNewsletterBlock({ moments: [], shipped: [], docs: [], slow: true })).toContain('A slow week: write a short issue anyway')
    expect(renderNewsletterBlock({ moments: [], shipped: [{ identifier: 'ENG-1', title: 'Search', kind: 'action' }], docs: [], slow: false })).toContain('- ENG-1 Search')
    expect(renderNewsletterBlock({ moments: [], shipped: [], docs: [], slow: false })).toContain('Dial8 never sends it')
  })

  it('the issue lands as a document private to the loop’s owner until they share it', () => {
    const src = readFileSync(resolve(__dirname, '../run-skill.ts'), 'utf8')
    expect(src).toContain("return { block: renderNewsletterBlock(week), privateReport: true }")
    expect(src).toContain("if (spec.privateReport && member?.id) insert.visibility = 'private'")
  })

  it('holds no backslash', () => {
    expect(raw).not.toContain('\\')
  })
})
