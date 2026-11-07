/**
 * The system-skill migrations (225 /create-skill, 253 /create-eval) each carry
 * the SAME prompt twice: once in the idempotent INSERT and once in the
 * unconditional UPDATE that follows it. Only the UPDATE runs on a database that
 * already has the row — which is every environment after the first apply.
 *
 * So a prompt edit made in only one copy is invisible: DEV picks up whichever
 * half was applied first, PROD picks up the UPDATE, and the two drift with no
 * error anywhere. This test compares the two dollar-quoted bodies byte for byte
 * so an edit to one half fails here instead of shipping a stale prompt.
 *
 * It also pins the tool names the /create-eval prompt steers by: `get_agent`
 * only became real when the chat library tools grew read-only agent lookups,
 * and the prompt is the only thing telling the model to reach for it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')

/** Pull the body of a `$tag$ ... $tag$` dollar-quoted literal. */
function dollarQuoted(sql: string, tag: string): string {
  const open = `$${tag}$`
  const start = sql.indexOf(open)
  expect(start, `missing ${open} block`).toBeGreaterThan(-1)
  const from = start + open.length
  const end = sql.indexOf(open, from)
  expect(end, `unterminated ${open} block`).toBeGreaterThan(-1)
  return sql.slice(from, end)
}

const CASES = [
  { file: '253_create_eval_skill.sql', label: '/create-eval' },
  { file: '225_create_skill_system_skill.sql', label: '/create-skill' },
  { file: '381_create_call_playbook_skill.sql', label: '/create-call-playbook' },
]

describe.each(CASES)('$label system-skill migration', ({ file }) => {
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8')

  it('INSERT and UPDATE carry byte-identical prompts', () => {
    expect(dollarQuoted(sql, 'uprompt')).toBe(dollarQuoted(sql, 'prompt'))
  })

  it('INSERT and UPDATE carry byte-identical agent_config', () => {
    expect(dollarQuoted(sql, 'ucfg')).toBe(dollarQuoted(sql, 'cfg'))
  })
})

describe('/create-eval prompt steers at real tools', () => {
  const prompt = dollarQuoted(
    readFileSync(join(MIGRATIONS, '253_create_eval_skill.sql'), 'utf8'),
    'uprompt',
  )

  it('names the agent path and the skill path separately', () => {
    expect(prompt).toContain('`list_agents`')
    expect(prompt).toContain('`get_agent`')
    expect(prompt).toContain('`list_skills`')
    expect(prompt).toContain('`get_skill`')
  })

  it('tells the model to stop rather than keep hunting for a reader tool', () => {
    // The failure this replaced: ~12 search_tools calls looking for a get_agent
    // that did not exist, then cases written from the catalog description.
    expect(prompt).toMatch(/cannot be read, say so once/)
  })
})

describe('/create-call-playbook prompt steers at real tools', () => {
  const prompt = dollarQuoted(readFileSync(join(MIGRATIONS, '381_create_call_playbook_skill.sql'), 'utf8'), 'uprompt')

  it('saves through create_skill with call_playbook, and revises through update_skill', () => {
    expect(prompt).toContain('`create_skill` with `call_playbook: true`')
    expect(prompt).toContain('`update_skill`')
    expect(prompt).toContain('`get_skill`')
  })

  it('names the built-ins it can start from, as call-playbooks.ts has them', async () => {
    const { BUILT_IN_CALL_PLAYBOOKS, MAX_PLAYBOOK_BODY_CHARS } = await import('@/lib/live-agent/call-playbooks')
    for (const p of BUILT_IN_CALL_PLAYBOOKS) expect(prompt).toContain(`\`${p.name}\``)
    expect(prompt).toContain(`over ${MAX_PLAYBOOK_BODY_CHARS}`)
  })
})
