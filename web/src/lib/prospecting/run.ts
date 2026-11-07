/**
 * The discovery run engine (spec §7, §9).
 *
 * `executeDiscoveryRun` is the whole pipeline as a plain async function over an
 * injected dependency bag. The Inngest wrapper
 * (`src/lib/inngest/prospecting-functions.ts`) only sequences `step.run` calls
 * around it; every decision — what to search, what to admit, what to write,
 * and above all WHEN TO STOP — lives here, where it can be tested without an
 * Inngest harness, without a network, and without a database.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THIS FILE OWNS: EVERY TERMINAL WRITE
 * ---------------------------------------------------------------------------
 * `completed`, `failed`, `canceled` and `budget_exhausted` are all written
 * HERE, by {@link finish}. The wrapper never writes a status. This mirrors the
 * `crm/enrichment` precedent for the same reason it was adopted there: a run
 * that RETURNS has already persisted its outcome, so a run that THROWS is
 * transient by construction and Inngest's retries are always retrying
 * something that might actually succeed.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF THE LOOP
 * ---------------------------------------------------------------------------
 *   preflight (free)
 *     guardUsage  →  monthly ceiling  →  source company  →  exclusion set
 *   for round in 1..max_rounds:
 *     for angle in buildDiscoveryAngles(...):        ← ONE paid call each
 *       budget check BEFORE the call · cancel check BEFORE the call
 *       deepSearch → parse → admit → insert entries + ledger → progress
 *     stop if new-this-run >= target, or the round found ZERO new
 *   finish
 *
 * The exclusion set is built once in preflight and then **mutated in memory**
 * as keys are admitted. Rebuilding it per round from the database would be
 * more literal about §6's "recomputed at the start of every round", and would
 * also be a second full read of every entry in the workspace for information
 * we already hold — the rows this round just wrote. In-memory accumulation is
 * what makes angle 4 of round 1 refuse a company angle 1 already found.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT HERE
 * ---------------------------------------------------------------------------
 * The account-card and people stages (§7 Stage 3b/4) run off an explicit user
 * selection at the cost gate and are a separate run `kind`. This function is
 * `kind: 'discover'` only, and it says so by finishing at `stage: 'done'` with
 * `accounts_total: 0`.
 */
import {
  buildDiscoveryAngles,
  buildDiscoverySystemPrompt,
  discoveryNounFor,
} from './angles'
import {
  admitCandidates,
  buildExclusionSet,
  exclusionSnapshot,
  suppressedDomainHints,
  type ExclusionSet,
} from './exclusions'
import { antiRuleHit, antiRuleRationale } from './fit'
import { probeDomains, probeParkedDomain } from './parked'
import { parseDiscoveryResponse, type DiscoveryCandidate } from './parse'
import { PROSPECT_DISCOVERY_CARD } from './schemas'
import { RUN_CAP_ERROR, budgetVerdict } from './spend'
import {
  BaseRunState,
  clampInt,
  icpForRun,
  isCanceling,
  loadList,
  loadRun,
  numberOr,
  preflight,
  purposeOf,
  readMemberEmails,
  type ProspectListShape,
  type RunEngineArgs,
  type RunEngineDeps,
  type RunEngineOutcome,
} from './run-shared'
import type { Icp, ProspectSuppressionSource, ProspectingRunStatus } from './types'

export type { RunEngineArgs, RunEngineDeps, RunEngineOutcome } from './run-shared'

/** `deepSearch`'s `numResults` for a discovery call. §12 measured $0.027 here;
 *  the whole cost model in `spend.ts` assumes this number. */
const DISCOVERY_NUM_RESULTS = 25

/** How many entries one call's insert loop may create. A hard stop against a
 *  malformed response claiming hundreds of companies; the measured response
 *  produced 20. */
const MAX_ENTRIES_PER_CALL = 60

// ---------------------------------------------------------------------------
// executeDiscoveryRun
// ---------------------------------------------------------------------------

