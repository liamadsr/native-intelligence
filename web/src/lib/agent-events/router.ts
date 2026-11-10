/**
 * The router (A6 slices 1 and 3; docs/plans/always-on-agent.md §5): the
 * agent's inbox sorted into ignore, quiet, turn or notify, code first.
 *
 * Run by an Inngest function debounced 60 s per person
 * (src/lib/inngest/agent-events.ts), so a burst (four drafts at once) is one
 * pass. A pass reads the person's `new` rows, then:
 *
 *   1. GATES, once per pass:
 *      • autonomy (A5's kill switch, isAgentPaused): off → no notice and no
 *        Jev call; every row is routed quiet (never terminal: "while you were
 *        away" and the digest still show it once autonomy is back on), except
 *        the notices the recorder already sent (a question, a failure), which
 *        are recorded as they are. A failed read of the switch fails CLOSED
 *        (it spends money past here; nothing is lost while paused);
 *      • dormancy (workspaceIsDormant, 14 days): no new notice and no turn;
 *      • usage (guardBackgroundUsage, as a boolean): over the limit → no
 *        turn and no Jev call (Jev is metered).
 *   2. RULES ("needs you", decision Defaults):
 *      • questions and approvals → notify. The recorder already sent that
 *        notice (work/notify.ts): the router records its id and never sends
 *        another.
 *      • a meeting in under 30 minutes → notify, through the face: one
 *        `meeting_starting_soon` notice from the Calendar face (else the
 *        Assistant), once per event (group key `agent_event:<id>`), saying
 *        the prep is ready when it is and a plain "starts in N min" when not.
 *        The producer writes one row per meeting occurrence (meeting-soon.ts:
 *        a heads-up waits for a coming prep until 15 minutes before).
 *      • a row past its expiry (a meeting that has started) → ignore, expired.
 *      • TURN (the agent tells the person in the home thread, within a couple
 *        of minutes), never past the dormancy or usage gate (then quiet):
 *          - mail from someone the person knows (`facts.known`: a CRM contact
 *            or an address they have sent mail to, ./known-senders.ts) whose
 *            thread needs a reply, drafted or not (Liam's "known people only"
 *            rule, 2026-10-15);
 *          - a processed meeting the live agent left open asks or staged
 *            proposals in (the live chat → main agent bridge);
 *          - someone's first processed meeting while getting started
 *            (`facts.firstRun`, docs/plans/getting-started-skill.md): the
 *            agent shows them what their capture pulled out;
 *          - with no notifications page (docs/plans/retire-notifications-page.md
 *            phase 2, decision 1): what a teammate aimed at the person (a
 *            mention: a reply, a comment, an assignment, a share), a
 *            reminder they set coming due, and a failure (a work item's the
 *            recorder noticed, a sequence's). A notification already went
 *            out for each: its id is recorded, no second notice is sent. A
 *            failure the recorder didn't notify (a row written already
 *            failed) stays quiet, as its writer chose;
 *          - a connected app whose sign-in expired for good (GEN-1171,
 *            src/lib/mcp-client/expired-notice.ts): the agent says so once
 *            and puts up its Reconnect card;
 *          - a customer's quote from the business's website (roadmap B1,
 *            src/lib/customers/receive.ts): the owner hears it at once;
 *          - a customer's payment the owner wasn't texted about (roadmap C2,
 *            src/lib/payments/paid.ts: no verified number, or the text
 *            failed): the agent tells them in the home thread. Texted, it
 *            stays quiet.
 *        An approval an unattended run holds is NOT a turn (P13): its card
 *        already asks in the home thread, in the agent's own templated
 *        message (src/lib/safety/approvals.ts askAtHome), so a turn would
 *        only say it twice.
 *        The pass's turn rows become ONE `home/turn.requested` (reason
 *        'event') for the person's home thread, debounced 90 s there like a
 *        helper's report (src/lib/inngest/home-turn.ts), so a burst is one
 *        message. The turn's plan re-reads the rows, drops what has settled
 *        since, and marks the rest delivered once the agent wrote its reply.
 *      • everything else (unknown senders' mail, finished work, reviews, a
 *        teammate's FYI change, a follow-up date, an approval in the
 *        person's own chat, a pull request's change) → quiet: it waits for
 *        "while you were away" (./away-section.ts) and the digest.
 *   3. JEV, WHERE IT IS PROVEN (Liam, 2026-10-16: "let it make the call"
 *      where it has agreed with the rules over enough cases):
 *      event.needs_person (now, digest or ignore) on every row a rule didn't
 *      force (not a recorded notice, not expired, not paused) whose priority
 *      is above 0 (a plain finish is never asked about), at most
 *      JEV_SHADOW_MAX per pass and JEV_SHADOW_DAILY_MAX per person per UTC
 *      day, never over the usage limit. The answer is stored on the row
 *      (`jev_shadow`) beside the rule's outcome, always.
 *      Each SIDE of a kind is proven on its own (provenKindsFrom), over the
 *      last JEV_PROVEN_WINDOW_MS, from this task version's trusted picks,
 *      counted across everyone:
 *        - the LOWER side, on the rows the rules sent the person (turn or
 *          notify): Jev said now on at least JEV_PROVEN_MIN_AGREEMENT of at
 *          least JEV_PROVEN_MIN_CASES of them;
 *        - the RAISE side, on the rows the rules kept quiet: Jev said digest
 *          or ignore just as often.
 *      Per side, never overall: mail is mostly quiet rows, so an overall rate
 *      could pass while Jev lowered every known person's mail (review,
 *      2026-10-16). For a kind in JEV_DECIDABLE_KINDS whose side for the
 *      rule's outcome is proven, Jev's TRUSTED pick decides (`decided_by
 *      'jev'`, applyJev):
 *        - digest or ignore over a rule's turn or notify → quiet (the noise
 *          cut: still in "while you were away" and the digest; never
 *          `ignore`, which would drop it from both);
 *        - now over a rule's quiet → a turn in the home thread (the missed
 *          item), never past dormancy or the usage limit, at most
 *          JEV_PROMOTIONS_DAILY_MAX a day per person, never for a thread
 *          email.trust flagged (`facts.flagged`), and never for a meeting
 *          (its heads-up window is the rule's: no early notice).
 *      An untrusted or failed answer, a kind not proven, and every kind
 *      outside the list (questions, approvals, failures, reviews, mentions,
 *      finishes) stay with the rules. Agreement keeps being measured while
 *      Jev decides, so a kind whose agreement drops goes back to the rules on
 *      its own. JEV_ROUTER_DECIDES false returns everything to the rules.
 *
 * Each row is written once: the update is fenced on `state = 'new'`, so a
 * retried pass changes nothing it already routed, and the face notice is
 * looked up by its group key before it is sent. Everything outside text in a
 * row (a title, a subject) reaches Jev only inside its labelled-untrusted
 * state, and a notice only as a clipped title in Native Intelligence's own sentence.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { MEETING_SOON_WINDOW_MS, NOTICE_KINDS, WAITING_KINDS, type AgentEventKind, type AgentEventOutcome, type AgentEventRow } from './types'
import { eventNeedsPerson, type EventNeedsPersonInput, type EventNeedsPersonValue } from '@/lib/ai/decisions/tasks/event-needs-person'

/** At most this many rows per pass (a later pass takes the rest). */
export const ROUTER_BATCH = 100
/** At most this many shadow Jev calls per pass. */
export const JEV_SHADOW_MAX = 10
/** At most this many shadow Jev calls per person (workspace and user) per UTC day. */
export const JEV_SHADOW_DAILY_MAX = 40

