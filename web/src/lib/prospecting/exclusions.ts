/**
 * Layer 3 of the dedup story (spec §6) — the exclusion set, recomputed live at
 * the start of every round, and the post-filter that is the AUTHORITATIVE
 * correctness guarantee.
 *
 * Read the scoping honestly, because it is easy to overclaim: the DATABASE
 * guarantees only that a candidate cannot enter the SAME list twice, via
 * `UNIQUE (list_id, candidate_key)` (migration 248). Every other rule below —
 * crm, other_lists, dismissed_global, contacted, opted_out, self — is
 * application code in this file, applied post-parse. Nothing about them is
 * "correct by construction".
 *
 * Two places consume this set, deliberately (§6, "Where it is applied"):
 *
 *   1. A PROMPT HINT of up to ~30 suppressed domains, which is a cost
 *      optimization ONLY. Exa's company and people categories 400 on
 *      `excludeDomains` (`deep-search.ts`), so the exclusion has to travel as
 *      prose, and the measured leak rate is 2 of 30 (§12). Never rely on it.
 *   2. {@link admitCandidates}, run on parse before any row is written. THIS
 *      is the guarantee.
 *
 * And the part that makes dedup trustworthy at all: nothing is silently
 * dropped. Every suppressed candidate comes back with the rule that caught it
 * and a `ref_id` pointing at the record responsible, so the run's "17 skipped"
 * row expands into an audit trail. A dedup that silently drops repeats is
 * indistinguishable from a search that found nothing.
 *
 * No network, no LLM. Every query carries an explicit `workspace_id` filter —
 * this module runs under the service-role client inside the Inngest lane, so
 * RLS is never the only boundary.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { companyDomainFromEmail, isPersonalDomain } from '@/lib/crm/domains'
import { companyCandidateKey, personCandidateKey } from './keys'
import type {
  ExclusionSnapshot,
  ProspectExcludeContacted,
  ProspectSuppressionSource,
  ProspectingRunCounts,
} from './types'
import { PROSPECT_GLOBAL_DISMISS_REASONS, PROSPECT_SUPPRESSION_SOURCES } from './types'

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Why a key is suppressed, and which record is to blame. */
export interface ExclusionHit {
  by: ProspectSuppressionSource
  /**
   * The CRM record / entry / suppression row that caused it, for the UI's
   * "already in your CRM →" link. NULL for rules that are not row-backed:
   * `self` derives from the workspace's own domains, and `personal_domain` is
   * a property of the key itself rather than of any stored row.
   */
  ref_id: string | null
}

/** `Map<candidate_key, hit>`. Built once per round and consulted per candidate. */
export type ExclusionSet = Map<string, ExclusionHit>

export interface BuildExclusionSetArgs {
  workspaceId: string
  /** The list being run. Its own entries are the `this_list` source; every
   *  OTHER active list is the `other_list` source. */
  listId: string
  options: {
    exclude_crm: boolean
    exclude_other_lists: boolean
    exclude_contacted: ProspectExcludeContacted
  }
  /** The source company's domain — "us". Any form; normalized here. */
  sourceDomain?: string | null
  /** Every workspace member's email. Their employer domains are also "us". */
  memberEmails?: readonly (string | null | undefined)[]
}

/**
 * Precedence when one key is hit by several sources. The set stores ONE hit
 * per key, so the order decides what the audit row says, and the ordering is
 * chosen so the reason shown is the most ACTIONABLE one:
 *
 *   1. `this_list`      — "it is already right here in this list" answers the
 *                         user's question completely. Nothing else is worth
 *                         saying once this is true, and it is also the only
 *                         rule the database itself enforces.
 *   2. `dismissed_global` — a deliberate human verdict ("competitor",
 *                         "already a customer") outranks every mechanical
 *                         rule. Telling someone their competitor was skipped
 *                         "because it is in your CRM" hides the decision they
 *                         made.
 *   3. `opted_out`      — a compliance fact, and the worst failure this
 *                         feature can have is re-contacting an opted-out
 *                         person. It ranks above everything mechanical so it
 *                         can never be masked in the audit trail.
 *   4. `self`           — "this is you" is a correctness statement about the
 *                         search, not about the CRM.
 *   5. `crm`            — the common, expected case: you already own it.
 *   6. `contacted`      — narrower than `crm` (a contacted person is nearly
 *                         always also in the CRM), so surfacing it under `crm`
 *                         would waste the more specific reason. It sits below
 *                         `crm` only because `crm` is the account-level fact
 *                         and toggling `exclude_crm` off is the coarser lever.
 *   7. `other_list`     — the weakest and the only OFF-by-default rule; it
 *                         should never mask a reason from this workspace's
 *                         canonical data.
 *
 * `personal_domain`, `noise_host`, `over_cap` and `invalid` are not in this
 * table. The first two are properties of the candidate's own key (it could not
 * be built) and are decided by {@link admitCandidates}; `over_cap` is a
 * property of how many rows the people stage has already kept for one company
 * and is decided there. None of them is ever a stored row's verdict, so none
 * of them can lose a precedence contest.
 */
