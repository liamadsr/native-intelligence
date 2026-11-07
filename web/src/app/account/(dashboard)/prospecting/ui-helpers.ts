/**
 * Presentation vocabulary shared by the Prospecting pages.
 *
 * The two colour/label maps deliberately MIRROR the ones in
 * `src/components/views/list/entity-row.tsx` rather than importing them: those
 * are module-private to the row renderer, and the alternative — exporting them
 * from a file the whole views system pulls in — would widen a shared surface
 * for two consts. The lockstep that actually matters (the stage vocabulary
 * against migration 248) is pinned by a test here instead.
 */

import type { IcpDraft } from '@/lib/prospecting/icp'
import { PROSPECTING_RUN_STAGES, PROSPECT_SUPPRESSION_SOURCES } from '@/lib/prospecting/types'
import type {
  ProspectEntryStage,
  ProspectExcludeContacted,
  ProspectSuppressionSource,
  ProspectingRunCounts,
  ProspectingRunProgress,
  ProspectingRunStatus,
} from '@/lib/prospecting/types'
import {
  ESTIMATED_ACCOUNT_CARD_DOLLARS,
  ESTIMATED_DISCOVERY_CALL_DOLLARS,
  ESTIMATED_PEOPLE_CALL_DOLLARS,
  ESTIMATED_SECONDS_PER_COMPANY,
} from '@/lib/prospecting/spend'
import type { SkippedEntry } from '@/lib/prospecting/lists'

/**
 * THE SCORE SCALE LIVES IN `@/lib/prospecting/fit-display`, not here.
 *
 * The list row (shared views system) and the panel's `FitScore` chip both read
 * it from there, so the colours and the tooltip cannot drift between the two.
 * Import `FitScore` from './fit-score'.
 */

export const STAGE_LABELS: Record<ProspectEntryStage, string> = {
  discovered: 'Discovered',
  shortlisted: 'Shortlisted',
  saved: 'Saved to CRM',
  dismissed: 'Dismissed',
}

/** Segment colours for the stage bar on an index card. */
export const STAGE_BAR_CLASS: Record<ProspectEntryStage, string> = {
  discovered: 'bg-muted-foreground/30',
  shortlisted: 'bg-sky-500/60',
  saved: 'bg-emerald-500/70',
  dismissed: 'bg-muted-foreground/15',
}

/**
 * MOVED to `@/lib/prospecting/types` and re-exported here.
 *
 * The views system now draws this chip too — `entity-row.tsx` renders a
 * `prospect_list` row's purpose — and a shared component cannot import from a
 * page folder. Re-exported rather than relocated at the call sites so every
 * existing page import (`prospecting-view`, `list-detail`) is unchanged.
 */
export { PROSPECT_PURPOSE_LABELS as PURPOSE_CHIP_LABELS } from '@/lib/prospecting/types'

/**
 * Why the save route refused an entry, in words a user can act on.
 *
 * `Partial` + a fallback in {@link saveSkipLabel}, NOT an exhaustive Record:
 * the reason union is owned by the save route (Package A) and grows there
 * first. An exhaustive map turns a new server reason into a BUILD failure in
 * the UI package, which in a two-package build is the one failure mode that
 * blocks the wrong half — the honest client behaviour for an unknown reason is
 * to print the raw code, not to refuse to compile.
 */
export const SAVE_SKIP_LABELS: Partial<Record<string, string>> = {
  not_found: 'no longer on this list',
  /** Reserved on the server and never actually emitted — an already-saved
   *  entry comes back in `saved` so Add-to-sequence still gets its id. Kept
   *  only so the fallback never prints a raw code if that ever changes. */
  already_saved: 'already saved',
  dismissed: 'dismissed',
  no_domain: 'no website found',
  /** §8: the people stage could not confirm the employer from the company's
   *  own domain, so bulk save holds them back and the row offers a confirm. */
  needs_review: 'could not verify the employer',
  /** A person whose parent account could not be promoted — a saved person
   *  implies a saved account, so the person is refused rather than orphaned. */
  parent_failed: 'their company could not be saved',
  /** Neither an email nor a LinkedIn URL: nothing durable to dedupe on. */
  no_identity: 'no email or LinkedIn profile',
  error: 'an error occurred',
}