/** False: Jev is only recorded, the rules decide everything (the one switch back). */
export const JEV_ROUTER_DECIDES = true
/** The kinds Jev may decide once proven: the mail and meeting rows, the ones with volume. */
export const JEV_DECIDABLE_KINDS: ReadonlySet<AgentEventKind> = new Set(['email.drafted', 'email.needs_reply', 'capture.processed', 'meeting.soon'])
/** The proven kinds a "now" can raise to a turn (a meeting's heads-up window stays the rule's). */
export const JEV_PROMOTABLE_KINDS: ReadonlySet<AgentEventKind> = new Set(['email.drafted', 'email.needs_reply', 'capture.processed'])
/**
 * Kinds never put to Jev's shadow, whatever their priority: the notices the
 * notifications page used to hold (retire-notifications-page), mentions
 * included, and a pull request's change (pr.changed, always quiet: it waits
 * for "while you were away", the digest and the check-in;
 * docs/plans/now-file.md "PR updates"). Their routing is the rules' alone
 * (none is in JEV_DECIDABLE_KINDS), so an answer could never be used, and
 * each call would spend a slot of the pass's and the day's shadow budget the
 * mail kinds need.
 */
export const JEV_NEVER_KINDS: ReadonlySet<AgentEventKind> = new Set(['mention', 'activity', 'reminder.due', 'contact.followup_due', 'sequence.failed', 'pr.changed', 'connection.needs_reconnect', 'quote.received', 'job.paid'])
/** A side of a kind is proven after at least this many trusted answers of this version on it… */
export const JEV_PROVEN_MIN_CASES = 40
/** …that agreed with the rules at least this often… */
export const JEV_PROVEN_MIN_AGREEMENT = 0.9
/** …within this window. */
export const JEV_PROVEN_WINDOW_MS = 30 * 24 * 60 * 60_000
/** At most this many rows Jev raises to a turn per person per UTC day. */
export const JEV_PROMOTIONS_DAILY_MAX = 6
/** Rules whose quiet is a gate, not a judgment: never counted for or against Jev. */
const GATED_RULES: ReadonlySet<string> = new Set(['dormant', 'over_usage', 'paused'])

