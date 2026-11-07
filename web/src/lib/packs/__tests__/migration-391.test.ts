/**
 * Migration 391 (P9): the content and marketing playbooks teach the recipes
 * by name. Pinned: two text-only rows; every recipe they name exists; the
 * Typefully approval card is the only other way a post goes out; nothing is
 * on by default; every other line byte for byte as 384/385 left it.
 */
import { describe, it, expect } from 'vitest'
import { FLOW_RECIPES } from '@/lib/flows/recipes'
import { promptRewrites, readMigration, seededSkills } from './playbook-seeds'

const FILE = '391_playbooks_teach_recipes.sql'
const rows = promptRewrites(FILE)
const by = (slug: string) => rows.find((r) => r.slug === slug)!

/** The lines of a text outside one section, and minus the lines in `changed`. */
function untouched(text: string, section: string, changed: readonly string[] = []): string[] {
  const start = text.indexOf(section)
  const end = text.indexOf('\n## ', start + 1)
  return (text.slice(0, start) + text.slice(end)).split('\n').filter((l) => !changed.some((c) => l.startsWith(c)))
}

describe('migration 391', () => {
  it('rewrites only the two playbooks, by their ids and slugs', () => {
    const c = seededSkills('384_content_area_skills.sql').find((r) => r.slug === 'content-playbook')!
    const m = seededSkills('385_marketing_skills.sql').find((r) => r.slug === 'marketing-playbook')!
    expect(rows.map((r) => [r.id, r.slug])).toEqual([[c.id, 'content-playbook'], [m.id, 'marketing-playbook']])
  })

  it('names every recipe it teaches, and each exists', () => {
    const named = new Set(rows.flatMap((r) => [...r.prompt.matchAll(/`([a-z_]+)`/g)].map((x) => x[1])).filter((w) => (FLOW_RECIPES as readonly string[]).includes(w)))
    // small_bug_draft_prs and ci_fix_loop (P10) are coding recipes, not content
    // or marketing ones: the chat agent's prompt teaches them, not these playbooks.
    expect([...named].sort()).toEqual(FLOW_RECIPES.filter((r) => r !== 'small_bug_draft_prs' && r !== 'ci_fix_loop').sort())
    for (const r of rows) {
      expect(r.prompt, r.slug).toMatch(/## Recipes \(only when they ask; nothing is seeded for anyone\)/)
      // P12 (Liam, 2026-10-20): what the person asks for is on, built in one call.
      expect(r.prompt, r.slug).toMatch(/its `recipe` and `enabled` true: they asked, so it is on/)
      expect(r.prompt, r.slug).toMatch(/that they can switch it off/)
      expect(r.prompt, r.slug).not.toMatch(/only after their yes/)
    }
  })

  it('a post goes out only by the person: the post link, or their Typefully approval card', () => {
    const p = by('content-playbook').prompt
    expect(p).toMatch(/Nothing is ever published for them, now or later/)
    expect(p).toMatch(/on the approval card `publish_post` \(now\) or `schedule_post` \(their next free slot\) raises\. Neither runs in your turn/)
    expect(p).toMatch(/Dial8 never sends a newsletter/)
    expect(by('marketing-playbook').prompt).toMatch(/its grade rises with the evidence/)
  })

  it('keeps every other line as 384 and 385 wrote it', () => {
    const c384 = seededSkills('384_content_area_skills.sql').find((r) => r.slug === 'content-playbook')!.prompt
    const m385 = seededSkills('385_marketing_skills.sql').find((r) => r.slug === 'marketing-playbook')!.prompt
    expect(untouched(by('content-playbook').prompt, '## Recipes', ['- Dial8 drafts; the person posts.'])).toEqual(untouched(c384, '## Recipes', ['- Dial8 drafts; the person posts.']))
    expect(untouched(by('marketing-playbook').prompt, '## Recipes')).toEqual(untouched(m385, '## Recipes'))
  })

  it('holds no backslash', () => {
    expect(readMigration(FILE)).not.toContain('\\')
  })
})
