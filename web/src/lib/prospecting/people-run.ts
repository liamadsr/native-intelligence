/**
 * The PEOPLE run — spec §7 Stage 4, run kind `people`.
 *
 * One anchored people search per selected company, inserting each person it
 * finds as a `prospect_list_entry` with `kind='person'` and
 * `parent_entry_id` → its account. §12 measured the shape this run bets on: 5
 * people at quillfort.ai, **all with `linkedin.com/in` URLs, all grounded high,
 * $0.012, 4.8s**.
 *
 * ---------------------------------------------------------------------------
 * THE IDENTITY GATE IS THE POINT
 * ---------------------------------------------------------------------------
 * `includeDomains: [domain]` is MANDATORY on every call, and every person then
 * passes through `demoteUnrelatedPersonSources` inside `parsePeopleResponse`.
 * The Devin Marsh incident is exactly this shape — a real profile, a
 * confident card, and a different human — and it happened on a search that was
 * NOT anchored. Anchoring restricts retrieval to pages that mention the
 * company; the gate then checks that the citations actually back THIS person
 * at THIS company.
 *
 * A person who fails the gate is NOT dropped. They arrive as
 * `identity_state='needs_review'`, which the UI excludes from bulk save and
 * requires a per-row confirm for. Dropping them would be worse than showing
 * them: the user would have no way to tell "we found nobody" from "we found
 * someone we could not verify".
 *
 * ANCHORED PEOPLE ARE INSERTED FIRST, and that ordering is load-bearing rather
 * than cosmetic. `people_per_company` is a hard cap on how many of a company's
 * people become rows, so an unordered insert loop would let three unverifiable
 * candidates consume a cap of three and push the two verified ones out
 * entirely.
 *
 * ---------------------------------------------------------------------------
 * EXPECT SPARSE RESULTS
 * ---------------------------------------------------------------------------
 * §7: Exa does not index every profile, and anchoring restricts retrieval to
 * pages mentioning the company — many small companies have no team page.
 * Realistic yield is 1–3 people, sometimes zero. This engine therefore reports
 * `people_found` against `people_target` on every company, so the UI can say
 * "Found 3 of the 5 roles you asked for" rather than implying a complete
 * roster. A working feature that implies completeness reads as broken.
 *
 * ---------------------------------------------------------------------------
 * NO `contact` ROW IS CREATED HERE
 * ---------------------------------------------------------------------------
 * Promotion to the CRM happens at Save (§8), which is phase 6. Until then a
 * person entry carries `contact_id = NULL`, and — per migration 248's
 * `prospect_entry_kind_target` CHECK — `company_id = NULL` always: the account
 * is reached through `parent_entry_id`, never by pointing a person row at a
 * company.
 */
import { admitCandidates, buildExclusionSet, type ExclusionSet } from './exclusions'
import { personCandidateKey } from './keys'
import { parsePeopleResponse, type PersonCandidate } from './parse'
import { PROSPECT_PEOPLE_CARD } from './schemas'
import { ESTIMATED_PEOPLE_CALL_DOLLARS, RUN_CAP_ERROR, budgetVerdict } from './spend'
import {
  BaseRunState,
  clampInt,
  icpForRun,
  loadList,
  loadRun,
  numberOr,
  preflight,
  readMemberEmails,
  type RunEngineArgs,
  type RunEngineDeps,
  type RunEngineOutcome,
} from './run-shared'
import {
  PEOPLE_SEARCH_KNOWN_CAP,
  type Icp,
  type ProspectCandidate,
  type ProspectPeopleSearch,
  type ProspectSuppressionSource,
  type ProspectingRunStatus,
} from './types'

/** What one company's search saw — everything `candidate.people_search`
 *  carries except the clock, which the stamp adds. */
type PeopleSearchOutcome = Omit<ProspectPeopleSearch, 'at'>

/** `numResults` for the anchored people search. §12's measured shape. */
const PEOPLE_NUM_RESULTS = 10