export async function executeDiscoveryRun(
  deps: RunEngineDeps,
  args: RunEngineArgs,
): Promise<RunEngineOutcome> {
  const { supabase } = deps
  const { runId, workspaceId, listId } = args

  const state = new RunState(deps, args)

  // ── Load the run and the list ────────────────────────────────────────
  //
  // Both reads are workspace-scoped and shared with the other two run kinds
  // (`run-shared.ts`), including the resume guard that refuses to re-bill a
  // row that already settled.
  const loaded = await loadRun(deps, args)
  if (loaded.terminal) return state.bare(loaded.terminal.status, loaded.terminal.error)
  const runRow = loaded.row
  state.seedFromRow(runRow)

  const list = await loadList(deps, args)
  if (!list) return await state.finish('failed', 'list_not_found')

  const icpVersion = numberOr(list.icp_version, 1)
  const icp: Icp = icpForRun(runRow, list)
  const purpose = purposeOf(list)

  // ══ Preflight (free) ═════════════════════════════════════════════════
  //
  // Usage cap → monthly ceiling → source company, all before anything paid.
  const pre = await preflight(deps, args, icp)
  if (pre.parked) return await state.finish(pre.parked.status, pre.parked.error)
  const sourceDomain = pre.sourceDomain ?? null

  // 4. The exclusion set, and the snapshot the consent screen reads.
  const memberEmails = await readMemberEmails(supabase, workspaceId)
  const exclusions: ExclusionSet = await buildExclusionSet(supabase, {
    workspaceId,
    listId,
    options: {
      exclude_crm: list.exclude_crm !== false,
      exclude_other_lists: list.exclude_other_lists === true,
      exclude_contacted: list.exclude_contacted ?? 'ever',
    },
    sourceDomain,
    memberEmails,
  })

  // No `status` here: the claim already set `running`, and writing it again
  // would overwrite a `canceling` pressed during preflight, losing the cancel.
  await state.write({
    stage: 'discover',
    exclusion_snapshot: exclusionSnapshot(exclusions),
    started_at: state.nowIso(),
  })

  // ══ Rounds ═══════════════════════════════════════════════════════════

  const maxRounds = clampInt(list.max_rounds, 1, 3, 2)
  const targetNew = clampInt(list.target_new_candidates, 5, 100, 20)
  state.progress.max_rounds = maxRounds

  let parked: { status: ProspectingRunStatus; error: string | null } | null = null

  for (let round = 1; round <= maxRounds && !parked; round++) {
    state.progress.round = round
    const angles = buildDiscoveryAngles(icp, purpose, round)
    const newBefore = state.newEntries

    for (let index = 0; index < angles.length; index++) {
      const angle = angles[index]
      state.progress.angle_index = index

      // ── The two pre-call gates, in this order and BEFORE the call ────
      //
      // Cancel first: a user who pressed Cancel wants the run stopped, and
      // reporting `budget_exhausted` to someone who cancelled would be a lie
      // about why it stopped.
      if (await isCanceling(supabase, runId, workspaceId)) {
        parked = { status: 'canceled', error: null }
        break
      }
      // §9: "max_spend_dollars is checked before each paid call". The estimate
      // is the measured price of this exact call shape (§12) — see spend.ts on
      // why a pre-call reservation must round UP.
      if (!budgetVerdict(state.spent, state.budget).ok) {
        parked = { status: 'budget_exhausted', error: RUN_CAP_ERROR }
        break
      }

      // ── The one paid call ────────────────────────────────────────────
      const res = await deps.deepSearch({
        query: angle.query,
        additionalQueries: angle.additionalQueries,
        systemPrompt: buildDiscoverySystemPrompt(icp, {
          suppressedDomains: suppressedDomainHints(exclusions),
          noun: discoveryNounFor(purpose),
        }),
        category: 'company',
        numResults: DISCOVERY_NUM_RESULTS,
        outputSchema: PROSPECT_DISCOVERY_CARD,
      })

      // Bill FIRST, unconditionally. A response we then fail to parse still
      // cost money, and a run whose `spent_dollars` under-reports is a run
      // whose cap does not hold.
      state.bill(res.costDollars)

      const candidates = parseDiscoveryResponse(res, { angle: angle.key })
      await state.ingest({
        candidates,
        exclusions,
        icp,
        icpVersion,
        angleKey: angle.key,
      })
      await state.write({})
    }

    if (parked) break

    // ── The two stop conditions (§6 step 5, §9) ──────────────────────
    //
    // ZERO-NEW IS A HARD STOP and it comes first: an exhausted ICP must not
    // burn another full-price round to re-learn the same thing. It is checked
    // on the round, not on the angle, because one angle legitimately finding
    // nothing while another finds ten is a normal round.
    if (state.newEntries === newBefore) break
    if (state.newEntries >= targetNew) break
  }

  if (parked) return await state.finish(parked.status, parked.error)
  return await state.finish('completed', null)
}