const PRECEDENCE: readonly ProspectSuppressionSource[] = [
  'this_list',
  'dismissed_global',
  'opted_out',
  'self',
  'crm',
  'contacted',
  'other_list',
]

function rank(by: ProspectSuppressionSource): number {
  const i = PRECEDENCE.indexOf(by)
  // 'personal_domain', 'noise_host' and 'over_cap' never enter the set; treat
  // any unknown as weakest.
  return i < 0 ? PRECEDENCE.length : i
}

/** Insert unless an equal-or-stronger reason already claimed this key. */
function claim(set: ExclusionSet, key: string | null | undefined, hit: ExclusionHit): void {
  if (!key) return
  const existing = set.get(key)
  if (existing && rank(existing.by) <= rank(hit.by)) return
  set.set(key, hit)
}

// ---------------------------------------------------------------------------
// Row shapes read from the database
// ---------------------------------------------------------------------------

interface EntryRow {
  id: string
  list_id: string
  candidate_key: string
  stage: string | null
  dismissed_reason: string | null
}

interface CompanyRow {
  id: string
  domain: string | null
}

interface ContactRow {
  id: string
  email: string | null
  secondary_emails: string[] | null
  linkedin_url: string | null
}

interface EnrollmentRow {
  id: string
  contact_id: string | null
  contact_email: string | null
  status: string | null
}

interface SuppressionRow {
  id: string
  email: string | null
}

/** Uniform read helper: one place that logs and throws, so a silently empty
 *  result — an exclusion set that would re-surface everything the user already
 *  owns, a list that renders as empty — can never be a swallowed error. */
function unwrap<T>(
  label: string,
  res: { data: unknown; error: { message: string } | null },
): T[] {
  if (res.error) {
    console.error(`[prospecting] read failed (${label}):`, res.error.message)
    // The label, not a fixed sentence: `readAll` is shared with `lists.ts` and
    // `telemetry.ts`, and "Failed to build exclusion set" on a list-entries
    // read sends the next reader to the wrong file.
    throw new Error(`prospecting read failed: ${label}`)
  }
  return (res.data ?? []) as T[]
}

/** PostgREST's default response cap. A read that returns exactly this many
 *  rows may have more behind it. */
export const PAGE_SIZE = 1000

/** Ids per `.in()` read: keeps the GET URL well under gateway limits. */
const ENROLLED_CONTACT_CHUNK = 100

/**
 * Read EVERY row, not the first page.
 *
 * This is a correctness requirement, not a scale nicety. PostgREST caps a
 * response at {@link PAGE_SIZE} rows by default and truncates SILENTLY — no
 * error, no flag. An unpaginated read on a workspace with more than 1000
 * contacts therefore yields a quietly incomplete exclusion set, and the run
 * re-surfaces accounts the user already owns while looking like it worked.
 * That is the exact failure §6 exists to prevent, and it is invisible.
 *
 * `page` must apply a STABLE `.order(...)` of its own — without one PostgREST
 * may return the same row in two windows and this loop will duplicate it.
 *
 * Ordering by `id` gives the pages a stable window. Every page still goes
 * through {@link unwrap}, so the throw-on-error contract is unchanged.
 *
 * Matches the convention in `src/lib/crm/contact-dedup.ts:loadActiveContacts`.
 *
 * EXPORTED because the same hazard is not unique to the exclusion set: every
 * unbounded prospecting read has it. `lists.ts` reads a list's entries and the
 * per-list stage counts with no limit at all, and a list past 1000 entries —
 * which one discover run plus one people run can reach — would silently render
 * a truncated board and truncated tab counts. One implementation, one place to
 * get the short-page rule right.
 */
