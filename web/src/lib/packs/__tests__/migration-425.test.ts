/**
 * Migration 425 (cloud browser C5): the Browser core for the cloud browser.
 * Pinned: one text-only row and one description; every line but the
 * rewritten ones is 338's byte for byte; nothing says the desktop app, the
 * in-app browser or the Agent panel; no backslash; idempotent updates.
 */
import { describe, it, expect } from 'vitest'
import { promptRewrites, readMigration } from './playbook-seeds'

const FILE = '425_browser_playbook_cloud.sql'
const ID = 'eec790ec-399f-416d-8189-c883859ba8c3'
const sql = readMigration(FILE)
const rows = promptRewrites(FILE)
const before = promptRewrites('338_skill_helper_lines.sql').find((r) => r.id === ID)!.prompt

/** The lines 425 rewrites, by how each starts in 338's text. */
const REWRITTEN = [
  'How the in-app browser works in Dial8',
  '- A browser inside the Dial8 desktop app',
  '4. `open_browser` and `close_browser`',
  '- Cancelled: stop. Hard stops',
  '- Sites the person blocked are off limits',
  '- It never types passwords',
  "- Anything that sends, buys, deletes or submits waits for the person's OK",
]

describe('migration 425', () => {
  it('rewrites only the Browser core, by its id and slug', () => {
    expect(rows.map((r) => [r.id, r.slug])).toEqual([[ID, 'browser-playbook']])
  })

  it('keeps every other line of 338’s text, in order', () => {
    const after = rows[0].prompt.split('\n')
    const old = before.split('\n')
    expect(after).toHaveLength(old.length)
    old.forEach((line, i) => {
      if (REWRITTEN.some((start) => line.startsWith(start))) expect(after[i], line).not.toBe(line)
      else expect(after[i]).toBe(line)
    })
    expect(old.filter((line) => REWRITTEN.some((start) => line.startsWith(start)))).toHaveLength(REWRITTEN.length)
  })

  it('describes the cloud browser: the live view, take over, the Mac, approval cards', () => {
    const text = rows[0].prompt
    for (const gone of ['desktop app', 'in-app', 'Agent panel', 'browser card']) expect(text).not.toContain(gone)
    expect(text).toContain('a Chrome in the cloud, one for each person and workspace')
    expect(text).toContain('the computer card in their side panel')
    expect(text).toContain('While their Mac is online, sites see their own connection')
    expect(text).toContain('Agent browser feature')
    expect(text).toContain("under Blocked sites in their agent's computer (its live view)")
    expect(text).toContain('takes the browser over and signs in or pays themselves')
    expect(text).toContain("waits for the person's OK on an approval card")
  })

  it('drops "in-app" from the description, and updates both only where they differ', () => {
    const desc = sql.match(/SET description = \$desc\$([\s\S]*?)\$desc\$/)![1]
    expect(desc).not.toContain('in-app')
    expect(desc).toMatch(/^How your browser works in Dial8/)
    expect(sql).toContain('AND r.system_prompt IS DISTINCT FROM p.system_prompt;')
    expect(sql).toContain(`AND description IS DISTINCT FROM $desc$${desc}$desc$;`)
    expect(sql.match(/AND (r\.)?is_system/g)).toHaveLength(2)
  })

  it('has no backslash (the MCP transport decodes unicode escapes)', () => {
    expect(sql).not.toContain('\\')
  })
})