// ---------------------------------------------------------------------------
// RunState — the mutable half, and every write
// ---------------------------------------------------------------------------

class RunState extends BaseRunState {
  /**
   * Identity keys already tallied into {@link counts} (and into
   * `progress.suppressed`).
   *
   * A round fires up to four angles and the SAME company legitimately comes
   * back from three of them — the recorded response's 19 distinct companies
   * arrive 57 times across a round. Counting every sighting would make the run
   * summary read "57 already in this list" for a list holding 19 of them, which
   * is not a rounding error but a different and wrong claim. `counts` is the
   * per-reason tally of COMPANIES, so each key contributes once.
   *
   * The ledger agrees by construction: `UNIQUE (run_id, identity_key)` means a
   * repeat sighting collides on insert and is swallowed, so the ledger already
   * holds one row per key per run.
   */
  private readonly countedKeys = new Set<string>()
  /** Identity keys already counted into `progress.found`. */
  private readonly foundKeys = new Set<string>()
  /**
   * Keys THIS run admitted as new entries.
   *
   * Angle 1 banks a company; angles 2–4 of the same round see it again and the
   * (in-memory, just-updated) exclusion set correctly refuses it as
   * `this_list`. Tallying that as a suppression would be wrong twice over: it
   * would say a company this run just found was "already in this list before
   * you started", and `new + suppressed` would exceed `found` — the arithmetic
   * a user does when reading "38 candidates · 20 already here · 9 new". A
   * re-sighting of our own find is neither new nor suppressed; it is the same
   * candidate, already counted.
   */
  private readonly ownKeys = new Set<string>()

  constructor(deps: RunEngineDeps, args: RunEngineArgs) {
    // `discover` is the base stage: a parked or cancelled discovery run reports
    // that it stopped in `discover`, and only a completed one claims `done`.
    super(deps, args, 'discover')
  }

  /** Keys refused by the parked-domain gate this run — a later angle's
   *  re-sighting is skipped, its ledger row already written. */
  private readonly refusedKeys = new Set<string>()