export async function readAll<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const batch = unwrap<T>(label, await page(offset, offset + PAGE_SIZE - 1))
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) break
  }
  return rows
}

// ---------------------------------------------------------------------------
// buildExclusionSet
// ---------------------------------------------------------------------------

/**
 * Build the round's exclusion set from the seven sources in §6's Layer-3
 * table. Recomputed LIVE at the start of every round, never cached: a company
 * added to the CRM between round 1 and round 2 must suppress in round 2.
 *
 * Throws when any read fails, on purpose. A partially-built set is worse than
 * no run at all — it would look like a successful search that happened to
 * re-discover 40 accounts the user already owns.
 */
export async function buildExclusionSet(
  supabase: SupabaseClient,
  args: BuildExclusionSetArgs,
): Promise<ExclusionSet> {
  const { workspaceId, listId, options } = args
  const set: ExclusionSet = new Map()

  // -- entries: this_list, dismissed_global, other_list -----------------------
  //
  // ONE read covers three sources. The alternative — three filtered reads —
  // would race itself: a row could be dismissed between them and land in the
  // set twice under two reasons, or in neither.
  //
  // `other_list` is scoped to ACTIVE lists (an archived list is a decision the
  // user has put away and must not keep suppressing), but `this_list` and
  // `dismissed_global` are not: this list is the list being run, and a global
  // dismissal is a verdict about the company, not about the list it happened
  // in.
  const activeListIds = new Set(
    (
      await readAll<{ id: string }>('active lists', (from, to) =>
        supabase
          .from('prospect_list')
          .select('id')
          .eq('workspace_id', workspaceId)
          .eq('status', 'active')
          .order('id')
          .range(from, to),
      )
    ).map((l) => l.id),
  )

  const entries = await readAll<EntryRow>('entries', (from, to) =>
    supabase
      .from('prospect_list_entry')
      .select('id, list_id, candidate_key, stage, dismissed_reason')
      .eq('workspace_id', workspaceId)
      .order('id')
      .range(from, to),
  )

  const globalReasons = new Set<string>(PROSPECT_GLOBAL_DISMISS_REASONS)
  for (const row of entries) {
    if (!row.candidate_key) continue

    if (row.list_id === listId) {
      // Every entry in THIS list at ANY stage, dismissed included. This is the
      // rule that gives an emailless person a home: the key lives on the
      // entry, so it holds without an email, without a CRM row, and after the
      // CRM row is deleted (ON DELETE SET NULL, never cascade).
      claim(set, row.candidate_key, { by: 'this_list', ref_id: row.id })
      continue
    }

    // A `competitor` / `already_customer` dismissal is a verdict about the
    // COMPANY and suppresses in every list, including lists that do not exist
    // yet (decision 3). `not_icp` / `too_small` are genuinely list-relative
    // and deliberately do not.
    if (row.stage === 'dismissed' && row.dismissed_reason && globalReasons.has(row.dismissed_reason)) {
      claim(set, row.candidate_key, { by: 'dismissed_global', ref_id: row.id })
      continue
    }

    // Off by default, and rightly so: a company discovered-but-unsaved in list
    // A is a candidate nobody has acted on, and list B is allowed to find it.
    if (options.exclude_other_lists && activeListIds.has(row.list_id)) {
      claim(set, row.candidate_key, { by: 'other_list', ref_id: row.id })
    }
  }

  // -- crm -------------------------------------------------------------------
  if (options.exclude_crm) {
    const companies = await readAll<CompanyRow>('crm companies', (from, to) =>
      supabase
        .from('company')
        .select('id, domain')
        .eq('workspace_id', workspaceId)
        .not('domain', 'is', null)
        .order('id')
        .range(from, to),
    )
    for (const c of companies) {
      // Through companyCandidateKey, not raw `domain`: the set difference has
      // to be exact, and a hand-typed "https://Acme.com/" in the CRM must
      // suppress the discovered "acme.com".
      claim(set, companyCandidateKey(c.domain), { by: 'crm', ref_id: c.id })
    }

    // `merged_into_contact_id IS NULL` excludes merge tombstones, and
    // `secondary_emails` is where the tombstone's address WENT: merge_contacts()
    // NULLs the loser's email and folds it into the survivor's array. Reading
    // only `email` would make every merged-away address re-discoverable —
    // exactly the OR-filter findOrCreateContact applies and enrollContacts
    // does not (§6, point 1).
    const contacts = await readAll<ContactRow>('crm contacts', (from, to) =>
      supabase
        .from('contact')
        .select('id, email, secondary_emails, linkedin_url')
        .eq('workspace_id', workspaceId)
        .is('merged_into_contact_id', null)
        .order('id')
        .range(from, to),
    )
    for (const c of contacts) {
      const emails = [c.email, ...(c.secondary_emails ?? [])]
      for (const email of emails) {
        claim(set, personCandidateKey({ email }), { by: 'crm', ref_id: c.id })
      }
      // The only person key that survives having no email at all.
      claim(set, personCandidateKey({ linkedinUrl: c.linkedin_url }), { by: 'crm', ref_id: c.id })
    }
  }

  // -- contacted -------------------------------------------------------------
  //
  // Read `sequence_enrollment` DIRECTLY rather than shadowing it in a column
  // of our own. That is what makes "there is no stage='contacted' to go stale"
  // true rather than aspirational.
  //
  // The tri-state is a product decision, not a nicety: enrollContacts' own
  // `already_active` check is `status='active'` only, so hardcoding 'ever'
  // here would permanently hide the entire re-engagement segment.
  //
  // Known, bounded divergence (§6, point 2): enrollContacts reads only
  // `id, email` and never `secondary_emails`, so a contact enrolled under an
  // address later folded into another contact can be suppressed here and not
  // there, or the reverse. Stated, not papered over.
  if (options.exclude_contacted !== 'off') {
    const enrollments = await readAll<EnrollmentRow>('enrollments', (from, to) =>
      supabase
        .from('sequence_enrollment')
        .select('id, contact_id, contact_email, status')
        .eq('workspace_id', workspaceId)
        .order('id')
        .range(from, to),
    )
    const wanted =
      options.exclude_contacted === 'active'
        ? enrollments.filter((e) => e.status === 'active')
        : enrollments

    // Account-level suppression needs the enrolled person's company, and
    // `sequence_enrollment` has no `company_id`. The join is
    // enrollment → contact → company, which yields NOTHING for an enrollment
    // created from a bare email (contact_id IS NULL) — so the domain falls
    // back to companyDomainFromEmail(contact_email). Without that fallback the
    // account-level rule is silently partial (§6, point 3).
    const contactIds = Array.from(
      new Set(wanted.map((e) => e.contact_id).filter((id): id is string => !!id)),
    )
    const contactCompanyDomain = new Map<string, string | null>()
    // Chunked: one `.in()` over every enrolled contact would put hundreds of
    // uuids in a single GET URL, which the gateway rejects.
    for (let i = 0; i < contactIds.length; i += ENROLLED_CONTACT_CHUNK) {
      const chunk = contactIds.slice(i, i + ENROLLED_CONTACT_CHUNK)
      const rows = await readAll<{ id: string; company: { domain: string | null } | null }>(
        'enrolled contacts',
        (from, to) =>
          supabase
            .from('contact')
            .select('id, company:company_id (domain)')
            .eq('workspace_id', workspaceId)
            .in('id', chunk)
            .order('id')
            .range(from, to),
      )
      for (const row of rows) {
        // PostgREST returns an embedded to-one either as an object or, on some
        // relationship shapes, as a one-element array. Accept both.
        const embedded = Array.isArray(row.company) ? row.company[0] : row.company
        contactCompanyDomain.set(row.id, embedded?.domain ?? null)
      }
    }

    for (const e of wanted) {
      claim(set, personCandidateKey({ email: e.contact_email }), {
        by: 'contacted',
        ref_id: e.id,
      })
      const domain = e.contact_id
        ? (contactCompanyDomain.get(e.contact_id) ?? companyDomainFromEmail(e.contact_email))
        : companyDomainFromEmail(e.contact_email)
      claim(set, companyCandidateKey(domain), { by: 'contacted', ref_id: e.id })
    }
  }

  // -- opted_out — always on, no toggle --------------------------------------
  //
  // Re-surfacing an opted-out person and re-contacting them is the worst
  // failure this feature can have, so this source has no switch. enrollContacts
  // checks the same table; the exclusion set must too, or the list shows a row
  // that Add-to-sequence will then refuse.
  const suppressions = await readAll<SuppressionRow>('opt-outs', (from, to) =>
    supabase
      .from('outreach_suppression')
      .select('id, email')
      .eq('workspace_id', workspaceId)
      .order('id')
      .range(from, to),
  )
  for (const s of suppressions) {
    claim(set, personCandidateKey({ email: s.email }), { by: 'opted_out', ref_id: s.id })
  }

  // -- self — always on ------------------------------------------------------
  //
  // The source company's own domain plus every member's employer domain.
  // companyDomainFromEmail returns null for webmail, so a member who signed up
  // with a personal address contributes nothing rather than suppressing
  // gmail.com as if it were the workspace's own company.
  claim(set, companyCandidateKey(args.sourceDomain), { by: 'self', ref_id: null })
  for (const email of args.memberEmails ?? []) {
    claim(set, companyCandidateKey(companyDomainFromEmail(email)), { by: 'self', ref_id: null })
  }

  return set
}

