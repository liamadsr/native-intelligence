/**
 * The shared auto-apply gate (One Accept Authority, W-1). ONE pure decision
 * function — `decideAutoApply` — that both authorities call to decide whether a
 * staged proposal auto-applies or waits as a card/pending item:
 *
 *   - the verdict path (verdict-apply.ts acceptDecision), reached from gateway,
 *     eve, and local-MCP runs, and
 *   - the extraction path (live-agent/route.ts, live turns and batch).
 *
 * "Exactly one gate decides." (docs/loop-engine/NORTH-STAR.md invariant 1;
 * design docs/loop-engine/ONE-ACCEPT-AUTHORITY-DESIGN.md, D1/D2.) Before this,
 * the two paths judged the same mutation ("filed to your board") by two
 * different, verbatim-duplicated rulesets. This collapses the DECISION; each
 * caller keeps its own transaction / near-dup-damping scaffolding (design trap:
 * the two extraction blocks are duplicated on purpose — the race damping differs
 * per path).
 *
 * PURE — no side effects, no DB reads. The caller resolves everything the gate
 * needs (self-binding, speaker-map provenance, the model's explicitness flags)
 * and passes booleans. applyChange stays the single mutation primitive; the gate
 * decides, it never writes (design trap: don't let the gate grow side effects).
 */

import type { ChangeType, EntityType } from './types'
import type { TrustPolicy, TrustEntity } from './trust-policy'

/** Which authority is asking. Governs the explicitness contract per entity. */
export type GateAuthority = 'verdict' | 'extraction'

/** The proposal facts the gate reads — a structural subset of ProposedChange so
 *  either a DB row or a synthesized candidate can be passed. */
export interface GateProposal {
  change_type: ChangeType | string
  entity_type: EntityType | string
  confidence: number | null | undefined
}

export interface GateContext {
  authority: GateAuthority
  /** Run mode. The verdict path passes its per-flow mode; extraction derives it
   *  from the capture via `gateModeForCapture` below — 'act' for a real capture,
   *  'report' for an eval one (design trap: never a literal at an extraction
   *  call site). Only 'act' can ever auto-apply. */
  mode: 'report' | 'act'
  /**
   * ACTIONS explicitness/ownership signal.
   *   - verdict: the model's is_mine_explicit (first-person / named-owner commitment).
   *   - extraction: the caller's verified me-ownership (assignee === me AND
   *     resolved through the speaker map AND an evidence-backed self binding), OR
   *     an action delegated to an agent (which auto-creates so it can be started).
   * When an action proposal isn't assignable at all (e.g. an action UPDATE), the
   * caller passes the authority's rule — see the call sites. Undefined ⇒ false.
   */
  isMineExplicit?: boolean
  /**
   * DECISIONS/MILESTONES explicitness signal (D2): the model marked the item
   * explicitly stated in the source ("we decided X"), not inferred. Consumed only
   * when the resolved policy rule has require_explicit set. Undefined ⇒ false.
   */
  isExplicitlyStated?: boolean
  /**
   * The workspace EDITION's auto-createable entity_type set
   * (EditionDefinition.autoCreateEntities). `'all'`/undefined ⇒ no edition
   * restriction — today's behavior for every workspace without an edition.
   *
   * Consulted ONLY for `change_type === 'create'` — the set names entity classes
   * an edition may CREATE unattended, so applying it to an update would let a
   * narrowed edition stop the AI from touching entities the workspace already
   * has (see the gate body).
   *
   * An entity outside the set STAGES; it is never dropped. A notes-edition
   * workspace still RECEIVES a contact proposal from extraction — it just waits
   * as a card instead of auto-filing, and a human accept applies it normally
   * (manual accepts call applyChange directly and never reach this gate).
   */
  allowedEntityTypes?: 'all' | string[]
}

/** The gate's verdict for one proposal. */
export type GateDecision = 'apply' | 'stage'

/** External side effects (email / mcp / the external entity) never auto-apply on
 *  confidence — they wait for an explicit human click unless policy allows it. */
export function isExternal(p: GateProposal): boolean {
  return (
    p.change_type === 'send_email' ||
    p.change_type === 'mcp_call' ||
    p.entity_type === 'external'
  )
}

/** Map an entity_type to its trust-policy rule bucket, or null if the gate does
 *  not judge that entity (everything unmapped stages unconditionally). */
function entityBucket(entityType: string): TrustEntity | null {
  if (entityType === 'action') return 'actions'
  if (entityType === 'decision') return 'decisions'
  if (entityType === 'milestone') return 'milestones'
  return null
}