/** The entry columns the run needs from each target company. */
const ENTRY_COLUMNS = 'id, list_id, kind, stage, candidate, candidate_key'

interface CompanyEntryRow {
  id: string
  list_id: string
  kind: string
  stage: string
  candidate: unknown
  candidate_key: string
}

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

// ---------------------------------------------------------------------------
// executePeopleRun
// ---------------------------------------------------------------------------

export async function executePeopleRun(
  deps: RunEngineDeps,
  args: RunEngineArgs,
): Promise<RunEngineOutcome> {
  const state = new PeopleRunState(deps, args)

  // ── Load the run and the list ────────────────────────────────────────
  const loaded = await loadRun(deps, args)
  if (loaded.terminal) return state.bare(loaded.terminal.status, loaded.terminal.error)
  const runRow = loaded.row
  state.seedFromRow(runRow)

  const list = await loadList(deps, args)
  if (!list) return await state.finish('failed', 'list_not_found')

  const icp: Icp = icpForRun(runRow, list)
  const icpVersion = numberOr(list.icp_version, 1)
  const perCompany = clampInt(list.people_per_company, 0, 10, 3)

  // ── The selection ────────────────────────────────────────────────────
  const targetIds = (runRow.target_entry_ids ?? []).filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  )
  const entries = await readTargetEntries(deps, args, targetIds)
  // Order by the SELECTION — the UI's progress counts against the list the
  // user picked.
  const byId = new Map(entries.map((e) => [e.id, e]))
  const ordered = targetIds.map((id) => byId.get(id)).filter((e): e is CompanyEntryRow => !!e)

  state.progress.accounts_total = ordered.length
  // The DENOMINATOR of "Found 3 of the 5 roles you asked for": what the user
  // asked for, not what came back. Reporting the yield against itself would
  // always read 100% and would hide the sparseness §7 warns about.
  state.progress.people_target = ordered.length * perCompany
  state.progress.round = 1
  state.progress.max_rounds = 1

  // ══ Preflight (free) ═════════════════════════════════════════════════
  const pre = await preflight(deps, args, icp)
  if (pre.parked) return await state.finish(pre.parked.status, pre.parked.error)

  // The exclusion set, built ONCE for the whole run rather than per company.
  // It already covers everything §6 promises for people — CRM contact emails
  // and LinkedIn URLs, current/ever enrollments, opt-outs, and this list's own
  // entries — and it is then mutated in memory as keys are admitted, so the
  // SECOND company in a run refuses a person the first one already banked.
  const memberEmails = await readMemberEmails(deps.supabase, args.workspaceId)
  const exclusions: ExclusionSet = await buildExclusionSet(deps.supabase, {
    workspaceId: args.workspaceId,
    listId: args.listId,
    options: {
      exclude_crm: list.exclude_crm !== false,
      exclude_other_lists: list.exclude_other_lists === true,
      exclude_contacted: list.exclude_contacted ?? 'ever',
    },
    sourceDomain: pre.sourceDomain ?? null,
    memberEmails,
  })

  // No `status` here: the claim already set `running`, and writing it again
  // would overwrite a `canceling` pressed during preflight, losing the cancel.
  await state.write({
    stage: 'people',
    started_at: state.nowIso(),
  })

  // `people_per_company = 0` means the user turned the stage off (§7: "Skipped
  // entirely when people_per_company = 0"). A completed run over zero people,
  // billed nothing.
  if (ordered.length === 0 || perCompany === 0) return await state.finish('completed', null)

  const titles = buyerTitlesOf(icp)

  // ══ One search per company ═══════════════════════════════════════════
  //
  // QUEUE-ON-CLICK (Liam, 2026-09-06): the target list is re-read from the
  // run row before every search, because `createRun` APPENDS to a live people
  // run rather than refusing a second one. A Find people pressed on another
  // row while this run is going lands in `target_entry_ids`, and the loop
  // picks it up, in order, after what was already queued. The read is the
  // same one the cancel gate made anyway — status and targets come back
  // together, so the queue costs no extra round trip.
  //
  // The window that remains: an append that lands between the final
  // "nothing left" read and the terminal write is recorded on the row but
  // never searched. The page copes — once the run settles, that row's button
  // comes back (no people, no stamp) and the next press starts a fresh run.
  let parked: { status: ProspectingRunStatus; error: string | null } | null = null
  /** Every id this run has taken a decision on, searched or skipped. */
  const done = new Set<string>()
  /** Ids the entry read has been tried for — the initial selection, then each
   *  appended id as it arrives — so an id that resolved to nothing (dismissed
   *  since, a person, foreign) is not re-read on every iteration. */
  const attempted = new Set(targetIds)
  let queue = targetIds

  for (;;) {
    // ── The gates, cancel first — and the queue, from the same read ──────
    const gate = await readGate(deps, args)
    if (gate.canceling) {
      parked = { status: 'canceled', error: null }
      break
    }
    queue = mergeTargets(queue, gate.targetIds)
    const nextId = queue.find((id) => !done.has(id))
    if (!nextId) break
    done.add(nextId)

    if (!attempted.has(nextId)) {
      // Appended after the initial read: load it under the same rules (this
      // list, a company, not dismissed) and count it into the totals the
      // rail and the chat card print.
      attempted.add(nextId)
      for (const row of await readTargetEntries(deps, args, [nextId])) byId.set(row.id, row)
      if (byId.has(nextId)) {
        state.progress.accounts_total += 1
        state.progress.people_target += perCompany
      }
    }
    const entry = byId.get(nextId)
    if (!entry) continue

    if (!budgetVerdict(state.spent, state.budget, ESTIMATED_PEOPLE_CALL_DOLLARS).ok) {
      parked = { status: 'budget_exhausted', error: RUN_CAP_ERROR }
      break
    }

    const candidate = readCandidate(entry.candidate)
    const domain = domainOf(entry, candidate)
    if (!domain) {
      // `includeDomains` is MANDATORY (§7). Without a domain there is no
      // anchor, and an unanchored people search is the namesake failure mode
      // this stage exists to avoid — so the company is skipped, not searched.
      state.progress.accounts_done += 1
      await state.write({})
      continue
    }
    const companyName = candidate.name?.trim() || domain

    // ── The one paid call ───────────────────────────────────────────────
    const res = await deps.deepSearch({
      query: `Current ${titles} at ${companyName} (${domain})`,
      category: 'people',
      includeDomains: [domain],
      numResults: PEOPLE_NUM_RESULTS,
      outputSchema: PROSPECT_PEOPLE_CARD,
      systemPrompt:
        `Find people who CURRENTLY work at the company whose website is ${domain}. ` +
        'Verify the employer from the profile itself; exclude people at other ' +
        'companies with similar names. One entry per person.',
    })

    // Bill FIRST, unconditionally.
    state.bill(res.costDollars)

    const people = parsePeopleResponse(res, { companyName, companyDomain: domain })
    const outcome = await state.ingest({
      people,
      parentEntryId: entry.id,
      // A saved company keeps the people found beneath it (migration 259):
      // they land ON THE LIST, pending publish, rather than as discovered
      // rows the user would have to save one by one.
      parentSaved: entry.stage === 'saved',
      companyName,
      companyDomain: domain,
      exclusions,
      perCompany,
      icpVersion,
    })

    // ── candidate.people_searched_at — THE STAMP ────────────────────────
    // The row's own record that this search reached this company, written
    // whether or not anyone was found. The list page swaps a targeted row's
    // Find people button for the searching orb while the people run is live,
    // and people landing beneath the row is the only other signal it has —
    // so without the stamp a company where nobody was found would keep its
    // orb until the whole run settled, minutes after its own search ended.
    await state.stampSearched(entry, candidate, outcome)

    state.progress.accounts_done += 1
    await state.write({})
  }

  if (parked) return await state.finish(parked.status, parked.error)
  return await state.finish('completed', null)
}