// ---------------------------------------------------------------------------
// admitCandidates — the authoritative post-filter
// ---------------------------------------------------------------------------

/** What a caller must supply per candidate: the key, or null when it could not
 *  be built. Everything else rides along untouched. */
export interface AdmissionCandidate {
  /** Output of `companyCandidateKey` / `personCandidateKey`; null = unusable.
   *
   *  Named `identity_key` to match what `parse.ts` produces and what
   *  `prospect_run_candidate.identity_key` stores — the table that records
   *  EVERY candidate, admitted or not, and therefore the one this filter
   *  feeds. The same value lands in `prospect_list_entry.candidate_key` for
   *  the admitted subset; that column keeps its own name, so `EntryRow`
   *  above still reads `candidate_key`. One value, two columns, and the
   *  in-memory shape follows the parser rather than either table. */
  identity_key: string | null
  /**
   * True when the key builder rejected a freemail/webmail domain specifically,
   * as opposed to finding nothing usable at all. The distinction is worth a
   * column: "we skipped gmail.com because it is a mail provider" is a
   * different story from "this result had no identity we could read", and
   * `suppressed_by='personal_domain'` exists to tell them apart.
   *
   * FREEMAIL ONLY since migration 251. A platform host sets {@link noise_host}
   * instead; before 251 both shared this flag because the CHECK had no value
   * for the second.
   */
  personal_domain?: boolean
  /**
   * True when the key was refused because the host is a platform or aggregator
   * — linkedin.com, crunchbase.com, a recruiter site — rather than a company.
   * See {@link isNoiseHost}.
   */
  noise_host?: boolean
}

