/**
 * The structured verdict contract a verdict-class skill run commits (Phase 2,
 * Workstream B) — decisions / needs_user / summary.
 *
 * The eve `skill-runner` task session requests it as the run's `outputSchema`
 * (run-skill-eve.ts); the server-side applyVerdict walk (verdict-apply.ts)
 * consumes it. RunVerdict is the shared shape.
 *
 * (This was verdict-tool.ts, which also built the in-process AI-SDK
 * `submit_run_verdict` terminating tool for the retired gateway branch.)
 */
import { z } from 'zod'
import type { RunVerdict } from './verdict-apply'
import { WORK_EXPECTS_MAX, WORK_EXPECT_MIN_CAP, WORK_EXPECT_TYPES, WORK_ROLES } from '@/lib/work/roles'
import { lensesOutputSchema, type LensKey } from './lenses'

const PRIORITY = z.enum(['none', 'low', 'medium', 'high', 'urgent'])

const decisionSchema = z.object({
  proposal_id: z.string().describe('UUID of the pending proposal this decision is about (or, for revoke, the applied proposal to undo).'),
  verdict: z
    .enum(['accept', 'dismiss', 'fold_into', 'revoke'])
    .describe(
      'accept = real, new, mine — promote it. dismiss = duplicate / not mine / stale / narration. ' +
        'fold_into = its substance belongs on an existing action (set fold_target_action_id). ' +
        'revoke = a previously AUTO-ACCEPTED item that was wrong; the engine deletes it (create-only, <72h, untouched).',
    ),
  corrections: z
    .object({
      priority: PRIORITY.optional(),
      due_date: z.string().nullable().optional().describe('ISO date, or null to clear an invented due date.'),
      status: z.string().optional().describe('Workflow state NAME to move/place the action in (Standup Sync).'),
    })
    .optional()
    .describe('Field corrections folded into the apply (re-grade inflated priority, drop invented dates).'),
  fold_target_action_id: z.string().optional().describe('For fold_into: UUID of the covering action to comment onto.'),
  reason: z.string().describe('One line, user-facing — cite GEN-X for a duplicate dismissal.'),
  confidence: z.number().min(0).max(1).describe('Your confidence in THIS decision (0..1).'),
  is_mine_explicit: z
    .boolean()
    .optional()
    .describe(
      'True ONLY if the commitment is explicitly the user’s — first-person in the trigger quote ' +
        '("I’ll…", the user named as owner). An accept can auto-apply only when this is true; ' +
        'otherwise it becomes a card for the user to confirm.',
    ),
  is_outreach: z
    .boolean()
    .optional()
    .describe(
      'True ONLY if this accept is an OUTREACH commitment — the user said they’d reach out / ' +
        'email / follow up with a specific person. When such an accept auto-applies, the system ' +
        'resolves that person’s email and surfaces a companion draft-email card (it never sends). ' +
        'Your judgment only — set outreach_contact_name to the person.',
    ),
  outreach_contact_name: z
    .string()
    .optional()
    .describe(
      'For is_outreach: the person to reach out to, exactly as named in the trigger quote. The ' +
        'server resolves this to a real contact/participant email — do NOT provide an address.',
    ),
})

