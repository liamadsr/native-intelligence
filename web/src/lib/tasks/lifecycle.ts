/**
 * Provider-agnostic lifecycle mapping for external task sync.
 *
 * Dial8 workflow states are per-team and fully user-customizable ("Triage",
 * "In review", "Shipped", …) — only their `category` is fixed by the schema.
 * Every external task provider has its OWN, much coarser lifecycle vocabulary.
 * Mapping team-specific state NAMES to each provider would be an N×M mess, so
 * everything folds through ONE canonical bucket set first:
 *
 *     workflow_state.category → LifecycleBucket → provider write
 *
 * This module owns the left arrow (shared by every provider) plus the Asana,
 * Jira and Linear adapters for the right one. They sit beside each other as
 * siblings and consume the same bucket, so adding one never touched the fold
 * above it.
 *
 * The three right-hand arrows are worth contrasting, because their differences
 * are the providers' and not ours: Asana has a single `completed` boolean and
 * cannot express cancellation at all; Jira has a three-value statusCategory that
 * merges done with canceled, forcing a documented NAME heuristic to separate
 * them; Linear has a stable seven-value state TYPE that names both, so its
 * adapter needs no heuristic and its bucket map can be derived instead of
 * configured.
 *
 * Pure functions only: no I/O, no provider clients. Unit-tested exhaustively.
 */

/** The canonical lifecycle vocabulary every provider adapter consumes. */
export type LifecycleBucket = 'not_started' | 'in_progress' | 'done' | 'canceled'

/** All four buckets, in board order — handy for iterating UI/config maps. */
export const LIFECYCLE_BUCKETS: readonly LifecycleBucket[] = [
  'not_started',
  'in_progress',
  'done',
  'canceled',
] as const

/**
 * A user-configured bucket → Asana section gid map. A null value means "don't
 * move the task for this bucket", which is also the shape of an unconfigured
 * project (all four null).
 */
export type SectionMap = Partial<Record<LifecycleBucket, string | null>>

/**
 * Fold a Dial8 `workflow_state.category` into its canonical bucket.
 *
 * The five categories collapse to four buckets: `backlog` and `unstarted` are
 * distinct on a Dial8 board (an idea parked for later vs. queued for this
 * cycle) but no external provider models that difference, so both read as
 * not-yet-started externally.
 *
 * Unknown/absent categories fall back to `not_started` rather than throwing: a
 * status echo must never fail a run because a workflow state carried a category
 * this build hadn't heard of.
 */
export function bucketForCategory(category: string): LifecycleBucket {
  switch (category) {
    case 'backlog':
    case 'unstarted':
      return 'not_started'
    case 'started':
      return 'in_progress'
    case 'completed':
      return 'done'
    case 'canceled':
      return 'canceled'
    default:
      return 'not_started'
  }
}

/** What the Asana adapter writes for a bucket. */
export interface AsanaLifecycleWrite {
  /** `PUT /tasks/{gid}` body value for `completed`. */
  completed: boolean
  /** Section to move the task into, or null when the bucket isn't mapped. */
  sectionGid: string | null
}

/**
 * The Asana adapter: bucket → (completed flag, optional section move).
 *
 * Asana's native task lifecycle is a SINGLE boolean. There is no "canceled" —
 * so a canceled action writes `completed: true`, exactly like a done one. That
 * is a deliberate, lossy choice: the alternatives (leaving it open forever, or
 * appending a "canceled in Dial8" comment) either misrepresent the work as
 * live or spam the task's activity feed on every status flip. Users who care
 * about the distinction map the `canceled` bucket to a dedicated Asana section,
 * which is what the section half of this return exists for.
 *
 * `sectionGid` is null whenever the bucket has no mapping — the caller then
 * writes the completion flag and leaves placement alone.
 */
export function asanaWriteForBucket(
  bucket: LifecycleBucket,
  sectionMap: SectionMap | null | undefined,
): AsanaLifecycleWrite {
  const completed = bucket === 'done' || bucket === 'canceled'
  const mapped = sectionMap?.[bucket]
  return {
    completed,
    sectionGid: typeof mapped === 'string' && mapped.length > 0 ? mapped : null,
  }
}