export interface AdmissionResult<C extends AdmissionCandidate> {
  admitted: C[]
  suppressed: Array<{ candidate: C; by: ProspectSuppressionSource; ref_id: string | null }>
  invalid: C[]
}

/**
 * THE correctness guarantee (§6, "Where it is applied"). Runs on every parsed
 * candidate before any row is written, and never relies on Exa having honoured
 * the prompt hint — the measured leak is 2 of 30 and that is expected, not a
 * failure.
 *
 * Nothing is dropped. A suppressed candidate comes back with the rule and the
 * `ref_id`, so `prospect_run_candidate` records the whole round including the
 * parts that never became entries.
 *
 * Within one call the same key is admitted at most ONCE: a candidate that
 * appears under two discovery angles would otherwise pass twice and hit the
 * `UNIQUE (list_id, candidate_key)` 23505 as a surprise. The duplicate is
 * reported as `this_list` — which is what it will be by the time the second
 * copy is considered.
 */
export function admitCandidates<C extends AdmissionCandidate>(
  candidates: readonly C[],
  set: ExclusionSet,
): AdmissionResult<C> {
  const admitted: C[] = []
  const suppressed: AdmissionResult<C>['suppressed'] = []
  const invalid: C[] = []
  const seen = new Set<string>()

  for (const candidate of candidates) {
    const key = candidate.identity_key
    // A platform host that reached here with a key intact — a caller that
    // built its key itself rather than through `companyAdmission`. Refuse it
    // here too: this function is the AUTHORITATIVE post-filter, and a rule it
    // can only enforce when the caller remembered to pre-apply it is not one.
    if (key && isNoiseHost(key)) {
      suppressed.push({ candidate, by: 'noise_host', ref_id: null })
      continue
    }
    if (!key) {
      if (candidate.noise_host) {
        // A platform/aggregator host that `companyAdmission` already refused,
        // so it arrives keyless. It gets its OWN source (migration 251) rather
        // than borrowing `personal_domain`: a run that reports "6 personal
        // domains" when it skipped six LinkedIn pages is lying about what the
        // search returned, and the two ask the user for different things —
        // webmail means "this result had no company behind it", a noise host
        // means "the search drifted onto a directory".
        suppressed.push({ candidate, by: 'noise_host', ref_id: null })
      } else if (candidate.personal_domain) {
        // A candidate that cannot produce a key never becomes a row. When the
        // reason was a FREEMAIL domain we say so: a run that reports
        // "6 invalid" and one that reports "6 personal domains" ask the user
        // for different things.
        suppressed.push({ candidate, by: 'personal_domain', ref_id: null })
      } else {
        invalid.push(candidate)
      }
      continue
    }

    const hit = set.get(key)
    if (hit) {
      suppressed.push({ candidate, by: hit.by, ref_id: hit.ref_id })
      continue
    }

    if (seen.has(key)) {
      suppressed.push({ candidate, by: 'this_list', ref_id: null })
      continue
    }

    seen.add(key)
    admitted.push(candidate)
  }

  return { admitted, suppressed, invalid }
}