export interface RouterGates {
  paused: boolean
  dormant: boolean
  overUsage: boolean
}

export interface RouteDecision {
  outcome: AgentEventOutcome
  /** 'expired' for a row past its time, else 'routed'. */
  state: 'routed' | 'expired'
  /** Send a new face notice (only the meeting-soon rule). */
  sendNotice: boolean
  /** Record the recorder's notice (a work event it already notified). */
  recordNotice: boolean
  /** A rule forced it (no Jev shadow call). */
  forced: boolean
  /** Why, for the log line. */
  rule: string
}

/**
 * The rules for one row, given the pass's gates. Pure.
 */
export function routeEvent(row: Pick<AgentEventRow, 'kind' | 'facts' | 'occurs_at' | 'expires_at'>, gates: RouterGates, nowMs: number): RouteDecision {
  const notified = row.facts?.notified === true
  const expires = row.expires_at ? Date.parse(row.expires_at) : NaN
  const occurs = Date.parse(row.occurs_at)
  // A question or an approval the recorder already told the person about: a
  // notice already out is a fact, whatever the gates say. Record it. (A
  // failure's notice is recorded too, below, but the failure is also told in
  // the home thread: retire-notifications-page phase 2.)
  const recorderNoticed = notified && (row.kind === 'work.needs_input' || row.kind === 'work.approval')
  if (recorderNoticed) return { outcome: 'notify', state: 'routed', sendNotice: false, recordNotice: true, forced: true, rule: 'recorder_notice' }
  // A notification already went out for a notice's event or a review (recordNotice keeps its id when known).
  const noticed = notified || NOTICE_KINDS.has(row.kind)
  if (Number.isFinite(expires) && expires <= nowMs) {
    return { outcome: 'ignore', state: 'expired', sendNotice: false, recordNotice: false, forced: true, rule: 'expired' }
  }
  // Paused: nothing goes out and nothing is decided, but nothing is lost either.
  if (gates.paused) return { outcome: 'quiet', state: 'routed', sendNotice: false, recordNotice: noticed, forced: true, rule: 'paused' }

  // An arrived email (docs/plans/email-through-the-agent.md E2): nothing
  // interrupts yet (decision 5, the rollout). Worth knowing, or unsure, waits
  // for "while you were away" and the digest; Jev's clear "no" is dropped.
  if (row.kind === 'email.arrived') {
    if (row.facts?.shouldKnow === false) return { outcome: 'ignore', state: 'routed', sendNotice: false, recordNotice: false, forced: false, rule: 'email_not_for_you' }
    return { outcome: 'quiet', state: 'routed', sendNotice: false, recordNotice: false, forced: false, rule: row.facts?.shouldKnow === true ? 'email_worth_knowing' : 'email_unsure' }
  }
  if (row.kind === 'meeting.soon') {
    const soon = Number.isFinite(occurs) && occurs > nowMs && occurs - nowMs <= MEETING_SOON_WINDOW_MS
    // A heads-up with or without prep (PROD audit, 2026-10-15: routing a
    // meeting with no prep quiet left people with no heads-up at all). The
    // producer writes one row per meeting occurrence (meeting-soon.ts).
    if (soon && !gates.dormant) {
      return { outcome: 'notify', state: 'routed', sendNotice: true, recordNotice: false, forced: false, rule: row.facts?.prepReady === true ? 'meeting_prep_ready' : 'meeting_soon' }
    }
    return { outcome: 'quiet', state: 'routed', sendNotice: false, recordNotice: false, forced: false, rule: gates.dormant ? 'dormant' : 'meeting_outside_window' }
  }
  const turnRule = turnRuleFor(row)
  if (turnRule) {
    if (gates.dormant || gates.overUsage) {
      return { outcome: 'quiet', state: 'routed', sendNotice: false, recordNotice: noticed, forced: FORCED_TURN_RULES.has(turnRule), rule: gates.dormant ? 'dormant' : 'over_usage' }
    }
    return { outcome: 'turn', state: 'routed', sendNotice: false, recordNotice: noticed, forced: FORCED_TURN_RULES.has(turnRule), rule: turnRule }
  }
  return {
    outcome: 'quiet',
    state: 'routed',
    sendNotice: false,
    recordNotice: noticed,
    forced: false,
    rule: WAITING_KINDS.has(row.kind) ? 'waiting_quiet' : 'quiet',
  }
}