/** The label for one skip reason, falling back to the raw code (see above). */
export function saveSkipLabel(reason: string): string {
  return SAVE_SKIP_LABELS[reason] ?? reason
}

/**
 * The label for one SKIPPED ENTRY, preferring the server's own `message`.
 *
 * `error` is the reason the save route uses for five distinct failures —
 * the company insert, the company write, the entry update, the contact write
 * and the parent load — and each one sends a `message` saying which. Reporting
 * all five as "an error occurred" throws away the only part of the response
 * that tells the user (or us, in a bug report) what actually broke. Any reason
 * may carry a message; `error` is simply the one that always does.
 */
export function saveSkipDetail(skipped: SkippedEntry): string {
  const message = typeof skipped.message === 'string' ? skipped.message.trim() : ''
  return message.length > 0 ? message.toLowerCase() : saveSkipLabel(skipped.reason)
}

/**
 * One line describing what Save actually did — the per-entry outcomes
 * collapsed for a toast, never a bare count (§8). Reasons are grouped in
 * insertion order so the message is stable for one response.
 *
 * MIXED SELECTIONS say what KIND of thing was saved, because the selection bar
 * now spans both tabs and "12 added to your CRM" over 5 companies and 7 people
 * hides the two writes that behave differently — a company becomes a
 * `company` row, a person becomes a `contact` and may have arrived with no
 * email at all. `kind` is on every `saved` entry for exactly this reason.
 */
export function summarizeSaveResult(
  result: {
    saved: Array<{ kind?: string } | Record<string, unknown>>
    skipped: SkippedEntry[]
  },
  /** `saved` — kept on the list (curation); `published` — written to the
   *  CRM. The verb is the only difference (migration 259). */
  kind: 'saved' | 'published' = 'published',
): string {
  const companies = result.saved.filter((s) => (s as { kind?: string }).kind === 'company').length
  const people = result.saved.filter((s) => (s as { kind?: string }).kind === 'person').length
  const verb = kind === 'saved' ? 'saved to the list' : 'added to your CRM'
  // An older response with no `kind` at all is still summarised honestly,
  // just without the split — this is the phase-5 shape and the tests for it.
  const head =
    companies > 0 && people > 0
      ? `${countLabel(companies, 'company', 'companies')} and ${countLabel(people, 'person', 'people')} ${verb}`
      : `${result.saved.length} ${verb}`
  const parts = [head]
  // Grouped by the RENDERED detail, not the bare reason: five different
  // failures share reason 'error' and are only told apart by their message,
  // so grouping on the reason would merge "failed to write the contact" into
  // "failed to load the parent company" and report one useless number.
  const byDetail = new Map<string, number>()
  for (const s of result.skipped) {
    const detail = saveSkipDetail(s)
    byDetail.set(detail, (byDetail.get(detail) ?? 0) + 1)
  }
  for (const [detail, count] of byDetail) {
    parts.push(`${count} skipped (${detail})`)
  }
  return parts.join(', ')
}

/** "1 company" / "3 companies" — a count that agrees with its own noun. */
function countLabel(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** "3 days ago" / "just now" — the index card's last-updated line. */
export function relativeTimeShort(iso: string | null | undefined): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}

/**
 * The initial `exclude_contacted` a new list is created with.
 *
 * The DATABASE is the source of truth: `supabase/migrations/248_prospecting.sql`
 * declares `exclude_contacted text NOT NULL DEFAULT 'ever'`, and
 * `createProspectList` (src/lib/prospecting/lists.ts) falls back to the same
 * 'ever' when the field is omitted. §3 says why: a list is for NEW people, so
 * 'ever' is the default and 'active' is the re-engagement setting a user opts
 * into. This const exists only because the sheet renders the control before it
 * POSTs — there is no shared default exported from
 * `@/lib/prospecting/types` to import, so if that ever changes, delete this and
 * import it instead.
 *
 * It applies to EVERY template: no purpose wants a re-engagement list by
 * default.
 */