// ---------------------------------------------------------------------------
// PeopleRunState
// ---------------------------------------------------------------------------

class PeopleRunState extends BaseRunState {
  constructor(deps: RunEngineDeps, args: RunEngineArgs) {
    super(deps, args, 'people')
  }

  /**
   * `candidate.people_searched_at` for one company — see the call site.
   *
   * Spread over the candidate AS STORED so `account_card_at` and the discovery
   * keys survive the write. A failed stamp is deliberately not thrown: it is
   * a display hint, and an error here would hand Inngest a retry that re-runs
   * the paid search above it.
   */
  async stampSearched(
    entry: CompanyEntryRow,
    candidate: ProspectCandidate,
    outcome: PeopleSearchOutcome,
  ): Promise<void> {
    const at = this.nowIso()
    // `people_search` rides beside the stamp: the row's own summary of what
    // the search saw, so "1 found, already in this list" can be said on the
    // row and in the panel without a ledger fetch (see types.ts).
    const people_search: ProspectPeopleSearch = {
      at,
      ...outcome,
      known: outcome.known.slice(0, PEOPLE_SEARCH_KNOWN_CAP),
    }
    await this.deps.supabase
      .from('prospect_list_entry')
      .update({ candidate: { ...candidate, people_searched_at: at, people_search } })
      .eq('id', entry.id)
      .eq('workspace_id', this.args.workspaceId)
  }