  /**
   * One angle's candidates: admit, score, write entries, write the ledger.
   *
   * EVERY candidate reaches `prospect_run_candidate` — new, suppressed and
   * invalid alike. §6 is explicit that this is what makes dedup trustworthy: a
   * dedup that silently drops repeats is indistinguishable from a search that
   * found nothing.
   */
  async ingest(input: {
    candidates: DiscoveryCandidate[]
    exclusions: ExclusionSet
    icp: Icp
    icpVersion: number
    angleKey: string
  }): Promise<void> {
    const { candidates, exclusions, icp, icpVersion, angleKey } = input

    // `found` counts CANDIDATES, on the same per-identity basis as
    // `suppressed` and `new`, so the three always add up to it and the §9
    // stepper's arithmetic is checkable. Counting sightings here and
    // identities there would make "38 candidates · 20 already in this list ·
    // 9 new" fail to reconcile in the one place a user does the sum.
    const admission = admitCandidates(candidates, exclusions)
    const ledger: LedgerRow[] = []

    // ── suppressed ───────────────────────────────────────────────────
    for (const { candidate, by, ref_id } of admission.suppressed) {
      const key = candidate.identity_key
      // A re-sighting of a company this very run banked: already counted as
      // `new`, and not a suppression at all. Still written to the ledger?  No
      // — `UNIQUE (run_id, identity_key)` already holds its `new` row, and a
      // second row claiming it was suppressed would contradict it.
      if (key && this.ownKeys.has(key)) continue
      this.bumpCount(by, key)
      this.countFound(key)
      ledger.push(
        ledgerRow(candidate, angleKey, {
          outcome: 'suppressed',
          suppressed_by: by,
          suppressed_ref_id: ref_id,
        }),
      )
    }

    // ── invalid ──────────────────────────────────────────────────────
    for (const candidate of admission.invalid) {
      // An invalid candidate has no key by definition, so there is nothing to
      // dedupe it by — each unusable result is counted once, as seen.
      this.progress.invalid += 1
      this.progress.found += 1
      ledger.push(ledgerRow(candidate, angleKey, { outcome: 'invalid' }))
    }

    // ── admitted → entries ───────────────────────────────────────────
    //
    // The cap is a hard stop against a malformed response claiming hundreds of
    // companies, and it is UNREACHABLE at the current `numResults` (up to 20
    // synthesized plus up to 25 result entities). It is loud rather than
    // silent because dropping a candidate here would drop it from the LEDGER
    // too — and a dedup that silently discards candidates is indistinguishable
    // from a search that found nothing, which is the exact failure the
    // transparency table exists to prevent. If raising `numResults` ever makes
    // this fire, the fix is to raise the cap knowingly, not to lose records.
    if (admission.admitted.length > MAX_ENTRIES_PER_CALL) {
      console.error(
        `[prospecting] ${admission.admitted.length} admitted candidates exceeds ` +
          `MAX_ENTRIES_PER_CALL=${MAX_ENTRIES_PER_CALL}; ` +
          `${admission.admitted.length - MAX_ENTRIES_PER_CALL} will be dropped ` +
          `from both entries and the ledger (run ${this.args.runId}, angle ${angleKey})`,
      )
    }

    // ── the parked-domain gate ───────────────────────────────────────
    //
    // Exa's index remembers what a domain USED to host. A for-sale domain
    // synthesized from stale pages became a row, scored 80 off the same
    // pages, and swallowed the real firm's people (Solenne Ventures,
    // 2026-09-07 — see ./parked). So every admitted domain is asked, once,
    // whether a live site answers. Parked and dead domains are refused as
    // `invalid` — the ledger row says why — and a re-sighting by a later
    // angle in this run is skipped outright: its row is already written.
    // A probe that cannot decide (a bot wall, a timeout) admits.
    const admitted = admission.admitted.slice(0, MAX_ENTRIES_PER_CALL)
    const probes = await probeDomains(
      admitted
        .filter((c) => c.identity_key && !this.refusedKeys.has(c.identity_key))
        .map((c) => c.domain),
      this.deps.probeDomain ?? probeParkedDomain,
    )

    for (const candidate of admitted) {
      const key = candidate.identity_key
      if (!key) continue
      if (this.refusedKeys.has(key)) continue

      const probe = candidate.domain ? probes.get(candidate.domain) : undefined
      if (probe && (probe.status === 'parked' || probe.status === 'dead')) {
        this.refusedKeys.add(key)
        this.progress.invalid += 1
        this.countFound(key)
        ledger.push(
          ledgerRow(
            {
              ...candidate,
              raw: {
                ...candidate.raw,
                refused: probe.status === 'parked' ? 'parked_domain' : 'dead_domain',
                refused_reason: probe.reason,
              },
            },
            angleKey,
            { outcome: 'invalid' },
          ),
        )
        continue
      }

      // NO SCORE AT DISCOVERY. The full profile scores once, with the whole
      // card in hand (fit.ts). The one thing decided here is the user's own
      // exclusion rule: a company whose text matches an `anti` term is written
      // at 0 with the rule named, so it sinks to the bottom with a reason
      // rather than sitting among the unscored rows waiting to be profiled.
      const anti = antiRuleHit(
        { fields: candidate.fields, entity: candidate.entity ?? null },
        icp,
      )
      const whyMatch = candidate.fields.why_match?.value?.trim() || null

      const { entryId, conflicted, error } = await this.insertEntry({
        candidate,
        key,
        fit: anti
          ? { fit_score: 0, fit_rationale: antiRuleRationale(anti) }
          : { fit_score: null, fit_rationale: whyMatch },
        icpVersion,
        angleKey,
      })

      if (error) {
        // A write we cannot classify is transient by construction: throwing
        // lets Inngest retry the whole step, and the entry insert is idempotent
        // under `UNIQUE (list_id, candidate_key)` so the retry is safe.
        throw new Error(`prospect_list_entry insert failed: ${error}`)
      }

      if (conflicted) {
        // 23505 on `prospect_entry_key_idx` — the row is already in this list,
        // written by a concurrent run or an earlier angle whose in-memory key
        // we somehow missed. §6 Layer 2: this is a suppression, not an error.
        this.bumpCount('this_list', key)
        this.countFound(key)
        ledger.push(
          ledgerRow(candidate, angleKey, {
            outcome: 'suppressed',
            suppressed_by: 'this_list',
            suppressed_ref_id: null,
          }),
        )
        continue
      }

      this.newEntries += 1
      this.progress.new += 1
      this.countFound(key)
      this.ownKeys.add(key)
      // The key joins the live set immediately, so the NEXT angle in this same
      // round refuses it rather than paying the 23505 to find out.
      exclusions.set(key, { by: 'this_list', ref_id: entryId })
      ledger.push(ledgerRow(candidate, angleKey, { outcome: 'new', entry_id: entryId }))
    }

    await this.writeLedger(ledger)
  }