export const DEFAULT_EXCLUDE_CONTACTED: ProspectExcludeContacted = 'ever'

// ---------------------------------------------------------------------------
// Run vocabulary (§9) — the confirm dialog, the stepper and the outcome banner
// ---------------------------------------------------------------------------

/**
 * Money, rendered the one way this feature renders it: two decimals, always,
 * with the `$`. A run that spent $0.4 must not read as "$0.4" beside a cap
 * written "$2.00" — the consent screen's whole job is that the two numbers are
 * comparable at a glance.
 *
 * IT MUST ACCEPT STRINGS. `prospecting_run.budget_dollars` is `numeric(10,4)`
 * and `spent_dollars` is `numeric(10,6)` (migration 248), and supabase-js
 * serializes `numeric` as a STRING — the read path (`getRun`/`listRuns`) casts
 * the row rather than coercing, so `RunPayload`'s `number` declaration is a
 * claim the wire does not honour. A `typeof value === 'number'` guard would
 * render every raw column as "$0.00", including the cap banner — "Stopped at
 * your $0.00 cap" — which destroys the one promise this feature makes: the
 * number you consented to is the number that binds. Coerces the way
 * `spend.ts`'s `safeAmount` does.
 */
export function formatDollars(value: unknown): string {
  const raw =
    typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  const n = Number.isFinite(raw) && raw > 0 ? raw : 0
  return `$${n.toFixed(2)}`
}

/**
 * What the consent screen predicts a discovery run will cost.
 *
 * `rounds × 4 searches × ESTIMATED_DISCOVERY_CALL_DOLLARS` — the same
 * per-call reservation the engine's `budgetVerdict` uses, so the number the
 * user approved and the number the gate enforces cannot drift. Four is the
 * angle count per round (§7); it is a literal here because `angles.ts` fixes
 * it and the dialog must state a number before any run exists to ask.
 */
export const SEARCHES_PER_ROUND = 4

export function estimateRunDollars(
  maxRounds: number,
  perCallDollars: number = ESTIMATED_DISCOVERY_CALL_DOLLARS,
): number {
  const rounds = Number.isFinite(maxRounds) && maxRounds > 0 ? Math.floor(maxRounds) : 1
  return Math.round(rounds * SEARCHES_PER_ROUND * perCallDollars * 1e6) / 1e6
}

/** "1 round" / "2 rounds" — the dialog says round(s) with a real number. */
export function roundsLabel(maxRounds: number): string {
  const rounds = Number.isFinite(maxRounds) && maxRounds > 0 ? Math.floor(maxRounds) : 1
  return `${rounds} ${rounds === 1 ? 'round' : 'rounds'}`
}

/** Human label for each terminal/live run status, used by the history list. */
export const RUN_STATUS_LABELS: Record<ProspectingRunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  needs_input: 'Needs input',
  canceling: 'Cancelling',
  completed: 'Completed',
  failed: 'Failed',
  canceled: 'Cancelled',
  budget_exhausted: 'Stopped early',
}

/**
 * The §10 copy for each suppression reason, plus `invalid`.
 *
 * `contacted` and `opted_out` are DELIBERATELY unlinked by the candidates
 * route — a suppression by outreach history points at an enrollment, not at a
 * record the user can open here — so their copy is written to stand on its own
 * rather than to read as a link that failed to render.
 */
export const SUPPRESSION_GROUP_LABELS: Record<
  ProspectSuppressionSource | 'invalid',
  string
> = {
  this_list: 'Already in this list',
  crm: 'Already in your CRM',
  dismissed_global: 'You dismissed as a competitor or customer',
  contacted: 'Already contacted',
  opted_out: 'Opted out',
  self: 'Your own company',
  personal_domain: 'Not a company site',
  other_list: 'In another list',
  // A person the company DID return but `people_per_company` did not have
  // room for. This is the one group in the ledger that is not a dedup or a
  // quality rule — it is the user's own setting turning people away — so the
  // copy points at the setting ("than you asked for") rather than implying the
  // person failed a check they never took.
  over_cap: 'More people than you asked for',
  // Previously reported as `personal_domain`, which was a lie the ledger told
  // about its own most common entry: linkedin.com and the recruiter sites are
  // not somebody's personal blog, they are platforms, and a group header that
  // called them personal made the one surface whose job is checkability
  // demonstrably wrong on inspection.
  noise_host: 'Not a company site — platform or directory',
  invalid: 'No usable domain',
}