/**
 * The extraction authority's bucket mapping — a superset of entityBucket:
 * update:project rides the ACTIONS rule (threshold only, no explicitness
 * requirement), matching its pre-gate behavior (the design's Part 1 inventories
 * project-updates among extraction's auto-applies; live-agent bucketed them into
 * the actions threshold and never me-gated them). Everything else unmapped —
 * project creates, initiatives, contacts, external — stages unconditionally.
 */
function extractionBucket(p: GateProposal): TrustEntity | null {
  const bucket = entityBucket(p.entity_type)
  if (bucket) return bucket
  if (p.entity_type === 'project' && p.change_type === 'update') return 'actions'
  return null
}

/**
 * Decide whether a staged proposal auto-applies now or waits. Pure.
 *
 * The two authorities share the confidence + kill-switch + external rules but
 * differ on WHICH entities they auto-apply and what "explicit" means:
 *
 *   VERDICT — auto-applies ONLY actions, and only create|update (delete destroys
 *     a card, assign moves someone else's work — both always card). An action
 *     needs is_mine_explicit. Decisions/milestones ALWAYS stage in the verdict
 *     path (a decision isn't a personal commitment, and createDecision fires an
 *     async knowledge claim the lost-CAS rollback can't fully undo). This
 *     reproduces verdict-apply's historical gate exactly.
 *
 *   EXTRACTION — auto-applies actions (create/update), project updates (under
 *     the actions rule), decisions, and milestones. Action creates need verified
 *     me-ownership (isMineExplicit); decisions/milestones need the D2
 *     explicitly-stated flag when the policy rule requires it. This reproduces
 *     the live-agent gate plus the D2 addition — except externals, which now
 *     ALWAYS stage (invariant 5; see the unmapped-bucket branch), and
 *     deletes/assigns, which the shared guard below stages for every authority.
 */
export function decideAutoApply(
  proposal: GateProposal,
  policy: TrustPolicy,
  ctx: GateContext,
): GateDecision {
  // Report mode never writes the board; the master kill-switch wins everything.
  if (ctx.mode !== 'act') return 'stage'
  if (!policy.enabled) return 'stage'

  // External side effects: never auto-apply unless the policy explicitly allows.
  if (isExternal(proposal) && !policy.allow_external) return 'stage'

  // Destructive/ownership ops ALWAYS require a human click, for EVERY authority
  // (NORTH-STAR: a card for anything irreversible). A delete hard-destroys an
  // entity (delete:milestone is an unrecoverable row DELETE — no undo path);
  // an assign moves someone's work. The verdict path already staged both
  // (decideVerdict's create|update-only rule); this hoists the rule to the
  // shared path so the extraction authority can never auto-fire one either —
  // is_explicitly_stated is stamped for ANY decision/milestone proposal
  // regardless of change_type, so without this guard a high-confidence
  // "explicitly stated" delete:milestone would auto-delete unattended.
  // Deliberate behavior change for extraction's assign:action (it used to
  // auto-apply verified-mine assigns); target-less assigns normalize to
  // create:action at APPLY time, but that is the accept-click path — the gate
  // judges the proposal as staged, and an assign as staged re-points work.
  if (proposal.change_type === 'delete' || proposal.change_type === 'assign') return 'stage'

  const bucket =
    ctx.authority === 'extraction' ? extractionBucket(proposal) : entityBucket(proposal.entity_type)
  // An entity the gate doesn't judge → always stage. INTENTIONAL CHANGE from the
  // pre-gate extraction path: with allow_external on, mcp_call:external and
  // send_email proposals used to auto-FIRE on confidence alone — a NORTH-STAR
  // invariant-5 violation (no unattended external side effects). Externals that
  // survive the allow_external check above still land here (entity 'external' /
  // non-core entities are unmapped) and are STAGED as drafts for explicit review.
  if (!bucket) return 'stage'

  // Edition scope: a workspace whose edition doesn't surface this entity class
  // never auto-CREATES one unattended. STAGE, never drop — the proposal is still
  // written and still acceptable by hand, so switching editions later loses
  // nothing and a mis-set edition can't silently destroy extracted work.
  //
  // CREATES ONLY. `autoCreateEntities` is, by its own name and manifest doc, the
  // set of entity classes automation may bring into EXISTENCE; it says nothing
  // about grooming what the workspace already has. Keying it on entity_type
  // alone would also stage every UPDATE of an existing entity, which is a
  // different (and unasked-for) restriction: a workspace with any feature off
  // enumerates `autoCreateEntities`, and `update:project` — which rides the
  // ACTIONS rule via extractionBucket and auto-applied before editions existed —
  // would silently stop auto-applying because no feature contributes 'project'
  // to a create set. Updates are therefore governed solely by the trust policy,
  // exactly as they were pre-editions.
  //
  // change_type is the ChangeType union (./types.ts): create | update | delete |
  // assign | send_email | mcp_call. delete/assign are staged above and the two
  // external kinds are unmapped buckets, so in practice this narrows the
  // edition check to create-vs-update.
  if (
    proposal.change_type === 'create' &&
    ctx.allowedEntityTypes &&
    ctx.allowedEntityTypes !== 'all' &&
    !ctx.allowedEntityTypes.includes(proposal.entity_type)
  ) {
    return 'stage'
  }

  const rule = policy[bucket]
  if (!rule.enabled) return 'stage'

  // Confidence floor — a null/unscored confidence never auto-applies.
  const conf = proposal.confidence
  if (typeof conf !== 'number' || Number.isNaN(conf)) return 'stage'
  if (conf < rule.min_confidence) return 'stage'

  if (ctx.authority === 'verdict') {
    return decideVerdict(proposal, ctx)
  }
  return decideExtraction(proposal, bucket, rule.require_explicit, ctx)
}