  /**
   * One company's people: order, admit, insert, ledger.
   *
   * EVERY person reaches `prospect_run_candidate` — new, suppressed and
   * invalid alike (§6). A dedup that silently drops repeats is
   * indistinguishable from a search that found nothing, and for people that
   * distinction is the difference between "this company has no one we can
   * reach" and "you already know all of them".
   */
  async ingest(input: {
    people: PersonCandidate[]
    parentEntryId: string
    /** The company is saved: its people are inserted `saved` too. */
    parentSaved: boolean
    companyName: string
    companyDomain: string
    exclusions: ExclusionSet
    perCompany: number
    icpVersion: number
  }): Promise<PeopleSearchOutcome> {
    const {
      people,
      parentEntryId,
      parentSaved,
      companyName,
      companyDomain,
      exclusions,
      perCompany,
      icpVersion,
    } = input
    const ledger: LedgerRow[] = []
    const outcome: PeopleSearchOutcome = { found: 0, added: 0, known: [], capped: 0, invalid: 0 }

    // ANCHORED FIRST. `people_per_company` is a hard cap, so an unordered loop
    // would let unverifiable candidates consume the cap and push the verified
    // ones out. A stable sort keeps Exa's own ordering within each group,
    // which is roughly relevance order.
    const orderedPeople = [
      ...people.filter((p) => p.identity_state === 'anchored'),
      ...people.filter((p) => p.identity_state !== 'anchored'),
    ]

    // The exclusion post-filter, over the WHOLE response rather than only the
    // slice that fits the cap: a person suppressed because they are already a
    // contact must be RECORDED as such even if the cap would have excluded
    // them anyway, or the ledger under-reports what the search actually saw.
    const admission = admitCandidates(
      orderedPeople.map((person) => ({
        ...person,
        // `personCandidateKey` again rather than trusting the parser's key:
        // this is the one place email is available as a tier, and the contract
        // names this function as the source of the key that is stored.
        identity_key: personCandidateKey({
          linkedinUrl: person.linkedin_url,
          email: person.candidate.email ?? null,
          name: person.display_name,
          domain: companyDomain,
        }),
      })),
      exclusions,
    )

    for (const { candidate, by, ref_id } of admission.suppressed) {
      this.counts[by] = (this.counts[by] ?? 0) + 1
      this.progress.suppressed += 1
      this.progress.found += 1
      outcome.found += 1
      outcome.known.push({ name: candidate.display_name, by, ref_id })
      ledger.push(
        personLedgerRow(candidate, {
          outcome: 'suppressed',
          suppressed_by: by,
          suppressed_ref_id: ref_id,
        }),
      )
    }

    for (const candidate of admission.invalid) {
      // No LinkedIn, no email, and no usable name+domain pair — there is no
      // identity to store, so there is no row to create. Recorded anyway.
      this.progress.invalid += 1
      this.progress.found += 1
      outcome.found += 1
      outcome.invalid += 1
      ledger.push(personLedgerRow(candidate, { outcome: 'invalid' }))
    }

    // ── admitted → person entries, up to the cap ────────────────────────
    //
    // The cap bounds ROWS, never RECORDS. A person the cap turned away is
    // still written to the ledger — §6 again: a run that reports "3 found" for
    // a search that saw 7 leaves the user unable to tell a thin company from a
    // capped one, and "show me the other four" is the obvious next question.
    //
    // `suppressed_by='over_cap'` says exactly that, as of migration 251. Until
    // then this borrowed `this_list`, which was true only in the loosest sense
    // ("this list's run accounted for them") and was indistinguishable in the
    // audit trail from a genuine duplicate — the one question the ledger
    // exists to answer.
    let kept = 0
    for (const person of admission.admitted) {
      const key = person.identity_key
      if (!key) continue

      if (kept >= perCompany) {
        this.counts.over_cap = (this.counts.over_cap ?? 0) + 1
        this.progress.suppressed += 1
        this.progress.found += 1
        outcome.found += 1
        outcome.capped += 1
        ledger.push(
          personLedgerRow(person, {
            outcome: 'suppressed',
            // No `ref_id`: nothing was stored, so there is no row to link to.
            suppressed_by: 'over_cap',
            suppressed_ref_id: null,
          }),
        )
        continue
      }

      const { entryId, conflicted, error } = await this.insertPerson({
        person,
        key,
        parentEntryId,
        parentSaved,
        companyName,
        icpVersion,
      })
      if (error) {
        // Transient by construction: the insert is idempotent under
        // `UNIQUE (list_id, candidate_key)`, so an Inngest retry is safe.
        throw new Error(`prospect_list_entry insert failed: ${error}`)
      }

      if (conflicted) {
        // 23505 on `prospect_entry_key_idx` — this person is already in this
        // list, written by a concurrent run or by an earlier company in this
        // very run whose in-memory key we somehow missed. §6 Layer 2: a
        // suppression, not an error.
        this.counts.this_list = (this.counts.this_list ?? 0) + 1
        this.progress.suppressed += 1
        this.progress.found += 1
        outcome.found += 1
        outcome.known.push({ name: person.display_name, by: 'this_list', ref_id: null })
        ledger.push(
          personLedgerRow(person, {
            outcome: 'suppressed',
            suppressed_by: 'this_list',
            suppressed_ref_id: null,
          }),
        )
        continue
      }

      kept += 1
      this.newEntries += 1
      this.progress.new += 1
      this.progress.found += 1
      this.progress.people_found += 1
      outcome.found += 1
      outcome.added += 1
      // The key joins the live set immediately, so the NEXT company in this
      // same run refuses the same person rather than paying the 23505 to find
      // out. People do move between the accounts on one list.
      exclusions.set(key, { by: 'this_list', ref_id: entryId })
      ledger.push(personLedgerRow(person, { outcome: 'new', entry_id: entryId }))
    }

    await this.writeLedger(ledger)
    return outcome
  }