/** `ProspectingRunProgress` with every field defaulted — the poll's first tick
 *  can land before the engine has written any progress at all, and a rail that
 *  renders `NaN/undefined` for two seconds is worse than one that renders 0. */
export function readProgress(raw: unknown): ProspectingRunProgress {
  const p = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >
  const num = (key: string, fallback = 0): number => {
    const v = p[key]
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
    return Number.isFinite(n) ? n : fallback
  }
  const stage = p.stage
  return {
    stage: (PROSPECTING_RUN_STAGES as readonly string[]).includes(stage as string)
      ? (stage as ProspectingRunProgress['stage'])
      : 'discover',
    round: num('round', 1),
    max_rounds: num('max_rounds', 1),
    angle_index: num('angle_index'),
    found: num('found'),
    suppressed: num('suppressed'),
    new: num('new'),
    invalid: num('invalid'),
    accounts_done: num('accounts_done'),
    accounts_total: num('accounts_total'),
    people_found: num('people_found'),
    people_target: num('people_target'),
    spent_dollars: num('spent_dollars'),
    exa_calls: num('exa_calls'),
    updated_at: typeof p.updated_at === 'string' ? p.updated_at : '',
  }
}

/**
 * `ProspectingRunCounts` with every key defaulted, for the outcome line.
 *
 * Built by ITERATING `PROSPECT_SUPPRESSION_SOURCES` rather than by listing the
 * keys, because the two are the same set by definition (the interface's own
 * comment says so) and a hand-written literal is exactly the shape that goes
 * quietly stale: migration 251 added `over_cap` and `noise_host`, and a listed
 * version compiles fine while silently reporting those groups as absent.
 * The cast is safe because the const array IS the key set.
 */