// ---------------------------------------------------------------------------
// Jira adapter
// ---------------------------------------------------------------------------

/**
 * A user-configured bucket → Jira STATUS ID map. Structurally identical to
 * SectionMap but semantically different enough to name separately: a null value
 * means "no explicit status picked for this bucket", which is NOT "don't move"
 * (Asana's meaning) but "fall back to matching on statusCategory".
 */
export type StatusMap = Partial<Record<LifecycleBucket, string | null>>

/**
 * Jira's statusCategory keys — the STABLE, non-localizable enum every Jira
 * status carries exactly one of. Status NAMES are per-workflow and translated;
 * these three are not, which is why every category-level decision keys off them.
 */
export type JiraStatusCategoryKey = 'new' | 'indeterminate' | 'done'

/**
 * The explicit status id a bucket is mapped to, or null when unmapped.
 *
 * Deliberately the whole Jira "write" — unlike Asana's, a Jira lifecycle write
 * cannot be computed here at all. Jira has no status field you can set: you fire
 * a TRANSITION, and which transitions exist is a property of the issue's current
 * status in its project's workflow, discoverable only at write time against that
 * one issue. So this returns the TARGET and the echo does the lookup
 * (src/lib/inngest/jira-echo-status.ts owns the selection algorithm).
 */
export function jiraTargetForBucket(
  bucket: LifecycleBucket,
  statusMap: StatusMap | null | undefined,
): string | null {
  const mapped = statusMap?.[bucket]
  return typeof mapped === 'string' && mapped.length > 0 ? mapped : null
}

/**
 * The statusCategory a bucket lands in when no explicit status is mapped.
 *
 * FOUR buckets fold onto THREE categories: Jira has no canceled category, so
 * `canceled` shares `done` with `done`. That collision is why the name heuristic
 * below exists — within the done category it is the only signal that separates
 * "finished" from "abandoned".
 */
export function jiraCategoryForBucket(bucket: LifecycleBucket): JiraStatusCategoryKey {
  switch (bucket) {
    case 'in_progress':
      return 'indeterminate'
    case 'done':
    case 'canceled':
      return 'done'
    case 'not_started':
    default:
      return 'new'
  }
}

/**
 * Canceled-ish status names, as WHOLE-WORD patterns over a normalized name.
 *
 * Normalization strips apostrophes and punctuation first, so "Won't Do",
 * "Won’t Do" (curly) and "Wont do" all reduce to `wont do`. Whole-word matching
 * (rather than substring) keeps "Uncancelled"-shaped names from matching while
 * still catching real-world compounds like "Rejected by QA".
 *
 * `cancell?ed` covers both the US and UK spellings in one pattern.
 */
const CANCELED_NAME_PATTERNS: readonly RegExp[] = [
  /\bcancell?ed\b/,
  /\bwont\s+do\b/,
  /\bwont\s+fix\b/,
  /\bdeclined\b/,
  /\brejected\b/,
  /\babandoned\b/,
] as const