  private async insertEntry(input: {
    candidate: DiscoveryCandidate
    key: string
    fit: { fit_score: number | null; fit_rationale: string | null }
    icpVersion: number
    angleKey: string
  }): Promise<{ entryId: string | null; conflicted: boolean; error: string | null }> {
    const { candidate, key, fit, icpVersion, angleKey } = input
    const { data, error } = await this.deps.supabase
      .from('prospect_list_entry')
      .insert({
        workspace_id: this.args.workspaceId,
        list_id: this.args.listId,
        kind: 'company',
        candidate_key: key,
        candidate: {
          name: candidate.display_name,
          domain: candidate.domain,
          one_liner: candidate.fields.one_liner?.value ?? null,
          exa_entity_id: candidate.exa_entity_id ?? null,
          found_via: candidate.found_via,
        },
        stage: 'discovered',
        identity_state: 'resolved',
        // NULL until the profile scores it (0 when an anti rule fired); the
        // rationale is discovery's own why-match sentence, the row's "why"
        // before there is a score.
        fit_score: fit.fit_score,
        fit_rationale: fit.fit_rationale,
        // Blob-shaped, the SAME shape as `company.metadata.enrichment.fields`,
        // so promotion at Save merges it with the existing mergeBlobFields
        // discipline and `readBlob` renders it with no new display code.
        research: candidate.fields,
        sources: candidate.evidence_url
          ? [{ url: candidate.evidence_url, title: null, published_date: null }]
          : [],
        icp_version: icpVersion,
        discovered_by_run_id: this.args.runId,
        discovery_angle: angleKey,
      })
      .select('id')
      .single()

    if (error) {
      if (error.code === '23505') return { entryId: null, conflicted: true, error: null }
      return { entryId: null, conflicted: false, error: error.message }
    }
    return { entryId: (data as { id: string } | null)?.id ?? null, conflicted: false, error: null }
  }

