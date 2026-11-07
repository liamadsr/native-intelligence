/**
 * The migrations' CHECK constraints and the const arrays in
 * `src/lib/prospecting/types.ts` describe the SAME vocabularies. The compiler
 * cannot see the SQL, so drift between them is silent until a production
 * INSERT returns 23514 — the class of failure
 * `sequence-view-registration.test.ts` pins for the sequence status enum, done
 * here by reading the migration text directly so every enum is covered at once.
 *
 * 248 is the CURRENT definition of every vocabulary EXCEPT `suppressed_by`:
 * migration 251 dropped and re-added that constraint to add `over_cap` and
 * `noise_host`, so 251 is what `PROSPECT_SUPPRESSION_SOURCES` must match and
 * 248's copy of the list is now history. That is why the `suppressed_by` case
 * is pulled out of the generic table below rather than left in it — left
 * there, it would pin the array to the OLD list and fail the moment the
 * feature gained a reason.
 *
 * These tests read the files; they never touch a database.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  PROSPECTING_RUN_KINDS,
  PROSPECTING_RUN_STAGES,
  PROSPECTING_RUN_STATUSES,
  PROSPECT_CANDIDATE_OUTCOMES,
  PROSPECT_DISMISSED_REASONS,
  PROSPECT_ENTRY_KINDS,
  PROSPECT_ENTRY_STAGES,
  PROSPECT_EXCLUDE_CONTACTED,
  PROSPECT_GLOBAL_DISMISS_REASONS,
  PROSPECT_IDENTITY_STATES,
  PROSPECT_LIST_PURPOSES,
  PROSPECT_LIST_STATUSES,
  PROSPECT_SUPPRESSION_SOURCES,
  type ProspectingRunCounts,
} from '../types'

const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase/migrations/248_prospecting.sql'),
  'utf8',
)

/**
 * Pull the value list out of `<column> ... CHECK (<column> IN ('a','b',…))`.
 * Column definitions in 248 wrap across lines, so whitespace and newlines
 * inside the parenthesised list are tolerated. Returns the values in the order
 * the SQL declares them — order is asserted too, so the board columns and the
 * migration cannot disagree about lifecycle order either.
 */
function checkValues(column: string): string[] {
  const re = new RegExp(
    `CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`,
    'i',
  )
  const m = MIGRATION.match(re)
  if (!m) throw new Error(`No CHECK (… IN …) found for column "${column}" in 248_prospecting.sql`)
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1])
}

describe('248_prospecting.sql CHECK constraints are in lockstep with types.ts', () => {
  const cases: Array<[string, readonly string[]]> = [
    ['purpose', PROSPECT_LIST_PURPOSES],
    ['exclude_contacted', PROSPECT_EXCLUDE_CONTACTED],
    ['kind', PROSPECT_ENTRY_KINDS],
    ['stage', PROSPECT_ENTRY_STAGES],
    ['identity_state', PROSPECT_IDENTITY_STATES],
    ['dismissed_reason', PROSPECT_DISMISSED_REASONS],
    ['outcome', PROSPECT_CANDIDATE_OUTCOMES],
    // `suppressed_by` is NOT here — 251 supersedes 248 for that column. See
    // the 251 describe block below.
  ]

  for (const [column, values] of cases) {
    it(`${column} matches its const array, in order`, () => {
      expect(checkValues(column)).toEqual([...values])
    })
  }

  // `status`, `stage` and `kind` each appear on more than one table, so they
  // are matched positionally rather than by the generic single-match helper.
  it('prospect_list.status and prospecting_run.status both match their arrays', () => {
    const all = [...MIGRATION.matchAll(/CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)/gi)].map((m) =>
      [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]),
    )
    expect(all).toHaveLength(2)
    expect(all[0]).toEqual([...PROSPECT_LIST_STATUSES])
    expect(all[1]).toEqual([...PROSPECTING_RUN_STATUSES])
  })

  it('prospect_list_entry.stage and prospecting_run.stage both match their arrays', () => {
    const all = [...MIGRATION.matchAll(/CHECK\s*\(\s*stage\s+IN\s*\(([^)]*)\)/gi)].map((m) =>
      [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]),
    )
    expect(all).toHaveLength(2)
    expect(all[0]).toEqual([...PROSPECT_ENTRY_STAGES])
    expect(all[1]).toEqual([...PROSPECTING_RUN_STAGES])
  })

  it('prospect_list_entry.kind and prospecting_run.kind both match their arrays', () => {
    const all = [...MIGRATION.matchAll(/CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)/gi)].map((m) =>
      [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]),
    )
    expect(all).toHaveLength(2)
    expect(all[0]).toEqual([...PROSPECT_ENTRY_KINDS])
    expect(all[1]).toEqual([...PROSPECTING_RUN_KINDS])
  })
})

