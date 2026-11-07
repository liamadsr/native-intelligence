/**
 * The ACCOUNT CARD run — spec §7 Stage 3b, run kind `account_card`.
 *
 * One own-domain-anchored deep search per selected company, turning a
 * discovered `prospect_list_entry` into an enriched one. It is the cheap half
 * of enrichment: ≈$0.013 and 5–15s per company against the flat 9-property
 * {@link PROSPECT_ACCOUNT_CARD}, versus ≈$0.04–0.05 and up to 180 seconds for
 * the existing 3-card `enrichCompany`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `enrichCompany`
 * ---------------------------------------------------------------------------
 * §7 is explicit that the full `enrichCompany` waits for Save, for two
 * reasons that both still hold here: its fill-empty write-back needs a real
 * `company` row to write to, and paying its price for a company the user has
 * not committed to is the mistake Exa's demo makes. This run writes to the
 * ENTRY, creates no `company`, and leaves the expensive pass to the manual
 * lane after Save.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT PRESERVES, AND WHY THAT IS THE HARD PART
 * ---------------------------------------------------------------------------
 * An entry arriving here already carries `research` from discovery — the
 * synthesized `one_liner`, `why_match`, `signal` and `employee_range` that
 * Stage 3a scored. The card must therefore MERGE, not replace, and merge with
 * the same confidence discipline the CRM side has used since the enrichment
 * blob existed: {@link mergeBlobFields} keeps everything the previous pass
 * held and refuses to let a LESS confident new value displace a more confident
 * old one. Re-implementing that rule here would be a second copy of the one
 * decision in this codebase that protects a verified fact from a namesake's
 * guess, so it is imported rather than rewritten.
 *
 * The same applies to fit: the entry was already tiered against the ICP, and a
 * card that happens to omit the field a signal was drawn from must not silently
 * demote a company the user is already looking at. Re-scoring therefore takes
 * the MAX of the old and new tiers — enrichment can only ever improve an
 * account's standing, never quietly worsen it.
 *
 * ---------------------------------------------------------------------------
 * EVERY TERMINAL WRITE IS STILL THE ENGINE'S
 * ---------------------------------------------------------------------------
 * Identical to `run.ts`: `completed`, `failed`, `canceled` and
 * `budget_exhausted` are written here, through the shared {@link BaseRunState}.
 * A run that RETURNS has persisted its outcome, so a run that THROWS is
 * transient by construction.
 */
import { mergeBlobFields } from '@/lib/crm/enrichment'
import type { GroundedField } from '@/lib/exa/deep-search'
import { scoreFromProfile } from './fit'
import { parseAccountCard } from './parse'
import { PROSPECT_ACCOUNT_CARD } from './schemas'
import { ESTIMATED_ACCOUNT_CARD_DOLLARS, RUN_CAP_ERROR, budgetVerdict } from './spend'
import {
  BaseRunState,
  icpForRun,
  isCanceling,
  loadList,
  loadRun,
  numberOr,
  preflight,
  type RunEngineArgs,
  type RunEngineDeps,
  type RunEngineOutcome,
} from './run-shared'
import type {
  Icp,
  ProspectCandidate,
  ProspectingRunStatus,
} from './types'

/** `numResults` for the anchored card. §12 measured the whole cost model at
 *  this number; raising it raises the price of every company in the run. */
const ACCOUNT_CARD_NUM_RESULTS = 5

/** Tier ordering, best first — used to take the BETTER of two tiers. */

/** The entry columns this run reads. `research`/`sources` come back so the
 *  merge starts from what the entry already knows rather than clobbering it. */
const ENTRY_COLUMNS =
  'id, list_id, kind, stage, candidate, candidate_key, research, sources, ' +
  'fit_score, fit_rationale'

interface AccountEntryRow {
  id: string
  list_id: string
  kind: string
  stage: string
  candidate: unknown
  candidate_key: string
  research: unknown
  sources: unknown
  fit_score: number | null
  fit_rationale: string | null
}