  /**
   * The ledger, in ONE insert per angle rather than one per candidate.
   *
   * A 25-result round produces ~25 rows; 25 round-trips per angle against 4
   * angles per round is 200 sequential writes for a table nothing reads
   * synchronously. The `UNIQUE (run_id, identity_key)` index means a candidate
   * seen under two angles collides — expected, and swallowed: the first angle's
   * record is the true one, and a batch that partially conflicts is retried
   * row-by-row so one repeat cannot lose 24 honest records.
   */
  private async writeLedger(rows: LedgerRow[]): Promise<void> {
    if (rows.length === 0) return
    const payload = rows.map((row) => ({
      workspace_id: this.args.workspaceId,
      run_id: this.args.runId,
      list_id: this.args.listId,
      ...row,
    }))
    const { error } = await this.deps.supabase.from('prospect_run_candidate').insert(payload)
    if (!error) return
    if (error.code !== '23505') {
      // The ledger is an audit trail, not the run's product. Losing it must
      // never fail a round that actually found companies.
      console.error('[prospecting] run-candidate ledger insert failed:', error.message)
      return
    }
    for (const row of payload) {
      const { error: rowError } = await this.deps.supabase
        .from('prospect_run_candidate')
        .insert(row)
      if (rowError && rowError.code !== '23505') {
        console.error('[prospecting] run-candidate row insert failed:', rowError.message)
      }
    }
  }

  /** `found`, once per identity, for the same reason {@link bumpCount} is. */
  private countFound(key: string | null | undefined) {
    if (key) {
      if (this.foundKeys.has(key)) return
      this.foundKeys.add(key)
    }
    this.progress.found += 1
  }

  /** Tally one suppression, ONCE per identity — see {@link countedKeys}. A
   *  keyless suppression (a freemail/noise host with no usable key) is counted
   *  every time, because there is no identity to collapse it onto. */
  private bumpCount(by: ProspectSuppressionSource, key: string | null | undefined) {
    if (key) {
      if (this.countedKeys.has(key)) return
      this.countedKeys.add(key)
    }
    this.counts[by] = (this.counts[by] ?? 0) + 1
    this.progress.suppressed += 1
  }

}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

interface LedgerRow {
  identity_key: string
  display_name: string | null
  raw: Record<string, unknown>
  discovery_angle: string | null
  outcome: 'new' | 'suppressed' | 'invalid'
  suppressed_by?: ProspectSuppressionSource | null
  suppressed_ref_id?: string | null
  entry_id?: string | null
}

/**
 * One ledger row.
 *
 * `identity_key` is NOT NULL in the table, so an invalid candidate — which by
 * definition has no key — gets a synthetic one derived from what it DID carry.
 * Recording "we saw something at this domain and could not use it" is the
 * entire reason the invalid outcome exists; dropping the row because the
 * column is NOT NULL would delete exactly the information the transparency
 * table is for.
 */
function ledgerRow(
  candidate: DiscoveryCandidate,
  angleKey: string,
  fields: Pick<LedgerRow, 'outcome' | 'suppressed_by' | 'suppressed_ref_id' | 'entry_id'>,
): LedgerRow {
  const key =
    candidate.identity_key ??
    (candidate.domain ? `invalid:${candidate.domain}` : null) ??
    (candidate.display_name ? `invalid:${candidate.display_name.toLowerCase()}` : null) ??
    `invalid:${angleKey}:${candidate.found_via}`
  return {
    identity_key: key,
    display_name: candidate.display_name,
    raw: candidate.raw,
    discovery_angle: candidate.angle ?? angleKey,
    suppressed_by: null,
    suppressed_ref_id: null,
    entry_id: null,
    ...fields,
  }
}