describe('cross-vocabulary invariants', () => {
  it('ProspectingRunCounts keys are exactly the suppressed_by enum', () => {
    // The counts blob is a per-reason tally; a reason with no key would be
    // recorded in prospect_run_candidate and vanish from the run summary.
    const counts: ProspectingRunCounts = {
      this_list: 0,
      crm: 0,
      other_list: 0,
      dismissed_global: 0,
      contacted: 0,
      opted_out: 0,
      self: 0,
      personal_domain: 0,
      over_cap: 0,
      noise_host: 0,
    }
    expect(Object.keys(counts).sort()).toEqual([...PROSPECT_SUPPRESSION_SOURCES].sort())
  })

  it('the workspace-wide dismissal reasons are a subset of dismissed_reason', () => {
    for (const reason of PROSPECT_GLOBAL_DISMISS_REASONS) {
      expect(PROSPECT_DISMISSED_REASONS).toContain(reason)
    }
    // Decision 3 scoped this to exactly two reasons; not_icp and too_small are
    // list-relative and must stay per-list.
    expect([...PROSPECT_GLOBAL_DISMISS_REASONS]).toEqual(['competitor', 'already_customer'])
  })

  it('prospecting_run.status is AgentRunStatus minus pr_open plus budget_exhausted', () => {
    // The divergence is deliberate and otherwise silent.
    expect(PROSPECTING_RUN_STATUSES).not.toContain('pr_open')
    expect(PROSPECTING_RUN_STATUSES).toContain('budget_exhausted')
  })
})

