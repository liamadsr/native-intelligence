/**
 * Migration 400: the flows playbooks say a loop the person asks for is on
 * (Liam, 2026-10-20). Pins: every sentence it replaces is word for word in
 * the text that ships today (so the replace() lands), the replaced text
 * teaches the new rule (asked for: `enabled` true; suggested: saved off and
 * asked once; a webhook: the person's card), no new sentence contains an old
 * one (a second run changes nothing), each UPDATE is fenced to its system
 * row, and no backslash anywhere.
 */
import { describe, it, expect } from 'vitest'
import { allShippedSkills, readMigration } from './playbook-seeds'

const SQL = readMigration('400_flows_asked_for_loops_on.sql')
const PAIRS = [...SQL.matchAll(/\$o\$([^$]*)\$o\$,\s*\$n\$([^$]*)\$n\$/g)].map((m) => ({ old: m[1], next: m[2] }))
const shipped = (slug: string) => allShippedSkills().find((s) => s.slug === slug)!
const SHIPPED_324_DESC = readMigration('324_workflows_skill.sql')

/** The text as 400 leaves it. */
function after(text: string): string {
  return PAIRS.reduce((t, p) => t.split(p.old).join(p.next), text)
}

describe('migration 400', () => {
  it('replaces six sentences, each word for word in what ships now', () => {
    expect(PAIRS).toHaveLength(6)
    const sources = [shipped('flows-playbook').prompt, shipped('build-a-workflow').prompt, SHIPPED_324_DESC].join('\n')
    for (const p of PAIRS) expect(sources.includes(p.old), p.old.slice(0, 60)).toBe(true)
  })

  it('the playbooks then teach: asked for is on, suggested is asked once, a webhook takes the card', () => {
    const core = after(shipped('flows-playbook').prompt)
    const recipe = after(shipped('build-a-workflow').prompt)
    for (const text of [core, recipe]) {
      expect(text).not.toMatch(/saved off\.|every loop is saved off|ask once after they've seen the summary/i)
      expect(text).toMatch(/`enabled` true/)
      expect(text).toMatch(/http_post \(webhook\) step/)
      expect(text).toContain('`update_flow` with')
    }
    expect(core).toContain('A loop the person asks for (or says yes to when you offer it) is created on')
    expect(recipe).toContain('The person asked for it, so it is on as soon as it is built.')
    expect(recipe).toMatch(/Never set `confirmed_with_user` without that yes/)
  })

  it('is idempotent: no new sentence holds an old one, and each update is fenced on an old one', () => {
    for (const p of PAIRS) for (const q of PAIRS) expect(p.next.includes(q.old)).toBe(false)
    expect(SQL).toMatch(/WHERE id = '1ef0c12f-5d78-41ef-ab12-714512fa03cd'::uuid\s+AND slug = 'flows-playbook'\s+AND is_system\s+AND strpos/)
    expect(SQL).toMatch(/WHERE id = 'a1c4ac7d-4b00-4af4-a97e-1c79abaed9b3'::uuid\s+AND slug = 'build-a-workflow'\s+AND is_system\s+AND \(strpos/)
  })

  it('touches only those two rows, and has no backslash', () => {
    expect(SQL.match(/^UPDATE public\.recipe/gm)).toHaveLength(2)
    expect(SQL.includes('\\')).toBe(false)
  })
})