/** The card's facts, minus its score. The score is a column (`applyCard`),
 *  and the merge must not carry it into the research blob. */
function withoutScore(fields: Record<string, GroundedField>): Record<string, GroundedField> {
  const out: Record<string, GroundedField> = {}
  for (const [key, field] of Object.entries(fields)) {
    if (key === 'fit_score') continue
    out[key] = field
  }
  return out
}

interface EntrySource {
  url: string
  title: string | null
  published_date: string | null
}

// ---------------------------------------------------------------------------
// executeAccountCardRun
// ---------------------------------------------------------------------------

export async function executeAccountCardRun(
  deps: RunEngineDeps,
  args: RunEngineArgs,
): Promise<RunEngineOutcome> {
  const state = new AccountRunState(deps, args)

  // ── Load the run and the list ────────────────────────────────────────
  const loaded = await loadRun(deps, args)
  if (loaded.terminal) return state.bare(loaded.terminal.status, loaded.terminal.error)
  const runRow = loaded.row
  state.seedFromRow(runRow)

  const list = await loadList(deps, args)
  if (!list) return await state.finish('failed', 'list_not_found')

  const icp: Icp = icpForRun(runRow, list)
  const icpVersion = numberOr(list.icp_version, 1)

  // ── The selection ────────────────────────────────────────────────────
  //
  // `target_entry_ids` is written by the kickoff route, which has already
  // rejected a selection that is empty, foreign, dismissed, person-kind or
  // over the cap. Re-reading the rows here is not a second validation pass —
  // it is how the loop gets each company's DOMAIN, which is the one input the
  // anchored search cannot work without.
  const targetIds = (runRow.target_entry_ids ?? []).filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  )
  const entries = await readTargetEntries(deps, args, targetIds)

  // Order by the SELECTION, not by whatever order PostgREST returned: the UI
  // shows progress against the list the user picked, and a run that enriches
  // them in a different order makes "3 of 18" point at the wrong three.
  const byId = new Map(entries.map((e) => [e.id, e]))
  const ordered = targetIds.map((id) => byId.get(id)).filter((e): e is AccountEntryRow => !!e)

  state.progress.accounts_total = ordered.length
  state.progress.round = 1
  state.progress.max_rounds = 1

  // ══ Preflight (free) ═════════════════════════════════════════════════
  const pre = await preflight(deps, args, icp)
  if (pre.parked) return await state.finish(pre.parked.status, pre.parked.error)

  // No `status` here: the claim already set `running`, and writing it again
  // would overwrite a `canceling` pressed during preflight, losing the cancel.
  await state.write({
    stage: 'account_card',
    started_at: state.nowIso(),
  })

  // A selection whose rows all vanished between the press and the run (deleted,
  // or dismissed in the gap) is a completed run over zero companies, not a
  // failure: nothing went wrong and nothing was billed.
  if (ordered.length === 0) return await state.finish('completed', null)

  const systemPrompt = buildAccountCardSystemPrompt(icp)

  // ══ One card per company ═════════════════════════════════════════════
  let parked: { status: ProspectingRunStatus; error: string | null } | null = null

  for (const entry of ordered) {
    // ── The two pre-call gates, in this order and BEFORE the call ──────
    //
    // Cancel first: a user who pressed Cancel wants the run stopped, and
    // reporting `budget_exhausted` to someone who cancelled would be a lie
    // about why it stopped.
    if (await isCanceling(deps.supabase, args.runId, args.workspaceId)) {
      parked = { status: 'canceled', error: null }
      break
    }
    // §9: "max_spend_dollars is checked before each paid call" — reserved at
    // the ACCOUNT estimate, not the discovery one, because this loop's calls
    // cost a third as much and reserving the wrong number would park a run
    // with two thirds of its budget unspent.
    if (!budgetVerdict(state.spent, state.budget, ESTIMATED_ACCOUNT_CARD_DOLLARS).ok) {
      // Parked, KEEPING the companies already enriched. Each entry's write
      // committed as it happened, so partial results are already durable.
      parked = { status: 'budget_exhausted', error: RUN_CAP_ERROR }
      break
    }

    const domain = domainOf(entry)
    if (!domain) {
      // No domain, no anchor — and an unanchored card is exactly the namesake
      // failure this stage's `includeDomains` exists to prevent. Count it done
      // (the user asked for it and it will not be retried) and spend nothing.
      state.progress.accounts_done += 1
      await state.write({})
      continue
    }

    // ── The one paid call ───────────────────────────────────────────────
    const res = await deps.deepSearch({
      query:
        `Company profile of ${domain}: headcount, headquarters, funding stage, ` +
        'total raised, growth signals, technology stack, products, key people',
      category: 'company',
      // MANDATORY. The card carries no identity gate precisely because it is
      // anchored by construction — a card built only from the company's own
      // site cannot describe someone else.
      includeDomains: [domain],
      numResults: ACCOUNT_CARD_NUM_RESULTS,
      outputSchema: PROSPECT_ACCOUNT_CARD,
      systemPrompt,
    })

    // Bill FIRST, unconditionally. A response we then fail to parse still cost
    // money, and a run whose `spent_dollars` under-reports is a run whose cap
    // does not hold.
    state.bill(res.costDollars)

    const card = parseAccountCard(res)
    await state.applyCard({ entry, card, icp, icpVersion })

    state.progress.accounts_done += 1
    await state.write({})
  }

  if (parked) return await state.finish(parked.status, parked.error)
  return await state.finish('completed', null)
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/**
 * The systemPrompt.
 *
 * "Research this company for the source company's sales team and explain why
 * it would buy" is what makes `whyFit` a SALES artefact rather than a generic
 * company summary — the card is being written for one specific seller, and the
 * source line is what tells the model who that is.
 *
 * THE IDEAL CUSTOMER IS IN HERE because `fitScore` is judged against it. This
 * is the one place the model rates fit (fit.ts: discovery does not score), so
 * everything the user wrote in the ICP — the description, the narrowing
 * criteria, the exclusions — has to reach the model that produces the number,
 * or the number is a rating against nothing. Empty ICP fields are simply
 * omitted rather than rendered as "Industries: (none)".
 */