/** Lowercase, drop apostrophes, collapse everything else to single spaces. */
function normalizeStatusName(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Does this Jira status NAME read as a cancellation rather than a completion?
 *
 * It is a heuristic and is documented as one: many real Jira workspaces have no
 * cancel status at all and express the distinction through the RESOLUTION field
 * instead ("Done" status + "Won't Do" resolution), which is why the echo also
 * sets a canceled resolution when the transition screen offers one. Between the
 * two signals the common shapes are covered; a workspace with a bespoke name
 * ("Shelved") maps the bucket explicitly.
 *
 * WHERE IT IS CONSULTED — FOUR places, all of them CHOICES between two statuses
 * that share the `done` category, never a test of whether an issue may be left
 * alone (jira-echo-status's statusSatisfiesBucket deliberately does not call it,
 * and its docblock explains why):
 *  - selectTransition tier (b): prefer a cancel-named landing status for the
 *    `canceled` bucket. Applies whenever tier (a) did not MATCH — including a
 *    mapping that exists but is unreachable, which is NOT the same as "no
 *    explicit status mapped".
 *  - selectTransition tier (c): never land the `done` bucket on a cancel-named
 *    status. Applies regardless of any mapping.
 *  - jiraRemoteState (below): read a done-category status the READ-BACK fetched
 *    as an abandonment rather than a completion.
 *  - `automaticStatusName` in the settings UI
 *    (src/app/account/settings/integrations/[provider]/[capability]/
 *    integration-detail-view.tsx): the "→ Done" hint beside an unmapped
 *    bucket's picker. It is the only consumer outside the echo, and it must
 *    reproduce BOTH selectTransition tiers above or the hint contradicts the
 *    behaviour it claims to describe. Count it when you change either tier.
 */
export function isCanceledStatusName(name: string | null | undefined): boolean {
  if (typeof name !== 'string' || name.length === 0) return false
  const normalized = normalizeStatusName(name)
  if (!normalized) return false
  return CANCELED_NAME_PATTERNS.some((pattern) => pattern.test(normalized))
}

/**
 * What a Jira status the READ-BACK just fetched means to applyRemoteTaskState.
 *
 * Exactly the shape of that function's optional arguments, so a caller spreads
 * it: `applyRemoteTaskState({ …, ...jiraRemoteState(categoryKey, name) })`.
 *
 * The three-way split is why this exists at all. `remoteCompleted` alone (the
 * Asana-shaped contract) collapses "In Progress" onto "not done" and "Won't Do"
 * onto "done", and the read-back then lands the action in a state the ECHO
 * disagrees with — which is a real transition fired back at the customer's Jira,
 * undoing what they just did. Both extra bits exist to make the two directions
 * agree; see apply-remote-task-state.ts's docblock for the full trace.
 */
export interface JiraRemoteState {
  remoteCompleted: boolean
  remoteHint?: { category: 'new' | 'indeterminate' }
  remoteCanceled?: boolean
}

export function jiraRemoteState(
  categoryKey: string | null | undefined,
  statusName: string | null | undefined,
): JiraRemoteState {
  if (categoryKey === 'done') {
    // The name is the ONLY signal separating the two halves of this category —
    // Jira has no canceled one — and it is a heuristic, so it is passed as a
    // refinement rather than as a different completion.
    return isCanceledStatusName(statusName)
      ? { remoteCompleted: true, remoteCanceled: true }
      : { remoteCompleted: true }
  }
  // Anything not in the done category is open. `indeterminate` is the only open
  // category worth distinguishing; an unknown/absent key reads as `new`, the
  // same conservative default bucketForCategory takes.
  return {
    remoteCompleted: false,
    remoteHint: { category: categoryKey === 'indeterminate' ? 'indeterminate' : 'new' },
  }
}

// ---------------------------------------------------------------------------
// Linear adapter
// ---------------------------------------------------------------------------

/**
 * A destination's bucket → Linear workflow state map.
 *
 * Structurally the richest of the three provider maps and semantically the
 * simplest, because it is DERIVED rather than picked: the settings save funnel
 * reads the team's states and folds them by `type` (see deriveLinearStateMap
 * below), so there is no bucket→status mapping UI and no user choice to store.
 *
 * Each entry carries the NAME alongside the id for two reasons the bare-string
 * StatusMap next door doesn't have:
 *  - the mapping is shown read-only in settings, and a derived map has no
 *    user-typed label to fall back on;
 *  - a stored name lets the echo report WHICH state it wrote, and lets it tell
 *    "the id is stale" apart from "the id is wrong" when Linear rejects it.
 *
 * A bucket with no state of the right type on the team is ABSENT (not null): the
 * caller declines that bucket rather than guessing a target.
 */
export type LinearStateRef = { id: string; name: string }
export type LinearStateMap = Partial<Record<LifecycleBucket, LinearStateRef>>

/**
 * The SEVEN documented values of `WorkflowState.type`, in the order Linear
 * documents them. Typed as a plain string union rather than an enum because the
 * API returns a String and a new value must degrade, not throw.
 */
export type LinearStateType =
  | 'triage'
  | 'backlog'
  | 'unstarted'
  | 'started'
  | 'completed'
  | 'canceled'
  | 'duplicate'

/**
 * Fold a Linear workflow-state TYPE into its canonical bucket.
 *
 * Seven types onto four buckets. The two collapses that matter:
 *  - `triage` / `backlog` / `unstarted` all read as not-yet-started, exactly as
 *    bucketForCategory collapses Dial8's own backlog/unstarted pair.
 *  - `duplicate` folds onto `canceled` WITH `canceled`. This is the value it is
 *    easiest to forget (six types feel like the whole enum) and getting it wrong
 *    is not cosmetic: an issue closed as a duplicate would otherwise read as "no
 *    signal" and leave the Dial8 action open forever, or — worse, if defaulted —
 *    as still-in-progress. A duplicate is abandoned work, not finished work, so
 *    it shares the canceled bucket rather than the done one.
 *
 * An unknown or absent type returns NULL rather than a default bucket, which is
 * the deliberate difference from bucketForCategory. That function folds OUR
 * schema, where an unrecognized value is a build-skew bug and `not_started` is a
 * safe landing. This one folds THEIRS, where an unrecognized value means Linear
 * shipped something this build has never seen — and quietly deciding such a
 * state means "not started" would let the read-back reopen work a user just
 * closed. No signal is the honest answer; callers leave the action alone.
 */
export function linearBucketForStateType(
  type: string | null | undefined,
): LifecycleBucket | null {
  switch (type) {
    case 'triage':
    case 'backlog':
    case 'unstarted':
      return 'not_started'
    case 'started':
      return 'in_progress'
    case 'completed':
      return 'done'
    case 'canceled':
    case 'duplicate':
      return 'canceled'
    default:
      return null
  }
}

/**
 * What a Linear state the READ-BACK just fetched means to applyRemoteTaskState.
 *
 * Same shape as JiraRemoteState so a caller spreads it identically, but derived
 * PURELY FROM THE TYPE — and that is the whole point. Jira has no canceled
 * category, so jiraRemoteState has to fall back on isCanceledStatusName, a
 * documented heuristic over human-readable status names. Linear has a real
 * `canceled` type (and a `duplicate` one), so the distinction is a fact rather
 * than a guess: isCanceledStatusName must NEVER be called on a Linear state.
 * A team whose done state is literally named "Rejected" would be misread by the
 * heuristic and is read correctly here.
 *
 * `remoteHint` mirrors the Jira contract's vocabulary ('new' | 'indeterminate')
 * because applyRemoteTaskState is shared and speaks that language; `started`
 * maps to 'indeterminate' and everything else open to 'new'.
 *
 * An unknown type is reported as open-with-a-'new'-hint, but callers are
 * expected to check linearBucketForStateType FIRST and skip applying at all when
 * it returns null — this function's job is the shape, not the decision.
 */
export interface LinearRemoteState {
  remoteCompleted: boolean
  remoteHint?: { category: 'new' | 'indeterminate' }
  remoteCanceled?: boolean
}

export function linearRemoteState(type: string | null | undefined): LinearRemoteState {
  const bucket = linearBucketForStateType(type)
  switch (bucket) {
    case 'done':
      return { remoteCompleted: true }
    case 'canceled':
      // Both `canceled` and `duplicate` land here: closed, but abandoned rather
      // than finished. The extra bit is what keeps the read-back and the echo
      // from disagreeing and firing a write back at the customer's Linear.
      return { remoteCompleted: true, remoteCanceled: true }
    case 'in_progress':
      return { remoteCompleted: false, remoteHint: { category: 'indeterminate' } }
    default:
      return { remoteCompleted: false, remoteHint: { category: 'new' } }
  }
}

/**
 * The Linear state id a bucket is mapped to, or null when the destination has
 * no state for it.
 *
 * Null is a REAL, expected outcome rather than a misconfiguration: Linear does
 * not guarantee a team has a state of every type, and a team with no
 * canceled-type state is ordinary. The echo declines that bucket
 * (`no_target_state`) instead of writing a guessed state — moving a canceled
 * action to "Done" because that is the nearest closed state would tell the
 * customer's team the work shipped.
 */
export function linearTargetForBucket(
  stateMap: LinearStateMap | null | undefined,
  bucket: LifecycleBucket,
): string | null {
  const mapped = stateMap?.[bucket]
  const id = mapped?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/**
 * Type preference per bucket, most-specific first.
 *
 * `not_started` is the only bucket with a real choice to make. Linear's three
 * open types are not interchangeable: `unstarted` ("Todo") is where a team
 * expects queued work, `backlog` is the parking lot, and `triage` is an inbox
 * that may not even be enabled. Preferring them in that order means a pushed
 * action lands where someone will look at it.
 *
 * `duplicate` appears in NO list, deliberately. It is a legitimate READ signal
 * (an issue someone closed as a duplicate — linearBucketForStateType folds it to
 * canceled) but it must never be a WRITE target: marking a Dial8 action's issue
 * as a duplicate of nothing is a claim about the customer's backlog that Dial8
 * has no basis to make.
 */
const BUCKET_TYPE_PREFERENCE: Record<LifecycleBucket, readonly string[]> = {
  not_started: ['unstarted', 'backlog', 'triage'],
  in_progress: ['started'],
  done: ['completed'],
  canceled: ['canceled'],
}

/**
 * Derive the bucket → state map from a team's workflow states.
 *
 * Called at DESTINATION-SAVE time (the settings PATCH fetches the team's states
 * and persists the result) and again by the echo when a stored state id has gone
 * stale. Pure, so both paths agree by construction.
 *
 * The rules, in order:
 *  1. For each bucket, walk BUCKET_TYPE_PREFERENCE and take the first type that
 *     any state on the team carries.
 *  2. Within that winning type, pick the LOWEST `position` — Linear's own board
 *     order, so a team with "Todo" then "Ready" gets "Todo". A missing position
 *     sorts last rather than as 0, so a state with no position never displaces
 *     one that has one.
 *  3. A bucket whose every preferred type is absent from the team is OMITTED. It
 *     is not set to null: absent means "this team cannot express that bucket",
 *     which the echo turns into a decline. A canceled-less team is the common
 *     case here, not an error.
 *
 * States with no id, or with a type this build doesn't know, are ignored
 * entirely — they can never be a write target.
 */
export function deriveLinearStateMap(
  states: ReadonlyArray<{ id?: string; name?: string; type?: string; position?: number }>,
): LinearStateMap {
  const map: LinearStateMap = {}

  for (const bucket of LIFECYCLE_BUCKETS) {
    for (const type of BUCKET_TYPE_PREFERENCE[bucket]) {
      const candidates = states.filter(
        (s) => s?.type === type && typeof s.id === 'string' && s.id.length > 0,
      )
      if (candidates.length === 0) continue

      const winner = candidates.reduce((best, current) => {
        // A missing position sorts LAST: an unpositioned state should never
        // outrank a positioned one just because `undefined` isn't a number.
        const bestPos = typeof best.position === 'number' ? best.position : Number.POSITIVE_INFINITY
        const currentPos =
          typeof current.position === 'number' ? current.position : Number.POSITIVE_INFINITY
        return currentPos < bestPos ? current : best
      })

      map[bucket] = {
        id: winner.id!,
        // The name is display + staleness detection; falling back to the id
        // keeps the entry usable rather than storing an empty label.
        name: typeof winner.name === 'string' && winner.name.length > 0 ? winner.name : winner.id!,
      }
      break
    }
  }

  return map
}
