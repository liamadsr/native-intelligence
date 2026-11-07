/**
 * The case a reviewer starts from (/admin/evals): drafted from a candidate's
 * evidence, never final. The reviewer reads the evidence, edits the draft and
 * saves it; validateCaseDraft (./case-schema.ts) checks it then.
 *
 *   thumbs_up                        "keep doing this": the loads seen and the
 *                                    calls that succeeded, in order.
 *   input_invalid / repeated_failure the same request, calling the tool that
 *                                    failed, this time without an error.
 *   thumbs_down                      the request and the loads seen; the
 *                                    reviewer fills in the tools from the reason.
 *   loop_failed / draft_rewrite /    no chat request is known: the request is
 *   draft_dismissed                  left empty for the reviewer to write, and
 *                                    `why` says what happened (a dismissed
 *                                    draft: its reason; a wrong one is the
 *                                    drafter's, the rest the inbox's).
 *
 * Pure and client-safe.
 */
import type { FlywheelSkillCase } from './case-schema'
import { FLYWHEEL_SKILL_RE } from './case-schema'
import type { ChatTurnEvidence, DraftDismissedEvidence, DraftRewriteEvidence, EvalCandidateRow, LoopRunEvidence, TurnToolStep } from './types'
import { FLYWHEEL_LIMITS } from './types'
import { sliceStart } from './bytes'

export type CaseDraftInput = Pick<EvalCandidateRow, 'source' | 'polarity' | 'evidence' | 'reason' | 'skill_slugs' | 'tools'>

/** The skill a draft of a draft rewrite belongs to. */
export const DRAFT_REWRITE_SKILL = 'write-in-your-tone'
/** The skill a dismissed draft's case belongs to, unless the draft itself was wrong (then DRAFT_REWRITE_SKILL's). */
export const DRAFT_DISMISSED_SKILL = 'clear-inbox'

/** A dismissal reason in a reviewer's words. */
const DISMISS_WHY: Record<DraftDismissedEvidence['reason'], string> = {
  no_reply_needed: 'nothing in the thread needed a reply',
  outdated: 'the moment had passed',
  duplicate: 'another draft already answered the thread',
  bad_draft: 'a reply was owed, but the draft was wrong',
  other: 'another reason',
}

