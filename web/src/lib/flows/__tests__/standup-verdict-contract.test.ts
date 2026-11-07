/**
 * Migration 194 (Standup Sync → verdict contract) shape tests.
 *
 * The migration is the ONLY thing that turns the Standup Sync system skill into a
 * verdict-class loop — there is no engine change behind Standup v2, so the config
 * it writes IS the feature. These parse the migration SQL directly and assert:
 *   1. it is an idempotent natural-key UPDATE on the system Standup row (matching
 *      the 166/Triage template exactly, so an arm never hits a workspace copy);
 *   2. the agent_config it writes is a well-formed verdict contract — output_contract
 *      'verdict', a read-only enabled_tools scope, and NO mutating tool in
 *      preferred_tools (the model decides; the engine applies);
 *   3. the read-only enabled_tools scope, run through the REAL ceiling builder,
 *      leaks no mutating tool and still surfaces the reads + submit_run_verdict the
 *      skill needs — i.e. the contract the migration declares is actually runnable.
 *
 * Reading the .sql is deliberate: it is the artifact that ships. A hand-mirrored
 * copy of the JSON in the test would let the two drift.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeSkillCeiling } from '../run-skill'
import { getMutatingToolNames } from '@/lib/ai/tool-registry'

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8')
}

/**
 * Pull a dollar-quoted body out of a migration by its tag (e.g. $sv2_cfg$…$sv2_cfg$).
 * Migrations use dollar-quoting so the prompt/JSON can contain any punctuation;
 * the tag is unique per migration.
 */
function extractDollarQuoted(sql: string, tag: string): string {
  const delim = `$${tag}$`
  const start = sql.indexOf(delim)
  expect(start, `opening ${delim} present`).toBeGreaterThanOrEqual(0)
  const bodyStart = start + delim.length
  const end = sql.indexOf(delim, bodyStart)
  expect(end, `closing ${delim} present`).toBeGreaterThan(bodyStart)
  return sql.slice(bodyStart, end)
}

interface VerdictAgentConfig {
  output_contract?: string
  enabled_tools?: string[]
  preferred_tools?: string[]
  disabled_tools?: string[]
  context_rules?: string[]
}

describe('migration 194 — Standup Sync verdict contract', () => {
  const sql = readMigration('194_standup_verdict_contract.sql')

  it('is an idempotent natural-key UPDATE on the SYSTEM Standup row (matches the 166 template)', () => {
    // Exactly one UPDATE, keyed by is_system + slug — same shape as migration 166,
    // so it touches the single system row on every environment and never a
    // workspace copy. (The arm-time trap the migration comment documents.)
    expect(sql).toMatch(/update\s+recipe\s+set/i)
    expect(sql).toMatch(/where\s+is_system\s*=\s*true\s+and\s+slug\s*=\s*'standup-sync'/i)
    // No INSERT / DELETE / DDL — a pure, re-runnable UPDATE.
    expect(sql).not.toMatch(/\binsert\s+into\b/i)
    expect(sql).not.toMatch(/\bdelete\s+from\b/i)
    expect(sql).not.toMatch(/\b(create|drop|alter)\s+(table|index|type)\b/i)
    // Sets exactly the three columns the flip needs.
    expect(sql).toMatch(/system_prompt\s*=/i)
    expect(sql).toMatch(/agent_config\s*=/i)
    expect(sql).toMatch(/updated_at\s*=\s*now\(\)/i)
  })

  it('keys the SAME natural-key column pair as the 166 Triage template', () => {
    const triage = readMigration('166_triage_verdict_contract.sql')
    const keyRe = /where\s+is_system\s*=\s*true\s+and\s+slug\s*=\s*'([a-z-]+)'/i
    const standupKey = sql.match(keyRe)
    const triageKey = triage.match(keyRe)
    expect(standupKey?.[1]).toBe('standup-sync')
    expect(triageKey?.[1]).toBe('triage')
  })

  const cfg = JSON.parse(extractDollarQuoted(sql, 'sv2_cfg')) as VerdictAgentConfig

  it('declares the verdict output contract', () => {
    expect(cfg.output_contract).toBe('verdict')
  })

  it('scopes enabled_tools to the read-only standup surface', () => {
    // The categories the standup prompt actually reads from — the same shape the
    // 159 prose skill had (captures/actions/search/projects/comments), minus the
    // mutating tools the verdict ceiling denies. Categories are declarative; the
    // ceiling test below proves they resolve to a read-only permit set.
    expect(new Set(cfg.enabled_tools)).toEqual(
      new Set(['captures', 'actions', 'search', 'projects', 'comments']),
    )
  })

  it('lists NO mutating tool in preferred_tools — the model decides, the engine applies', () => {
    const mutating = getMutatingToolNames()
    const preferred = cfg.preferred_tools ?? []
    const leaked = preferred.filter((t) => mutating.has(t))
    expect(leaked, `preferred_tools leaked mutators: ${leaked.join(', ')}`).toEqual([])
    // The old prose skill steered the model to update_action/complete_action/
    // add_comment; the verdict skill must NOT — those are the engine's job now.
    for (const banned of ['update_action', 'complete_action', 'add_comment', 'create_action']) {
      expect(preferred).not.toContain(banned)
    }
    // It DOES surface the one write it's allowed: submit_run_verdict.
    expect(preferred).toContain('submit_run_verdict')
  })

  it('the declared read-only scope is actually runnable — ceiling leaks no mutator, keeps the reads it needs', () => {
    // Run the REAL ceiling builder on the migration's enabled_tools with the
    // verdict contract. Verdict runs on the report ceiling regardless of mode.
    const ceiling = computeSkillCeiling(
      { enabled_tools: cfg.enabled_tools, output_contract: 'verdict' },
      'act',
      true, // a standup fire carries a triggering capture
    )
    expect(ceiling).not.toBeNull()
    const set = ceiling!
    // No mutating tool survives.
    const mutating = getMutatingToolNames()
    expect([...set].filter((n) => mutating.has(n))).toEqual([])
    // The single write is the verdict terminator.
    expect(set.has('submit_run_verdict')).toBe(true)
    // The reads the prompt leans on are reachable.
    for (const read of [
      'get_capture_content',
      'get_capture_transcript',
      'get_capture_extractions',
      'list_actions',
      'list_workflow_states',
    ]) {
      expect(set.has(read), `${read} reachable`).toBe(true)
    }
    // And the mutators the old prose skill used are NOT.
    for (const banned of ['update_action', 'complete_action', 'create_action']) {
      expect(set.has(banned), `${banned} denied`).toBe(false)
    }
  })

  it('the system_prompt encodes the two load-bearing v2 rules (attribution + tiny surfaced set)', () => {
    const prompt = extractDollarQuoted(sql, 'sv2_prompt')
    // C3 attribution: is_mine_explicit gates on the run-as user's OWN first-person
    // statement; teammate-reported moves card.
    expect(prompt).toMatch(/is_mine_explicit/)
    expect(prompt).toMatch(/first person/i)
    expect(prompt).toMatch(/teammate/i)
    // The verdict IS the deliverable — submit_run_verdict, once.
    expect(prompt).toMatch(/submit_run_verdict/)
    // The 0-2 surfaced-items principle (cards only for what genuinely needs the user).
    expect(prompt).toMatch(/needs_user/)
    expect(prompt).toMatch(/0-2|tiny/i)
    // The reconciler-not-creator invariant survives from the prose skill.
    expect(prompt).toMatch(/reconciler/i)
  })
})