/** Turn rules no judgment can lower (a reminder the person set, a failure, a sign-in to renew, a new person's capture): never put to Jev's shadow. */
const FORCED_TURN_RULES: ReadonlySet<string> = new Set(['reminder_due', 'failed', 'reconnect', 'getting_started', 'new_quote'])

/**
 * Why a row needs the agent's judgment in the home thread now (the `turn`
 * outcome), or null. Pure. See the header.
 */
export function turnRuleFor(row: Pick<AgentEventRow, 'kind' | 'facts'>): string | null {
  const f = row.facts ?? {}
  if ((row.kind === 'email.drafted' || row.kind === 'email.needs_reply') && f.known === true) return 'known_sender'
  // A new person's first capture while getting started
  // (docs/plans/getting-started-skill.md): the agent shows them what it pulled out.
  if (row.kind === 'capture.processed' && f.firstRun === true) return 'getting_started'
  if (row.kind === 'capture.processed' && ((f.openAsks ?? 0) > 0 || (f.pendingProposals ?? 0) > 0)) return 'live_followups'
  // A meeting someone else set up, within the next day, was cancelled, went
  // missing or moved (meeting-changes.ts already left out the person's own
  // and solo ones): the agent says so, or decides it isn't worth saying
  // (docs/plans/email-through-the-agent.md E4, decision 4). Its expiry is the
  // meeting's time, so a stale change never interrupts.
  if (row.kind === 'meeting.changed') return 'meeting_changed'
  // retire-notifications-page phase 2 (decision 1): with no notifications
  // page, what a teammate aimed at the person (a reply, a comment, an
  // assignment, a share), a reminder they set and a failure are told in the
  // home thread; a teammate's FYI change (`activity`) and a follow-up date
  // wait for "while you were away" and the digest.
  if (row.kind === 'mention') return 'aimed_at_you'
  if (row.kind === 'reminder.due') return 'reminder_due'
  // A failure its writer kept silent (no notice) stays quiet, as it chose; one
  // whose report already landed in the home thread was told there.
  if (row.kind === 'work.failed' && f.notified === true && f.toldHome !== true) return 'failed'
  if (row.kind === 'sequence.failed') return 'failed'
  // A connected app's tools fail until the person signs in again: only they can.
  if (row.kind === 'connection.needs_reconnect') return 'reconnect'
  // A customer's quote from the website (roadmap B1): the owner hears it now,
  // texted when they are away (src/lib/reach/route.ts), to say yes to the price.
  if (row.kind === 'quote.received') return 'new_quote'
  // A customer paid and the owner's text didn't go out (roadmap C2): say it here.
  if (row.kind === 'job.paid' && f.notified !== true) return 'paid_untold'
  return null
}

/** Jev's input for a row: Native Intelligence's own kind and numbers, plus the row's templated facts. Pure. */
export function eventNeedsPersonInput(row: Pick<AgentEventRow, 'kind' | 'priority' | 'facts' | 'occurs_at'>, nowMs: number): EventNeedsPersonInput {
  const occurs = Date.parse(row.occurs_at)
  const timeBound = row.kind === 'meeting.soon'
  const f = row.facts ?? {}
  const facts: EventNeedsPersonInput['facts'] = {}
  if (typeof f.title === 'string') facts.title = f.title.slice(0, 200)
  if (typeof f.from === 'string') facts.from = f.from.slice(0, 200)
  if (typeof f.reason === 'string') facts.reason = f.reason.slice(0, 200)
  if (typeof f.workKind === 'string') facts.workKind = f.workKind.slice(0, 80)
  if (typeof f.notificationType === 'string') facts.notificationType = f.notificationType.slice(0, 80)
  if (typeof f.prepReady === 'boolean') facts.prepReady = f.prepReady
  if (typeof f.notified === 'boolean') facts.notified = f.notified
  // The facts the rules turn on (v2): Jev weighs the same evidence.
  if (typeof f.known === 'boolean') facts.known = f.known
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(99, Math.round(v))) : undefined)
  const asks = count(f.openAsks)
  if (asks !== undefined) facts.openAsks = asks
  const proposals = count(f.pendingProposals)
  if (proposals !== undefined) facts.pendingProposals = proposals
  if (typeof f.door === 'string') facts.door = f.door.slice(0, 20)
  return {
    kind: row.kind,
    priority: Math.max(0, Math.min(3, Math.round(row.priority ?? 1))),
    startsInMinutes: timeBound && Number.isFinite(occurs) ? Math.max(-100_000, Math.min(100_000, Math.round((occurs - nowMs) / 60_000))) : null,
    facts,
  }
}