// ---------------------------------------------------------------------------
// Noise hosts
// ---------------------------------------------------------------------------

/**
 * Platform and aggregator hosts that are never a prospect.
 *
 * §7 on the two-source harvest: "Result hosts include noise (linkedin.com,
 * recruiter sites, chimewell.io), so the personal/noise-domain filter and the full
 * exclusion set run over both sources." This is that filter's host half.
 *
 * It is genuinely needed rather than defensive. `parseDiscoveryResponse`
 * harvests `results[].entities[]` by the RESULT's host, and on the recorded
 * 25-result discovery response those hosts include `linkedin.com` (from a
 * `linkedin.com/company/...` result). `companyCandidateKey` rejects only
 * WEBMAIL via `isPersonalDomain`, so `linkedin.com` sails through with a
 * perfectly valid key and would become a live `prospect_list_entry` with
 * `candidate_key='linkedin.com'` — a row the user cannot act on and cannot
 * explain.
 *
 * They are surfaced deliberately (§6 requires every candidate be RECORDED with
 * an outcome rather than vanishing); this is where they are refused, under
 * `suppressed_by='noise_host'` since migration 251.
 *
 * Matching is on the registrable-ish suffix as well as the exact host, so
 * `www.linkedin.com` and `uk.linkedin.com` are caught by the same entry.
 */
const NOISE_HOSTS: ReadonlySet<string> = new Set([
  // Professional/social networks — the most common false positive by far.
  'linkedin.com',
  'facebook.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'youtube.com',
  'reddit.com',
  // Company databases and directories: a page ABOUT companies, not a company.
  'crunchbase.com',
  'pitchbook.com',
  'owler.com',
  'zoominfo.com',
  'apollo.io',
  'clearbit.com',
  'g2.com',
  'capterra.com',
  'producthunt.com',
  // Jobs / recruiting — where the "hiring" signal angle lands.
  'glassdoor.com',
  'indeed.com',
  'wellfound.com',
  'angel.co',
  'lever.co',
  'greenhouse.io',
  'ashbyhq.com',
  'workable.com',
  'ziprecruiter.com',
  'monster.com',
  // Publishing and code hosting.
  'github.com',
  'gitlab.com',
  'medium.com',
  'substack.com',
  'wordpress.com',
  'blogspot.com',
  'notion.site',
  'wikipedia.org',
  // Press.
  'techcrunch.com',
  'forbes.com',
  'businesswire.com',
  'prnewswire.com',
  'bloomberg.com',
  'reuters.com',
])

