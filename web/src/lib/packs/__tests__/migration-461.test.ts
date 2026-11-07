/**
 * Migration 461 (roadmap D1/D2): the outreach playbooks teach the launch.
 * Pinned: three text-only rows; every line but the rewritten and added ones
 * is the earlier text's byte for byte, in order; nothing says there is no
 * launch tool or that a campaign never sends; the launch is always the
 * person's yes; no backslash; an idempotent update.
 */
import { describe, it, expect } from 'vitest'
import { promptRewrites, readMigration, seededSkills } from './playbook-seeds'

const FILE = '461_outreach_launch_playbooks.sql'
const sql = readMigration(FILE)
const rows = promptRewrites(FILE)

const SEQUENCES = '1438190a-646d-4709-ae89-22e24ddf340b'
const CAMPAIGNS = '48b8e8bd-2299-43b2-9a65-f9928a232b90'
const LAUNCH = '287cbaef-c539-42b2-84be-3cbfef7a88ec'

/** The text each row rewrites: 338's for the two cores, 326's for the recipe. */
function before(id: string): string {
  const from338 = promptRewrites('338_skill_helper_lines.sql').find((r) => r.id === id)
  if (from338) return from338.prompt
  return seededSkills('326_crm_outreach_skills.sql').find((s) => s.id === id)!.prompt
}

/** Each text's change: the earlier lines it rewrites (by how they start) and the lines it adds. */
const CHANGES: Record<string, { rewritten: readonly string[]; added: readonly string[] }> = {
  [SEQUENCES]: {
    rewritten: ['- A sequence is draft, active, paused or archived.', 'Recipe: `launch-a-sequence`', 'Enrolling: `enroll_contacts_in_sequence`', "- A draft can't be started", '- Enrolling into a live sequence'],
    added: ['- Call `launch_sequence` once'],
  },
  [CAMPAIGNS]: {
    rewritten: ['- What the tools really do:', '- `update_campaign` changes only the fields you pass.'],
    added: ['- A campaign can also send:', '4. Win back quiet customers'],
  },
  [LAUNCH]: {
    rewritten: [
      "From a chosen sequence to the person's launch.",
      '## 4. The launch is theirs',
      '- Say exactly what will send and when',
      '- Then hand it over:',
      '- On a sequence already live',
      '- A paused sequence:',
      'The sequence, who went in and who was skipped',
    ],
    added: [],
  },
}

describe('migration 461', () => {
  it('rewrites only the Sequences and Campaigns cores and launch-a-sequence, by id and slug', () => {
    expect(rows.map((r) => [r.id, r.slug])).toEqual([
      [SEQUENCES, 'sequences-playbook'],
      [CAMPAIGNS, 'campaigns-playbook'],
      [LAUNCH, 'launch-a-sequence'],
    ])
  })

  for (const id of [SEQUENCES, CAMPAIGNS, LAUNCH]) {
    it(`keeps every other line of the earlier text in order (${id})`, () => {
      const { rewritten, added } = CHANGES[id]
      const after = rows.find((r) => r.id === id)!.prompt.split('\n')
      const old = before(id).split('\n')
      const isAdded = (line: string) => added.some((start) => line.startsWith(start))
      const kept = after.filter((line) => !isAdded(line))
      expect(kept).toHaveLength(old.length)
      old.forEach((line, i) => {
        if (rewritten.some((start) => line.startsWith(start))) expect(kept[i], line).not.toBe(line)
        else expect(kept[i]).toBe(line)
      })
      expect(old.filter((line) => rewritten.some((start) => line.startsWith(start)))).toHaveLength(rewritten.length)
      expect(after.filter(isAdded)).toHaveLength(added.length)
    })
  }

  it('teaches the launch as the person\'s yes, and never that there is no launch tool', () => {
    for (const { prompt } of rows) {
      expect(prompt).not.toMatch(/no launch tool/i)
      expect(prompt).not.toMatch(/Nothing here sends, picks an audience/)
      expect(prompt).toMatch(/yes/)
    }
    const seq = rows.find((r) => r.id === SEQUENCES)!.prompt
    expect(seq).toContain('`launch_sequence` gives them one card with every email')
    expect(seq).toContain('by texting back its code')
    expect(seq).toContain('never claim it launched before the tool says so')
    const camp = rows.find((r) => r.id === CAMPAIGNS)!.prompt
    expect(camp).toContain('`launch_campaign` gives the person one card with every email and every recipient')
    expect(camp).toContain('`recipe` win_back')
    expect(camp).toContain('Pausing a rolling campaign stops its weekly cards.')
    const launch = rows.find((r) => r.id === LAUNCH)!.prompt
    expect(launch).toContain('`launch_sequence` with `sequence_id`. It sends nothing')
    expect(launch).toContain('never write one yourself')
    // The resume-first rule stays (227: Review & launch on a paused sequence restarts everyone).
    expect(launch).toContain('"Set it up and launch it" is not that yes.')
  })

  it('updates only where the text differs, and has no backslash', () => {
    expect(sql).toContain('AND r.system_prompt IS DISTINCT FROM p.system_prompt;')
    expect(sql.match(/AND r\.is_system/g)).toHaveLength(1)
    expect(sql).not.toContain('\\')
  })
})