/** What Jev's call stored on the row (`jev_shadow`, applied or not). */
export interface JevShadow {
  version: string
  status: 'accepted' | 'escalate' | 'cancelled' | 'error'
  pick: 'now' | 'digest' | 'ignore'
  probability: number | null
  trusted: boolean
  reason?: string
  /** The rules' outcome for the row, before Jev: what agreement is measured against. */
  rule_outcome?: AgentEventOutcome
  /** The rule that gave it (a gated one is never counted). */
  rule?: string
  /** Jev's pick overturned the rule: raised to a turn, or lowered to quiet. */
  change?: 'promoted' | 'demoted'
}

/** The task's own version (one source: a prompt bump starts the proof again). */
export const EVENT_NEEDS_PERSON_VERSION = eventNeedsPerson.version

/** Jev's pick against the rule's outcome: does it say "now" where the rule does. Pure. */
function sidesAgree(pick: JevShadow['pick'], ruleOutcome: AgentEventOutcome): boolean {
  return (pick === 'now') === (ruleOutcome === 'turn' || ruleOutcome === 'notify')
}

export interface JevAgreement {
  cases: number
  agreed: number
  proven: boolean
}

/** One kind's proof, per side (header, step 3). */
export interface JevKindProof {
  /** On the rows the rules sent the person: does Jev say now too. Proven: it may lower them. */
  lower: JevAgreement
  /** On the rows the rules kept quiet: does Jev keep them quiet too. Proven: it may raise them. */
  raise: JevAgreement
}

/** The proven sides per kind, as a pass reads them. */
export type JevProven = ReadonlyMap<AgentEventKind, { lower: boolean; raise: boolean }>

function ruleSaysNow(outcome: AgentEventOutcome): boolean {
  return outcome === 'turn' || outcome === 'notify'
}

/**
 * Per kind and side, how often this version's trusted picks agreed with the
 * rules, and whether that proves the side (header, step 3). Counts only
 * accepted, trusted answers that stored the rule's outcome, on decidable
 * kinds, never a gated rule's quiet. Pure.
 */
export function provenKindsFrom(rows: ReadonlyArray<{ kind: unknown; jev_shadow: unknown }>): Map<AgentEventKind, JevKindProof> {
  const stats = new Map<AgentEventKind, JevKindProof>()
  const empty = (): JevAgreement => ({ cases: 0, agreed: 0, proven: false })
  for (const r of rows) {
    const s = r.jev_shadow as Partial<JevShadow> | null
    if (!s || typeof s !== 'object' || s.version !== EVENT_NEEDS_PERSON_VERSION) continue
    if (s.status !== 'accepted' || s.trusted !== true || !s.rule_outcome || !s.pick) continue
    if (s.rule && GATED_RULES.has(s.rule)) continue
    const kind = r.kind as AgentEventKind
    if (!JEV_DECIDABLE_KINDS.has(kind)) continue
    const k = stats.get(kind) ?? { lower: empty(), raise: empty() }
    const side = ruleSaysNow(s.rule_outcome) ? k.lower : k.raise
    side.cases++
    if (sidesAgree(s.pick, s.rule_outcome)) side.agreed++
    stats.set(kind, k)
  }
  for (const k of stats.values()) {
    for (const side of [k.lower, k.raise]) side.proven = side.cases >= JEV_PROVEN_MIN_CASES && side.agreed / side.cases >= JEV_PROVEN_MIN_AGREEMENT
  }
  return stats
}

/** The proven sides out of provenKindsFrom's stats (kinds with neither side left out). Pure. */
export function provenSides(stats: ReadonlyMap<AgentEventKind, JevKindProof>): JevProven {
  return new Map([...stats].filter(([, k]) => k.lower.proven || k.raise.proven).map(([kind, k]) => [kind, { lower: k.lower.proven, raise: k.raise.proven }]))
}