/**
 * Is this host a platform/aggregator rather than a company?
 *
 * Exact match or a dot-suffix match, so `uk.linkedin.com` and
 * `www.crunchbase.com` are both caught by their one entry.
 */
export function isNoiseHost(domain: string | null | undefined): boolean {
  const host = (domain ?? '').trim().toLowerCase().replace(/^www\./, '')
  if (!host) return false
  if (NOISE_HOSTS.has(host)) return true
  for (const noise of NOISE_HOSTS) {
    if (host.endsWith(`.${noise}`)) return true
  }
  return false
}

/**
 * Convenience for callers holding a raw domain rather than a pre-built key:
 * produces the `{identity_key, personal_domain}` pair `admitCandidates` wants,
 * so the personal-domain distinction is made in ONE place instead of at every
 * harvest site.
 */
export function companyAdmission(domainOrUrl: string | null | undefined): {
  identity_key: string | null
  personal_domain: boolean
  noise_host: boolean
} {
  const key = companyCandidateKey(domainOrUrl)
  // A platform/aggregator host is a real, parseable domain, so
  // `companyCandidateKey` happily returns a key for it. It is still not a
  // company, and it must never become an entry — see {@link isNoiseHost}.
  // It reports as `noise_host`, NOT as `personal_domain`: since 251 those are
  // two different facts and the run summary distinguishes them.
  if (key && isNoiseHost(key)) {
    return { identity_key: null, personal_domain: false, noise_host: true }
  }
  if (key) return { identity_key: key, personal_domain: false, noise_host: false }
  // Re-ask the narrower question: was there a real domain that we rejected
  // BECAUSE it is webmail, or was there nothing readable at all?
  const raw = (domainOrUrl ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0]
  return {
    identity_key: null,
    personal_domain: !!raw && isPersonalDomain(raw),
    noise_host: false,
  }
}

// ---------------------------------------------------------------------------
// exclusionSnapshot
// ---------------------------------------------------------------------------

/**
 * `prospecting_run.exclusion_snapshot`, written at preflight so the UI can say
 * "excluding 412 domains you already know" BEFORE the first paid call — the
 * number that makes the consent screen honest.
 *
 * `domain_count` is the whole set, not just the company half: it is the size
 * of what this run will refuse to re-surface, and a suppressed LinkedIn
 * profile counts every bit as much as a suppressed domain.
 */
export function exclusionSnapshot(set: ExclusionSet): ExclusionSnapshot {
  const sources: Partial<Record<keyof ProspectingRunCounts, number>> = {}
  for (const hit of set.values()) {
    sources[hit.by] = (sources[hit.by] ?? 0) + 1
  }
  return { domain_count: set.size, sources }
}

/** A zeroed {@link ProspectingRunCounts} — every key present, so the run's
 *  tally never renders a hole where a reason with no hits should be a 0. */
export function emptyRunCounts(): ProspectingRunCounts {
  const counts = {} as ProspectingRunCounts
  for (const source of PROSPECT_SUPPRESSION_SOURCES) counts[source] = 0
  return counts
}

/** Up to `limit` company domains from the set, for the prompt hint. A COST
 *  OPTIMIZATION ONLY — the post-filter is what makes the run correct. Person
 *  keys are excluded: a LinkedIn slug in a domain-exclusion sentence teaches
 *  the model nothing and burns prompt budget. */
export function suppressedDomainHints(set: ExclusionSet, limit = 30): string[] {
  const domains: string[] = []
  for (const key of set.keys()) {
    if (domains.length >= limit) break
    // Person keys are `linkedin.com/in/<slug>`, `<email>` or `<name>@<domain>`.
    if (key.includes('@') || key.startsWith('linkedin.com/in/')) continue
    domains.push(key)
  }
  return domains
}