export function buildAccountCardSystemPrompt(icp: Icp): string {
  const source = icp.source.what_we_sell?.trim()
  const lines: string[] = [
    "Research this company for the source company's sales team and explain why " +
      `it would buy. Source: ${source || 'the source company'}`,
  ]
  const target = icp.target
  const criteria: string[] = []
  if (target.description?.trim()) criteria.push(target.description.trim())
  const named = (label: string, values: readonly string[]) => {
    const clean = values.map((v) => v.trim()).filter(Boolean)
    if (clean.length > 0) criteria.push(`${label}: ${clean.join(', ')}`)
  }
  named('Industries', target.industries)
  named('Company size', target.employee_bands)
  named('Geographies', target.geographies)
  named('Buyers', target.buyer_titles)
  named('Use cases', target.use_cases)
  if (criteria.length > 0) lines.push(`Ideal customer: ${criteria.join('. ')}.`)
  const excluded = [...icp.anti.exclude_industries, ...icp.anti.exclude_keywords]
    .map((v) => v.trim())
    .filter(Boolean)
  if (excluded.length > 0) lines.push(`Not a fit: ${excluded.join(', ')}.`)
  lines.push(
    'fitScore is how likely this company is to buy from the source company, 0–100, ' +
      'judged against the ideal customer. Use the whole range and be strict: 85–100 only ' +
      'when the company matches the profile AND shows an active need or signal; 60–84 a ' +
      'solid match; 35–59 a partial match; below 35 a poor match or an excluded case. ' +
      'whyFit states the reasons behind the number.',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The selected entries, in ONE read.
 *
 * Scoped by `workspace_id` AND `list_id` as well as the id set: the route
 * already refused a foreign selection, but this lib runs under a service-role
 * client where RLS does not apply at all, so the filter is the boundary rather
 * than a nicety.
 */
async function readTargetEntries(
  deps: RunEngineDeps,
  args: RunEngineArgs,
  ids: readonly string[],
): Promise<AccountEntryRow[]> {
  if (ids.length === 0) return []
  const { data, error } = await deps.supabase
    .from('prospect_list_entry')
    .select(ENTRY_COLUMNS)
    .eq('workspace_id', args.workspaceId)
    .eq('list_id', args.listId)
    .in('id', ids as string[])
  if (error) throw new Error(`prospect_list_entry read failed: ${error.message}`)
  return ((data ?? []) as unknown as AccountEntryRow[]).filter(
    // Belt and braces against a selection that drifted between the press and
    // the run: a person entry has no domain to anchor on, and a dismissed one
    // is a company the user already said no to.
    (row) => row.kind === 'company' && row.stage !== 'dismissed',
  )
}

// ---------------------------------------------------------------------------
// AccountRunState
// ---------------------------------------------------------------------------

class AccountRunState extends BaseRunState {
  constructor(deps: RunEngineDeps, args: RunEngineArgs) {
    // A parked or cancelled account-card run reports that it stopped in
    // `account_card`; only a completed one claims `done`.
    super(deps, args, 'account_card')
  }

  /**
   * Merge one card onto its entry: research, sources, name, and THE score.
   *
   * The research merge is ADDITIVE. The entry arrived with discovery's
   * `research`; a card that omits a field must leave the old value alone, and
   * a card that contradicts a more-confident old value must lose.
   *
   * The score is NOT additive. This is the one scoring call in the pipeline
   * (fit.ts): the card's `fitScore` replaces whatever the entry held, because
   * a profile that just read the company's own site knows more than anything
   * before it did — the only thing that overrides it is the user's own anti
   * rule, which zeroes it.
   */
  async applyCard(input: {
    entry: AccountEntryRow
    card: { fields: Record<string, GroundedField>; sources: EntrySource[] }
    icp: Icp
    icpVersion: number
  }): Promise<void> {
    const { entry, card, icp, icpVersion } = input
    const now = this.nowIso()

    // ── research: the confidence-ranked additive merge ─────────────────
    //
    // `mergeBlobFields` is imported from `crm/enrichment` rather than
    // reimplemented: it is the one function in the codebase that encodes "a
    // verified fact must never be displaced by a low-confidence guess", and a
    // second copy of that rule would drift from the CRM's.
    //
    // `fit_score` is stripped from the card BEFORE the merge: it is a column,
    // not a fact about the company, and left in the blob it would render on
    // the Details tab as "Fit score: 85" beside the headquarters.
    const previous = readFieldMap(entry.research)
    const cardFacts = withoutScore(card.fields)
    const merged = mergeBlobFields(previous, cardFacts, now) as Record<string, GroundedField>

    // ── sources: a deduped union, this run's citations first ───────────
    const sources = mergeSources(card.sources, readSources(entry.sources))

    // ── candidate.name, filled only when missing ───────────────────────
    //
    // A discovery entry harvested purely from a result entity can arrive with
    // no name at all, and "(no name)" in the list is the most visible symptom
    // of that. The card's own `name` is not in the schema, so the fill comes
    // from the MERGED research — which is where discovery's `name` lives too.
    const candidate = readCandidate(entry.candidate)
    const nameFromResearch = merged.name?.value?.trim() || null
    const filledName = candidate.name?.trim() || nameFromResearch

    // ── THE score ──────────────────────────────────────────────────────
    //
    // Read from the card's own `fit_score`, never from the blob. A card that
    // came back without a usable number leaves the entry unscored (NULL), which
    // the row shows as "Enrich" again rather than as a guess.
    const scored = scoreFromProfile({
      card: card.fields,
      merged,
      icp,
      previousRationale: entry.fit_rationale,
    })

    const patch: Record<string, unknown> = {
      research: merged,
      sources,
      fit_score: scored.fit_score,
      fit_rationale: scored.fit_rationale,
      icp_version: icpVersion,
    }

    // ── candidate.account_card_at — THE STAMP ──────────────────────────
    //
    // The one unambiguous record that this stage ran. It is written even when
    // the card came back with nothing extractable, and that is the point: an
    // entry the user paid for and that yielded nothing must leave the research
    // queue, or the gate re-offers it forever at full price.
    //
    // A stamp is necessary because the alternative does not work. Discovery
    // writes to the SAME `research` column this merge writes to, so "the blob
    // is non-empty" is true from the moment a company is discovered — the gate
    // shipped with exactly that test and consequently offered the card to
    // nobody while offering people-search for 44 companies that had never been
    // carded. No key's presence separates the two stages for certain (the
    // merge is additive and a card may omit any field), so the fact has to be
    // recorded rather than inferred.
    //
    // It rides on `candidate` because that jsonb is the entry's own
    // per-candidate state and needs no migration; the write below is a full
    // replacement of the object, which is why `filledName` folds into the SAME
    // patch rather than a second one that would drop the stamp.
    patch.candidate = {
      ...candidate,
      ...(filledName && filledName !== candidate.name ? { name: filledName } : {}),
      account_card_at: now,
    }

    const { error } = await this.deps.supabase
      .from('prospect_list_entry')
      .update(patch)
      .eq('id', entry.id)
      .eq('workspace_id', this.args.workspaceId)
    if (error) {
      // A write we cannot classify is transient by construction: throwing lets
      // Inngest retry, and the merge is idempotent — re-running it against the
      // same card produces the same row.
      throw new Error(`prospect_list_entry update failed: ${error.message}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The company's domain: the candidate's own, falling back to the
 *  `candidate_key`, which IS the normalized domain for a company entry. */
function domainOf(entry: AccountEntryRow): string | null {
  const candidate = readCandidate(entry.candidate)
  const fromCandidate = typeof candidate.domain === 'string' ? candidate.domain.trim() : ''
  if (fromCandidate) return fromCandidate
  const key = entry.candidate_key?.trim()
  // A person key would be a linkedin slug or an email; neither is a domain.
  if (key && !key.includes('@') && !key.includes('/')) return key
  return null
}

function readCandidate(raw: unknown): ProspectCandidate & Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as ProspectCandidate & Record<string, unknown>
  }
  return {} as ProspectCandidate & Record<string, unknown>
}

/** `entry.research` as the `{ key: GroundedField }` map `mergeBlobFields`
 *  takes. Anything else — null, an array, a string — is "no previous fields"
 *  rather than a crash. */
function readFieldMap(raw: unknown): Record<string, Record<string, unknown>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, Record<string, unknown>> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = value as Record<string, unknown>
    }
  }
  return out
}

function readSources(raw: unknown): EntrySource[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (s): s is EntrySource =>
      !!s && typeof s === 'object' && typeof (s as { url?: unknown }).url === 'string',
  )
}

/** How many citations one entry may accumulate. The same bound
 *  `mergeBlobSources` applies on the CRM side, for the same reason: an entry
 *  re-enriched repeatedly must not accrete an unbounded list. */
const MAX_ENTRY_SOURCES = 40

/** This run's citations first (they back the freshest fields), then the
 *  entry's earlier ones, de-duplicated by URL. */
export function mergeSources(current: EntrySource[], previous: EntrySource[]): EntrySource[] {
  const seen = new Set<string>()
  const out: EntrySource[] = []
  for (const source of [...current, ...previous]) {
    if (!source || typeof source.url !== 'string' || seen.has(source.url)) continue
    seen.add(source.url)
    out.push(source)
    if (out.length >= MAX_ENTRY_SOURCES) break
  }
  return out
}