/** `kind:side` labels for the log line, sorted. Pure. */
export function provenLabels(proven: JevProven): string[] {
  return [...proven].flatMap(([kind, p]) => [...(p.lower ? [`${kind}:lower`] : []), ...(p.raise ? [`${kind}:raise`] : [])]).sort()
}

export interface AppliedRoute {
  outcome: AgentEventOutcome
  sendNotice: boolean
  decidedBy: 'rule' | 'jev'
  change: 'promoted' | 'demoted' | null
}

/**
 * The rule's decision, or Jev's trusted pick where the side of the rule's
 * outcome is proven for the row's kind (header, step 3). Pure.
 */
export function applyJev(
  row: Pick<AgentEventRow, 'kind' | 'facts'>,
  decision: RouteDecision,
  jev: JevShadow | null,
  gates: RouterGates,
  proven: JevProven,
  promotionsLeft: number,
): AppliedRoute {
  const rule: AppliedRoute = { outcome: decision.outcome, sendNotice: decision.sendNotice, decidedBy: 'rule', change: null }
  if (!JEV_ROUTER_DECIDES || decision.forced || !jev || jev.status !== 'accepted' || !jev.trusted) return rule
  const sides = JEV_DECIDABLE_KINDS.has(row.kind) ? proven.get(row.kind) : undefined
  if (!sides) return rule
  // A row a gate silenced is not the rules' judgment; Jev can't open the gate either.
  if (GATED_RULES.has(decision.rule) || gates.paused) return rule
  const ruleNow = ruleSaysNow(decision.outcome)
  // Jev decides a row only where it is proven on the rule's side of it.
  if (ruleNow ? !sides.lower : !sides.raise) return rule
  if (sidesAgree(jev.pick, decision.outcome)) return { ...rule, decidedBy: 'jev' }
  if (ruleNow) return { outcome: 'quiet', sendNotice: false, decidedBy: 'jev', change: 'demoted' }
  if (!JEV_PROMOTABLE_KINDS.has(row.kind) || row.facts?.flagged === true || gates.dormant || gates.overUsage || promotionsLeft <= 0) return rule
  return { outcome: 'turn', sendNotice: false, decidedBy: 'jev', change: 'promoted' }
}

export interface RouterDeps {
  isPaused: (supabase: SupabaseClient, workspaceId: string) => Promise<boolean>
  isDormant: (supabase: SupabaseClient, workspaceId: string) => Promise<boolean>
  /** True when the person is over their AI usage limit. */
  isOverUsage: (userId: string) => Promise<boolean>
  /** event.needs_person (recorded on every row it answers; applied only where proven). */
  decide: (input: EventNeedsPersonInput, ctx: { userId: string; workspaceId: string; runId: string }) => Promise<JevShadow>
  /** The sides Jev is proven on, per kind (provenKindsFrom over recent rows). Absent or failing: none, the rules decide. */
  provenKinds?: (supabase: SupabaseClient, nowMs: number) => Promise<JevProven>
  /** One face notice for a meeting starting soon; resolves to the notification id (or null). */
  sendMeetingNotice: (supabase: SupabaseClient, row: AgentEventRow) => Promise<string | null>
  /** The notice already out for a row (the recorder's, or the notification a notice's event stands behind), when one can be found. */
  findNotice: (supabase: SupabaseClient, row: AgentEventRow) => Promise<string | null>
  /**
   * Ask for ONE home turn (reason 'event') carrying the pass's turn rows;
   * resolves to whether it was asked. Absent: the rows wait, undelivered, for
   * "while you were away" and the digest.
   */
  requestTurn?: (supabase: SupabaseClient, person: { workspaceId: string; userId: string }, eventIds: string[]) => Promise<boolean>
  now?: () => number
}

export interface RouterResult {
  read: number
  routed: number
  outcomes: Record<AgentEventOutcome, number>
  gates: RouterGates
  shadowed: number
  /** A home turn was asked for this pass's turn rows. */
  turnRequested?: boolean
  /** Rows Jev decided (its kind proven), and of those, where it overturned the rule. */
  jev?: { decided: number; promoted: number; demoted: number; proven: string[] }
}

function emptyOutcomes(): Record<AgentEventOutcome, number> {
  return { ignore: 0, quiet: 0, turn: 0, notify: 0 }
}

function toRow(raw: Record<string, unknown>): AgentEventRow {
  return {
    ...(raw as unknown as AgentEventRow),
    id: String(raw.id),
    facts: raw.facts && typeof raw.facts === 'object' && !Array.isArray(raw.facts) ? (raw.facts as AgentEventRow['facts']) : {},
  }
}