export function readCounts(raw: unknown): ProspectingRunCounts {
  const c = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >
  const num = (key: string): number => {
    const v = c[key]
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  const counts = {} as ProspectingRunCounts
  for (const key of PROSPECT_SUPPRESSION_SOURCES) counts[key] = num(key)
  return counts
}

// ---------------------------------------------------------------------------
// The second gate (§9) — per-company research and people
// ---------------------------------------------------------------------------

/**
 * What the gate promises the per-company stages will cost.
 *
 * `companies × ESTIMATED_ACCOUNT_CARD_DOLLARS`, the SAME constant
 * `budgetVerdict` reserves before each account-card call — for exactly the
 * reason `estimateRunDollars` shares its constant with the discovery gate: a
 * banner that predicted from its own number would drift from the gate that
 * enforces it, and the whole point of consenting with real numbers is that the
 * figure shown is the figure that binds.
 */
export function estimateAccountCardDollars(companies: number): number {
  return round6(safeCount(companies) * ESTIMATED_ACCOUNT_CARD_DOLLARS)
}

/**
 * What the people stage will cost: ONE call per company, not one per person.
 * `people_per_company` caps how many of the returned people are kept; it does
 * not multiply the calls, so a list set to 10 people costs the same as one set
 * to 3. Saying otherwise would over-quote by 3× and make the gate read as a
 * bigger commitment than it is.
 */
export function estimatePeopleDollars(companies: number): number {
  return round6(safeCount(companies) * ESTIMATED_PEOPLE_CALL_DOLLARS)
}

/**
 * "roughly 3 minutes" / "under a minute" — the wall-clock half of the gate.
 *
 * §12 measured 4.8s per people call and 5–15s per account card; the estimate
 * is deliberately coarse (`ESTIMATED_SECONDS_PER_COMPANY`, rounded up to whole
 * minutes) and the copy says "roughly", because a precise-looking prediction
 * that misses by 40% is worse than an honest range. Anything under a minute
 * says so rather than rendering "roughly 0 minutes".
 */
export function estimateMinutesLabel(
  companies: number,
  secondsEach: number = ESTIMATED_SECONDS_PER_COMPANY,
): string {
  const seconds = safeCount(companies) * (Number.isFinite(secondsEach) ? secondsEach : 0)
  if (seconds <= 0) return 'under a minute'
  const minutes = Math.ceil(seconds / 60)
  if (minutes <= 1) return 'about a minute'
  return `roughly ${minutes} minutes`
}

/** "18 companies" / "1 company" — the gate counts things in words, not in a
 *  bare number the sentence then has to agree with. */
export function companiesLabel(count: number): string {
  const n = safeCount(count)
  return `${n} ${n === 1 ? 'company' : 'companies'}`
}

/**
 * The people stage's partiality line (§7 Stage 4).
 *
 * "Found 3 of the 5 roles you asked for" — REQUIRED copy, not a nicety. Exa
 * does not index every profile and anchoring restricts retrieval to pages that
 * mention the company, so a realistic yield is 1–3 people and sometimes zero.
 * A People tab that implies a complete roster makes a working feature read as
 * broken; naming the shortfall makes a sparse result legible as the expected
 * outcome it is.
 */
export function peopleYieldLabel(found: number, target: number): string {
  const got = safeCount(found)
  const asked = safeCount(target)
  if (asked <= 0) return ''
  if (got >= asked) {
    return `Found all ${asked} ${asked === 1 ? 'role' : 'roles'} you asked for`
  }
  return `Found ${got} of the ${asked} ${asked === 1 ? 'role' : 'roles'} you asked for`
}

function safeCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** Money at the precision `spent_dollars` is stored in — a gate that showed
 *  `$0.23400000000000001` in a tooltip would undo the point of the number. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

// ---------------------------------------------------------------------------
// Has this company been through the account card? (§7 Stage 3b)
// ---------------------------------------------------------------------------

/**
 * MOVED to `@/lib/prospecting/cards` and re-exported here.
 *
 * The predicate and its fallback key list are now shared with the AGENT lane
 * (`src/lib/ai/tools/prospecting.ts`, whose `find_prospects` uses it to decide
 * which companies a card run may skip). It could not stay under `src/app`:
 * server code importing a page module is the wrong direction, and the copy the
 * tools had grown instead disagreed about the fallback — which, for a
 * predicate that decides what gets billed, is a real bug rather than a tidiness
 * complaint.
 *
 * Re-exported rather than relocated at the call sites so every page consumer
 * (`list-detail.tsx`, `people-dialog.tsx`, the tests) keeps its import
 * exactly as it was. The module is pure TypeScript over a plain object, so it
 * costs the client bundle nothing.
 */
export { PROSPECT_ACCOUNT_CARD_KEYS, hasAccountCard } from '@/lib/prospecting/cards'

// ---------------------------------------------------------------------------
// Add-to-sequence (§8) — the copy for the two things the flow cannot do
// ---------------------------------------------------------------------------

/**
 * The inline note for people who were saved but could NOT be enrolled because
 * they have no email address.
 *
 * REQUIRED COPY, not a nicety (§8, `no_email`). Discovery frequently yields a
 * LinkedIn profile and nothing else, and `enrollContacts` skips those with
 * `no_email` — inside a toast that scrolls away, next to a success count that
 * says everything worked. So the count is stated INLINE, next to the control
 * the user just pressed, and it is stated BEFORE the dialog opens rather than
 * after the enrollment reports it: the honest thing to say is "these three are
 * not going", not "three of the twelve did not go".
 *
 * Returns '' when everyone had an email — an empty note renders nothing.
 */
export function noEmailNote(count: number): string {
  const n = safeCount(count)
  if (n <= 0) return ''
  return n === 1
    ? '1 person has no email address and was not added'
    : `${n} people have no email address and were not added`
}

/** The per-row Add-to-sequence tooltip when the row cannot be enrolled. */
export const NO_EMAIL_REASON = 'No email address — sequences send email, so this person cannot be enrolled'

/**
 * The Sequenced chip's label, derived at read time from `sequence_enrollment`
 * (§8). `exited` is a real, different state — the person went through and came
 * out — and collapsing it into "Sequenced" would make a finished enrollment
 * indistinguishable from a live one on the row where the user decides whether
 * to enroll them again.
 */
export function sequencedLabel(state: { status: 'active' | 'exited' } | null | undefined): string {
  if (!state) return ''
  return state.status === 'active' ? 'Sequenced' : 'Sequenced (done)'
}

/** The chip's tooltip: which sequence, and what the status means. */
export function sequencedTitle(
  state: { status: 'active' | 'exited'; sequence_name: string } | null | undefined,
): string {
  if (!state) return ''
  return state.status === 'active'
    ? `Active in ${state.sequence_name}`
    : `Finished ${state.sequence_name}`
}

// ── Source-company establishment (§4 step 4) ─────────────────────────────

/**
 * The three 400 codes POST /source answers with when it cannot turn what it
 * has into a domain, in words the user can act on WITHOUT leaving the input.
 *
 * These are inline messages, not toasts, and that is the whole point: every
 * one of them is a correction the user makes by editing the field they are
 * already looking at. A toast asks them to remember an instruction while
 * retyping — the same reasoning that put the hand-add INVALID_DOMAIN notice
 * beside its input rather than in a corner of the screen.
 *
 * `Partial` + a fallback, NOT an exhaustive Record: the code union is owned by
 * the route (Package A) and grows there first, and an unknown code should
 * print the server's own message rather than fail the UI build.
 */
export const SOURCE_DOMAIN_ERRORS: Partial<Record<string, string>> = {
  NEEDS_DOMAIN: "Tell us your company's website",
  PERSONAL_DOMAIN: "That looks like a personal email domain — enter your company's website",
  INVALID_DOMAIN: "That doesn't look like a website — try something like acme.com",
}

/**
 * The inline message for a failed POST /source.
 *
 * Falls back to the server's own message (via `errorMessage` at the call site,
 * passed in as `fallback`) so a code we do not recognise still says something
 * true instead of a generic "Something went wrong".
 */
export function sourceDomainErrorMessage(code: string | null, fallback: string): string {
  return (code ? SOURCE_DOMAIN_ERRORS[code] : undefined) ?? fallback
}

/**
 * Whether the source company has been through `COMPANY_CARD_ICP`.
 *
 * Read off the DRAFT's provenance rather than the company row: `buildIcpDraft`
 * marks `target.description` as `from: 'company_profile'` only when the card's
 * own answer seeded it, and falls back to a purpose TEMPLATE otherwise. The
 * distinction is load-bearing in two places — the empty state must never
 * present a sentence we wrote as knowledge about the user's business, and the
 * "Researching…" poll must stop on the card actually landing, not on the
 * company row merely existing (which it does the instant it is created).
 */
/**
 * Whether the FULL company enrichment has stopped running.
 *
 * `enrichment_status` is the company row's own column: null / 'pending' /
 * 'enriched' / 'failed' / 'skipped'. Terminal means anything that is not
 * pending and not null — a null status is a row nothing has ever tried to
 * enrich, which for a company we just established means the job is on its way.
 *
 * This is the second half of the poll's stop condition. The ICP card is a
 * $0.012 side search that can land in seconds while the enrichment that
 * actually fills `description` / `industry` — and therefore the "what you
 * sell" line — is still running for another minute. Stopping on the card alone
 * is what left that line stale under a spinner that had already given up.
 */
export function enrichmentSettled(source: {
  source?: { enrichment_status?: string | null } | null
} | null): boolean {
  const status = source?.source?.enrichment_status ?? null
  if (status === null || status === undefined) return false
  return status !== 'pending'
}

export function hasIcpCard(source: {
  source: unknown
  icp_draft_by_purpose?: Partial<Record<'buyers', Pick<IcpDraft, 'provenance'>>>
} | null): boolean {
  if (!source?.source) return false
  return source.icp_draft_by_purpose?.buyers?.provenance?.['target.description']?.from ===
    'company_profile'
}