describe('248 structural guarantees the CHECK scan cannot see', () => {
  it('declares UNIQUE (list_id, candidate_key) — the dedup guarantee', () => {
    expect(MIGRATION).toMatch(
      /CREATE UNIQUE INDEX prospect_entry_key_idx\s+ON public\.prospect_list_entry \(list_id, candidate_key\)/,
    )
  })

  it('declares the workspace-wide candidate_key index the exclusion set reads', () => {
    expect(MIGRATION).toMatch(
      /CREATE INDEX prospect_entry_ws_key_idx\s+ON public\.prospect_list_entry \(workspace_id, candidate_key\)/,
    )
  })

  it('declares the (list_id, stage) index', () => {
    expect(MIGRATION).toMatch(
      /CREATE INDEX prospect_entry_list_stage_idx\s+ON public\.prospect_list_entry \(list_id, stage\)/,
    )
  })

  it('points company_id and contact_id at ON DELETE SET NULL, never CASCADE', () => {
    // A cascade would let one deleteCompaniesWithContacts() call wipe dozens
    // of dismissals across lists and re-open every one for re-billing.
    expect(MIGRATION).toMatch(
      /company_id\s+uuid REFERENCES public\.company\(id\) ON DELETE SET NULL/,
    )
    expect(MIGRATION).toMatch(
      /contact_id\s+uuid REFERENCES public\.contact\(id\) ON DELETE SET NULL/,
    )
  })

  it('refuses a second live run per list at the database', () => {
    expect(MIGRATION).toMatch(
      /CREATE UNIQUE INDEX prospecting_run_one_live_per_list\s+ON public\.prospecting_run \(list_id\) WHERE status IN \('queued','running'\)/,
    )
  })

  it('enforces the kind/target pairing', () => {
    expect(MIGRATION).toMatch(/CONSTRAINT prospect_entry_kind_target CHECK/)
    expect(MIGRATION).toMatch(/kind = 'company' AND contact_id IS NULL/)
    expect(MIGRATION).toMatch(/kind = 'person' AND company_id IS NULL/)
  })

  it('allows at most one workspace company', () => {
    expect(MIGRATION).toMatch(
      /CREATE UNIQUE INDEX company_one_workspace_company_idx\s+ON public\.company \(workspace_id\) WHERE is_workspace_company/,
    )
  })

  it('rebuilds contact.source from 210s list plus prospecting — member included', () => {
    const m = MIGRATION.match(/CHECK\s*\(source IN \(([\s\S]*?)\)\)/)
    expect(m).toBeTruthy()
    const values = [...m![1].matchAll(/'([^']*)'/g)].map((x) => x[1])
    // 210_hubspot_crm_integration.sql's seven, plus 'prospecting'. Dropping
    // 'member' (ensureMemberContact writes it for every self-contact) would
    // fail immediately on any real database.
    expect(values).toEqual([
      'manual',
      'email_sync',
      'calendar_sync',
      'capture_participant',
      'csv_import',
      'member',
      'hubspot_sync',
      'prospecting',
    ])
  })

  it('gives prospect_list_entry a repoint inside merge_contacts()', () => {
    expect(MIGRATION).toMatch(/CREATE OR REPLACE FUNCTION public\.merge_contacts\(/)
    expect(MIGRATION).toMatch(/UPDATE public\.prospect_list_entry[\s\S]*?SET contact_id = p_target/)
    expect(MIGRATION).toMatch(/DELETE FROM public\.prospect_list_entry WHERE contact_id = p_source/)
    // A merge must never un-dismiss a rejected person.
    expect(MIGRATION).toMatch(/SET stage\s+= 'dismissed'/)
  })

  it('KEEPS 227s sequence_enrollment blocks — 248 rebases on 227, not on 132', () => {
    // 227_sequences.sql is the CURRENT definition of merge_contacts(). Rebasing
    // 248's CREATE OR REPLACE on 132's older body silently DELETES 227's two
    // enrollment blocks, and every contact merge after that strands or
    // duplicate-keys sequence enrollments. Both blocks must survive verbatim.
    expect(MIGRATION).toMatch(
      /UPDATE public\.sequence_enrollment se\s+SET status = 'exited', exit_reason = 'removed', next_send_at = NULL/,
    )
    expect(MIGRATION).toMatch(
      /UPDATE public\.sequence_enrollment se\s+SET contact_id = p_target/,
    )
    // The email-keyed half of the collision guard is the subtle one.
    expect(MIGRATION).toMatch(/lower\(t\.contact_email\) = lower\(v_target\.email\)/)
  })

  it('runs the enrollment blocks BEFORE the email rebuild that clears v_target.email', () => {
    const enrollment = MIGRATION.indexOf("UPDATE public.sequence_enrollment se\n  SET status = 'exited'")
    const emails = MIGRATION.indexOf('v_emails := (')
    expect(enrollment).toBeGreaterThan(-1)
    expect(emails).toBeGreaterThan(-1)
    expect(enrollment).toBeLessThan(emails)
  })

  it("keeps 227's REVOKE, which includes `authenticated`", () => {
    expect(MIGRATION).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.merge_contacts\([^)]*\) FROM PUBLIC, anon, authenticated;/,
    )
  })

  it('gives every mutable table an updated_at trigger', () => {
    for (const table of ['prospect_list', 'prospect_list_entry']) {
      expect(MIGRATION).toMatch(
        new RegExp(
          `CREATE TRIGGER ${table}_updated_at\\s+BEFORE UPDATE ON public\\.${table}\\s+FOR EACH ROW EXECUTE FUNCTION public\\.update_updated_at\\(\\)`,
        ),
      )
    }
  })

  it('enables RLS on all four tables', () => {
    for (const table of [
      'prospect_list',
      'prospect_list_entry',
      'prospecting_run',
      'prospect_run_candidate',
    ]) {
      expect(MIGRATION).toMatch(
        new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`),
      )
    }
  })

  it('gates prospect_list DELETE on creator-or-admin', () => {
    expect(MIGRATION).toMatch(/CREATE POLICY prospect_list_creator_or_admin_delete[\s\S]*?FOR DELETE[\s\S]*?created_by = auth\.uid\(\)[\s\S]*?get_member_role\(workspace_id\) IN \('owner', 'admin'\)/)
  })

  it('adds no lifecycle column to company — candidates never reach that table', () => {
    // A `lifecycle` column would mean a filter in fourteen company-reading
    // surfaces forever, two of them SQL functions needing their own
    // migrations. Comment lines are stripped so the header's explanation of
    // WHY there is none does not trip the check.
    const sql = MIGRATION.split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
    expect(sql).not.toMatch(/lifecycle/i)
  })
})

describe('251_prospect_suppression_values.sql is the CURRENT suppressed_by definition', () => {
  const migration = readFileSync(
    join(process.cwd(), 'supabase/migrations/251_prospect_suppression_values.sql'),
    'utf8',
  )

  /** The re-added constraint's value list, in declaration order. */
  function values(): string[] {
    const m = migration.match(/CHECK \(suppressed_by IN\s*\(([\s\S]*?)\)\)/i)
    expect(m).toBeTruthy()
    return [...m![1].matchAll(/'([^']*)'/g)].map((x) => x[1])
  }

  it('matches PROSPECT_SUPPRESSION_SOURCES, in order', () => {
    expect(values()).toEqual([...PROSPECT_SUPPRESSION_SOURCES])
  })

  it('adds over_cap and noise_host', () => {
    // The two reasons that previously had to borrow a value that misdescribed
    // them: a person turned away by people_per_company was reported as
    // `this_list`, and a linkedin.com result host as `personal_domain`.
    expect(values()).toContain('over_cap')
    expect(values()).toContain('noise_host')
  })

  it('KEEPS every value 248 allowed — the constraint is cumulative', () => {
    // Dropping one would 23514 on the next insert of an existing reason, and
    // would strand the rows already written with it.
    const old = MIGRATION.match(/CHECK \(suppressed_by IN\s*\(([\s\S]*?)\)\)/i)
    expect(old).toBeTruthy()
    const previous = [...old![1].matchAll(/'([^']*)'/g)].map((x) => x[1])
    expect(previous.length).toBe(8)
    for (const value of previous) expect(values()).toContain(value)
  })

  it('drops the old constraint before adding the new one, and only ever with IF EXISTS', () => {
    // 248 declared the CHECK inline, so Postgres named it
    // `prospect_run_candidate_suppressed_by_check`. A DROP without IF EXISTS
    // would fail on any database where the generated name differs.
    expect(migration).toMatch(
      /ALTER TABLE public\.prospect_run_candidate\s+DROP CONSTRAINT IF EXISTS prospect_run_candidate_suppressed_by_check;/,
    )
    expect(migration).not.toMatch(/DROP CONSTRAINT(?! IF EXISTS)/)
    const drop = migration.lastIndexOf('DROP CONSTRAINT')
    const add = migration.indexOf('ADD CONSTRAINT')
    expect(drop).toBeGreaterThan(-1)
    expect(add).toBeGreaterThan(drop)
  })

  it('touches nothing but that one constraint', () => {
    // Retention (the prune cron) deletes candidate ROWS; this migration must
    // not, and must not rewrite the history already stored under
    // `personal_domain` on a guess about which of the two it was.
    const sql = migration
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
    expect(sql).not.toMatch(/\b(DELETE|UPDATE|DROP TABLE|TRUNCATE)\b/i)
  })
})

describe('250_view_scope_prospect_list.sql widens the scope CHECK', () => {
  const scopeMigration = readFileSync(
    join(process.cwd(), 'supabase/migrations/250_view_scope_prospect_list.sql'),
    'utf8',
  )

  it("adds 'prospect_list' to view_scope_type_check without dropping 233's values", () => {
    // The list-detail page passes viewScope {type:'prospect_list'}; without
    // this every saved view created inside a list fails with 23514.
    expect(scopeMigration).toMatch(/ALTER TABLE public\.view\s+DROP CONSTRAINT view_scope_type_check;/)
    const m = scopeMigration.match(/CHECK \(scope_type IS NULL OR scope_type IN \(([^)]*)\)\)/)
    expect(m).toBeTruthy()
    const values = [...m![1].matchAll(/'([^']*)'/g)].map((x) => x[1])
    expect(values).toEqual(['project', 'initiative', 'contact', 'company', 'prospect_list'])
  })

  it('is in lockstep with ViewScope["type"] in @/lib/views/types', () => {
    // Against the LATEST migration that rewrites this constraint, not 250.
    //
    // `view_scope_type_check` is rewritten wholesale by each widening — the
    // value list is CUMULATIVE, and each new file repeats everything the
    // previous one allowed. So the constraint the database actually holds is
    // the last file's, and pinning the TS union against 250 would fail the
    // moment a new scope type shipped (257 added 'eval_suite' for the suite
    // detail page's Cases and Runs tabs) even though nothing had drifted.
    //
    // What must stay true is the invariant, not the file number: the union in
    // types.ts and the CHECK in force are the same set. A `viewScope` the
    // database refuses fails every saved view made under it with a 23514.
    const values = latestScopeCheckValues().sort()
    const types = readFileSync(join(process.cwd(), 'src/lib/views/types.ts'), 'utf8')
    const union = types.match(
      /export interface ViewScope \{[\s\S]*?\n  type: ([^\n]+)\n/,
    )
    expect(union).toBeTruthy()
    const declared = [...union![1].matchAll(/'([^']*)'/g)].map((x) => x[1]).sort()
    expect(declared).toEqual(values)
  })

  it('every later widening KEEPS the values 250 allowed', () => {
    // The cumulative rule, asserted rather than trusted: a rewrite that
    // forgot a value would not error — it would orphan every saved view under
    // that scope, invisibly, until someone opened the page it belongs to.
    const latest = latestScopeCheckValues()
    for (const value of ['project', 'initiative', 'contact', 'company', 'prospect_list']) {
      expect(latest).toContain(value)
    }
  })
})

/**
 * The value list of the LAST migration that rewrites `view_scope_type_check`
 * — i.e. the constraint the database is actually holding.
 *
 * Migrations sort lexicographically here the way they do on disk; every file
 * in this repo is a zero-padded three-digit prefix, so ordinal and lexical
 * order agree.
 */
function latestScopeCheckValues(): string[] {
  const dir = join(process.cwd(), 'supabase/migrations')
  const rewrites = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) =>
      /ADD CONSTRAINT view_scope_type_check/.test(readFileSync(join(dir, f), 'utf8')),
    )
  expect(rewrites.length).toBeGreaterThan(0)
  const last = readFileSync(join(dir, rewrites[rewrites.length - 1]), 'utf8')
  const m = last.match(/CHECK \(scope_type IS NULL OR scope_type IN \(([^)]*)\)\)/)
  expect(m).toBeTruthy()
  return [...m![1].matchAll(/'([^']*)'/g)].map((x) => x[1])
}

describe('249_prospect_view_enum.sql stands alone', () => {
  const enumMigration = readFileSync(
    join(process.cwd(), 'supabase/migrations/249_prospect_view_enum.sql'),
    'utf8',
  )

  it('contains exactly the one ALTER TYPE statement', () => {
    expect(enumMigration).toMatch(
      /ALTER TYPE public\.view_entity_type ADD VALUE IF NOT EXISTS 'prospect_list_entry';/,
    )
    const statements = enumMigration
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('--'))
    // ALTER TYPE ... ADD VALUE cannot run in the transaction that uses the new
    // value, so it must be alone in its own file (230's precedent).
    expect(statements).toHaveLength(1)
  })
})

describe('255_prospect_list_view_enum.sql registers the list-of-lists entity', () => {
  const migration = readFileSync(
    join(process.cwd(), 'supabase/migrations/255_prospect_list_view_enum.sql'),
    'utf8',
  )
  const prior = readFileSync(
    join(process.cwd(), 'supabase/migrations/249_prospect_view_enum.sql'),
    'utf8',
  )

  it("adds 'prospect_list' to view_entity_type", () => {
    // The Prospecting INDEX moves onto the shared views system
    // (UnifiedViewLayout entityType="prospect_list"), so
    // GET /api/account/views?entity_type=prospect_list filters the `view` table
    // on this enum. Without the value that query 500s and saving a view over
    // the list index fails.
    expect(migration).toMatch(
      /ALTER TYPE public\.view_entity_type ADD VALUE IF NOT EXISTS 'prospect_list';/,
    )
  })

  it('is a STANDALONE statement — ADD VALUE cannot share a transaction', () => {
    // Postgres refuses ALTER TYPE … ADD VALUE inside a transaction block, and
    // the new value is unusable in the transaction that added it. 249 is the
    // precedent; this must match its shape or the migration fails to apply.
    const statements = migration
      .split('\n')
      .filter((l) => !l.trim().startsWith('--') && l.trim() !== '')
      .join(' ')
      .split(';')
      .filter((x) => x.trim() !== '')
    expect(statements).toHaveLength(1)
  })

  it('reverses 249 EXPLICITLY, in a comment a future reader will find', () => {
    // 249 wrote, in the same file that registered the ENTRY type:
    // "`prospect_list` itself is deliberately NOT registered". That held while
    // a workspace had two lists; it stops holding at a dozen. A reader finding
    // both migrations must be able to tell this was a decision rather than an
    // oversight being papered over — so 255 has to name 249.
    expect(prior).toMatch(/prospect_list[\s\S]{0,40}deliberately NOT registered/)
    expect(migration).toMatch(/249/)
  })

  it("does NOT touch migration 250's scope CHECK — a different enum", () => {
    // 'prospect_list' already appears in view_scope_type_check, where it means
    // "a view scoped to ONE list" (what the entries view uses). The two enums
    // are independent and 250 needs no change; an edit here that also rewrote
    // the scope constraint would drop 233's values on the floor.
    expect(migration).not.toMatch(/view_scope_type_check/)
    expect(migration).not.toMatch(/ALTER TABLE/)
  })
})
