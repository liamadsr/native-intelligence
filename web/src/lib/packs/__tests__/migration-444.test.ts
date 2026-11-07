/**
 * Migration 444 (GEN-1166): the mail playbooks can tidy the inbox. Pinned:
 * two text-only rows; every line but the rewritten and added ones is 338's
 * byte for byte, in order; nothing says the agent can't archive or label;
 * every tidying line says "main chat" (loops, background runs and helpers
 * hold neither tool); no backslash; an idempotent update.
 */
import { describe, it, expect } from 'vitest'
import { promptRewrites, readMigration } from './playbook-seeds'

const FILE = '444_mail_playbooks_tidy.sql'
const sql = readMigration(FILE)
const rows = promptRewrites(FILE)
const before = (id: string) => promptRewrites('338_skill_helper_lines.sql').find((r) => r.id === id)!.prompt

const MAIL = '1534bd72-4cd1-4a53-b14a-a8fe8c4a0fb4'
const CLEAR = '72cc7391-28bf-46ef-a0f2-6206bfb5de64'

/**
 * Each text's change: the lines of 338's text it rewrites (by how they start)
 * and the new lines it inserts. Removing the inserted lines and putting the
 * rewritten ones back gives 338's text.
 */
const CHANGES: Record<string, { rewritten: readonly string[]; added: readonly string[] }> = {
  [MAIL]: {
    rewritten: ['2. Three piles, said in this order', '- Sending is a human act.'],
    added: ['Tidying, when the person asks', '- Pass the `thread_ids`', '- It applies at once', '- More than ten threads', '- Unsubscribing:'],
  },
  [CLEAR]: {
    rewritten: ['You can read, sort and draft'],
    added: ['5. In the main chat, offer once to archive'],
  },
}

describe('migration 444', () => {
  it('rewrites only the Mail core and clear-inbox, by id and slug', () => {
    expect(rows.map((r) => [r.id, r.slug])).toEqual([[MAIL, 'mail-playbook'], [CLEAR, 'clear-inbox']])
  })

  for (const id of [MAIL, CLEAR]) {
    it(`keeps every other line of 338's text in order (${id})`, () => {
      const { rewritten, added } = CHANGES[id]
      const after = rows.find((r) => r.id === id)!.prompt.split('\n')
      const old = before(id).split('\n')
      const isAdded = (line: string) => added.some((start) => line.startsWith(start))
      // The blank line before the Tidying block is added with it.
      const kept = after.filter((line, i) => !isAdded(line) && !(line === '' && after[i + 1]?.startsWith('Tidying,')))
      expect(kept).toHaveLength(old.length)
      old.forEach((line, i) => {
        if (rewritten.some((start) => line.startsWith(start))) expect(kept[i], line).not.toBe(line)
        else expect(kept[i]).toBe(line)
      })
      expect(old.filter((line) => rewritten.some((start) => line.startsWith(start)))).toHaveLength(rewritten.length)
      expect(after.filter(isAdded)).toHaveLength(added.length)
    })
  }

  it('says the agent tidies in the main chat, never sends or deletes, and never that it cannot archive', () => {
    for (const { prompt } of rows) {
      expect(prompt).not.toMatch(/can't (send, )?archive/)
      expect(prompt).not.toMatch(/archive, label,? (or )?delete/)
      expect(prompt).toContain('update_email_thread')
      expect(prompt).toContain('main chat')
      expect(prompt).toContain('confirmed_with_user')
    }
    const mail = rows.find((r) => r.id === MAIL)!.prompt
    expect(mail).toContain("you can't send or delete mail")
    expect(mail).toContain('Archive, label, mute or unsubscribe only what the person asked for or agreed to.')
    expect(mail).toContain('It becomes their approval card just below your message and runs only when they accept')
    expect(mail).toContain('Never on a thread that looks like phishing.')
  })

  it('updates only where the text differs, and has no backslash', () => {
    expect(sql).toContain('AND r.system_prompt IS DISTINCT FROM p.system_prompt;')
    expect(sql.match(/AND r\.is_system/g)).toHaveLength(1)
    expect(sql).not.toContain('\\')
  })
})