/** Verdict authority: actions only, create|update only, is_mine_explicit. */
function decideVerdict(proposal: GateProposal, ctx: GateContext): GateDecision {
  // Decisions/milestones NEVER auto-apply in the verdict path (they stage for
  // extraction's own authority / the human). Cards are the safe default.
  if (proposal.entity_type !== 'action') return 'stage'
  // create (new commitment) and update (status/field move) are reversible-or-
  // groomable; delete destroys a board card outright and assign moves someone
  // ELSE's work — both stay human-approved no matter how explicit the quote.
  if (proposal.change_type !== 'create' && proposal.change_type !== 'update') {
    return 'stage'
  }
  if (ctx.isMineExplicit !== true) return 'stage'
  return 'apply'
}

/** Extraction authority: actions (create/update), decisions, milestones.
 *  (delete/assign never reach here — the shared guard stages them upstream.) */
function decideExtraction(
  proposal: GateProposal,
  bucket: TrustEntity,
  requireExplicit: boolean,
  ctx: GateContext,
): GateDecision {
  if (bucket === 'actions') {
    // Action creates are me-scoped: only auto-apply verified-mine items (or
    // agent-delegated). The caller computes isMineExplicit with that exact
    // meaning (assignee === me via speaker map + self binding, OR
    // agent-delegated). A non-assignable proposal riding this rule (an action
    // update, a project update) has no ownership to verify — the caller passes
    // isMineExplicit:true so it clears here on confidence alone, matching
    // today's extraction behavior (only create:action was me-gated).
    if (ctx.isMineExplicit !== true) return 'stage'
    return 'apply'
  }
  // Decisions / milestones (D2): auto-apply on confidence, plus the explicitly-
  // stated flag when the policy rule requires it. Inferred → stage (card).
  if (requireExplicit && ctx.isExplicitlyStated !== true) return 'stage'
  return 'apply'
}

/**
 * The capture-derived run mode for the EXTRACTION authority.
 *
 * Extraction has no per-flow mode of its own (the verdict path passes its
 * flow's), so its call sites historically passed the literal `'act'`.
 * An EVAL capture (`captures.is_eval`, migration 252) must never write the
 * board: a synthetic mock call auto-filing actions onto a real workspace is
 * the feature's worst failure mode.
 *
 * `'report'` is a COMPLETE dry run rather than a disabled trust policy: every
 * candidate still runs the confidence floors, the external guard, the
 * delete/assign guard, edition scope, and race damp, and every gate decision is
 * still recorded in the extraction ledger — so an eval trial can grade the
 * counterfactual ("this would have auto-applied at 0.91"). Forcing
 * `trustPolicy.enabled = false` instead would skip the whole auto-apply block
 * and throw that counterfactual away.
 *
 * Both extraction sites derive their `mode` from here and never from a literal,
 * so a third copy of the loop cannot ship with `'act'` hardcoded
 * (`src/app/api/ai/live-agent/__tests__/no-act-literal.test.ts` enforces it).
 */
export function gateModeForCapture(capture: { is_eval?: boolean | null }): 'act' | 'report' {
  return capture.is_eval === true ? 'report' : 'act'
}