/**
 * Route one person's new rows (see the header). Throws only when the read of
 * the rows fails (the Inngest step retries); each row's own write is
 * best-effort and fenced on `state = 'new'`.
 */
export async function routeAgentEvents(
  supabase: SupabaseClient,
  person: { workspaceId: string; userId: string },
  deps: RouterDeps,
): Promise<RouterResult> {
  const nowMs = (deps.now ?? Date.now)()
  const { data, error } = await supabase
    .from('agent_event')
    .select('id, workspace_id, user_id, source, kind, priority, occurs_at, expires_at, ref_type, ref_id, facts, dedupe_key, state, outcome, notification_id, created_at')
    .eq('workspace_id', person.workspaceId)
    .eq('user_id', person.userId)
    .eq('state', 'new')
    .order('created_at', { ascending: true })
    .limit(ROUTER_BATCH)
  if (error) throw new Error(`agent_event read failed: ${error.message}`)
  const rows = ((data as Array<Record<string, unknown>> | null) ?? []).map(toRow)
  const outcomes = emptyOutcomes()
  if (!rows.length) return { read: 0, routed: 0, outcomes, gates: { paused: false, dormant: false, overUsage: false }, shadowed: 0 }

  const [paused, dormant, overUsage] = await Promise.all([
    // Fails CLOSED (A6 review): past it come Jev and home turns, which spend
    // money. Paused rows route quiet, never terminal, so nothing is lost.
    deps.isPaused(supabase, person.workspaceId).catch(() => true),
    deps.isDormant(supabase, person.workspaceId).catch(() => false),
    deps.isOverUsage(person.userId).catch(() => false),
  ])
  const gates: RouterGates = { paused, dormant, overUsage }

  let routed = 0
  let shadowed = 0
  const turnIds: string[] = []
  const jevTally = { decided: 0, promoted: 0, demoted: 0 }
  // Today's Jev calls and raises for this person so far (a failed count allows
  // neither: Jev is optional, the rules always route).
  const today = gates.paused || gates.overUsage ? { calls: JEV_SHADOW_DAILY_MAX, promotions: JEV_PROMOTIONS_DAILY_MAX } : await jevToday(supabase, person, nowMs)
  const shadowBudget = Math.max(0, Math.min(JEV_SHADOW_MAX, JEV_SHADOW_DAILY_MAX - today.calls))
  let promotionsLeft = Math.max(0, JEV_PROMOTIONS_DAILY_MAX - today.promotions)
  // The kinds and sides Jev decides this pass (none when asking it is not allowed).
  let proven: JevProven = new Map()
  if (JEV_ROUTER_DECIDES && shadowBudget > 0 && deps.provenKinds) {
    try {
      proven = await deps.provenKinds(supabase, nowMs)
    } catch (err) {
      console.warn('[agent-router] proven kinds unavailable:', err instanceof Error ? err.message : err)
    }
  }
  for (const row of rows) {
    const decision = routeEvent(row, gates, nowMs)
    let notificationId: string | null = row.notification_id ?? null

    // Jev first: where its kind is proven, its pick decides whether the
    // meeting notice goes out at all.
    let jevShadow: JevShadow | null = null
    if (!decision.forced && (row.priority ?? 1) > 0 && !JEV_NEVER_KINDS.has(row.kind) && shadowed < shadowBudget) {
      shadowed++
      try {
        jevShadow = await deps.decide(eventNeedsPersonInput(row, nowMs), {
          userId: person.userId,
          workspaceId: person.workspaceId,
          runId: `agent_event:${row.id}`,
        })
      } catch (err) {
        jevShadow = {
          version: EVENT_NEEDS_PERSON_VERSION,
          status: 'error',
          pick: 'digest',
          probability: null,
          trusted: false,
          reason: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        }
      }
    }
    const applied = applyJev(row, decision, jevShadow, gates, proven, promotionsLeft)
    if (jevShadow) {
      jevShadow = { ...jevShadow, rule_outcome: decision.outcome, rule: decision.rule, ...(applied.change ? { change: applied.change } : {}) }
    }

    let outcome = applied.outcome
    try {
      if (decision.recordNotice && !notificationId) notificationId = await deps.findNotice(supabase, row)
      if (applied.sendNotice) {
        notificationId = await deps.sendMeetingNotice(supabase, row)
        // A notice that could not go out leaves the row quiet: it still shows in "while you were away".
        if (!notificationId) outcome = 'quiet'
      }
    } catch (err) {
      console.warn('[agent-router] notice skipped:', err instanceof Error ? err.message : err)
      if (applied.sendNotice) outcome = 'quiet'
    }

    try {
      const { data: updated, error: updateError } = await supabase
        .from('agent_event')
        .update({
          state: decision.state,
          outcome,
          decided_by: applied.decidedBy,
          routed_at: new Date(nowMs).toISOString(),
          ...(notificationId ? { notification_id: notificationId } : {}),
          ...(jevShadow ? { jev_shadow: jevShadow } : {}),
        })
        .eq('id', row.id)
        .eq('state', 'new')
        .select('id')
      if (updateError) {
        console.warn('[agent-router] route write skipped:', updateError.message)
        continue
      }
      if (Array.isArray(updated) && updated.length > 0) {
        routed++
        outcomes[outcome]++
        if (outcome === 'turn') turnIds.push(row.id)
        if (applied.decidedBy === 'jev') jevTally.decided++
        if (applied.change === 'promoted') {
          jevTally.promoted++
          promotionsLeft--
        }
        if (applied.change === 'demoted') jevTally.demoted++
      }
    } catch (err) {
      console.warn('[agent-router] route write skipped:', err instanceof Error ? err.message : err)
    }
  }
  // One home turn for the whole pass. A lost request leaves the rows for the
  // away section and the digest (they read the turn outcome too).
  let turnRequested = false
  if (turnIds.length && deps.requestTurn) {
    try {
      turnRequested = await deps.requestTurn(supabase, person, turnIds)
    } catch (err) {
      console.warn('[agent-router] turn request skipped:', err instanceof Error ? err.message : err)
    }
  }
  return { read: rows.length, routed, outcomes, gates, shadowed, turnRequested, jev: { ...jevTally, proven: provenLabels(proven) } }
}