const INSTRUCTIONS = 'instructions'

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${sliceStart(t, max - 1).trimEnd()}…` : t
}

function asChatTurn(evidence: CaseDraftInput['evidence']): ChatTurnEvidence | null {
  return (evidence as { kind?: unknown }).kind === 'chat_turn' ? (evidence as ChatTurnEvidence) : null
}

function asLoopRun(evidence: CaseDraftInput['evidence']): LoopRunEvidence | null {
  return (evidence as { kind?: unknown }).kind === 'loop_run' ? (evidence as LoopRunEvidence) : null
}

function asDraftRewrite(evidence: CaseDraftInput['evidence']): DraftRewriteEvidence | null {
  return (evidence as { kind?: unknown }).kind === 'draft_rewrite' ? (evidence as DraftRewriteEvidence) : null
}

function asDraftDismissed(evidence: CaseDraftInput['evidence']): DraftDismissedEvidence | null {
  return (evidence as { kind?: unknown }).kind === 'draft_dismissed' ? (evidence as DraftDismissedEvidence) : null
}

/** A usable skill slug, or null. */
function slug(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim().toLowerCase()
  return FLYWHEEL_SKILL_RE.test(s) ? s : null
}

/** The skills the turn loaded: the evidence's, else the row's. */
function loadsOf(row: CaseDraftInput, turn: ChatTurnEvidence | null): string[] {
  const raw = turn && Array.isArray(turn.loads) && turn.loads.length > 0 ? turn.loads : row.skill_slugs ?? []
  const out: string[] = []
  for (const s of raw) {
    const ok = slug(s)
    if (ok && !out.includes(ok)) out.push(ok)
  }
  return out
}

function stepsOf(turn: ChatTurnEvidence | null): TurnToolStep[] {
  return turn && Array.isArray(turn.steps) ? turn.steps : []
}

/** `name [CODE]: error`, for a why. */
function describeStep(step: TurnToolStep): string {
  const code = step.code ? ` [${step.code}]` : ''
  const error = step.error ? `: ${step.error}` : ''
  return `${step.name}${code}${error}`
}

/** Names in order, a run of the same name kept once (a retry is one expectation). */
function inOrder(names: string[]): string[] {
  const out: string[] = []
  for (const n of names) if (n && out[out.length - 1] !== n) out.push(n)
  return out.slice(0, FLYWHEEL_LIMITS.tools)
}

function withWhy(c: FlywheelSkillCase, why: string): FlywheelSkillCase {
  const w = clip(why, FLYWHEEL_LIMITS.reason)
  return w ? { ...c, why: w } : c
}

/** The draft case for one candidate: which skill, and the case to start from. */
export function buildCaseDraft(row: CaseDraftInput): { skill: string; case: FlywheelSkillCase } {
  const turn = asChatTurn(row.evidence)
  const loads = loadsOf(row, turn)
  const steps = stepsOf(turn)
  const request = turn?.request?.trim() ?? ''
  const reason = row.reason?.trim() ?? ''
  const chatSkill = loads[0] ?? INSTRUCTIONS

  switch (row.source) {
    case 'thumbs_up': {
      const tools = inOrder(steps.filter((s) => s.ok).map((s) => s.name))
      const why = ['Thumbs-up: keep doing this.', reason ? `"${reason}"` : ''].filter(Boolean).join(' ')
      return { skill: chatSkill, case: withWhy({ request, loads, tools, noToolErrors: true }, why) }
    }

    case 'input_invalid':
    case 'repeated_failure': {
      const code = row.source === 'input_invalid' ? 'INPUT_INVALID' : 'REPEATED_FAILURE'
      const failed = steps.find((s) => !s.ok && s.code === code) ?? steps.find((s) => !s.ok)
      const tool = failed?.name ?? row.tools?.[0]
      // Named by the candidate's code; a first failed step with another code says so.
      const other = failed?.code && failed.code !== code ? ` (failed with ${failed.code})` : ''
      const why = `${code}${tool ? ` on ${tool}` : ''}${other}${failed?.error ? `: ${failed.error}` : ''}`
      return { skill: chatSkill, case: withWhy({ request, loads, tools: tool ? [tool] : [], noToolErrors: true }, why) }
    }

    case 'thumbs_down': {
      const failedSteps = steps.filter((s) => !s.ok).map(describeStep)
      const why = [
        reason ? `Thumbs-down: "${reason}".` : 'Thumbs-down (no reason given).',
        failedSteps.length > 0 ? `Failed steps: ${failedSteps.join('; ')}.` : '',
      ]
        .filter(Boolean)
        .join(' ')
      return { skill: chatSkill, case: withWhy({ request, loads, tools: [], avoid: [] }, why) }
    }

    case 'loop_failed': {
      const job = asLoopRun(row.evidence)
      const skill = slug(job?.skill) ?? slug(row.skill_slugs?.[0]) ?? INSTRUCTIONS
      const flowErrors = (job?.flowErrors ?? []).map((f) => `${f.action}: ${f.error}`)
      const why = [
        `Background job failed${job ? ` (${job.jobKind}${job.title ? `: ${job.title}` : ''})` : ''}.`,
        job?.error ? `Error: ${job.error}` : '',
        flowErrors.length > 0 ? `Failed actions: ${flowErrors.join('; ')}.` : '',
        'Write the chat request that reproduces it.',
      ]
        .filter(Boolean)
        .join(' ')
      return { skill, case: withWhy({ request: '', loads: skill === INSTRUCTIONS ? [] : [skill], tools: [] }, why) }
    }

    case 'draft_rewrite': {
      const draft = asDraftRewrite(row.evidence)
      const why = draft
        ? `Draft rewritten heavily before sending: ${Math.round(draft.similarity * 100)}% of its words kept (${draft.wordsBefore} → ${draft.wordsAfter} words; ${draft.origin} draft). Read the thread live, then write the request that drafts it.`
        : 'Draft rewritten heavily before sending. Read the thread live, then write the request that drafts it.'
      return { skill: DRAFT_REWRITE_SKILL, case: withWhy({ request: '', loads: [DRAFT_REWRITE_SKILL], tools: [] }, why) }
    }

    case 'draft_dismissed': {
      const draft = asDraftDismissed(row.evidence)
      const skill = draft?.reason === 'bad_draft' ? DRAFT_REWRITE_SKILL : DRAFT_DISMISSED_SKILL
      const why = [
        draft
          ? `Draft dismissed by ${draft.by === 'person' ? 'the person' : 'the agent at their word'}: ${DISMISS_WHY[draft.reason] ?? DISMISS_WHY.other} (${draft.origin} draft${draft.recipientDomain ? ` to ${draft.recipientDomain}` : ''}).`
          : 'Draft dismissed.',
        reason ? `"${reason}"` : '',
        'Read the thread live, then write the request that should (or should not) draft it.',
      ]
        .filter(Boolean)
        .join(' ')
      return { skill, case: withWhy({ request: '', loads: [skill], tools: [] }, why) }
    }
  }

  // An unknown source (a newer writer): the request and loads, nothing more.
  return { skill: chatSkill, case: { request, loads, tools: [] } }
}