  private async insertPerson(input: {
    person: PersonCandidate
    key: string
    parentEntryId: string
    parentSaved: boolean
    companyName: string
    icpVersion: number
  }): Promise<{ entryId: string | null; conflicted: boolean; error: string | null }> {
    const { person, key, parentEntryId, parentSaved, companyName, icpVersion } = input
    const candidate: ProspectCandidate = {
      name: person.display_name,
      title: person.job_title,
      linkedin_url: person.linkedin_url,
      // The employer's domain — the search was ANCHORED to it, so this is the
      // one company we can state about this person with confidence.
      domain: person.candidate.domain ?? null,
      // DENORMALISED at insert, deliberately. A person's `company_id` is NULL
      // by construction (248's CHECK) and the shared views select carries no
      // self-join on `parent_entry_id`, so the People tab could not otherwise
      // name the account a person belongs to without a feature-specific join
      // in generic query code.
      company_name: companyName,
      // NULL unless the response actually carried one. The people card has no
      // email property, so in practice this is always null in v1 — but writing
      // an invented address into a field the outreach path will later read is
      // the one mistake here that costs a real person a cold email.
      email: person.candidate.email ?? null,
      seniority: person.seniority,
      one_liner: person.candidate.one_liner ?? null,
      found_via: 'synthesized',
    }

    const { data, error } = await this.deps.supabase
      .from('prospect_list_entry')
      .insert({
        workspace_id: this.args.workspaceId,
        list_id: this.args.listId,
        kind: 'person',
        candidate_key: key,
        candidate,
        parent_entry_id: parentEntryId,
        // A saved company's people are on the list from the moment they are
        // found (pending publish); anyone else's wait for the company to be
        // saved, when the cascade picks them up.
        stage: parentSaved ? 'saved' : 'discovered',
        // NEVER set for a person: migration 248's `prospect_entry_kind_target`
        // CHECK is `person ⇒ company_id IS NULL`. The account is reached
        // through `parent_entry_id`.
        company_id: null,
        // NULL until Publish promotes the person (§8, phase 6; migration 259).
        contact_id: null,
        identity_state: person.identity_state,
        // Fit lives on the ACCOUNT, never on a person: the same person scores
        // differently only because their employer does, and duplicating the
        // account's score onto every person would make a list of 5 people at
        // one hot company look like five hot opportunities.
        fit_score: null,
        fit_rationale: null,
        // Blob-shaped, AFTER the identity gate — a demoted field is kept at
        // `confidence: 'low'` so the UI can show it as Unverified rather than
        // hiding what we found.
        research: person.fields,
        sources: sourcesOfPerson(person),
        icp_version: icpVersion,
        discovered_by_run_id: this.args.runId,
      })
      .select('id')
      .single()

    if (error) {
      if (error.code === '23505') return { entryId: null, conflicted: true, error: null }
      return { entryId: null, conflicted: false, error: error.message }
    }
    return { entryId: (data as { id: string } | null)?.id ?? null, conflicted: false, error: null }
  }