/**
 * This person's Jev use today (UTC): rows routed today with an answer stored
 * (calls), and of those, the ones it raised to a turn (promotions). A failed
 * read reads as both budgets used.
 */
async function jevToday(supabase: SupabaseClient, person: { workspaceId: string; userId: string }, nowMs: number): Promise<{ calls: number; promotions: number }> {
  const spent = { calls: JEV_SHADOW_DAILY_MAX, promotions: JEV_PROMOTIONS_DAILY_MAX }
  try {
    const dayStart = new Date(nowMs)
    dayStart.setUTCHours(0, 0, 0, 0)
    const { data, error } = await supabase
      .from('agent_event')
      .select('id, jev_shadow')
      .eq('workspace_id', person.workspaceId)
      .eq('user_id', person.userId)
      .not('jev_shadow', 'is', null)
      .gte('routed_at', dayStart.toISOString())
      .limit(JEV_SHADOW_DAILY_MAX + JEV_SHADOW_MAX)
    if (error || !Array.isArray(data)) return spent
    const rows = data as Array<{ jev_shadow?: { change?: unknown } | null }>
    return { calls: rows.length, promotions: rows.filter((r) => r.jev_shadow?.change === 'promoted').length }
  } catch {
    return spent
  }
}

/** Jev's stored answer for a decision result. Pure. */
export function jevShadowFrom(
  result: { status: 'accepted'; value: EventNeedsPersonValue } | { status: 'escalate' | 'cancelled'; reason: string },
): JevShadow {
  if (result.status === 'accepted') {
    return { version: EVENT_NEEDS_PERSON_VERSION, status: 'accepted', pick: result.value.pick, probability: result.value.probability, trusted: result.value.trusted }
  }
  // Uncertain waits for the digest (the quiet side).
  return { version: EVENT_NEEDS_PERSON_VERSION, status: result.status, pick: 'digest', probability: null, trusted: false, reason: result.reason.slice(0, 200) }
}

/** One `[agent-router]` line per pass. Pure. */
export function routerLogLine(person: { workspaceId: string; userId: string }, r: RouterResult): string {
  const o = r.outcomes
  const j = r.jev
  const jev = j ? ` jev_decided=${j.decided} jev_promoted=${j.promoted} jev_demoted=${j.demoted} jev_proven=${j.proven.join(',') || 'none'}` : ''
  return `[agent-router] ws=${person.workspaceId} user=${person.userId} read=${r.read} routed=${r.routed} notify=${o.notify} quiet=${o.quiet} ignore=${o.ignore} turn=${o.turn}${r.turnRequested ? ' turn_requested' : ''} shadow=${r.shadowed}${jev} paused=${r.gates.paused} dormant=${r.gates.dormant} over_usage=${r.gates.overUsage}`
}