const needsUserSchema = z.object({
  kind: z.enum(['action_card', 'draft_email', 'question', 'work_proposal']),
  // An action or email card's accept applies its proposal, so one without a
  // proposal_id is never made (verdict-apply.ts, isUnbackedCard).
  proposal_id: z
    .string()
    .optional()
    .describe(
      'The pending proposal this item is about. REQUIRED for action_card and draft_email: accepting one applies ' +
        'its proposal, and one without it is dropped. A new to-do of the user’s is an accept, not an action_card.',
    ),
  title: z.string().describe('Short imperative statement of the item (≤200 chars for work_proposal).'),
  why: z.string().describe('One line: why this needs the user specifically.'),
  // Left loose on purpose (record of unknown) so the tool never rejects a slightly
  // off item. For kind 'work_proposal' the payload SHOULD carry WorkProposalPayload
  // fields — REQUIRED: `task` (self-contained: what to do, the relevant names/
  // quotes/context, the desired output); OPTIONAL: `deliverable_hint`
  // ('email_draft'|'document'|'board_update'|'mixed'), `resources`
  // ([{type, id?, label}] naming the capture/contacts/entities the work draws on —
  // this MAY include the knowledge packages listed in the workspace context, cited
  // as {type:'package', id, label} with the LISTED id verbatim, never an invented
  // id), and, for email-drafting work, `email_to_name`/`email_to_address` when
  // known. The apply engine validates `task` presence server-side (a work item with
  // no task degrades to a plain question card — never an unstartable work card).
  payload: z.record(z.string(), z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  // Sequence step 2 (B PR 1): a work_proposal may say WHO should do it and WHAT
  // it must produce. Both optional — an item without them is today's card with
  // Start; the auto-attempt gate (B PR 3) only ever attempts one that has a role.
  role: z
    .enum(WORK_ROLES)
    .optional()
    .describe(
      'For kind "work_proposal": the teammate role whose output the item needs — researcher (find out and ' +
        'summarize), writer (draft a document), developer (change code, open a PR) or correspondent (draft an ' +
        'email). Omit when none fits; an item with no role stays a card and is never attempted on its own.',
    ),
  expects: z
    .array(
      z.object({
        type: z.enum(WORK_EXPECT_TYPES),
        min: z.number().int().min(0).max(WORK_EXPECT_MIN_CAP).optional(),
        entity_type: z.string().max(40).optional().describe('Qualifies type "entity", e.g. "pr".'),
      }),
    )
    .max(WORK_EXPECTS_MAX)
    .optional()
    .describe(
      'For kind "work_proposal": the artifact(s) the work must produce, e.g. [{"type":"document","min":1}] ' +
        'for a brief, [{"type":"email_draft","min":1}] for an email, [{"type":"entity","entity_type":"pr","min":1}] ' +
        'for code. Omit when a summary in the run\'s own words is enough.',
    ),
})

/**
 * The triage POLICY a verdict run judges by — the one server-side copy (it was
 * the retired gateway `submit_run_verdict` tool's description). It rides on the
 * top-level `description` of `verdictOutputSchema` below, which eve lowers into
 * the input schema of its `eve__reply` tool (`final_output` before eve 0.76;
 * eve harness/final-output.js — that tool’s own description is fixed by eve).
 */
export const VERDICT_POLICY_GUIDANCE =
  'Your FINAL triage verdict for this run: a decision for every pending proposal you reviewed ' +
  'and any items that need the user. You do NOT apply anything yourself — the system applies ' +
  'your verdict and records what it did. ' +
  'Default to dismiss; accept only real, new work that is explicitly the user’s. ' +
  'needs_user items: if an item is WORK an agent could complete with workspace tools ' +
  '(drafting an email, preparing a doc, researching + summarizing), emit kind ' +
  '"work_proposal" with a SELF-CONTAINED payload.task — what to do, the relevant names/' +
  'quotes/context, and the desired output — plus optional payload.resources (the ' +
  'capture/contacts/entities it draws on — including any RELEVANT knowledge packages ' +
  'from the workspace context, cited as {type:"package", id, label} with the listed id ' +
  'verbatim) and payload.deliverable_hint, INSTEAD OF a bare action_card. Reserve ' +
  'action_card for work only the human can do. An action_card or draft_email must name the ' +
  'pending proposal it is about (proposal_id): a next step with no proposal is not a card, and ' +
  'a new to-do of the user’s is an accept (it stays in its capture). For email-drafting work include ' +
  'email_to_name/email_to_address when known. On a work_proposal also set role (researcher | writer | ' +
  'developer | correspondent — the teammate whose output the item needs) and expects (the artifact it ' +
  'must produce) when the task is genuinely that shape; leave both out otherwise.'

/**
 * The verdict's schema: the eve task session's `outputSchema` (see the file
 * header). Carries
 * VERDICT_POLICY_GUIDANCE as its description (see above).
 */
export const verdictOutputSchema = z.object({
  decisions: z.array(decisionSchema).describe('One decision per proposal you reviewed.'),
  needs_user: z
    .array(needsUserSchema)
    .optional()
    .describe('Items that genuinely need the user — surfaced as cards (capped).'),
  summary: z.string().describe('At most two sentences: what mattered and what you did.'),
}).describe(VERDICT_POLICY_GUIDANCE)

/**
 * The verdict's schema with the lenses that ride this run (flows F3,
 * lenses.ts): the verdict's own fields, plus an optional `lenses` object with
 * one optional section per riding lens, in the lenses' fixed order. With no
 * lens it IS verdictOutputSchema, so a Triage run nobody added a lens to asks
 * for exactly what it always did. One schema per key set, built once.
 */
const withLensesCache = new Map<string, z.ZodType>()
export function verdictOutputSchemaFor(keys: readonly LensKey[]): typeof verdictOutputSchema {
  if (keys.length === 0) return verdictOutputSchema
  const id = [...keys].sort().join(',')
  let schema = withLensesCache.get(id)
  if (!schema) {
    schema = z
      .object({ ...verdictOutputSchema.shape, lenses: lensesOutputSchema(keys).optional() })
      .describe(VERDICT_POLICY_GUIDANCE)
    withLensesCache.set(id, schema)
  }
  // The session helpers type the result as the verdict; the lens sections are read raw (lens-deliver.ts).
  return schema as unknown as typeof verdictOutputSchema
}

/**
 * Normalize a schema-valid-but-sparse verdict into the full RunVerdict shape.
 * needs_user is OPTIONAL in the schema (model leniency), so any path that
 * receives a verdict across a process boundary — the eve outputSchema result,
 * an MCP call, a re-parsed ledger — must pass it through here before the apply
 * walk. Skipping this is the "e.needs_user is not iterable" prod crash
 * (recurring since 2026-07-13, /api/inngest).
 */
export function normalizeVerdict(raw: unknown): RunVerdict | null {
  if (raw == null || typeof raw !== 'object') return null
  const v = raw as Partial<RunVerdict>
  return {
    decisions: Array.isArray(v.decisions) ? v.decisions : [],
    needs_user: Array.isArray(v.needs_user) ? v.needs_user : [],
    summary: typeof v.summary === 'string' ? v.summary : '',
  }
}