  /** The ledger, in ONE insert per company. `UNIQUE (run_id, identity_key)`
   *  means a person seen at two companies collides — expected, and swallowed:
   *  the first company's record is the true one, and a batch that partially
   *  conflicts is retried row-by-row so one repeat cannot lose the rest. */
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
      // never fail a company that actually found people.
      console.error('[prospecting] person ledger insert failed:', error.message)
      return
    }
    for (const row of payload) {
      const { error: rowError } = await this.deps.supabase
        .from('prospect_run_candidate')
        .insert(row)
      if (rowError && rowError.code !== '23505') {
        console.error('[prospecting] person ledger row insert failed:', rowError.message)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The run row's live status and target list, in ONE read per iteration: the
 * cancel gate and the queue-on-click append both live on that row.
 *
 * A failed read answers "not cancelling, nothing new" — the same degradation
 * `isCanceling` has always had. The next iteration reads again.
 */
async function readGate(
  deps: RunEngineDeps,
  args: RunEngineArgs,
): Promise<{ canceling: boolean; targetIds: string[] }> {
  const { data, error } = await deps.supabase
    .from('prospecting_run')
    .select('status, target_entry_ids')
    .eq('id', args.runId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (error) {
    console.error('[prospecting] people gate read failed:', error.message)
    return { canceling: false, targetIds: [] }
  }
  const row = data as { status?: string; target_entry_ids?: unknown } | null
  const raw = Array.isArray(row?.target_entry_ids) ? (row.target_entry_ids as unknown[]) : []
  return {
    canceling: row?.status === 'canceling',
    targetIds: raw.filter((id): id is string => typeof id === 'string' && id.length > 0),
  }
}

/** `queue` with every id in `fresh` it does not already hold appended, in
 *  `fresh`'s order. The run row is append-only, so this is normally "the same
 *  list, longer"; anything odder still yields one stable order. */
function mergeTargets(queue: string[], fresh: string[]): string[] {
  const seen = new Set(queue)
  const out = [...queue]
  for (const id of fresh) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

async function readTargetEntries(
  deps: RunEngineDeps,
  args: RunEngineArgs,
  ids: readonly string[],
): Promise<CompanyEntryRow[]> {
  if (ids.length === 0) return []
  const { data, error } = await deps.supabase
    .from('prospect_list_entry')
    .select(ENTRY_COLUMNS)
    .eq('workspace_id', args.workspaceId)
    .eq('list_id', args.listId)
    .in('id', ids as string[])
  if (error) throw new Error(`prospect_list_entry read failed: ${error.message}`)
  return ((data ?? []) as unknown as CompanyEntryRow[]).filter(
    (row) => row.kind === 'company' && row.stage !== 'dismissed',
  )
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The buyer titles, joined for the query. Falls back to a generic phrasing
 *  rather than producing "Current  at Acme (acme.com)" — an ICP with no titles
 *  is a legitimate state (the field is optional narrowing) and the search
 *  should still run. */
export function buyerTitlesOf(icp: Icp): string {
  const titles = (icp.target.buyer_titles ?? []).map((t) => t.trim()).filter(Boolean)
  return titles.length > 0 ? titles.join(', ') : 'decision makers'
}

function readCandidate(raw: unknown): ProspectCandidate {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as ProspectCandidate
  return {}
}

/** The account's domain: the candidate's own, falling back to the
 *  `candidate_key`, which IS the normalized domain for a company entry. */
function domainOf(entry: CompanyEntryRow, candidate: ProspectCandidate): string | null {
  const fromCandidate = typeof candidate.domain === 'string' ? candidate.domain.trim() : ''
  if (fromCandidate) return fromCandidate
  const key = entry.candidate_key?.trim()
  if (key && !key.includes('@') && !key.includes('/')) return key
  return null
}

/** The distinct citations behind a person's fields — the same
 *  `{url, title, published_date}` shape `entry.sources` carries for a company,
 *  so one renderer serves both. */
function sourcesOfPerson(
  person: PersonCandidate,
): Array<{ url: string; title: string | null; published_date: string | null }> {
  const seen = new Set<string>()
  const out: Array<{ url: string; title: string | null; published_date: string | null }> = []
  for (const field of Object.values(person.fields)) {
    const url = field?.source_url
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push({ url, title: field.source_title ?? null, published_date: null })
  }
  return out
}

/**
 * One ledger row for a person.
 *
 * `identity_key` is NOT NULL in the table, so an invalid candidate — which by
 * definition has no key — gets a synthetic one derived from what it DID carry.
 * Recording "we saw someone here and could not identify them" is the entire
 * reason the invalid outcome exists.
 */
function personLedgerRow(
  person: Pick<PersonCandidate, 'identity_key' | 'display_name' | 'raw'>,
  fields: Pick<LedgerRow, 'outcome' | 'suppressed_by' | 'suppressed_ref_id' | 'entry_id'>,
): LedgerRow {
  const key =
    person.identity_key ??
    (person.display_name ? `invalid:person:${person.display_name.toLowerCase()}` : null) ??
    `invalid:person:${JSON.stringify(person.raw).slice(0, 60)}`
  return {
    identity_key: key,
    display_name: person.display_name,
    raw: person.raw,
    // People are not found by a discovery angle; the column stays NULL rather
    // than borrowing the parent's, which would make angle telemetry count one
    // company's people as extra hits for that angle.
    discovery_angle: null,
    suppressed_by: null,
    suppressed_ref_id: null,
    entry_id: null,
    ...fields,
  }
}
