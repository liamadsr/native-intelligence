/**
 * Migration 386 (P8 wiring): the lens skills point at the content and
 * marketing playbooks. Text only: each prompt is 382's word for word plus one
 * paragraph, on 382's ids and slugs, updated only where it differs.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { seededSkills } from '@/lib/packs/__tests__/playbook-seeds'

const sql = readFileSync(join(process.cwd(), 'supabase/migrations/386_lens_skills_point_at_playbooks.sql'), 'utf8')
const before = seededSkills('382_lens_skills.sql')
const rows = [...sql.matchAll(/\(\s*'([0-9a-f-]{36})'::uuid,\s*\$slug\$([a-z-]+)\$slug\$,\s*\$pb\$([\s\S]*?)\$pb\$\s*\)/g)].map((m) => ({ id: m[1], slug: m[2], prompt: m[3] }))

describe('migration 386', () => {
  it('rewrites exactly 382’s two lens skills, by id and slug', () => {
    expect(rows.map((r) => [r.id, r.slug])).toEqual(before.map((b) => [b.id, b.slug]))
  })

  it('keeps 382’s text word for word and adds one paragraph naming the playbook', () => {
    for (const r of rows) {
      const old = before.find((b) => b.id === r.id)!.prompt
      expect(r.prompt.startsWith(`${old}\n\n`), r.slug).toBe(true)
      const added = r.prompt.slice(old.length + 2)
      expect(added.split('\n\n'), r.slug).toHaveLength(1)
    }
    expect(rows[0].prompt).toMatch(/\(content-playbook\)/)
    expect(rows[1].prompt).toMatch(/\(marketing-playbook\)/)
    expect(rows[1].prompt).toMatch(/grades your lines as an assumption/)
    expect(rows[1].prompt).toMatch(/Never write a grade/)
  })

  it('changes only the text, only where it differs, and has no backslash', () => {
    expect(sql).toMatch(/SET system_prompt = p\.system_prompt,\s+updated_at\s+= now\(\)\s+FROM skill AS p/)
    expect(sql).toMatch(/AND r\.slug = p\.slug/)
    expect(sql).toMatch(/AND r\.system_prompt IS DISTINCT FROM p\.system_prompt;/)
    expect(sql).not.toMatch(/INSERT INTO|agent_config\s*=|description\s*=/)
    expect(sql).not.toContain('\\')
  })
})
